import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

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
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]);
  const payload = JSON.parse(stdout);
  const durationMs = Math.round(Number(payload.format?.duration || 0) * 1000);
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || !audio || durationMs <= 0) throw new Error("输出 QC 失败：缺少音视频流或时长无效");
  return { durationMs, width: Number(video.width || 0), height: Number(video.height || 0), hasVideo: true, hasAudio: true };
}

export function mapVisualEventsToClip(events, clipStartMs, clipEndMs) {
  return (events || [])
    .map((event) => ({ ...event, startMs: Math.max(event.startMs, clipStartMs), endMs: Math.min(event.endMs, clipEndMs) }))
    .filter((event) => event.endMs > event.startMs)
    .map((event) => ({ ...event, startMs: event.startMs - clipStartMs, endMs: event.endMs - clipStartMs }));
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

function wrapText(value, maxChars) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const chars = Array.from(word);
    for (const char of chars) {
      if (Array.from(line).length >= maxChars) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    if (line && Array.from(line).length < maxChars) line += " ";
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

function enabledBetween(event) {
  return `between(t\\,${(event.startMs / 1000).toFixed(3)}\\,${(event.endMs / 1000).toFixed(3)})`;
}

function eventFilters(event, assets, fontPath) {
  const enabled = enabledBetween(event);
  const common = `fontfile='${escapeFilterPath(fontPath)}':fix_bounds=1:shadowcolor=black@0.7:shadowx=2:shadowy=2:enable='${enabled}'`;
  const titleText = `drawtext=${common}:textfile='${escapeFilterPath(assets.textPath)}':x=w*0.085:y=h*0.085:fontsize=h*0.052:fontcolor=white:line_spacing=12`;
  const subText = assets.subPath ? `drawtext=${common}:textfile='${escapeFilterPath(assets.subPath)}':x=w*0.085:y=h*0.165:fontsize=h*0.029:fontcolor=0xc6f475` : "";
  const titleBox = [
    `drawbox=x=iw*0.04:y=ih*0.055:w=iw*0.92:h=ih*0.22:color=0x101510@0.82:t=fill:enable='${enabled}'`,
    `drawbox=x=iw*0.04:y=ih*0.055:w=iw*0.012:h=ih*0.22:color=0xc6f475@1:t=fill:enable='${enabled}'`,
  ];
  const emphasisBox = [
    `drawbox=x=iw*0.055:y=ih*0.71:w=iw*0.89:h=ih*0.15:color=0x101510@0.84:t=fill:enable='${enabled}'`,
    `drawbox=x=iw*0.055:y=ih*0.71:w=iw*0.012:h=ih*0.15:color=0xc6f475@1:t=fill:enable='${enabled}'`,
    `drawtext=${common}:textfile='${escapeFilterPath(assets.textPath)}':x=w*0.09:y=h*0.755:fontsize=h*0.043:fontcolor=white`,
  ];
  const ctaBox = [
    `drawbox=x=iw*0.05:y=ih*0.70:w=iw*0.90:h=ih*0.20:color=0x101510@0.88:t=fill:enable='${enabled}'`,
    `drawbox=x=iw*0.05:y=ih*0.70:w=iw*0.012:h=ih*0.20:color=0xc6f475@1:t=fill:enable='${enabled}'`,
    `drawtext=${common}:textfile='${escapeFilterPath(assets.textPath)}':x=w*0.09:y=h*0.735:fontsize=h*0.048:fontcolor=white`,
    ...(assets.subPath ? [`drawtext=${common}:textfile='${escapeFilterPath(assets.subPath)}':x=w*0.09:y=h*0.805:fontsize=h*0.028:fontcolor=0xc6f475`] : []),
  ];
  if (event.type === "title_card") return [...titleBox, titleText, ...(subText ? [subText] : [])];
  if (event.type === "emphasis") return emphasisBox;
  return ctaBox;
}

async function writeEventAssets(event, assetDir, index) {
  const maxChars = event.type === "title_card" ? 25 : 28;
  const textPath = join(assetDir, `visual-${index + 1}.txt`);
  await fs.writeFile(textPath, wrapText(event.text, maxChars), "utf8");
  let subPath;
  if (event.subtext) {
    subPath = join(assetDir, `visual-${index + 1}-sub.txt`);
    await fs.writeFile(subPath, wrapText(event.subtext, 34), "utf8");
  }
  return { textPath, subPath };
}

async function renderClip({ input, output, startMs, endMs, vertical, subtitlePath, events, assetDir, fontPath, commandLog }) {
  const start = Math.max(0, startMs / 1000);
  const duration = Math.max(0.05, (endMs - startMs) / 1000);
  const args = ["-y", "-ss", String(start), "-i", input, "-t", String(duration), "-map", "0:v:0", "-map", "0:a:0?"];
  const filters = [];
  if (vertical) filters.push("scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920");
  for (const [index, event] of events.entries()) {
    const assets = await writeEventAssets(event, assetDir, index);
    filters.push(...eventFilters(event, assets, fontPath));
  }
  if (subtitlePath) filters.push(`subtitles='${escapeFilterPath(subtitlePath)}':force_style='FontName=Noto Sans CJK SC,FontSize=38,Outline=3,Shadow=1,Alignment=2,MarginV=120'`);
  if (filters.length) args.push("-vf", filters.join(","));
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

async function resolveFontPath() {
  const candidates = [process.env.WAYNE_FONT_PATH, "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"];
  for (const candidate of candidates.filter(Boolean)) {
    try { await fs.access(candidate); return candidate; } catch { /* Try the next known local font. */ }
  }
  throw new Error("缺少可用字体，无法渲染中文视觉元素");
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
  const overlayDir = join(workDir, "overlays");
  const version = artifactVersion(project.artifacts);
  const suffix = version === 1 ? "" : `-v${version}`;
  const commandLog = [];
  const fontPath = await resolveFontPath();
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(subtitleDir, { recursive: true });
  await fs.mkdir(overlayDir, { recursive: true });

  const keepSegments = project.plan.segments.filter((segment) => segment.action !== "remove");
  const clips = [];
  for (const [index, segment] of keepSegments.entries()) {
    const clip = join(workDir, `main-${index + 1}.mp4`);
    const captionEntries = (project.transcript?.segments || []).map((item) => ({ ...item, startMs: Math.max(item.startMs, segment.startMs), endMs: Math.min(item.endMs, segment.endMs) }))
      .filter((item) => item.endMs > item.startMs)
      .map((item) => ({ ...item, startMs: item.startMs - segment.startMs, endMs: item.endMs - segment.startMs }));
    const subtitlePath = join(subtitleDir, `main-${index + 1}.srt`);
    await fs.writeFile(subtitlePath, toSrt(captionEntries), "utf8");
    const events = mapVisualEventsToClip(visualEvents, segment.startMs, segment.endMs);
    events.forEach((event) => appliedIds.add(event.id));
    await renderClip({ input: project.media.path, output: clip, startMs: segment.startMs, endMs: segment.endMs, subtitlePath: captionEntries.length ? subtitlePath : undefined, events, assetDir: overlayDir, fontPath, commandLog });
    clips.push(clip);
  }
  if (!clips.length) throw new Error("剪辑计划没有可保留片段");
  if (appliedIds.size !== visualEvents.length) throw new Error("有视觉编辑指令落在已删除片段中，无法完整执行");

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
    events.forEach((event) => appliedIds.add(event.id));
    await renderClip({ input: project.media.path, output, startMs: short.startMs, endMs: short.endMs, vertical: true, subtitlePath: captionEntries.length ? subtitlePath : undefined, events, assetDir: overlayDir, fontPath, commandLog });
    shorts.push({ name: filename, slot: index + 1, title: short.title, startMs: short.startMs, endMs: short.endMs });
  }

  const subtitleName = versionedName("captions.srt", version);
  const cutListName = versionedName("cut-list.json", version);
  const qcName = versionedName("qc.json", version);
  const logName = versionedName("ffmpeg-command.log", version);
  await fs.writeFile(join(artifactsDir, subtitleName), toSrt(project.transcript?.segments || []), "utf8");
  await fs.writeFile(join(artifactsDir, cutListName), JSON.stringify(project.plan, null, 2));

  const mainProbe = await probeOutput(mainPath);
  const firstMainProbe = await probeOutput(clips[0]);
  const shortProbes = [];
  for (const short of shorts) shortProbes.push({ ...short, probe: await probeOutput(join(artifactsDir, short.name)) });
  const transcriptHasText = (project.transcript?.segments || []).some((segment) => segment.text?.trim());
  const qc = {
    passed: mainProbe.hasVideo && mainProbe.hasAudio && mainProbe.width === firstMainProbe.width && mainProbe.height === firstMainProbe.height && shortProbes.length === 5 && shortProbes.every((item) => item.probe.width === 1080 && item.probe.height === 1920) && appliedIds.size === visualEvents.length && (!transcriptHasText || !!subtitleName),
    checkedAt: new Date().toISOString(),
    version,
    main: mainProbe,
    expectedMain: { width: firstMainProbe.width, height: firstMainProbe.height },
    subtitlesBurnedIn: transcriptHasText,
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
      ...shortProbes.map((item) => ({ name: item.name, kind: "short", slot: item.slot, version, title: item.title, ...item.probe })),
    ],
    qc,
  };
}
