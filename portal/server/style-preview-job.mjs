import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getWhisperConfig, transcribeWithWhisper } from "./local-whisper.mjs";
import { normalizeCaptionStyle, transcriptToSrt } from "./edit-plan.mjs";
import { probeReferenceMedia } from "./reference-analysis.mjs";
import { applyStyleToWorkflow } from "./style-application.mjs";
import { loadStylePack } from "./style-pack-store.mjs";
import { hashStyleProject } from "./style-project.mjs";
import { composeRemotionMain } from "./remotion-main.mjs";

const execFile = promisify(execFileCallback);
const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeSlug(value) {
  return String(value || "style-preview").normalize("NFKC")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "style-preview";
}

async function run(command, args, cwd) {
  await execFile(command, args, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
}

async function assertOutputAvailable(outDir, force) {
  try {
    const entries = await fs.readdir(outDir);
    if (entries.length && !force) throw new Error(`输出目录非空：${outDir}；如需覆盖请传 force=true`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(outDir, { recursive: true });
}

function previewDimensions(aspectRatio) {
  return aspectRatio === "16:9" ? { width: 960, height: 540 } : { width: 540, height: 960 };
}

async function normalizeClip({
  inputPath,
  outputPath,
  startMs,
  durationMs,
  fps,
  width,
  height,
  hasAudio,
}) {
  const frames = Math.round(durationMs / 1000 * fps);
  const videoFilter = [
    `fps=${fps}`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `trim=end_frame=${frames}`,
    "setpts=PTS-STARTPTS",
  ].join(",");
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(startMs / 1000), "-i", inputPath, "-t", String(durationMs / 1000)];
  if (hasAudio) {
    args.push("-map", "0:v:0", "-map", "0:a:0");
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0", "-shortest");
  }
  args.push(
    "-vf", videoFilter,
    "-frames:v", String(frames),
    "-af", `atrim=duration=${(durationMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    outputPath,
  );
  await run("ffmpeg", args);
}

async function readTranscript(transcriptPath, videoPath, workDir) {
  if (transcriptPath) {
    const transcript = JSON.parse(await fs.readFile(resolve(transcriptPath), "utf8"));
    if (!Array.isArray(transcript.segments) || !transcript.segments.length) throw new Error("转录文件缺少 segments");
    return transcript;
  }
  const config = getWhisperConfig();
  if (!config.available) throw new Error("本地 Whisper 不可用；请传 transcriptPath 提供已校对转录");
  const audioPath = join(workDir, "audio-preview.wav");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath]);
  return transcribeWithWhisper({ audioPath, config });
}

function previewCopy(application) {
  return {
    ...application.parameters,
    copyAudio: false,
  };
}

function trimText(value, limit) {
  const chars = Array.from(String(value || "").trim());
  return chars.length > limit ? `${chars.slice(0, Math.max(1, limit - 1)).join("")}…` : chars.join("");
}

function deriveContentCopy({ transcript, sourceFilename, title, subtitle, identity, identitySubtext }) {
  const spoken = Array.isArray(transcript?.segments) ? transcript.segments.map((segment) => String(segment.text || "").trim()).filter(Boolean) : [];
  const spokenText = spoken.join(" ").trim();
  const filenameTitle = basename(sourceFilename || "").replace(/\.[^.]+$/, "").replace(/^\d+[.、_-]?\s*/, "");
  const detectedIdentity = spokenText.match(/(?:我是|我叫)([\u4e00-\u9fffA-Za-z·]{2,12})/)?.[1] || "";
  const explicitTitle = String(title || "").trim();
  const explicitSubtitle = String(subtitle || "").trim();
  const explicitIdentity = String(identity || "").trim();
  return {
    contract: "content-copy.v1",
    title: trimText(explicitTitle || spoken[0] || filenameTitle, 24),
    subtitle: trimText(explicitSubtitle || spoken[1] || "", 28),
    identity: trimText(explicitIdentity || detectedIdentity, 20),
    identitySubtext: trimText(identitySubtext || "", 32),
    source: explicitTitle || explicitIdentity ? "explicit" : spoken.length ? "transcript" : "filename",
  };
}

function previewVisualEvents({ manifest, durationMs, copy }) {
  const events = [];
  if (manifest.capabilities?.includes("title_card") && copy.title) {
    events.push({
      id: "preview-title",
      type: "title_card",
      startMs: 0,
      endMs: durationMs,
      text: copy.title,
      subtext: copy.subtitle,
    });
  }
  if (manifest.capabilities?.includes("emphasis") && copy.identity) {
    events.push({
      id: "preview-identity",
      type: "emphasis",
      startMs: 0,
      endMs: durationMs,
      text: copy.identity,
      subtext: copy.identitySubtext,
    });
  }
  return events;
}

export async function runStylePreview({
  inputPath,
  outputDir,
  stylePackId,
  styleVersion = 1,
  styleRoot = process.env.WAYNE_STYLE_DIR || join(portalRoot, "style-library"),
  referenceAnalysisPath,
  transcriptPath = null,
  copyPath = null,
  startMs = 0,
  durationMs = 6000,
  title = "",
  subtitle = "",
  identity = "",
  identitySubtext = "",
  force = false,
} = {}) {
  if (!inputPath || !outputDir || !stylePackId || !referenceAnalysisPath) {
    throw new Error("inputPath、outputDir、stylePackId 和 referenceAnalysisPath 均为必填");
  }
  const sourcePath = await fs.realpath(inputPath);
  const referencePath = await fs.realpath(referenceAnalysisPath);
  const outDir = resolve(outputDir);
  await assertOutputAvailable(outDir, force);
  const workDir = join(outDir, "work");
  await fs.mkdir(workDir, { recursive: true });

  const [pack, referenceAnalysis, sourceProbe] = await Promise.all([
    loadStylePack(stylePackId, Number(styleVersion), { root: resolve(styleRoot) }),
    fs.readFile(referencePath, "utf8").then(JSON.parse),
    probeReferenceMedia(sourcePath),
  ]);
  if (pack.status !== "approved") throw new Error("只有 approved StylePack 可以生成预览");
  if (referenceAnalysis.analysisId !== pack.manifest.sourceAnalysisId) throw new Error("ReferenceAnalysis 与 StylePack 来源不一致");
  if (!Number.isFinite(Number(startMs)) || Number(startMs) < 0 || !Number.isFinite(Number(durationMs)) || Number(durationMs) < 1000) {
    throw new Error("Preview 时间范围无效");
  }
  if (Number(startMs) + Number(durationMs) > Number(sourceProbe.durationMs) + 1) throw new Error("Preview 时间范围超出输入视频");

  const requestedDurationMs = Math.round(Number(durationMs));
  const { width, height } = previewDimensions(referenceAnalysis.source?.aspectRatio);
  const fps = 30;
  const basePath = join(workDir, "base.mp4");
  const inputCopyPath = join(workDir, "input.mp4");
  await normalizeClip({
    inputPath: sourcePath,
    outputPath: basePath,
    startMs: Number(startMs),
    durationMs: requestedDurationMs,
    fps,
    width,
    height,
    hasAudio: sourceProbe.hasAudio,
  });
  await fs.copyFile(basePath, inputCopyPath);
  const clipProbe = await probeReferenceMedia(basePath);
  const transcript = await readTranscript(transcriptPath, basePath, workDir);
  const copy = copyPath
    ? { contract: "content-copy.v1", ...JSON.parse(await fs.readFile(resolve(copyPath), "utf8")), source: "explicit_file" }
    : deriveContentCopy({ transcript, sourceFilename: sourcePath, title, subtitle, identity, identitySubtext });
  const media = {
    filename: basename(sourcePath),
    durationMs: clipProbe.durationMs,
    width: clipProbe.width,
    height: clipProbe.height,
    fps: clipProbe.fps,
    hasVideo: true,
    hasAudio: clipProbe.hasAudio,
  };
  const initialPlan = {
    version: 1,
    summary: "任意用户素材的可复用风格预览",
    segments: [{ id: "keep", startMs: 0, endMs: clipProbe.durationMs, action: "keep", title: "保留用户口播", note: "" }],
    shorts: [],
    visualEvents: previewVisualEvents({
      manifest: pack.manifest,
      durationMs: clipProbe.durationMs,
      copy,
    }),
    brollEvents: [],
    captionStyle: {},
    layoutEvents: [],
    captionCoverage: [],
  };
  const styled = applyStyleToWorkflow({
    stylePack: pack,
    referenceAnalysis,
    workflowMode: "single-video-v1",
    transcript,
    media,
    assets: [{ id: "main", role: "main", hasVideo: true, licenseConfirmed: true }],
    brief: { styleCopy: { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: false, copyAudio: false } },
    plan: initialPlan,
  });
  const styleProjectDir = join(workDir, "style-project");
  await fs.cp(pack.styleProjectDir, styleProjectDir, { recursive: true });
  const styleProjectHash = await hashStyleProject(styleProjectDir);
  if (pack.codeSha256 && styleProjectHash !== pack.codeSha256) throw new Error("StyleProject 内容哈希与已审批版本不一致");
  const plan = styled.plan;
  const application = {
    parameters: previewCopy(styled.application),
    captionPolicy: { ...styled.application.captionPolicy },
    warnings: [...(styled.application.warnings || [])],
    unsupported: [...(styled.application.unsupported || [])],
  };
  const styleParameters = { ...styled.application.styleParameters };
  const styleApplicationHash = hash({
    parameters: application.parameters,
    captionPolicy: application.captionPolicy,
    styleParameters,
    captionStyle: normalizeCaptionStyle(plan.captionStyle),
    layoutEvents: plan.layoutEvents || [],
  });
  const brief = {
    phase: "plan",
    projectId: `${safeSlug(basename(sourcePath))}-${randomUUID().slice(0, 8)}`,
    compositionMode: "remotion-main.v1",
    goal: "使用已审批 StylePack 生成任意素材的风格预览",
    contentCopy: copy,
    stylePackId: pack.id,
    styleVersion: pack.version,
    styleProjectDir: "style-project",
    styleProjectHash,
    styleManifestSha256: pack.manifestSha256,
    styleCompositionId: "ReferenceStyle",
    styleApplication: application,
    styleApplicationHash,
    media,
    styleParameters,
    referenceAnalysisPath: "reference-analysis.json",
    styleQc: { requireFaceEvidence: false },
  };
  await Promise.all([
    fs.writeFile(join(workDir, "brief.json"), JSON.stringify(brief, null, 2)),
    fs.writeFile(join(workDir, "transcript.json"), JSON.stringify(transcript, null, 2)),
    fs.writeFile(join(workDir, "edit-plan.json"), JSON.stringify(plan, null, 2)),
    fs.writeFile(join(workDir, "timeline.json"), JSON.stringify({
      pieces: [{ src: [0, clipProbe.durationMs], out: [0, clipProbe.durationMs] }],
    }, null, 2)),
    fs.writeFile(join(workDir, "captions.srt"), transcriptToSrt(transcript)),
    fs.writeFile(join(workDir, "reference-analysis.json"), JSON.stringify(referenceAnalysis, null, 2)),
  ]);
  const composition = await composeRemotionMain({ root: workDir, baseVideo: "base.mp4", phase: "plan" });
  const generatedPath = resolve(workDir, composition.outputPath);
  const finalPath = join(outDir, "style-preview.mp4");
  await fs.copyFile(generatedPath, finalPath);
  const qcSource = join(dirname(generatedPath), "style-qc.json");
  const qcPath = join(outDir, "style-qc.json");
  await fs.copyFile(qcSource, qcPath);
  const result = {
    contract: "style-preview-result.v1",
    generatedAt: new Date().toISOString(),
    input: {
      filename: basename(sourcePath),
      sha256: sourceProbe.sha256,
      startMs: Number(startMs),
      durationMs: clipProbe.durationMs,
      width,
      height,
      fps,
    },
    style: {
      stylePackId: pack.id,
      styleVersion: pack.version,
      styleManifestSha256: pack.manifestSha256,
      styleProjectHash,
      referenceAnalysisSha256: hash(referenceAnalysis),
      styleApplicationSha256: styleApplicationHash,
    },
    copy,
    output: {
      video: "style-preview.mp4",
      qc: "style-qc.json",
      workDir: "work",
    },
    qc: composition.qc,
  };
  await fs.writeFile(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  return { ...result, outputPath: finalPath, qcPath, workDir };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "force") args.force = true;
    else {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`${token} 缺少值`);
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runStylePreview({
      inputPath: args.input,
      outputDir: args.output,
      stylePackId: args["style-pack"],
      styleVersion: Number(args.version || 1),
      styleRoot: args["style-root"] || undefined,
      referenceAnalysisPath: args.analysis,
      transcriptPath: args.transcript || null,
      copyPath: args.copy || null,
      startMs: Number(args.start || 0),
      durationMs: Number(args.duration || 6000),
      title: args.title || "",
      subtitle: args.subtitle || "",
      identity: args.identity || "",
      identitySubtext: args["identity-subtext"] || "",
      force: args.force === true,
    });
    console.log(JSON.stringify({ outputPath: result.outputPath, qcPath: result.qcPath, qc: result.qc }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
