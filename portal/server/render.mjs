import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { renderHyperframesOverlay } from "./hyperframes-overlay.mjs";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`)));
  });
}

export async function probeOutput(path) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration,start_time", "-of", "json", path]);
  const payload = JSON.parse(stdout);
  const durationMs = Math.round(Number(payload.format?.duration || 0) * 1000);
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || !audio || durationMs <= 0) throw new Error("输出 QC 失败：缺少音视频流或时长无效");
  const videoDuration = Number(video.duration || 0);
  const audioDuration = Number(audio.duration || 0);
  const avSyncDeltaMs = Number.isFinite(Number(video.start_time)) && Number.isFinite(Number(audio.start_time))
    ? Math.round(Math.abs(Number(video.start_time) - Number(audio.start_time)) * 1000) : null;
  const avDurationDeltaMs = videoDuration > 0 && audioDuration > 0 ? Math.round(Math.abs(videoDuration - audioDuration) * 1000) : null;
  return { durationMs, width: Number(video.width || 0), height: Number(video.height || 0), hasVideo: true, hasAudio: true, avSyncDeltaMs, avDurationDeltaMs };
}

export async function detectBlackFrames(path) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", path, "-vf", "blackdetect=d=0.3:pix_th=0.10", "-an", "-f", "null", "-"]);
  return [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)]
    .map((match) => ({ startMs: Math.round(Number(match[1]) * 1000), endMs: Math.round(Number(match[2]) * 1000), durationMs: Math.round(Number(match[3]) * 1000) }));
}

export function mapVisualEventsToClip(events, clipStartMs, clipEndMs) {
  return (events || [])
    .map((event) => ({ ...event, startMs: Math.max(event.startMs, clipStartMs), endMs: Math.min(event.endMs, clipEndMs) }))
    .filter((event) => event.endMs > event.startMs)
    .map((event) => ({ ...event, startMs: event.startMs - clipStartMs, endMs: event.endMs - clipStartMs }));
}

export function mapBrollEventsToClip(events, clipStartMs, clipEndMs) {
  return (events || []).map((event) => {
    const startMs = Math.max(event.startMs, clipStartMs);
    const endMs = Math.min(event.endMs, clipEndMs);
    return { ...event, startMs, endMs, sourceStartMs: event.sourceStartMs + startMs - event.startMs };
  }).filter((event) => event.endMs > event.startMs).map((event) => ({ ...event, startMs: event.startMs - clipStartMs, endMs: event.endMs - clipStartMs }));
}

function formatSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(total % 1000).padStart(3, "0")}`;
}

function toSrt(segments = []) {
  return segments.filter((segment) => segment.endMs > segment.startMs).map((segment, index) => (
    `${index + 1}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}\n${segment.text || ""}\n`
  )).join("\n");
}

function escapeFilterPath(path) {
  return path.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

async function renderClip({ input, output, startMs, endMs, vertical, subtitlePath, brollEvents = [], brollAssetsById = new Map(), visualOverlayPath, width, height, musicPath, musicStartMs = 0, fadeMusicIn = false, fadeMusicOut = false, commandLog }) {
  const start = Math.max(0, startMs / 1000);
  const duration = Math.max(0.05, (endMs - startMs) / 1000);
  const args = ["-y", "-ss", String(start), "-i", input];
  for (const event of brollEvents) {
    const asset = brollAssetsById.get(event.assetId);
    if (!asset?.path) throw new Error(`缺少 B-roll 素材：${event.assetId}`);
    args.push("-ss", String(event.sourceStartMs / 1000), "-i", asset.path);
  }
  const visualOverlayInputIndex = 1 + brollEvents.length;
  if (visualOverlayPath) args.push("-ss", String(start), "-i", visualOverlayPath);
  const musicInputIndex = visualOverlayInputIndex + (visualOverlayPath ? 1 : 0);
  if (musicPath) args.push("-ss", String(Math.max(0, musicStartMs) / 1000), "-stream_loop", "-1", "-i", musicPath);
  args.push("-t", String(duration));

  const visualFilters = [];
  if (vertical) visualFilters.push("scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920");
  const subtitleFilter = subtitlePath ? `subtitles='${escapeFilterPath(subtitlePath)}':force_style='FontName=Noto Sans CJK SC,FontSize=38,Outline=3,Shadow=1,Alignment=2,MarginV=120'` : "";
  const needsComplex = brollEvents.length > 0 || Boolean(visualOverlayPath) || Boolean(musicPath);
  if (needsComplex) {
    const baseFilters = [];
    if (vertical) baseFilters.push("scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920");
    if (!vertical && baseFilters.length === 0) baseFilters.push("null");
    const chains = [`[0:v]${baseFilters.join(",")}[base0]`];
    let previous = "base0";
    const frameWidth = vertical ? 1080 : width;
    const frameHeight = vertical ? 1920 : height;
    for (const [index, event] of brollEvents.entries()) {
      const inputIndex = index + 1;
      const outputName = index === brollEvents.length - 1 && !visualOverlayPath ? "vout" : `base${index + 1}`;
      const from = (event.startMs / 1000).toFixed(3);
      const to = (event.endMs / 1000).toFixed(3);
      chains.push(`[${inputIndex}:v]scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=increase,crop=${frameWidth}:${frameHeight},setpts=PTS-STARTPTS[cutaway${index}]`);
      chains.push(`[${previous}][cutaway${index}]overlay=0:0:enable='between(t\\,${from}\\,${to})'[${outputName}]`);
      previous = outputName;
    }
    if (visualOverlayPath) {
      const outputName = "vout";
      chains.push(`[${visualOverlayInputIndex}:v]setpts=PTS-STARTPTS[hf-overlay]`);
      chains.push(`[${previous}][hf-overlay]overlay=0:0:format=auto:eof_action=pass[${outputName}]`);
      previous = outputName;
    }
    if (brollEvents.length === 0 && !visualOverlayPath) chains.push("[base0]null[vout]");
    const designedVideo = "vout";
    if (subtitleFilter) chains.push(`[${designedVideo}]${subtitleFilter}[vfinal]`);
    const finalVideo = subtitleFilter ? "vfinal" : designedVideo;
    const mappedVideo = `[${finalVideo}]`;
    args.push("-map", mappedVideo);
    if (musicPath) {
      const fadeOutStart = Math.max(0, duration - 1).toFixed(3);
      const fades = [fadeMusicIn ? "afade=t=in:st=0:d=0.5" : "", fadeMusicOut ? `afade=t=out:st=${fadeOutStart}:d=1` : ""].filter(Boolean).join(",");
      chains.push(`[0:a]volume=1.0,apad=pad_dur=1[voice];[${musicInputIndex}:a]volume=0.18${fades ? `,${fades}` : ""}[music]`, "[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]");
      args.push("-filter_complex", chains.join(";"), "-map", "[aout]");
    } else {
      chains.push("[0:a]apad=pad_dur=1[aout]");
      args.push("-filter_complex", chains.join(";"), "-map", "[aout]");
    }
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
    if (subtitleFilter) visualFilters.push(subtitleFilter);
    if (visualFilters.length) args.push("-vf", visualFilters.join(","));
  }
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output);
  commandLog.push(`ffmpeg ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
  await run("ffmpeg", args);
}

async function concatClips(clips, output, dir, commandLog) {
  const manifest = join(dir, "concat.txt");
  await fs.writeFile(manifest, clips.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", manifest, "-c", "copy", "-movflags", "+faststart", output];
  commandLog.push(`ffmpeg ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
  await run("ffmpeg", args);
}

function artifactVersion(artifacts = []) {
  const used = new Set((artifacts || []).map((item) => item.name));
  let version = 1;
  while (used.has(`wayne-case-01-final${version === 1 ? "" : `-v${version}`}.mp4`)) version += 1;
  return version;
}

function versionedName(base, version) {
  const dot = base.lastIndexOf(".");
  const suffix = version === 1 ? "" : `-v${version}`;
  return `${base.slice(0, dot)}${suffix}${base.slice(dot)}`;
}

export async function renderProject(project) {
  if (!project.media?.path) throw new Error("没有可渲染的原始视频");
  if (!project.plan) throw new Error("请先确认剪辑计划");
  const visualEvents = project.plan.visualEvents || [];
  if (!visualEvents.length) throw new Error("当前剪辑计划没有视觉编辑指令，请先重新生成视觉计划");
  const appliedIds = new Set();
  const artifactsDir = join(project.dir, "artifacts");
  const workDir = join(project.dir, "render-work");
  const subtitleDir = join(workDir, "subtitles");
  const version = artifactVersion(project.artifacts);
  const commandLog = [];
  const mainOrientation = project.media.height > project.media.width ? "portrait" : "landscape";
  const overlayLandscape = await renderHyperframesOverlay({ events: visualEvents, durationMs: project.media.durationMs, width: project.media.width, height: project.media.height, outputPath: join(workDir, "hyperframes-landscape.mov"), workDir: join(workDir, "hyperframes-landscape") });
  const overlayPortrait = mainOrientation === "portrait" ? overlayLandscape : await renderHyperframesOverlay({ events: visualEvents, durationMs: project.media.durationMs, width: 1080, height: 1920, outputPath: join(workDir, "hyperframes-portrait.mov"), workDir: join(workDir, "hyperframes-portrait") });
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(subtitleDir, { recursive: true });
  const mainSourceName = versionedName(`hyperframes-overlay-${mainOrientation}.html`, version);
  const portraitSourceName = versionedName("hyperframes-overlay-portrait.html", version);
  const mainOverlayName = versionedName(`hyperframes-overlay-${mainOrientation}.mov`, version);
  const portraitOverlayName = versionedName("hyperframes-overlay-portrait.mov", version);
  const gsapName = versionedName("hyperframes-gsap.min.js", version);
  const gsapArtifactPath = join(artifactsDir, gsapName);
  const landscapeHtml = await fs.readFile(overlayLandscape.sourcePath, "utf8");
  const mainSourcePath = join(artifactsDir, mainSourceName);
  const mainOverlayArtifactPath = join(artifactsDir, mainOverlayName);
  await fs.writeFile(mainSourcePath, landscapeHtml.replaceAll("./gsap.min.js", `./${gsapName}`));
  await fs.copyFile(overlayLandscape.outputPath, mainOverlayArtifactPath);
  await fs.copyFile(join(dirname(overlayLandscape.sourcePath), "gsap.min.js"), gsapArtifactPath);
  if (overlayPortrait !== overlayLandscape) {
    const portraitHtml = await fs.readFile(overlayPortrait.sourcePath, "utf8");
    const portraitSourcePath = join(artifactsDir, portraitSourceName);
    const portraitOverlayArtifactPath = join(artifactsDir, portraitOverlayName);
    await fs.writeFile(portraitSourcePath, portraitHtml.replaceAll("./gsap.min.js", `./${gsapName}`));
    await fs.copyFile(overlayPortrait.outputPath, portraitOverlayArtifactPath);
  }

  const keepSegments = project.plan.segments.filter((segment) => segment.action !== "remove");
  const brollAssetsById = new Map((project.brollAssets || []).map((asset) => [asset.id, asset]));
  const brollEvents = project.plan.brollEvents || [];
  const appliedBrollIds = new Set();
  const clips = [];
  for (const [index, segment] of keepSegments.entries()) {
    const clip = join(workDir, `main-${index + 1}.mp4`);
    const captionEntries = (project.transcript?.segments || []).map((item) => ({ ...item, startMs: Math.max(item.startMs, segment.startMs), endMs: Math.min(item.endMs, segment.endMs) }))
      .filter((item) => item.endMs > item.startMs)
      .map((item) => ({ ...item, startMs: item.startMs - segment.startMs, endMs: item.endMs - segment.startMs }));
    const subtitlePath = join(subtitleDir, `main-${index + 1}.srt`);
    await fs.writeFile(subtitlePath, toSrt(captionEntries), "utf8");
    const events = mapVisualEventsToClip(visualEvents, segment.startMs, segment.endMs);
    const broll = mapBrollEventsToClip(brollEvents, segment.startMs, segment.endMs);
    events.forEach((event) => appliedIds.add(event.id));
    broll.forEach((event) => appliedBrollIds.add(event.id));
    await renderClip({ input: project.media.path, output: clip, startMs: segment.startMs, endMs: segment.endMs, subtitlePath: captionEntries.length ? subtitlePath : undefined, brollEvents: broll, brollAssetsById, visualOverlayPath: overlayLandscape.outputPath, width: project.media.width, height: project.media.height, musicPath: project.music?.path, musicStartMs: segment.startMs, fadeMusicIn: index === 0, fadeMusicOut: index === keepSegments.length - 1, commandLog });
    clips.push(clip);
  }
  if (!clips.length) throw new Error("剪辑计划没有可保留片段");
  if (appliedIds.size !== visualEvents.length) throw new Error("有视觉编辑指令落在已删除片段中，无法完整执行");
  if (appliedBrollIds.size !== brollEvents.length) throw new Error("有 B-roll 事件落在已删除片段中，无法完整执行");

  const mainName = versionedName("wayne-case-01-final.mp4", version);
  const mainPath = join(artifactsDir, mainName);
  await concatClips(clips, mainPath, workDir, commandLog);

  const shorts = [];
  for (const [index, short] of project.plan.shorts.entries()) {
    const baseName = `short-${String(index + 1).padStart(2, "0")}.mp4`;
    const filename = versionedName(baseName, version);
    const output = join(artifactsDir, filename);
    const captionEntries = (project.transcript?.segments || []).map((item) => ({ ...item, startMs: Math.max(item.startMs, short.startMs), endMs: Math.min(item.endMs, short.endMs) }))
      .filter((item) => item.endMs > item.startMs)
      .map((item) => ({ ...item, startMs: item.startMs - short.startMs, endMs: item.endMs - short.startMs }));
    const subtitlePath = join(subtitleDir, `${filename}.srt`);
    await fs.writeFile(subtitlePath, toSrt(captionEntries), "utf8");
    const events = mapVisualEventsToClip(visualEvents, short.startMs, short.endMs);
    const broll = mapBrollEventsToClip(brollEvents, short.startMs, short.endMs);
    events.forEach((event) => appliedIds.add(event.id));
    await renderClip({ input: project.media.path, output, startMs: short.startMs, endMs: short.endMs, vertical: true, subtitlePath: captionEntries.length ? subtitlePath : undefined, brollEvents: broll, brollAssetsById, visualOverlayPath: overlayPortrait.outputPath, width: project.media.width, height: project.media.height, musicPath: project.music?.path, musicStartMs: short.startMs, fadeMusicIn: true, fadeMusicOut: true, commandLog });
    shorts.push({ name: filename, slot: index + 1, title: short.title, startMs: short.startMs, endMs: short.endMs });
  }

  const subtitleName = versionedName("captions.srt", version);
  const cutListName = versionedName("cut-list.json", version);
  const qcName = versionedName("qc.json", version);
  const logName = versionedName("ffmpeg-command.log", version);
  await fs.writeFile(join(artifactsDir, subtitleName), toSrt(project.transcript?.segments || []), "utf8");
  await fs.writeFile(join(artifactsDir, cutListName), JSON.stringify(project.plan, null, 2));

  const mainProbe = await probeOutput(mainPath);
  const mainBlackFrames = await detectBlackFrames(mainPath);
  const firstMainProbe = await probeOutput(clips[0]);
  const shortProbes = [];
  for (const short of shorts) shortProbes.push({ ...short, probe: await probeOutput(join(artifactsDir, short.name)), blackFrames: await detectBlackFrames(join(artifactsDir, short.name)) });
  const transcriptHasText = (project.transcript?.segments || []).some((segment) => segment.text?.trim());
  const audioVideoSyncChecked = mainProbe.avSyncDeltaMs !== null && mainProbe.avDurationDeltaMs !== null;
  const noUnexpectedBlackFrames = mainBlackFrames.length === 0 && shortProbes.every((item) => item.blackFrames.length === 0);
  const qc = {
    passed: mainProbe.hasVideo && mainProbe.hasAudio && overlayLandscape.hasAlpha && overlayPortrait.hasAlpha && audioVideoSyncChecked && mainProbe.avSyncDeltaMs <= 250 && mainProbe.avDurationDeltaMs <= 250 && noUnexpectedBlackFrames && mainProbe.width === firstMainProbe.width && mainProbe.height === firstMainProbe.height && shortProbes.length === 5 && shortProbes.every((item) => item.probe.width === 1080 && item.probe.height === 1920) && appliedIds.size === visualEvents.length && appliedBrollIds.size === brollEvents.length && (!transcriptHasText || !!subtitleName),
    checkedAt: new Date().toISOString(),
    version,
    main: mainProbe,
    expectedMain: { width: firstMainProbe.width, height: firstMainProbe.height },
    subtitlesBurnedIn: transcriptHasText,
    musicMixed: Boolean(project.music?.path),
    hyperframesRendered: overlayLandscape.hasAlpha && overlayPortrait.hasAlpha,
    brollEventCountPlanned: brollEvents.length,
    brollEventCountApplied: appliedBrollIds.size,
    audioVideoSyncChecked,
    mainBlackFrames,
    noUnexpectedBlackFrames,
    visualEventCountPlanned: visualEvents.length,
    visualEventCountApplied: appliedIds.size,
    visualEventIdsApplied: [...appliedIds],
    shorts: shortProbes,
  };
  await fs.writeFile(join(artifactsDir, qcName), JSON.stringify(qc, null, 2));
  await fs.writeFile(join(artifactsDir, logName), `${commandLog.join("\n\n")}\n`);
  if (!qc.passed) throw new Error("输出 QC 未通过");
  return {
    artifacts: [
      { name: mainName, kind: "video", version, ...mainProbe },
      { name: subtitleName, kind: "subtitle", version },
      { name: cutListName, kind: "plan", version },
      { name: qcName, kind: "qc", version },
      { name: logName, kind: "log", version },
      { name: mainSourceName, kind: "source", version },
      { name: gsapName, kind: "source", version },
      { name: mainOverlayName, kind: "overlay", version, width: overlayLandscape.width, height: overlayLandscape.height, durationMs: overlayLandscape.durationMs },
      ...(overlayPortrait === overlayLandscape ? [] : [{ name: portraitSourceName, kind: "source", version }, { name: portraitOverlayName, kind: "overlay", version, width: overlayPortrait.width, height: overlayPortrait.height, durationMs: overlayPortrait.durationMs }]),
      ...shortProbes.map((item) => ({ name: item.name, kind: "short", slot: item.slot, version, title: item.title, ...item.probe })),
    ],
    qc,
  };
}
