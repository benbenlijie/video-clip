import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { detectBlackFrames, probeOutput } from "./render.mjs";
import { assertAssetsLicensed } from "./multi-asset.mjs";
import { toTimelineV2 } from "./timeline-v2.mjs";
import { assertStylePackCompatible } from "./style-pack-store.mjs";
import { hashStyleProject } from "./style-project.mjs";
import { deriveUserStyleFacts, detectFaceFrames, evaluateStyleQc, writeStyleQc } from "./style-qc.mjs";
import { compositeRemotionPreview } from "./remotion-overlay.mjs";
import { renderStyleProject } from "./style-renderer.mjs";
import { regroupCaptionCues } from "./style-application.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`)));
  });
}

function valueHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function escapeFilterPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function srtTime(value) {
  const ms = Math.max(0, Math.round(value));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function captionsForClip(clip, asset) {
  const segments = asset.transcript?.segments || [];
  return segments.map((segment) => {
    const startMs = Math.max(Number(segment.startMs) || 0, clip.sourceInMs);
    const endMs = Math.min(Number(segment.endMs) || 0, clip.sourceOutMs);
    return { startMs: startMs - clip.sourceInMs, endMs: endMs - clip.sourceInMs, text: String(segment.text || "") };
  }).filter((segment) => segment.endMs > segment.startMs && segment.text.trim());
}

function toSrt(segments) {
  return segments.map((segment, index) => `${index + 1}\n${srtTime(segment.startMs)} --> ${srtTime(segment.endMs)}\n${segment.text}\n`).join("\n");
}

function expectedMainDimensions(profile) {
  return { width: profile.width, height: profile.height };
}

function assColor(value) {
  const hex = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).slice(1) : "ffffff";
  return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
}

export function subtitleForceStyle(style = {}) {
  const fontSize = Math.max(8, Math.min(64, Math.round(Number(style.fontSize) || 38)));
  const marginV = Math.max(0, Math.min(160, Math.round(Number(style.marginV) || 120)));
  const outline = Math.max(0, Math.min(5, Number(style.outline) || 0));
  return `FontName=Noto Sans CJK SC,FontSize=${fontSize},PrimaryColour=${assColor(style.color)},Outline=${outline},Shadow=1,Alignment=2,MarginV=${marginV}`;
}

function timelineCaptions(clips, assetById) {
  return clips.flatMap((clip) => {
    const asset = assetById.get(clip.sourceAssetId);
    if (!asset) return [];
    return captionsForClip(clip, asset).map((caption) => ({
      ...caption,
      startMs: caption.startMs + clip.timelineStartMs,
      endMs: caption.endMs + clip.timelineStartMs,
    }));
  });
}

function aggregateStyleQc(profileResults) {
  const first = profileResults[0];
  if (!first) return null;
  const hardGates = Object.fromEntries(Object.keys(first.hardGates).map((key) => {
    const gates = profileResults.map((result) => result.hardGates[key]);
    return [key, {
      passed: gates.every((gate) => gate.passed),
      profiles: profileResults.map((result) => ({ id: result.profileId, ...result.hardGates[key] })),
      ...(key === "captionsClearOfFace" ? {
        overlapCount: gates.reduce((sum, gate) => sum + Number(gate.overlapCount || 0), 0),
        sampledFrameCount: gates.reduce((sum, gate) => sum + Number(gate.sampledFrameCount || 0), 0),
        detectedFaceCount: gates.reduce((sum, gate) => sum + Number(gate.detectedFaceCount || 0), 0),
        faceDetectionAvailable: gates.every((gate) => gate.faceDetectionAvailable !== false),
        requireFaceEvidence: gates.some((gate) => gate.requireFaceEvidence === true),
      } : {}),
    }];
  }));
  return {
    contract: "style-qc.v1",
    checkedAt: new Date().toISOString(),
    passed: profileResults.every((result) => result.passed),
    metrics: first.metrics,
    thresholds: first.thresholds,
    issues: profileResults.flatMap((result) => result.issues.map((issue) => ({ profile: result.profileId, ...issue }))),
    hardGates,
    profiles: profileResults.map((result) => ({
      id: result.profileId,
      passed: result.passed,
      probedAt: result.checkedAt,
      issues: result.issues,
    })),
  };
}

async function renderClip({ clip, profile, assetById, overlays, musicPath, fadeMusicIn, fadeMusicOut, outputPath, subtitlePath, captionStyle = {} }) {
  const asset = assetById.get(clip.sourceAssetId);
  const durationMs = clip.sourceOutMs - clip.sourceInMs;
  const durationSec = durationMs / 1000;
  const width = profile.width;
  const height = profile.height;
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(clip.sourceInMs / 1000), "-i", asset.path];
  for (const overlay of overlays) {
    const source = assetById.get(overlay.sourceAssetId);
    args.push("-ss", String(overlay.sourceInMs / 1000), "-t", String((overlay.sourceOutMs - overlay.sourceInMs) / 1000), "-i", source.path);
  }
  let audioInputIndex = 0;
  if (!asset.hasAudio) {
    audioInputIndex = overlays.length + 1;
    args.push("-f", "lavfi", "-t", String(durationSec), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }
  let musicInputIndex = -1;
  if (musicPath) {
    musicInputIndex = 1 + overlays.length + (asset.hasAudio ? 0 : 1);
    args.push("-stream_loop", "-1", "-ss", String(clip.timelineStartMs / 1000), "-i", musicPath);
  }
  args.push("-t", String(durationSec));

  const layoutType = clip.layout?.type || "full";
  const baseFilter = [`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1`];
  if (layoutType === "punch_in") baseFilter.push(`crop=trunc(iw/1.12):trunc(ih/1.12),scale=${width}:${height}`);
  baseFilter.push("[base0]");
  const filters = [baseFilter.join(",").replace(",[base0]", "[base0]")];
  let previous = "base0";
  for (const [index, overlay] of overlays.entries()) {
    const inputIndex = index + 1;
    const next = `base${index + 1}`;
    const start = ((overlay.timelineStartMs - clip.timelineStartMs) / 1000).toFixed(3);
    const end = ((overlay.timelineEndMs - clip.timelineStartMs) / 1000).toFixed(3);
    const overlayWidth = layoutType === "split" ? Math.max(2, Math.round(width / 2)) : width;
    const overlayHeight = height;
    filters.push(`[${inputIndex}:v]scale=${overlayWidth}:${overlayHeight}:force_original_aspect_ratio=increase,crop=${overlayWidth}:${overlayHeight},fps=30,setsar=1,setpts=PTS-STARTPTS+${start}/TB[cutaway${index}]`);
    const overlayX = layoutType === "split" ? Math.round(width / 2) : 0;
    filters.push(`[${previous}][cutaway${index}]overlay=${overlayX}:0:enable='between(t\\,${start}\\,${end})':eof_action=pass[${next}]`);
    previous = next;
  }
  if (subtitlePath) {
    filters.push(`[${previous}]subtitles='${escapeFilterPath(subtitlePath)}':force_style='${subtitleForceStyle(captionStyle)}'[vout]`);
  } else filters.push(`[${previous}]null[vout]`);
  const voiceInput = asset.hasAudio ? "[0:a:0]" : `[${audioInputIndex}:a:0]`;
  filters.push(`${voiceInput}aresample=48000,apad=pad_dur=1[voice]`);
  if (musicInputIndex >= 0) {
    const fades = [fadeMusicIn ? "afade=t=in:st=0:d=0.5" : "", fadeMusicOut ? `afade=t=out:st=${Math.max(0, durationSec - 1)}:d=1` : ""].filter(Boolean).join(",");
    filters.push(`[${musicInputIndex}:a:0]aresample=48000,volume=0.18${fades ? `,${fades}` : ""}[bed]`);
    filters.push("[voice][bed]amix=inputs=2:duration=first:dropout_transition=2[aout]");
  } else filters.push("[voice]anull[aout]");
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outputPath);
  await run("ffmpeg", args);
}

async function concatClips(clips, manifestPath, outputPath) {
  await fs.writeFile(manifestPath, clips.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifestPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
}

async function versionFor(project) {
  let version = Math.max(0, ...(project.artifacts || []).filter((item) => item.kind === "video" && item.profile).map((item) => Number(item.version) || 0)) + 1;
  for (;;) {
    const names = ["landscape", "portrait"].map((profile) => `multi-${profile}${version === 1 ? "" : `-v${version}`}.mp4`);
    const exists = await Promise.all(names.map((name) => fs.access(join(project.dir, "artifacts", name)).then(() => true, () => false)));
    if (!exists.some(Boolean)) return version;
    version += 1;
  }
}

async function uniqueArtifactName(artifactsDir, baseName) {
  let name = baseName;
  let index = 2;
  while (await fs.access(join(artifactsDir, name)).then(() => true, () => false)) {
    const dot = baseName.lastIndexOf(".");
    name = `${baseName.slice(0, dot)}-r${index++}${baseName.slice(dot)}`;
  }
  return name;
}

export async function renderMultiAssetProject(project, { preview = false } = {}) {
  if (project?.workflowMode !== "multi-asset-v1") throw new Error("只有多素材项目可以执行多素材渲染");
  if (!project.multiAssetPlan?.confirmed) throw new Error("方案必须先由用户确认后才能渲染");
  if (project.multiAssetPlan.stylePackId) {
    if (!project.stylePack) throw new Error("多素材方案引用了风格包，但项目缺少已审批的 StylePack");
    assertStylePackCompatible(project.stylePack, "multi-asset-v1");
  }
  const timeline = toTimelineV2(project);
  assertAssetsLicensed(project);
  const version = preview ? Number(project.multiAssetPlan.version) : await versionFor(project);
  const artifactsDir = join(project.dir, "artifacts");
  const workRoot = join(project.dir, "render-work", preview ? `multi-preview-p${version}` : `multi-v${version}`);
  await Promise.all([fs.mkdir(artifactsDir, { recursive: true }), fs.mkdir(workRoot, { recursive: true })]);
  const assetById = new Map(project.assets.map((asset) => [String(asset.id), asset]));
  const mainClips = timeline.clips.filter((clip) => clip.track === "video-main").sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const overlayClips = timeline.clips.filter((clip) => clip.track === "video-overlay");
  const unsupportedLayouts = mainClips.filter((clip) => clip.layout?.type === "split" && !overlayClips.some((overlay) => overlay.timelineStartMs >= clip.timelineStartMs && overlay.timelineEndMs <= clip.timelineEndMs)).map((clip) => ({ code: "split-needs-overlay", clipId: clip.id }));
  const profiles = [];
  const artifacts = [];
  let qcPassed = true;
  const styleMode = Boolean(project.multiAssetPlan.stylePackId);
  const styleProjectHash = styleMode
    ? project.styleProjectPath
      ? await hashStyleProject(project.styleProjectPath)
      : project.stylePack?.codeSha256 || null
    : null;
  if (styleMode && (!styleProjectHash || styleProjectHash !== project.stylePack?.codeSha256)) throw new Error("StyleProject 内容哈希与已审批 StylePack 不一致");
  if (styleMode && !project.styleProjectPath) throw new Error("当前风格缺少可渲染的 StyleProject");
  if (styleMode && !/^[a-f0-9]{64}$/i.test(String(project.stylePack?.manifestSha256 || ""))) throw new Error("StylePack 缺少有效 manifest 哈希");
  const styleCopy = project.styleApplication?.parameters || project.styleCopy || {};
  const captionStyle = project.multiAssetPlan.captionStyle || { fontSize: 38, marginV: 120, outline: 2, color: "#ffffff" };
  const layoutEvents = mainClips.map((clip, index) => ({
    id: `multi-layout-${index + 1}`,
    type: clip.layout?.type || "full",
    startMs: Number(clip.timelineStartMs),
    endMs: Number(clip.timelineEndMs),
    params: {},
  }));
  const styleApplicationEvidence = styleMode ? {
    parameters: styleCopy,
    captionPolicy: project.styleApplication?.captionPolicy || null,
    styleParameters: project.multiAssetPlan.styleParameters || {},
    captionStyle,
    layoutEvents,
  } : null;
  if (styleMode && project.styleApplicationHash && valueHash(styleApplicationEvidence) !== project.styleApplicationHash) {
    throw new Error("风格应用参数已变化，请重新应用 StylePack 后再渲染预览");
  }
  const styleProvenance = styleMode ? {
    stylePackId: project.multiAssetPlan.stylePackId,
    styleVersion: Number(project.multiAssetPlan.styleVersion),
    styleManifestSha256: String(project.stylePack.manifestSha256).toLowerCase(),
    styleProjectHash,
    referenceAnalysisSha256: valueHash(project.referenceAnalysis),
    styleApplicationSha256: valueHash(styleApplicationEvidence),
  } : null;
  const sourceCaptions = timelineCaptions(mainClips, assetById);
  const captions = regroupCaptionCues(sourceCaptions, project.styleApplication?.captionPolicy?.wordsPerCue);
  const styleFacts = styleMode
    ? deriveUserStyleFacts({
        plan: { ...project.multiAssetPlan, captionStyle },
        transcript: { segments: captions },
        media: { width: 1080, height: 1920, durationMs: timeline.durationMs },
        assets: project.assets,
      })
    : null;
  const styleProfileResults = [];
  let styleOverlayCount = 0;
  const renderProfiles = timeline.profiles.map((profile) => preview ? { ...profile, width: profile.id === "landscape" ? 960 : 540, height: profile.id === "landscape" ? 540 : 960 } : profile);
  for (const profile of renderProfiles) {
    const workDir = join(workRoot, profile.id);
    await fs.mkdir(workDir, { recursive: true });
    const profileClips = [];
    for (const [index, clip] of mainClips.entries()) {
      const asset = assetById.get(clip.sourceAssetId);
      const overlays = overlayClips.filter((overlay) => overlay.timelineStartMs >= clip.timelineStartMs && overlay.timelineEndMs <= clip.timelineEndMs);
      const subtitlePath = join(workDir, `captions-${index + 1}.srt`);
      const clipCaptions = captionsForClip(clip, asset);
      if (!styleMode && clipCaptions.length) await fs.writeFile(subtitlePath, toSrt(clipCaptions), "utf8");
      const outputPath = join(workDir, `clip-${index + 1}.mp4`);
      await renderClip({ clip, profile, assetById, overlays, musicPath: project.music?.path || null, fadeMusicIn: clip.timelineStartMs === 0, fadeMusicOut: clip.timelineEndMs === timeline.durationMs, outputPath, subtitlePath: !styleMode && clipCaptions.length ? subtitlePath : null, captionStyle });
      profileClips.push(outputPath);
    }
    const baseName = preview ? `multi-preview-${profile.id}-p${version}.mp4` : `multi-${profile.id}${version === 1 ? "" : `-v${version}`}.mp4`;
    const name = await uniqueArtifactName(artifactsDir, baseName);
    const outputPath = join(artifactsDir, name);
    const concatenatedPath = styleMode ? join(workDir, "base.mp4") : outputPath;
    await concatClips(profileClips, join(workDir, "concat.txt"), concatenatedPath);
    let profileCaptionStyle = captionStyle;
    if (styleMode) {
      const scale = profile.height / 1920;
      profileCaptionStyle = {
        ...captionStyle,
        fontSize: Math.max(8, Math.round(Number(captionStyle.fontSize) * scale)),
        marginV: Math.max(0, Math.round(Number(captionStyle.marginV) * scale)),
      };
      const overlay = await renderStyleProject({
        projectDir: project.styleProjectPath,
        compositionId: "ReferenceStyle",
        outputPath: join(workDir, "style-overlay.mov"),
        props: {
          width: profile.width,
          height: profile.height,
          fps: 30,
          durationMs: timeline.durationMs,
          captions,
          visualEvents: project.multiAssetPlan.visualEvents || [],
          layoutEvents,
          styleParams: project.multiAssetPlan.styleParameters || {},
          captionStyle: profileCaptionStyle,
          styleSpec: project.stylePack?.manifest?.styleSpec || null,
        },
      });
      await compositeRemotionPreview({
        inputPath: concatenatedPath,
        overlayPath: overlay.outputPath,
        outputPath,
        subtitlePath: null,
        durationMs: timeline.durationMs,
        phase: preview ? "plan" : "render",
      });
      const overlayName = await uniqueArtifactName(artifactsDir, preview ? `multi-style-overlay-${profile.id}-p${version}.mov` : `multi-style-overlay-${profile.id}-v${version}.mov`);
      await fs.copyFile(overlay.outputPath, join(artifactsDir, overlayName));
      artifacts.push({ name: overlayName, kind: "style-overlay", profile: profile.id, version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0), width: overlay.width, height: overlay.height, durationMs: overlay.durationMs, stylePackId: project.multiAssetPlan.stylePackId, styleVersion: project.multiAssetPlan.styleVersion, networkIsolated: overlay.networkIsolated === true });
      styleOverlayCount += 1;
    }
    const probe = await probeOutput(outputPath);
    const blackFrames = await detectBlackFrames(outputPath);
    const expected = expectedMainDimensions(profile);
    const delta = timeline.brief.targetDurationMs ? Math.abs(probe.durationMs - timeline.brief.targetDurationMs) / timeline.brief.targetDurationMs : 0;
    let styleQc = null;
    if (styleMode) {
      let faceFrames = [];
      let faceDetectionAvailable = true;
      try {
        faceFrames = await detectFaceFrames(outputPath, { maxSamples: 12 });
      } catch {
        faceDetectionAvailable = false;
      }
      styleQc = await evaluateStyleQc({
        referenceAnalysis: project.referenceAnalysis,
        userFacts: styleFacts,
        render: {
          probe,
          blackFrames,
          inputHashes: project.assets.map((asset) => asset.sha256).filter(Boolean),
          assetsLicensed: project.assets.every((asset) => asset.licenseConfirmed === true) && (!project.music || project.music.licenseConfirmed === true),
          styleProjectHash,
        },
        expectedStyleProjectHash: project.stylePack?.codeSha256 || null,
        captions,
        captionStyle: profileCaptionStyle,
        faceFrames,
        faceDetectionAvailable,
        copy: styleCopy,
      });
      styleProfileResults.push({ ...styleQc, profileId: profile.id });
    }
    const passed = probe.width === expected.width && probe.height === expected.height && probe.hasVideo && probe.hasAudio && probe.avSyncDeltaMs !== null && probe.avSyncDeltaMs <= 250 && probe.avDurationDeltaMs !== null && probe.avDurationDeltaMs <= 250 && blackFrames.length === 0 && (!styleQc || styleQc.passed);
    qcPassed &&= passed;
    profiles.push({ id: profile.id, probe, blackFrameCount: blackFrames.length, durationDeltaRatio: delta, passed, ...(styleQc ? { styleQc: { passed: styleQc.passed, metrics: styleQc.metrics, issues: styleQc.issues } } : {}) });
    artifacts.push({ name, kind: preview ? "preview" : "video", profile: profile.id, version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0), width: probe.width, height: probe.height, durationMs: probe.durationMs });
  }
  const timelineName = preview ? null : await uniqueArtifactName(artifactsDir, `timeline-v2-v${version}.json`);
  const qcName = await uniqueArtifactName(artifactsDir, preview ? `multi-preview-p${version}-qc.json` : `multi-qc-v${version}.json`);
  const styleQc = styleMode ? aggregateStyleQc(styleProfileResults) : null;
  if (styleQc && styleProvenance) styleQc.styleProvenance = styleProvenance;
  const styleQcName = styleMode ? await uniqueArtifactName(artifactsDir, preview ? `multi-preview-p${version}-style-qc.json` : `multi-style-qc-v${version}.json`) : null;
  if (timelineName) await fs.writeFile(join(artifactsDir, timelineName), `${JSON.stringify(timeline, null, 2)}\n`);
  if (styleQc && styleQcName) await writeStyleQc(join(artifactsDir, styleQcName), styleQc);
  const qc = {
    passed: qcPassed && (!styleQc || styleQc.passed),
    checkedAt: new Date().toISOString(),
    version,
    planVersion: Number(project.multiAssetPlan.version),
    kind: preview ? "preview" : "final",
    sourceAssetCount: new Set(mainClips.map((clip) => clip.sourceAssetId)).size,
    plannedClipCount: mainClips.length,
    appliedClipCount: mainClips.length,
    stylePackId: project.multiAssetPlan.stylePackId || null,
    styleVersion: project.multiAssetPlan.styleVersion || null,
    styleProvenance,
    styleApplicationEvidence,
    styleOverlayCount,
    styleQc: styleQc ? { contract: styleQc.contract, passed: styleQc.passed, metrics: styleQc.metrics, issues: styleQc.issues, hardGates: styleQc.hardGates, profiles: styleQc.profiles } : null,
    profileCount: profiles.length,
    profiles,
    subtitlesBurnedIn: project.assets.some((asset) => (asset.transcript?.segments || []).length > 0),
    musicMixed: Boolean(project.music?.path),
    requiresHumanReview: true,
    warnings: [...(timeline.warnings || []), ...unsupportedLayouts, ...profiles.filter((profile) => profile.durationDeltaRatio > 0.1).map((profile) => ({ code: "duration-target-exceeded", profile: profile.id, deltaRatio: profile.durationDeltaRatio }))],
  };
  await fs.writeFile(join(artifactsDir, qcName), `${JSON.stringify(qc, null, 2)}\n`);
  if (timelineName) artifacts.push({ name: timelineName, kind: "timeline", version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0) });
  if (styleQcName) artifacts.push({ name: styleQcName, kind: "style-qc", version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0), preview });
  artifacts.push({ name: qcName, kind: "qc", version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0), preview });
  if (!qc.passed) {
    const reasons = [
      ...profiles.filter((profile) => !profile.passed).flatMap((profile) => profile.styleQc?.issues?.map((issue) => `${profile.id}:${issue.metric || issue.code}`) || [`${profile.id}:profile`]),
      ...(styleQc?.issues?.map((issue) => issue.profile ? `${issue.profile}:${issue.metric || issue.code}` : issue.metric || issue.code) || []),
      ...Object.entries(styleQc?.hardGates || {}).filter(([, gate]) => !gate.passed).map(([name]) => `hard-gate:${name}`),
    ];
    throw new Error(`${preview ? "多素材预览" : "多素材成片"}未通过 QC${reasons.length ? `: ${[...new Set(reasons)].join(", ")}` : ""}`);
  }
  return { artifacts, qc, profiles, timeline };
}
