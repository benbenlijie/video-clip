import { createReadStream, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";

export const EDIT_REVIEW_DIMENSIONS = Object.freeze([
  { id: "rhythmAndShots", label: "节奏与镜头组织", weight: 20 },
  { id: "visualSupport", label: "视觉支撑与信息表达", weight: 20 },
  { id: "captionsAndGraphics", label: "字幕与图形包装", weight: 15 },
  { id: "audioEditing", label: "声音剪辑与混音", weight: 15 },
  { id: "continuityAndTechnical", label: "连续性与技术质量", weight: 15 },
  { id: "loadAndStyle", label: "观看负荷与风格一致性", weight: 15 },
]);

export const EDIT_REVIEW_DIMENSION_IDS = Object.freeze(EDIT_REVIEW_DIMENSIONS.map((item) => item.id));

const DIMENSION_BY_ID = new Map(EDIT_REVIEW_DIMENSIONS.map((item) => [item.id, item]));
const HARD_DEFECT_PENALTIES = Object.freeze({ critical: 15, major: 8, minor: 3 });
const DEFAULT_TIMEOUT_MS = Number(process.env.EDIT_REVIEW_TIMEOUT_MS || 300000);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 3) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function safeSlug(value) {
  return String(value || "video")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "video";
}

function toRelative(root, target) {
  return relative(root, target).replaceAll("\\", "/");
}

function errorText(result) {
  const text = String(result.stderr || "").trim();
  return text ? text.slice(-1200) : `exit ${result.code}`;
}

function requireSuccess(result, label) {
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}): ${errorText(result)}`);
}

function parseRate(value) {
  const [numerator, denominator] = String(value || "0/1").split("/").map(Number);
  return denominator ? numerator / denominator : Number(value) || 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function runProcess(command, args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdoutBytes = 64 * 1024 * 1024,
  maxStderrBytes = 4 * 1024 * 1024,
} = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutParts = [];
    const stderrParts = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const remaining = maxStdoutBytes - stdoutBytes;
      if (remaining > 0) {
        stdoutParts.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(remaining, chunk.length);
      }
      if (chunk.length > remaining) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk) => {
      const remaining = maxStderrBytes - stderrBytes;
      if (remaining > 0) {
        stderrParts.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(remaining, chunk.length);
      }
      if (chunk.length > remaining) stderrTruncated = true;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({
        code,
        timedOut,
        stdout: Buffer.concat(stdoutParts),
        stderr: Buffer.concat(stderrParts).toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export async function probeEditVideo(videoPath) {
  const result = await runProcess("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ], { timeoutMs: 30000, maxStdoutBytes: 4 * 1024 * 1024 });
  requireSuccess(result, "ffprobe");
  const data = JSON.parse(result.stdout.toString("utf8"));
  const video = (data.streams || []).find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("no-video-stream: file is not a decodable video");
  const audio = (data.streams || []).find((stream) => stream.codec_type === "audio") || null;
  const rotation = Number(
    video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation
      ?? video.tags?.rotate
      ?? 0,
  );
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const displayWidth = normalizedRotation % 180 === 0 ? width : height;
  const displayHeight = normalizedRotation % 180 === 0 ? height : width;
  const durationSeconds = Number(data.format?.duration || video.duration || 0);
  const videoDurationMs = Math.max(0, Math.round((Number(video.duration) || durationSeconds) * 1000));
  const audioDurationMs = audio ? Math.max(0, Math.round((Number(audio.duration) || durationSeconds) * 1000)) : null;
  const videoStart = numberOrNull(video.start_time);
  const audioStart = audio ? numberOrNull(audio.start_time) : null;
  const avStartDeltaMs = videoStart !== null && audioStart !== null ? Math.round(Math.abs(videoStart - audioStart) * 1000) : null;
  const avDurationDeltaMs = audioDurationMs !== null ? Math.abs(videoDurationMs - audioDurationMs) : null;

  return {
    filename: basename(videoPath),
    durationMs: Math.round(Number(data.format?.duration || videoDurationMs / 1000) * 1000),
    videoDurationMs,
    audioDurationMs,
    avStartDeltaMs,
    avDurationDeltaMs,
    width: displayWidth,
    height: displayHeight,
    encodedWidth: width,
    encodedHeight: height,
    rotation: normalizedRotation,
    aspectRatio: displayWidth && displayHeight ? (displayWidth < displayHeight ? "9:16" : displayWidth === displayHeight ? "1:1" : "16:9") : "unknown",
    fps: round(parseRate(video.avg_frame_rate || video.r_frame_rate), 3),
    frameCount: numberOrNull(video.nb_frames),
    videoCodec: video.codec_name || null,
    videoProfile: video.profile || null,
    pixelFormat: video.pix_fmt || null,
    videoBitRate: numberOrNull(video.bit_rate),
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
    audioChannels: audio?.channels ?? null,
    audioSampleRate: audio?.sample_rate ?? null,
    audioBitRate: numberOrNull(audio?.bit_rate),
    formatBitRate: numberOrNull(data.format?.bit_rate),
    sizeBytes: numberOrNull(data.format?.size),
  };
}

export async function detectEditShots(videoPath, {
  durationMs,
  sceneThreshold = 0.24,
} = {}) {
  const threshold = clamp(Number(sceneThreshold) || 0.24, 0.05, 0.9);
  const result = await runProcess("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", videoPath,
    "-vf", `select='gt(scene,${threshold})',metadata=print`,
    "-an",
    "-f", "null",
    "-",
  ]);
  requireSuccess(result, "scene detection");

  const lines = result.stderr.split(/\r?\n/);
  const cuts = [];
  let pending = null;
  for (const line of lines) {
    const frameMatch = line.match(/frame:\s*(\d+)\s+pts:\s*\S+\s+pts_time:\s*([0-9.]+)/);
    if (frameMatch) {
      pending = { frame: Number(frameMatch[1]), timeSeconds: Number(frameMatch[2]) };
      continue;
    }
    const scoreMatch = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (scoreMatch && pending) {
      const timeMs = Math.round(pending.timeSeconds * 1000);
      if (timeMs > 50 && timeMs < Number(durationMs) - 50) {
        const previous = cuts.at(-1);
        if (!previous || timeMs - previous.timeMs > 80) {
          cuts.push({ timeMs, sceneScore: round(Number(scoreMatch[1]), 4) });
        }
      }
      pending = null;
    }
  }

  const totalMs = Math.max(1, Number(durationMs) || 1);
  const boundaries = [
    { timeMs: 0, sceneScore: null },
    ...cuts,
    { timeMs: totalMs, sceneScore: null },
  ];
  const shots = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return {
      id: `shot-${index + 1}`,
      startMs: start.timeMs,
      endMs: end.timeMs,
      durationMs: Math.max(0, end.timeMs - start.timeMs),
      boundaryScore: end.sceneScore,
    };
  }).filter((shot) => shot.durationMs > 0);
  const durations = shots.map((shot) => shot.durationMs);
  const average = mean(durations);
  const cutCount = cuts.length;

  return {
    threshold,
    cutCount,
    cuts,
    shots,
    metrics: {
      cutsPerMinute: round(cutCount / (totalMs / 60000), 2),
      averageShotDurationMs: round(average, 1),
      shotDurationCv: round(average ? stddev(durations) / average : 0, 3),
      shortShotRatio: round(durations.length ? durations.filter((value) => value < 1000).length / durations.length : 0, 3),
      longShotRatio: round(durations.length ? durations.filter((value) => value > 5000).length / durations.length : 0, 3),
      shotCount: shots.length,
    },
  };
}

export async function analyzeEditMotion(videoPath, {
  durationMs,
  sampleFps = 3,
  frameWidth = 64,
  frameHeight = 36,
} = {}) {
  const fps = clamp(Number(sampleFps) || 3, 0.5, 10);
  const frameBytes = frameWidth * frameHeight;
  const expectedFrames = Math.ceil((Number(durationMs) / 1000 + 2) * fps);
  const maxStdoutBytes = Math.min(
    128 * 1024 * 1024,
    Math.max(8 * 1024 * 1024, expectedFrames * frameBytes * 2),
  );
  const result = await runProcess("ffmpeg", [
    "-hide_banner",
    "-v", "error",
    "-i", videoPath,
    "-vf", `fps=${fps},scale=${frameWidth}:${frameHeight}:flags=area,format=gray`,
    "-an",
    "-f", "rawvideo",
    "pipe:1",
  ], { maxStdoutBytes });
  requireSuccess(result, "motion analysis");
  if (result.stdoutTruncated) throw new Error("motion analysis frame buffer was truncated");

  const frameCount = Math.floor(result.stdout.length / frameBytes);
  const series = [];
  let previousOffset = 0;
  for (let index = 1; index < frameCount; index += 1) {
    const offset = index * frameBytes;
    let difference = 0;
    for (let pixel = 0; pixel < frameBytes; pixel += 1) {
      difference += Math.abs(result.stdout[offset + pixel] - result.stdout[previousOffset + pixel]);
    }
    series.push({
      timeMs: Math.round((index / fps) * 1000),
      value: round(difference / frameBytes / 255, 4),
    });
    previousOffset = offset;
  }

  const values = series.map((item) => item.value);
  const average = mean(values);
  const deviation = stddev(values);
  const spikeThreshold = Math.max(0.04, average + deviation * 2);
  const spikes = series
    .filter((item) => item.value >= spikeThreshold)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const maxSeriesPoints = 240;
  const seriesStep = Math.max(1, Math.ceil(series.length / maxSeriesPoints));
  const sampledSeries = series.filter((_, index) => index % seriesStep === 0);

  return {
    sampleFps: fps,
    frameWidth,
    frameHeight,
    frameCount,
    series: sampledSeries,
    spikes: spikes.map((item) => ({ timeMs: item.timeMs, value: item.value })),
    metrics: {
      meanMotion: round(average, 4),
      motionP95: round(percentile(values, 0.95), 4),
      motionMax: round(values.length ? Math.max(...values) : 0, 4),
      motionCv: round(average ? deviation / average : 0, 3),
      staticSampleRatio: round(values.length ? values.filter((value) => value < 0.003).length / values.length : 0, 3),
      motionBurstCount: spikes.length,
    },
  };
}

export async function analyzeEditAudio(videoPath, {
  probe,
  silenceDb = -35,
  silenceMinSeconds = 0.35,
} = {}) {
  if (!probe?.hasAudio) {
    return {
      available: false,
      silenceIntervals: [],
      pauseBoundariesMs: [],
      metrics: {
        integratedLufs: null,
        loudnessRangeLu: null,
        truePeakDbfs: null,
        silenceRatio: 0,
        pauseCount: 0,
        medianPauseMs: null,
        longestPauseMs: 0,
        clippingRisk: null,
      },
    };
  }
  const threshold = clamp(Number(silenceDb) || -35, -80, 0);
  const minimum = clamp(Number(silenceMinSeconds) || 0.35, 0.1, 5);
  const result = await runProcess("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", videoPath,
    "-af", `silencedetect=noise=${threshold}dB:d=${minimum},ebur128=peak=true`,
    "-vn",
    "-f", "null",
    "-",
  ]);
  requireSuccess(result, "audio analysis");
  const lines = result.stderr.split(/\r?\n/);
  const silenceIntervals = [];
  let silenceStartMs = null;
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*(-?[0-9.]+)/);
    if (startMatch) {
      silenceStartMs = Math.max(0, Math.round(Number(startMatch[1]) * 1000));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?[0-9.]+)\s*\|\s*silence_duration:\s*(-?[0-9.]+)/);
    if (endMatch) {
      const endMs = Math.max(0, Math.round(Number(endMatch[1]) * 1000));
      const start = silenceStartMs ?? Math.max(0, Math.round(endMs - Number(endMatch[2]) * 1000));
      if (endMs > start) silenceIntervals.push({ startMs: start, endMs, durationMs: endMs - start });
      silenceStartMs = null;
    }
  }
  if (silenceStartMs !== null) {
    const endMs = Math.max(silenceStartMs, Number(probe.durationMs) || silenceStartMs);
    if (endMs > silenceStartMs) silenceIntervals.push({ startMs: silenceStartMs, endMs, durationMs: endMs - silenceStartMs });
  }

  const integratedMatch = result.stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?[0-9.]+) LUFS/);
  const lraMatch = result.stderr.match(/Loudness range:\s*\n\s*LRA:\s*(-?[0-9.]+) LU/);
  const peakMatch = result.stderr.match(/True peak:\s*\n\s*Peak:\s*(-?[0-9.]+) dBFS/);
  const pauseDurations = silenceIntervals.map((item) => item.durationMs).sort((a, b) => a - b);
  const silenceDuration = silenceIntervals.reduce((sum, item) => sum + item.durationMs, 0);
  const truePeakDbfs = peakMatch ? round(Number(peakMatch[1]), 2) : null;

  return {
    available: true,
    silenceIntervals,
    pauseBoundariesMs: [...new Set(silenceIntervals.flatMap((item) => [item.startMs, item.endMs]))].sort((a, b) => a - b),
    metrics: {
      integratedLufs: integratedMatch ? round(Number(integratedMatch[1]), 2) : null,
      loudnessRangeLu: lraMatch ? round(Number(lraMatch[1]), 2) : null,
      truePeakDbfs,
      silenceRatio: round((Number(probe.durationMs) || 0) ? silenceDuration / Number(probe.durationMs) : 0, 3),
      pauseCount: silenceIntervals.length,
      medianPauseMs: pauseDurations.length ? round(percentile(pauseDurations, 0.5), 1) : null,
      longestPauseMs: pauseDurations.length ? pauseDurations.at(-1) : 0,
      clippingRisk: truePeakDbfs === null ? null : truePeakDbfs > -0.1,
    },
  };
}

export async function analyzeEditTechnical(videoPath, { durationMs } = {}) {
  const result = await runProcess("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", videoPath,
    "-vf", "blackdetect=d=0.1:pix_th=0.10,freezedetect=n=0.001:d=2",
    "-an",
    "-f", "null",
    "-",
  ]);
  requireSuccess(result, "technical analysis");
  const lines = result.stderr.split(/\r?\n/);
  const blackIntervals = [];
  const freezeIntervals = [];
  let freezeStartMs = null;
  for (const line of lines) {
    const blackMatch = line.match(/black_start:\s*(-?[0-9.]+)\s+black_end:\s*(-?[0-9.]+)\s+black_duration:\s*(-?[0-9.]+)/);
    if (blackMatch) {
      const startMs = Math.max(0, Math.round(Number(blackMatch[1]) * 1000));
      const endMs = Math.max(startMs, Math.round(Number(blackMatch[2]) * 1000));
      blackIntervals.push({ startMs, endMs, durationMs: endMs - startMs });
      continue;
    }
    const freezeStart = line.match(/freeze_start:\s*(-?[0-9.]+)/);
    if (freezeStart) {
      freezeStartMs = Math.max(0, Math.round(Number(freezeStart[1]) * 1000));
      continue;
    }
    const freezeEnd = line.match(/freeze_end:\s*(-?[0-9.]+)\s*\|\s*freeze_duration:\s*(-?[0-9.]+)/);
    if (freezeEnd) {
      const endMs = Math.max(0, Math.round(Number(freezeEnd[1]) * 1000));
      const start = freezeStartMs ?? Math.max(0, Math.round(endMs - Number(freezeEnd[2]) * 1000));
      if (endMs > start) freezeIntervals.push({ startMs: start, endMs, durationMs: endMs - start });
      freezeStartMs = null;
    }
  }
  if (freezeStartMs !== null) {
    const endMs = Math.max(freezeStartMs, Number(durationMs) || freezeStartMs);
    if (endMs > freezeStartMs) freezeIntervals.push({ startMs: freezeStartMs, endMs, durationMs: endMs - freezeStartMs });
  }
  const decodeErrorCount = lines.filter((line) => /Error while decoding|Invalid data found|corrupt/i.test(line)).length;

  return {
    blackIntervals,
    freezeIntervals,
    metrics: {
      blackIntervalCount: blackIntervals.length,
      blackDurationMs: blackIntervals.reduce((sum, item) => sum + item.durationMs, 0),
      freezeIntervalCount: freezeIntervals.length,
      freezeDurationMs: freezeIntervals.reduce((sum, item) => sum + item.durationMs, 0),
      decodeErrorCount,
    },
  };
}

function cutPauseAlignmentRatio(cuts, pauseBoundariesMs, windowMs = 250) {
  if (!cuts.length || !pauseBoundariesMs.length) return 0;
  const aligned = cuts.filter((cut) => pauseBoundariesMs.some((boundary) => Math.abs(boundary - cut.timeMs) <= windowMs)).length;
  return round(aligned / cuts.length, 3);
}

function buildReviewCandidates({ durationMs, shots, motion, audio, technical }) {
  const byTime = new Map();
  const add = (timeMs, reason) => {
    if (!Number.isFinite(timeMs) || timeMs < 0) return;
    const key = Math.round(timeMs / 100) * 100;
    const current = byTime.get(key) || { timeMs: key, reasons: [] };
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    byTime.set(key, current);
  };
  const total = Math.max(1, Number(durationMs) || 1);
  for (let index = 0; index < 5; index += 1) add((total * (index + 0.5)) / 5, "均匀覆盖");
  for (const cut of shots.cuts.slice(0, 8)) add(cut.timeMs, "切点");
  for (const spike of motion.spikes.slice(0, 4)) add(spike.timeMs, "运动峰值");
  for (const interval of technical.blackIntervals.slice(0, 3)) add((interval.startMs + interval.endMs) / 2, "黑帧");
  for (const interval of technical.freezeIntervals.slice(0, 3)) add((interval.startMs + interval.endMs) / 2, "静态段");
  for (const boundary of audio.pauseBoundariesMs.slice(0, 6)) add(boundary, "停顿边界");
  return [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs).slice(0, 18);
}

export async function analyzeVideoEdit(videoPath, {
  displayPath,
  sceneThreshold = 0.24,
  silenceDb = -35,
  silenceMinSeconds = 0.35,
  motionSampleFps = 3,
} = {}) {
  const [probe, hash] = await Promise.all([probeEditVideo(videoPath), sha256File(videoPath)]);
  const [shots, motion, audio, technical] = await Promise.all([
    detectEditShots(videoPath, { durationMs: probe.durationMs, sceneThreshold }),
    analyzeEditMotion(videoPath, { durationMs: probe.durationMs, sampleFps: motionSampleFps }),
    analyzeEditAudio(videoPath, { probe, silenceDb, silenceMinSeconds }),
    analyzeEditTechnical(videoPath, { durationMs: probe.durationMs }),
  ]);
  const durationMinutes = Math.max(0.001, probe.durationMs / 60000);
  const alignment = cutPauseAlignmentRatio(shots.cuts, audio.pauseBoundariesMs);
  const metrics = {
    durationMs: probe.durationMs,
    cutsPerMinute: shots.metrics.cutsPerMinute,
    averageShotDurationMs: shots.metrics.averageShotDurationMs,
    shotDurationCv: shots.metrics.shotDurationCv,
    shortShotRatio: shots.metrics.shortShotRatio,
    longShotRatio: shots.metrics.longShotRatio,
    cutPauseAlignmentRatio: alignment,
    visualEventsPerMinute: round((shots.cutCount + motion.metrics.motionBurstCount) / durationMinutes, 2),
    meanMotion: motion.metrics.meanMotion,
    motionP95: motion.metrics.motionP95,
    motionCv: motion.metrics.motionCv,
    staticSampleRatio: motion.metrics.staticSampleRatio,
    integratedLufs: audio.metrics.integratedLufs,
    loudnessRangeLu: audio.metrics.loudnessRangeLu,
    truePeakDbfs: audio.metrics.truePeakDbfs,
    silenceRatio: audio.metrics.silenceRatio,
    pauseCount: audio.metrics.pauseCount,
    longestPauseMs: audio.metrics.longestPauseMs,
    blackIntervalCount: technical.metrics.blackIntervalCount,
    freezeIntervalCount: technical.metrics.freezeIntervalCount,
    decodeErrorCount: technical.metrics.decodeErrorCount,
    avStartDeltaMs: probe.avStartDeltaMs,
    avDurationDeltaMs: probe.avDurationDeltaMs,
  };

  const limitations = [
    "切点由 FFmpeg scene score 估算，软转场和细微推镜可能漏检。",
    "B-roll、字幕、图形和构图必须看帧判断；数值不能替代视觉审片。",
    "静音与响度描述声音形式，不评价讲话内容或可听性。",
    "音视频起始/时长差是流级代理指标，不等同于逐帧口型同步。",
    "静态段检测可能把有意的静止画面识别为 freeze，需要人工复核。",
  ];

  return {
    contract: "talking-head-edit-analysis.v1",
    analysisId: hash.slice(0, 16),
    source: {
      path: displayPath || basename(videoPath),
      filename: basename(videoPath),
      sha256: hash,
    },
    probe,
    shots,
    motion,
    audio,
    technical,
    metrics,
    reviewCandidates: buildReviewCandidates({ durationMs: probe.durationMs, shots, motion, audio, technical }),
    limitations,
  };
}

const COMPARISON_METRICS = [
  "cutsPerMinute",
  "averageShotDurationMs",
  "shotDurationCv",
  "shortShotRatio",
  "longShotRatio",
  "cutPauseAlignmentRatio",
  "visualEventsPerMinute",
  "meanMotion",
  "motionP95",
  "staticSampleRatio",
  "integratedLufs",
  "loudnessRangeLu",
  "truePeakDbfs",
  "silenceRatio",
  "pauseCount",
  "longestPauseMs",
  "blackIntervalCount",
  "freezeIntervalCount",
  "decodeErrorCount",
  "avStartDeltaMs",
  "avDurationDeltaMs",
];

export async function compareVideoEdits(videoA, videoB, options = {}) {
  const labelA = String(options.labelA || "A").slice(0, 40);
  const labelB = String(options.labelB || "B").slice(0, 40);
  if (labelA === labelB) throw new Error("video labels must be different");
  const [analysisA, analysisB] = await Promise.all([
    analyzeVideoEdit(videoA, { ...options, displayPath: options.displayPathA || options.videoA }),
    analyzeVideoEdit(videoB, { ...options, displayPath: options.displayPathB || options.videoB }),
  ]);
  const metricDeltas = {};
  for (const key of COMPARISON_METRICS) {
    const a = analysisA.metrics[key] ?? null;
    const b = analysisB.metrics[key] ?? null;
    metricDeltas[key] = {
      a,
      b,
      bMinusA: a === null || b === null ? null : round(b - a, 3),
    };
  }
  const hash = createHash("sha256")
    .update(`${analysisA.analysisId}:${analysisB.analysisId}`)
    .digest("hex")
    .slice(0, 16);
  return {
    contract: "talking-head-edit-comparison.v1",
    comparisonId: hash,
    createdAt: new Date().toISOString(),
    videos: [
      { label: labelA, analysis: analysisA },
      { label: labelB, analysis: analysisB },
    ],
    metricDeltas,
    limitations: [...new Set([...analysisA.limitations, ...analysisB.limitations])],
  };
}

export async function createContactSheet(videoPath, {
  count = 9,
  outPath,
} = {}) {
  const probe = await probeEditVideo(videoPath);
  const samples = clamp(Math.round(Number(count) || 9), 4, 12);
  const columns = Math.max(1, Math.ceil(Math.sqrt(samples)));
  const rows = Math.ceil(samples / columns);
  const durationSeconds = Math.max(0.1, probe.durationMs / 1000);
  const fps = samples / durationSeconds;
  await fs.mkdir(dirname(outPath), { recursive: true });
  const result = await runProcess("ffmpeg", [
    "-y",
    "-hide_banner",
    "-v", "error",
    "-i", videoPath,
    "-vf", `fps=${fps},scale=240:-2:flags=lanczos,tile=${columns}x${rows}:padding=4:margin=4`,
    "-frames:v", "1",
    "-q:v", "3",
    outPath,
  ], { timeoutMs: 60000 });
  requireSuccess(result, "contact sheet");
  return {
    path: outPath,
    count: samples,
    columns,
    rows,
    approximateTimesMs: Array.from({ length: samples }, (_, index) => Math.round(((index + 0.5) / samples) * probe.durationMs)),
  };
}

export async function renderFrame(videoPath, timeSeconds, outPath) {
  const time = Math.max(0, Number(timeSeconds) || 0);
  await fs.mkdir(dirname(outPath), { recursive: true });
  const result = await runProcess("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(time),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=960:960:force_original_aspect_ratio=decrease",
    "-q:v", "3",
    outPath,
  ], { timeoutMs: 30000 });
  requireSuccess(result, "frame extraction");
  return outPath;
}

export async function persistAnalysis(root, analysis) {
  const directory = join(root, ".edit-review", "analyses");
  await fs.mkdir(directory, { recursive: true });
  const name = `${safeSlug(basename(analysis.source.path))}-${analysis.analysisId.slice(0, 8)}.json`;
  const target = join(directory, name);
  await fs.writeFile(target, `${JSON.stringify(analysis, null, 2)}\n`);
  return toRelative(root, target);
}

export async function persistComparison(root, comparison) {
  const directory = join(root, ".edit-review", "comparisons");
  await fs.mkdir(directory, { recursive: true });
  const target = join(directory, `comparison-${comparison.comparisonId}.json`);
  await fs.writeFile(target, `${JSON.stringify(comparison, null, 2)}\n`);
  return toRelative(root, target);
}

function validateReview(review) {
  if (review?.contract !== "talking-head-edit-review.v1") throw new Error("review.contract must be talking-head-edit-review.v1");
  if (!["single", "pairwise"].includes(review.mode)) throw new Error("review.mode must be single or pairwise");
  if (!String(review.summary || "").trim()) throw new Error("review.summary is required");
  if (!Number.isFinite(Number(review.confidence)) || Number(review.confidence) < 0 || Number(review.confidence) > 1) {
    throw new Error("review.confidence must be between 0 and 1");
  }
  const expectedVideos = review.mode === "pairwise" ? 2 : 1;
  if (!Array.isArray(review.videos) || review.videos.length !== expectedVideos) {
    throw new Error(`review.videos must contain exactly ${expectedVideos} video review(s)`);
  }
  const labels = review.videos.map((video) => String(video.label || "").trim());
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) throw new Error("video labels must be non-empty and unique");
  if (review.mode === "pairwise" && !["tie", ...labels].includes(review.winner)) {
    throw new Error(`review.winner must be tie, ${labels.join(", ")}`);
  }
  for (const video of review.videos) {
    if (!String(video.path || "").trim()) throw new Error("each video review needs path");
    const dimensions = Array.isArray(video.dimensions) ? video.dimensions : [];
    const ids = dimensions.map((dimension) => dimension.id);
    if (ids.length !== EDIT_REVIEW_DIMENSION_IDS.length || new Set(ids).size !== EDIT_REVIEW_DIMENSION_IDS.length) {
      throw new Error(`each video must contain exactly ${EDIT_REVIEW_DIMENSION_IDS.length} unique dimensions`);
    }
    for (const dimension of dimensions) {
      if (!DIMENSION_BY_ID.has(dimension.id)) throw new Error(`unknown dimension: ${dimension.id}`);
      if (!Number.isFinite(Number(dimension.score)) || Number(dimension.score) < 0 || Number(dimension.score) > 4) {
        throw new Error(`dimension ${dimension.id} score must be between 0 and 4`);
      }
      if (!Array.isArray(dimension.evidence) || !dimension.evidence.length) {
        throw new Error(`dimension ${dimension.id} needs at least one evidence item`);
      }
      for (const evidence of dimension.evidence) {
        if (!labels.includes(evidence.video)) throw new Error(`evidence video must be one of: ${labels.join(", ")}`);
        if (!String(evidence.note || "").trim()) throw new Error("evidence.note is required");
      }
    }
    for (const defect of video.hardDefects || []) {
      if (!labels.includes(defect.video)) throw new Error(`hard defect video must be one of: ${labels.join(", ")}`);
      if (!Object.hasOwn(HARD_DEFECT_PENALTIES, defect.severity)) throw new Error(`unknown hard defect severity: ${defect.severity}`);
      if (!String(defect.code || "").trim() || !String(defect.note || "").trim()) {
        throw new Error("hard defects need code and note");
      }
    }
  }
}

function computeVideoScore(video) {
  const dimensions = new Map(video.dimensions.map((dimension) => [dimension.id, dimension]));
  const weighted0to4 = EDIT_REVIEW_DIMENSIONS.reduce((sum, definition) => {
    const score = Number(dimensions.get(definition.id).score);
    return sum + (score * definition.weight) / 100;
  }, 0);
  const penalty = Math.min(30, (video.hardDefects || []).reduce((sum, defect) => sum + HARD_DEFECT_PENALTIES[defect.severity], 0));
  return {
    weightedScore0to4: round(weighted0to4, 3),
    weightedScore100: round((weighted0to4 / 4) * 100, 2),
    hardDefectPenalty: penalty,
    finalScore100: round(Math.max(0, (weighted0to4 / 4) * 100 - penalty), 2),
  };
}

function markdownEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function buildMarkdown(review, computed) {
  const labels = review.videos.map((video) => video.label);
  const lines = [
    "# 口播视频剪辑评价",
    "",
    `- 模式：${review.mode === "pairwise" ? "双视频对比" : "单视频评价"}`,
    `- 结论置信度：${round(Number(review.confidence), 2)}`,
    `- 评价维度：节奏、视觉支撑、字幕包装、声音、连续性、观看负荷`,
    "",
    "## 结论",
    "",
    review.summary,
    "",
  ];
  if (review.mode === "pairwise") {
    lines.push(`**偏好结论：${review.winner === "tie" ? "平局" : review.winner}**`, "");
  }
  lines.push("## 维度评分", "", `| 维度 | 权重 | ${labels.join(" | ")} |`, `|---|---:${"|---:|".repeat(labels.length)}`);
  for (const definition of EDIT_REVIEW_DIMENSIONS) {
    const scores = review.videos.map((video) => {
      const dimension = video.dimensions.find((item) => item.id === definition.id);
      return Number(dimension.score).toFixed(1);
    });
    lines.push(`| ${definition.label} | ${definition.weight}% | ${scores.join(" | ")} |`);
  }
  for (const video of review.videos) {
    const result = computed.scores.find((item) => item.label === video.label);
    lines.push(
      "",
      `### ${video.label}`,
      "",
      `- 加权分：${result.weightedScore100}/100`,
      `- 硬伤扣分：${result.hardDefectPenalty}`,
      `- 最终分：${result.finalScore100}/100`,
      `- 文件：\`${video.path}\``,
    );
    if (video.analysisPath) lines.push(`- 自动分析：\`${video.analysisPath}\``);
    if (video.strengths?.length) lines.push(`- 优势：${video.strengths.join("；")}`);
    if (video.weaknesses?.length) lines.push(`- 问题：${video.weaknesses.join("；")}`);
    for (const definition of EDIT_REVIEW_DIMENSIONS) {
      const dimension = video.dimensions.find((item) => item.id === definition.id);
      lines.push("", `#### ${definition.label}（${Number(dimension.score).toFixed(1)}/4）`, "", dimension.note || "");
      for (const evidence of dimension.evidence) {
        const time = evidence.timeSeconds === undefined ? "" : `[${Number(evidence.timeSeconds).toFixed(1)}s] `;
        lines.push(`- ${time}${evidence.note}`);
      }
    }
    if (video.hardDefects?.length) {
      lines.push("", "#### 硬伤", "");
      for (const defect of video.hardDefects) {
        const time = defect.timeSeconds === undefined ? "" : ` @ ${Number(defect.timeSeconds).toFixed(1)}s`;
        lines.push(`- [${defect.severity}] ${defect.code}${time}：${defect.note}`);
      }
    }
  }
  lines.push("", "## 限制与不确定性", "");
  for (const limitation of review.limitations?.length ? review.limitations : ["未声明额外限制。"]) {
    lines.push(`- ${markdownEscape(limitation)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function writeReviewReport(root, review) {
  validateReview(review);
  const computed = {
    scores: review.videos.map((video) => ({ label: video.label, ...computeVideoScore(video) })),
    evaluatedAt: new Date().toISOString(),
  };
  const output = { ...review, computed };
  const directory = join(root, ".edit-review", "reports");
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `review-${stamp}-${randomUUID().slice(0, 8)}`;
  const jsonPath = join(directory, `${base}.json`);
  const markdownPath = join(directory, `${base}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  await fs.writeFile(markdownPath, buildMarkdown(review, computed));
  return {
    jsonPath: toRelative(root, jsonPath),
    markdownPath: toRelative(root, markdownPath),
    computed,
  };
}
