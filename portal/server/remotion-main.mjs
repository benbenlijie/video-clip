import { promises as fs, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePath } from "./workspace-path.mjs";
import { compositeRemotionPreview, renderRemotionOverlay } from "./remotion-overlay.mjs";
import { detectBlackFrames, probeOutput } from "./render.mjs";
import { parseWhisperSrt } from "./local-whisper.mjs";
import { subtitlesMatchTranscript, transcriptFingerprint } from "./transcript-proofreading.mjs";
import { normalizeCaptionStyle } from "./edit-plan.mjs";

const SUPPORTED_EVENTS = new Set(["title_card", "emphasis", "cta"]);
export const REMOTION_MAIN_MODE = "remotion-main.v1";
const runtimeRoot = fileURLToPath(new URL("../remotion-runtime/", import.meta.url));

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function valueHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function mergedIntervals(intervals) {
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] < last[1] - 0.01) throw new Error("剪辑映射或计划区间重叠");
    if (last && Math.abs(interval[0] - last[1]) < 0.01) last[1] = interval[1];
    else merged.push([...interval]);
  }
  return merged;
}

export function validateEditMap({ map, plan, sourceDurationMs, durationMs, fps }) {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120 || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error("剪辑映射时长或帧率无效");
  if (!Array.isArray(map?.pieces) || !map.pieces.length || map.pieces.length > 10000) throw new Error("缺少实际剪辑映射 pieces");
  const frameMs = 1000 / fps;
  let cursorMs = 0;
  let previousSourceEnd = 0;
  const pieces = map.pieces.map((piece) => {
    if (!Array.isArray(piece?.src) || piece.src.length !== 2 || !Array.isArray(piece.out) || piece.out.length !== 2) throw new Error("剪辑映射区间无效");
    const [startMs, endMs, outputStartMs, outputEndMs] = [...piece.src, ...piece.out];
    if (![startMs, endMs, outputStartMs, outputEndMs].every(Number.isFinite)
      || startMs < previousSourceEnd - 0.01 || startMs < 0 || endMs <= startMs || endMs > sourceDurationMs + frameMs
      || Math.abs(outputStartMs - cursorMs) > 0.01 || outputEndMs <= outputStartMs
      || Math.abs((endMs - startMs) - (outputEndMs - outputStartMs)) > 0.01
      || [startMs, endMs, outputStartMs, outputEndMs].some((value) => Math.abs(value / frameMs - Math.round(value / frameMs)) > 0.001)) throw new Error("实际剪辑映射须按帧对齐、顺序且连续，不能重叠或变速");
    cursorMs = outputEndMs;
    previousSourceEnd = endMs;
    return { src: [startMs, endMs], out: [outputStartMs, outputEndMs] };
  });
  if (Math.abs(cursorMs - durationMs) > frameMs + 0.01) throw new Error("剪辑映射与基础视频时长不一致");
  const expected = (plan?.segments || []).filter((cut) => cut.action !== "remove").map((cut) => {
    if (!Number.isFinite(cut.startMs) || !Number.isFinite(cut.endMs) || cut.startMs < 0 || cut.endMs <= cut.startMs || cut.endMs > sourceDurationMs) throw new Error("剪辑计划时间无效");
    return [Math.round(cut.startMs / frameMs) * frameMs, Math.round(cut.endMs / frameMs) * frameMs];
  }).filter(([start, end]) => end > start);
  const planned = mergedIntervals(expected);
  const actual = mergedIntervals(pieces.map((piece) => piece.src));
  if (!planned.length || planned.length !== actual.length || planned.some((range, index) => range.some((value, edge) => Math.abs(value - actual[index][edge]) > 0.01))) throw new Error("实际剪辑映射与已确认的保留计划不一致");
  return pieces;
}

export function mapRemotionEvents(events, pieces) {
  return (events || []).flatMap((event) => {
    if (!SUPPORTED_EVENTS.has(event.type)) throw new Error(`不支持的 Remotion 事件类型: ${event.type}`);
    if (!event.id || !Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.startMs < 0 || event.endMs <= event.startMs || typeof event.text !== "string" || !event.text.trim()) throw new Error("Remotion 动效文字或时间无效");
    return pieces.flatMap((piece, index) => {
      const start = Math.max(event.startMs, piece.src[0]);
      const end = Math.min(event.endMs, piece.src[1]);
      if (end <= start) return [];
      return [{ ...event, id: `${event.id}-part-${index + 1}`, sourceEventId: event.id, startMs: start - piece.src[0] + piece.out[0], endMs: end - piece.src[0] + piece.out[0] }];
    });
  });
}

export async function composeRemotionMain({ root, baseVideo, phase }) {
  if (!["plan", "chat-edit", "render"].includes(phase)) throw new Error("主视频合成阶段无效");
  const readJson = async (name) => JSON.parse(await fs.readFile(await workspacePath(root, name), "utf8"));
  const [brief, plan, map] = await Promise.all([readJson("brief.json"), readJson("edit-plan.json"), readJson("timeline.json")]);
  const captionStyle = normalizeCaptionStyle(plan.captionStyle);
  if (brief.compositionMode !== REMOTION_MAIN_MODE || brief.phase !== phase) throw new Error("当前工程或阶段未启用 Remotion 主合成");
  const basePath = await workspacePath(root, baseVideo);
  const probe = await probeOutput(basePath);
  if (phase === "render" && (probe.width !== Number(brief.media.width) || probe.height !== Number(brief.media.height))) throw new Error("正式成片基础视频必须使用目标原片尺寸，不能复用低清草剪");
  const pieces = validateEditMap({ map, plan, sourceDurationMs: Number(brief.media?.durationMs), durationMs: probe.videoDurationMs, fps: probe.fps });
  const events = mapRemotionEvents(plan.visualEvents, pieces).map((event) => ({ ...event, endMs: Math.min(event.endMs, probe.videoDurationMs) }));
  if (!events.length) throw new Error("当前保留片段没有 Remotion 动效，请先明确主视频视觉设计");
  const transcript = await readJson("transcript.json");
  const captions = await fs.readFile(await workspacePath(root, "captions.srt"), "utf8");
  if (!subtitlesMatchTranscript(captions, transcript, plan, events.map((event) => `${event.text} ${event.subtext || ""}`), pieces, events)) throw new Error("字幕与保留口播或剪辑后时码不一致，请先修正 captions.srt");
  const sourceFiles = { source: "input.mp4", plan: "edit-plan.json", transcript: "transcript.json", map: "timeline.json", subtitle: "captions.srt", base: baseVideo };
  const hashes = {};
  for (const [key, name] of Object.entries(sourceFiles)) hashes[key] = await fileHash(await workspacePath(root, name));
  const prefix = `remotion-main-${randomUUID()}`;
  const outputDir = await workspacePath(root, prefix, { existing: false });
  await fs.mkdir(outputDir);
  try {
    const sources = [];
    for (const name of ["src/Overlay.jsx", "src/Root.jsx", "src/index.jsx", "src/render.mjs", "package.json"]) {
      const target = join(outputDir, name);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(join(runtimeRoot, name), target, fs.constants.COPYFILE_EXCL);
      sources.push({ path: relative(root, target), sha256: await fileHash(target) });
    }
    const paths = { outputPath: `${prefix}/main.mp4`, overlayPath: `${prefix}/overlay.mov`, inputPath: `${prefix}/render-input.json`, receiptPath: `${prefix}/composition.json` };
    const timeline = { contract: "timeline.v1", media: { width: probe.width, height: probe.height, fps: probe.fps, durationMs: probe.videoDurationMs }, visualEvents: events };
    await fs.writeFile(join(root, paths.inputPath), JSON.stringify({ ...timeline.media, events, pieces, captionStyle }, null, 2), { flag: "wx" });
    hashes.input = await fileHash(join(root, paths.inputPath));
    const overlay = await renderRemotionOverlay({ timeline, outputPath: join(root, paths.overlayPath), workDir: outputDir });
    const output = await compositeRemotionPreview({ inputPath: basePath, overlayPath: join(root, paths.overlayPath), outputPath: join(root, paths.outputPath), subtitlePath: await workspacePath(root, "captions.srt"), captionStyle, durationMs: probe.videoDurationMs, phase });
    const finalProbe = await probeOutput(output.outputPath);
    const black = await detectBlackFrames(output.outputPath);
    if (Math.abs(finalProbe.videoDurationMs - probe.videoDurationMs) > 1000 / probe.fps + 1 || finalProbe.width !== probe.width || finalProbe.height !== probe.height || finalProbe.avSyncDeltaMs === null || finalProbe.avDurationDeltaMs === null || finalProbe.avSyncDeltaMs > 250 || finalProbe.avDurationDeltaMs > 250 || black.length) throw new Error("Remotion 主视频未通过画幅、时长、音画同步或黑帧检查");
    for (const [key, name] of Object.entries(sourceFiles)) if (await fileHash(await workspacePath(root, name)) !== hashes[key]) throw new Error("合成期间输入发生变化，请重试");
    // Cross-phase identity follows editorial meaning; current-run byte hashes
    // still bind every file above, including formatting and provider metadata.
    const designSha256 = valueHash({
      source: hashes.source,
      fps: probe.fps,
      pieces,
      transcript: transcriptFingerprint(await readJson("transcript.json")),
      subtitles: parseWhisperSrt(await fs.readFile(await workspacePath(root, "captions.srt"), "utf8")).map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
      events: events.map(({ id, sourceEventId, type, startMs, endMs, text, subtext }) => ({ id, sourceEventId, type, startMs, endMs, text, subtext: subtext || "" })),
      broll: (plan.brollEvents || []).map(({ id, assetId, startMs, endMs, sourceStartMs }) => ({ id, assetId, startMs, endMs, sourceStartMs })),
      captionCoverage: (plan.captionCoverage || []).map(({ eventId, startMs, endMs, text }) => ({ eventId, startMs, endMs, text })),
      captionStyle,
      sources: sources.map((source) => source.sha256),
    });
    const result = { compositionMode: REMOTION_MAIN_MODE, phase, ...paths, sourceFiles, sources, events, pieces, captionStyle, width: probe.width, height: probe.height, fps: probe.fps, durationMs: finalProbe.durationMs, videoDurationMs: finalProbe.videoDurationMs, remotionVersion: overlay.remotionVersion, designSha256, sha256: { ...hashes, output: output.sha256, overlay: overlay.sha256 }, qc: { passed: true, alpha: overlay.alpha, audioVideoSyncDeltaMs: finalProbe.avSyncDeltaMs, audioVideoDurationDeltaMs: finalProbe.avDurationDeltaMs, blackFrameCount: 0 } };
    await fs.writeFile(join(root, paths.receiptPath), JSON.stringify(result, null, 2), { flag: "wx" });
    return { ...result, receiptSha256: await fileHash(join(root, paths.receiptPath)) };
  } catch (error) {
    await fs.rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function validateRemotionComposition({ dir, phase, manifest, audit, approvedDesignSha256 = null }) {
  const record = [...audit].reverse().find((item) => item.tool === "compose_remotion_video" && !item.error && item.phase === phase && item.outputPath === manifest.main);
  if (manifest.compositionMode !== REMOTION_MAIN_MODE || !record || record.compositionMode !== REMOTION_MAIN_MODE || !record.qc?.passed) throw new Error("缺少绑定当前主视频的 Remotion 主合成记录");
  if (manifest.subtitle !== record.sourceFiles.subtitle) throw new Error("主视频字幕清单与实际烧入的字幕不一致");
  if (phase === "render" && (!approvedDesignSha256 || approvedDesignSha256 !== record.designSha256)) throw new Error("正式导出的动效设计与已审核预览不一致");
  const check = async (name, expected) => {
    if (typeof expected !== "string" || await fileHash(await workspacePath(dir, name)) !== expected) throw new Error(`主合成证据过期或哈希不一致: ${name}`);
  };
  for (const [key, name] of Object.entries(record.sourceFiles)) await check(name, record.sha256[key]);
  await check(record.outputPath, record.sha256.output);
  await check(record.overlayPath, record.sha256.overlay);
  await check(record.inputPath, record.sha256.input);
  await check(record.receiptPath, record.receiptSha256);
  for (const source of record.sources) await check(source.path, source.sha256);
  const files = [{ path: record.overlayPath, kind: "render-layer", engine: "remotion" }, { path: record.inputPath, kind: "render-input", engine: "remotion" }, { path: record.receiptPath, kind: "composition-record", engine: "remotion" }, ...record.sources.map((source) => ({ path: source.path, kind: "source", engine: "remotion" }))];
  return { files, record };
}
