import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { detectBlackFrames, probeOutput } from "./render.mjs";
import { assertAssetsLicensed } from "./multi-asset.mjs";
import { toTimelineV2 } from "./timeline-v2.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`)));
  });
}

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

async function renderClip({ clip, profile, assetById, overlays, musicPath, fadeMusicIn, fadeMusicOut, outputPath, subtitlePath }) {
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

  const filters = [`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1[base0]`];
  let previous = "base0";
  for (const [index, overlay] of overlays.entries()) {
    const inputIndex = index + 1;
    const next = `base${index + 1}`;
    const start = ((overlay.timelineStartMs - clip.timelineStartMs) / 1000).toFixed(3);
    const end = ((overlay.timelineEndMs - clip.timelineStartMs) / 1000).toFixed(3);
    filters.push(`[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1,setpts=PTS-STARTPTS+${start}/TB[cutaway${index}]`);
    filters.push(`[${previous}][cutaway${index}]overlay=0:0:enable='between(t\\,${start}\\,${end})':eof_action=pass[${next}]`);
    previous = next;
  }
  if (subtitlePath) {
    filters.push(`[${previous}]subtitles='${escapeFilterPath(subtitlePath)}':force_style='FontName=Noto Sans CJK SC,FontSize=38,Outline=3,Shadow=1,Alignment=2,MarginV=120'[vout]`);
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
  const timeline = toTimelineV2(project);
  assertAssetsLicensed(project);
  const version = preview ? Number(project.multiAssetPlan.version) : await versionFor(project);
  const artifactsDir = join(project.dir, "artifacts");
  const workRoot = join(project.dir, "render-work", preview ? `multi-preview-p${version}` : `multi-v${version}`);
  await Promise.all([fs.mkdir(artifactsDir, { recursive: true }), fs.mkdir(workRoot, { recursive: true })]);
  const assetById = new Map(project.assets.map((asset) => [String(asset.id), asset]));
  const mainClips = timeline.clips.filter((clip) => clip.track === "video-main").sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const overlayClips = timeline.clips.filter((clip) => clip.track === "video-overlay");
  const profiles = [];
  const artifacts = [];
  let qcPassed = true;
  const renderProfiles = timeline.profiles.map((profile) => preview ? { ...profile, width: profile.id === "landscape" ? 960 : 540, height: profile.id === "landscape" ? 540 : 960 } : profile);
  for (const profile of renderProfiles) {
    const workDir = join(workRoot, profile.id);
    await fs.mkdir(workDir, { recursive: true });
    const profileClips = [];
    for (const [index, clip] of mainClips.entries()) {
      const asset = assetById.get(clip.sourceAssetId);
      const overlays = overlayClips.filter((overlay) => overlay.timelineStartMs >= clip.timelineStartMs && overlay.timelineEndMs <= clip.timelineEndMs);
      const subtitlePath = join(workDir, `captions-${index + 1}.srt`);
      const captions = captionsForClip(clip, asset);
      if (captions.length) await fs.writeFile(subtitlePath, toSrt(captions), "utf8");
      const outputPath = join(workDir, `clip-${index + 1}.mp4`);
      await renderClip({ clip, profile, assetById, overlays, musicPath: project.music?.path || null, fadeMusicIn: clip.timelineStartMs === 0, fadeMusicOut: clip.timelineEndMs === timeline.durationMs, outputPath, subtitlePath: captions.length ? subtitlePath : null });
      profileClips.push(outputPath);
    }
    const baseName = preview ? `multi-preview-${profile.id}-p${version}.mp4` : `multi-${profile.id}${version === 1 ? "" : `-v${version}`}.mp4`;
    const name = await uniqueArtifactName(artifactsDir, baseName);
    const outputPath = join(artifactsDir, name);
    await concatClips(profileClips, join(workDir, "concat.txt"), outputPath);
    const probe = await probeOutput(outputPath);
    const blackFrames = await detectBlackFrames(outputPath);
    const expected = expectedMainDimensions(profile);
    const delta = timeline.brief.targetDurationMs ? Math.abs(probe.durationMs - timeline.brief.targetDurationMs) / timeline.brief.targetDurationMs : 0;
    const passed = probe.width === expected.width && probe.height === expected.height && probe.hasVideo && probe.hasAudio && probe.avSyncDeltaMs !== null && probe.avSyncDeltaMs <= 250 && probe.avDurationDeltaMs !== null && probe.avDurationDeltaMs <= 250 && blackFrames.length === 0;
    qcPassed &&= passed;
    profiles.push({ id: profile.id, probe, blackFrameCount: blackFrames.length, durationDeltaRatio: delta, passed });
    artifacts.push({ name, kind: preview ? "preview" : "video", profile: profile.id, version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0), width: probe.width, height: probe.height, durationMs: probe.durationMs });
  }
  const timelineName = preview ? null : await uniqueArtifactName(artifactsDir, `timeline-v2-v${version}.json`);
  const qcName = await uniqueArtifactName(artifactsDir, preview ? `multi-preview-p${version}-qc.json` : `multi-qc-v${version}.json`);
  if (timelineName) await fs.writeFile(join(artifactsDir, timelineName), `${JSON.stringify(timeline, null, 2)}\n`);
  const qc = {
    passed: qcPassed,
    checkedAt: new Date().toISOString(),
    version,
    planVersion: Number(project.multiAssetPlan.version),
    kind: preview ? "preview" : "final",
    sourceAssetCount: new Set(mainClips.map((clip) => clip.sourceAssetId)).size,
    plannedClipCount: mainClips.length,
    appliedClipCount: mainClips.length,
    profileCount: profiles.length,
    profiles,
    subtitlesBurnedIn: project.assets.some((asset) => (asset.transcript?.segments || []).length > 0),
    musicMixed: Boolean(project.music?.path),
    requiresHumanReview: true,
    warnings: [...(timeline.warnings || []), ...profiles.filter((profile) => profile.durationDeltaRatio > 0.1).map((profile) => ({ code: "duration-target-exceeded", profile: profile.id, deltaRatio: profile.durationDeltaRatio }))],
  };
  await fs.writeFile(join(artifactsDir, qcName), `${JSON.stringify(qc, null, 2)}\n`);
  if (timelineName) artifacts.push({ name: timelineName, kind: "timeline", version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0) });
  artifacts.push({ name: qcName, kind: "qc", version, planVersion: Number(project.multiAssetPlan.version), inputRevision: Number(project.multiAssetRevision || 0), preview });
  if (!qc.passed) throw new Error(preview ? "多素材预览未通过尺寸、音画同步、黑帧或目标时长检查" : "多素材成片未通过尺寸、音画同步、黑帧或目标时长检查");
  return { artifacts, qc, profiles, timeline };
}
