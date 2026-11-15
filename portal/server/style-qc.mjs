import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const faceDetectorScript = fileURLToPath(new URL("./style-face-detect.py", import.meta.url));

const SFX_RANK = { none: 0, low: 1, medium: 2, high: 3 };

export const STYLE_QC_THRESHOLDS = {
  cutDensityDelta: 12,
  avgShotLengthDeltaMs: 2500,
  hookLengthDeltaMs: 3000,
  punchInRatioDelta: 0.35,
  brollRatioDelta: 0.35,
  captionWordsPerCueDelta: 3,
  captionPositionDelta: 1,
  captionFontRatioDelta: 0.025,
  visualEventRateDelta: 18,
  bpmDelta: 20,
  sfxDensityDelta: 2,
};

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function durationOf(plan, media) {
  const explicit = finite(plan?.durationMs, 0);
  if (explicit > 0) return explicit;
  const kept = (plan?.segments || []).filter((segment) => segment.action !== "remove");
  const duration = kept.reduce((sum, segment) => sum + Math.max(0, finite(segment.endMs) - finite(segment.startMs)), 0);
  return duration > 0 ? duration : finite(media?.durationMs, 0);
}

function shotsOf(plan) {
  if (Array.isArray(plan?.clips) && plan.clips.length) {
    return plan.clips.filter((clip) => clip.track !== "video-overlay").map((clip) => ({
      startMs: finite(clip.timelineStartMs),
      endMs: finite(clip.timelineEndMs),
      layout: clip.layout?.type || clip.shotRole || "full",
      broll: clip.layout?.type === "broll_cover" || clip.track === "video-overlay",
    })).filter((shot) => shot.endMs > shot.startMs);
  }
  return (plan?.segments || [])
    .filter((segment) => segment.action !== "remove")
    .map((segment) => ({ startMs: finite(segment.startMs), endMs: finite(segment.endMs), layout: "full", broll: false }))
    .filter((shot) => shot.endMs > shot.startMs);
}

function intervalsDuration(intervals, fallbackDuration = 0) {
  if (!Array.isArray(intervals) || !intervals.length) return Math.max(0, finite(fallbackDuration));
  return intervals.reduce((sum, interval) => sum + Math.max(0, finite(interval.endMs) - finite(interval.startMs)), 0);
}

function tokenCount(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  return /\s/.test(value) ? value.split(/\s+/).filter(Boolean).length : Array.from(value.replace(/\s+/g, "")).length;
}

function captionPosition(style = null) {
  if (style?.position && ["bottom", "middle", "top"].includes(style.position)) return style.position;
  if (!style) return "unknown";
  const margin = finite(style.marginV, -1);
  if (margin < 0) return "unknown";
  if (margin >= 120) return "top";
  if (margin >= 60) return "middle";
  return "bottom";
}

export function deriveUserStyleFacts({ plan = null, transcript = null, media = null, assets = [] } = {}) {
  const durationMs = Math.max(1, durationOf(plan, media));
  const shots = shotsOf(plan);
  const shotDurations = shots.map((shot) => shot.endMs - shot.startMs);
  const punchInMs = Array.isArray(plan?.layoutEvents) && plan.layoutEvents.length
    ? intervalsDuration(plan.layoutEvents.filter((event) => event.type === "punch_in"))
    : shots.filter((shot) => shot.layout === "punch_in").reduce((sum, shot) => sum + shot.endMs - shot.startMs, 0);
  const multiBroll = Array.isArray(plan?.clips)
    ? plan.clips.filter((clip) => clip.layout?.type === "broll_cover" || clip.track === "video-overlay")
    : [];
  const brollMs = Array.isArray(plan?.brollEvents) && plan.brollEvents.length
    ? intervalsDuration(plan.brollEvents)
    : multiBroll.length
      ? multiBroll.reduce((sum, clip) => sum + Math.max(0, finite(clip.timelineEndMs) - finite(clip.timelineStartMs)), 0)
      : shots.filter((shot) => shot.broll || shot.layout === "broll_cover").reduce((sum, shot) => sum + shot.endMs - shot.startMs, 0);
  const assetSegments = assets.flatMap((asset) => asset?.transcript?.segments || []);
  const captionSegments = transcript?.segments?.length ? transcript.segments : assetSegments;
  const maxWordsPerCue = Math.max(0, ...captionSegments.map((segment) => tokenCount(segment.text)));
  const fontSize = finite(plan?.captionStyle?.fontSize, 0);
  const height = Math.max(1, finite(media?.height, 1920));
  return {
    durationMs,
    shotCount: shots.length,
    hookMs: shotDurations[0] || 0,
    avgShotMs: round(shotDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, shots.length)),
    cutsPerMinute: round(Math.max(0, shots.length - 1) / durationMs * 60000),
    punchInRatio: round(Math.min(1, punchInMs / durationMs)),
    brollRatio: round(Math.min(1, brollMs / durationMs)),
    maxWordsPerCue,
    captionPosition: captionPosition(plan?.captionStyle),
    captionFontRatio: fontSize > 0 ? round(fontSize / height) : null,
    visualEventRate: round((plan?.visualEvents || []).length / durationMs * 60000),
    bpm: plan?.audio?.bpm == null ? null : finite(plan.audio.bpm),
    sfxDensity: plan?.audio?.sfxDensity || "unknown",
  };
}

function metricDelta(user, reference) {
  if (user == null || reference == null || !Number.isFinite(Number(user)) || !Number.isFinite(Number(reference))) return null;
  return round(Number(user) - Number(reference));
}

function positionDelta(user, reference) {
  if (!["top", "middle", "bottom"].includes(user) || !["top", "middle", "bottom"].includes(reference)) return null;
  return user === reference ? 0 : 1;
}

function sfxDensityDelta(user, reference) {
  if (!(user in SFX_RANK) || !(reference in SFX_RANK)) return null;
  return SFX_RANK[user] - SFX_RANK[reference];
}

export function computeStyleMetrics({ referenceAnalysis, userFacts, copy = {} } = {}) {
  const reference = referenceAnalysis || {};
  const user = userFacts || {};
  const rhythm = copy.copyRhythm === false ? {} : reference.rhythm || {};
  const captions = copy.copyCaptions === false ? {} : reference.captions || {};
  const layout = copy.copyLayout === false ? {} : reference.rhythm || {};
  const audio = copy.copyAudio === false ? {} : reference.audio || {};
  const referenceDurationMs = Math.max(1, finite(reference.source?.durationMs, 0));
  const userDurationMs = Math.max(1, finite(user.durationMs, 0));
  const shortPreview = userDurationMs * 2 < referenceDurationMs;
  return {
    cutDensityDelta: metricDelta(user.cutsPerMinute, rhythm.cutsPerMinute),
    avgShotLengthDelta: shortPreview ? null : metricDelta(user.avgShotMs, rhythm.avgShotMs),
    hookLengthDelta: shortPreview ? null : metricDelta(user.hookMs, rhythm.hookMs),
    punchInRatioDelta: metricDelta(user.punchInRatio, layout.punchInRatio),
    brollRatioDelta: copy.copyBroll === false ? null : metricDelta(user.brollRatio, rhythm.brollRatio),
    captionWordsPerCueDelta: metricDelta(user.maxWordsPerCue, captions.maxWordsPerCue),
    captionPositionDelta: positionDelta(user.captionPosition, captions.position),
    captionFontRatioDelta: metricDelta(user.captionFontRatio, captions.fontSizeRatio),
    visualEventRateDelta: copy.copyLayout === false || shortPreview
      ? null
      : metricDelta(user.visualEventRate, (reference.overlays || []).length / Math.max(1, reference.source?.durationMs || 1) * 60000),
    bpmDelta: metricDelta(user.bpm, audio.bpm),
    sfxDensityDelta: sfxDensityDelta(user.sfxDensity, audio.sfxDensity),
  };
}

function captionBox({ probe, captionStyle = {} }) {
  const width = Math.max(1, finite(probe?.width, 1080));
  const height = Math.max(1, finite(probe?.height, 1920));
  const fontSize = Math.max(8, finite(captionStyle.fontSize, Math.round(width * 0.05)));
  const outline = Math.max(0, finite(captionStyle.outline, 1));
  const textHeight = fontSize * 1.35 + outline * 2;
  const position = captionPosition(captionStyle);
  const marginV = Math.max(0, finite(captionStyle.marginV, 24));
  const x = width * 0.08;
  const boxWidth = width * 0.84;
  const y = position === "top"
    ? marginV
    : position === "middle"
      ? Math.max(0, (height - textHeight) / 2)
      : Math.max(0, height - marginV - textHeight);
  return { x: x / width, y: y / height, width: boxWidth / width, height: textHeight / height, position };
}

function overlap(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function plausibleFaceBox(box) {
  const width = Number(box?.width);
  const height = Number(box?.height);
  const area = width * height;
  const aspect = width / Math.max(0.0001, height);
  // Haar cascades occasionally classify a chest/hand region as a very large face.
  return area >= 0.004 && area <= 0.12 && width <= 0.55 && height <= 0.28 && aspect >= 0.6 && aspect <= 1.8;
}

export function findCaptionFaceOverlaps({ probe, captions = [], captionStyle = {}, faceFrames = [] } = {}) {
  const box = captionBox({ probe, captionStyle });
  const results = [];
  for (const frame of faceFrames || []) {
    const timeMs = finite(frame?.timeMs);
    const active = (captions || []).filter((caption) => timeMs >= finite(caption.startMs) && timeMs <= finite(caption.endMs));
    if (!active.length) continue;
    for (const [faceIndex, face] of (frame.boxes || []).entries()) {
      if (!face || [face.x, face.y, face.width, face.height].some((value) => !Number.isFinite(Number(value)))) continue;
      const normalized = { x: Number(face.x), y: Number(face.y), width: Number(face.width), height: Number(face.height) };
      if (!plausibleFaceBox(normalized)) continue;
      const area = overlap(box, normalized);
      if (area > 0.0001) results.push({ timeMs, caption: active.map((item) => item.text || "").join(" "), faceIndex, area: round(area, 5), captionBox: box, faceBox: normalized });
    }
  }
  return results;
}

function metricIssues(metrics, thresholds) {
  const keys = {
    cutDensityDelta: "cutDensityDelta",
    avgShotLengthDelta: "avgShotLengthDeltaMs",
    hookLengthDelta: "hookLengthDeltaMs",
    punchInRatioDelta: "punchInRatioDelta",
    brollRatioDelta: "brollRatioDelta",
    captionWordsPerCueDelta: "captionWordsPerCueDelta",
    captionPositionDelta: "captionPositionDelta",
    captionFontRatioDelta: "captionFontRatioDelta",
    visualEventRateDelta: "visualEventRateDelta",
    bpmDelta: "bpmDelta",
    sfxDensityDelta: "sfxDensityDelta",
  };
  return Object.entries(keys).flatMap(([metric, threshold]) => {
    const value = metrics[metric];
    if (value == null) return [];
    const tolerance = thresholds[threshold];
    return Math.abs(value) > tolerance ? [{ code: "style-metric-out-of-range", metric, value, tolerance }] : [];
  });
}

function hardGate(passed, details = {}) {
  return { passed: Boolean(passed), ...details };
}

export async function evaluateStyleQc({
  referenceAnalysis,
  userFacts,
  render = {},
  expectedStyleProjectHash = null,
  captions = [],
  captionStyle = {},
  faceFrames = [],
  faceDetectionAvailable = true,
  requireFaceEvidence = false,
  copy = {},
  thresholds = STYLE_QC_THRESHOLDS,
} = {}) {
  const metrics = computeStyleMetrics({ referenceAnalysis, userFacts, copy });
  const issues = metricIssues(metrics, thresholds);
  const overlaps = findCaptionFaceOverlaps({
    probe: render.probe,
    captions,
    captionStyle,
    faceFrames,
  });
  const detectedFaceCount = faceFrames.reduce((sum, frame) => sum + (frame.boxes?.length || 0), 0);
  const faceEvidenceOk = faceDetectionAvailable && (!requireFaceEvidence || (faceFrames.length > 0 && detectedFaceCount > 0));
  const referenceHash = String(referenceAnalysis?.source?.sha256 || "").toLowerCase();
  const inputHashes = (render.inputHashes || []).map((hash) => String(hash || "").toLowerCase());
  const referenceMediaUsed = Boolean(render.referenceMediaUsed) || Boolean(referenceHash && inputHashes.includes(referenceHash));
  const styleHashExpected = String(expectedStyleProjectHash || "").toLowerCase();
  const styleHashActual = String(render.styleProjectHash || "").toLowerCase();
  const hardGates = {
    noUnexpectedBlackFrames: hardGate((render.blackFrames || []).length === 0, { count: (render.blackFrames || []).length }),
    audioVideoSync: hardGate(
      Number.isFinite(Number(render.probe?.avSyncDeltaMs))
        && Number.isFinite(Number(render.probe?.avDurationDeltaMs))
        && Number(render.probe.avSyncDeltaMs) <= 250
        && Number(render.probe.avDurationDeltaMs) <= 250,
      { avSyncDeltaMs: render.probe?.avSyncDeltaMs ?? null, avDurationDeltaMs: render.probe?.avDurationDeltaMs ?? null, toleranceMs: 250 },
    ),
    captionsClearOfFace: hardGate(faceEvidenceOk && overlaps.length === 0, {
      overlapCount: overlaps.length,
      overlaps,
      sampledFrameCount: faceFrames.length,
      detectedFaceCount,
      faceDetectionAvailable,
      requireFaceEvidence,
    }),
    referenceMediaNotUsed: hardGate(!referenceMediaUsed, { referenceHash, inputHashes }),
    assetsLicensed: hardGate(render.assetsLicensed === true),
    styleProjectHashMatches: hardGate(Boolean(styleHashExpected) && styleHashExpected === styleHashActual, { expected: styleHashExpected || null, actual: styleHashActual || null }),
  };
  const passed = issues.length === 0 && Object.values(hardGates).every((gate) => gate.passed);
  return {
    contract: "style-qc.v1",
    checkedAt: new Date().toISOString(),
    passed,
    metrics,
    thresholds: { ...thresholds },
    issues,
    hardGates,
  };
}

export async function writeStyleQc(path, qc) {
  const text = `${JSON.stringify(qc, null, 2)}\n`;
  await fs.writeFile(path, text);
  return createHash("sha256").update(text).digest("hex");
}

export async function detectFaceFrames(videoPath, { maxSamples = 12, python = process.env.WAYNE_FACE_DETECTOR_PYTHON || "python3" } = {}) {
  const count = Math.max(1, Math.min(60, Math.round(Number(maxSamples) || 12)));
  const { stdout } = await execFileAsync(python, [faceDetectorScript, videoPath, String(count)], {
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout || "[]");
  if (!Array.isArray(parsed) || parsed.some((frame) => !Number.isFinite(Number(frame?.timeMs)) || !Array.isArray(frame.boxes))) {
    throw new Error("face detector returned invalid frame data");
  }
  return parsed.map((frame) => ({ timeMs: Number(frame.timeMs), boxes: frame.boxes }));
}
