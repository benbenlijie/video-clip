import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeStyleMetrics,
  detectFaceFrames,
  deriveUserStyleFacts,
  evaluateStyleQc,
  findCaptionFaceOverlaps,
  writeStyleQc,
} from "./style-qc.mjs";

async function ffmpeg(args, cwd) {
  const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { cwd });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, error);
}

const referenceAnalysis = {
  contract: "reference-analysis.v1",
  analysisId: "reference-qc-1",
  source: { filename: "reference.mp4", durationMs: 40000, width: 1080, height: 1920, aspectRatio: "9:16", fps: 30, hasAudio: true, sha256: "a".repeat(64) },
  shots: [
    { id: "ref-1", startMs: 0, endMs: 2500, role: "hook", layout: "full", broll: false },
    { id: "ref-2", startMs: 2500, endMs: 40000, role: "context", layout: "punch_in", broll: true },
  ],
  rhythm: { hookMs: 2500, avgShotMs: 20000, cutsPerMinute: 1.5, punchInRatio: 0.25, brollRatio: 0.125 },
  captions: { grouping: "phrase", maxWordsPerCue: 5, position: "bottom", fontSizeRatio: 0.05, primaryColor: "#ffffff", strokeColor: "#000000", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
  overlays: [{ id: "o1" }, { id: "o2" }],
  audio: { bpm: 110, voice: "human", sfxDensity: "medium" },
  capabilities: { needsBroll: true, needsScreenshots: false, needsSplitScreen: false },
  unsupported: [],
  confidence: { overall: 0.8, rhythm: 0.8, captions: 0.8, layout: 0.8 },
};

const plan = {
  durationMs: 40000,
  segments: [
    { id: "keep-1", startMs: 0, endMs: 2500, action: "keep" },
    { id: "remove", startMs: 2500, endMs: 12500, action: "remove" },
    { id: "keep-2", startMs: 12500, endMs: 50000, action: "keep" },
  ],
  layoutEvents: [
    { id: "layout-1", type: "punch_in", startMs: 0, endMs: 10000, params: {} },
    { id: "layout-2", type: "broll_cover", startMs: 30000, endMs: 35000, params: {} },
  ],
  brollEvents: [{ id: "broll-1", assetId: "asset-1", startMs: 30000, endMs: 35000, sourceStartMs: 1000 }],
  visualEvents: [{ id: "v1" }, { id: "v2" }],
  captionStyle: { fontSize: 96, marginV: 24, outline: 2, color: "#ffffff" },
  audio: { bpm: 110, sfxDensity: "medium" },
};

const facts = deriveUserStyleFacts({
  plan,
  transcript: {
    segments: [
      { id: "s1", startMs: 0, endMs: 2000, text: "一 二 三 四 五" },
      { id: "s2", startMs: 2000, endMs: 4000, text: "六 七 八" },
    ],
  },
  media: { width: 1080, height: 1920, durationMs: 40000 },
});
assert.deepEqual(facts, {
  durationMs: 40000,
  shotCount: 2,
  hookMs: 2500,
  avgShotMs: 20000,
  cutsPerMinute: 1.5,
  punchInRatio: 0.25,
  brollRatio: 0.125,
  maxWordsPerCue: 5,
  captionPosition: "bottom",
  captionFontRatio: 0.05,
  visualEventRate: 3,
  bpm: 110,
  sfxDensity: "medium",
});

const metrics = computeStyleMetrics({ referenceAnalysis, userFacts: facts });
assert.deepEqual(metrics, {
  cutDensityDelta: 0,
  avgShotLengthDelta: 0,
  hookLengthDelta: 0,
  punchInRatioDelta: 0,
  brollRatioDelta: 0,
  captionWordsPerCueDelta: 0,
  captionPositionDelta: 0,
  captionFontRatioDelta: 0,
  visualEventRateDelta: 0,
  bpmDelta: 0,
  sfxDensityDelta: 0,
});
const layoutDisabled = computeStyleMetrics({ referenceAnalysis, userFacts: facts, copy: { copyLayout: false } });
assert.equal(layoutDisabled.punchInRatioDelta, null);
assert.equal(layoutDisabled.visualEventRateDelta, null);
assert.deepEqual(
  (() => {
    const metrics = computeStyleMetrics({
      referenceAnalysis: {
        ...referenceAnalysis,
        captions: { ...referenceAnalysis.captions, maxWordsPerCue: 9, fontSizeRatio: 0.08 },
        styleSpec: {
          contract: "style-spec.v3",
          captions: {
            maxCharsPerCue: 5,
            typography: { fontSizeRatio: 0.05 },
          },
        },
      },
      userFacts: facts,
    });
    return {
      captionWordsPerCueDelta: metrics.captionWordsPerCueDelta,
      captionFontRatioDelta: metrics.captionFontRatioDelta,
    };
  })(),
  { captionWordsPerCueDelta: 0, captionFontRatioDelta: 0 },
);
const previewMetrics = computeStyleMetrics({
  referenceAnalysis,
  userFacts: {
    ...facts,
    durationMs: 6000,
    shotCount: 1,
    hookMs: 6000,
    avgShotMs: 6000,
    cutsPerMinute: 0,
    punchInRatio: 0,
    brollRatio: 0,
    visualEventRate: 20,
  },
});
assert.equal(previewMetrics.hookLengthDelta, null);
assert.equal(previewMetrics.avgShotLengthDelta, null);
assert.equal(previewMetrics.visualEventRateDelta, null);
const singleShotMetrics = computeStyleMetrics({
  referenceAnalysis: {
    ...referenceAnalysis,
    shots: [{ id: "single", startMs: 0, endMs: 40000, role: "hook", layout: "full", broll: false }],
    rhythm: { hookMs: 40000, avgShotMs: 40000, cutsPerMinute: 0, punchInRatio: 0, brollRatio: 0 },
  },
  userFacts: facts,
});
assert.equal(singleShotMetrics.cutDensityDelta, null);
assert.equal(singleShotMetrics.avgShotLengthDelta, null);
assert.equal(singleShotMetrics.hookLengthDelta, null);

assert.deepEqual(findCaptionFaceOverlaps({
  probe: { width: 1080, height: 1920 },
  captions: [{ startMs: 0, endMs: 2000, text: "字幕" }],
  captionStyle: { fontSize: 96, marginV: 24 },
  faceFrames: [{ timeMs: 1000, boxes: [{ x: 0.35, y: 0.18, width: 0.3, height: 0.25 }] }],
}), []);
assert.equal(findCaptionFaceOverlaps({
  probe: { width: 1080, height: 1920 },
  captions: [{ startMs: 0, endMs: 2000, text: "字幕" }],
  captionStyle: { fontSize: 96, marginV: 24 },
  faceFrames: [{ timeMs: 1000, boxes: [{ x: 0.35, y: 0.86, width: 0.24, height: 0.16 }] }],
}).length, 1);
assert.equal(findCaptionFaceOverlaps({
  probe: { width: 1080, height: 1920 },
  captions: [{ startMs: 0, endMs: 2000, text: "字幕" }],
  captionStyle: { fontSize: 96, marginV: 24 },
  faceFrames: [{ timeMs: 1000, boxes: [{ x: 0.35, y: 0.6, width: 0.6, height: 0.34 }] }],
}).length, 0);

const passed = await evaluateStyleQc({
  referenceAnalysis,
  userFacts: facts,
  render: {
    probe: { width: 1080, height: 1920, durationMs: 40000, avSyncDeltaMs: 20, avDurationDeltaMs: 15 },
    blackFrames: [],
    inputHashes: ["b".repeat(64)],
    assetsLicensed: true,
    styleProjectHash: "c".repeat(64),
  },
  expectedStyleProjectHash: "c".repeat(64),
  captions: [{ startMs: 0, endMs: 2000, text: "字幕" }],
  captionStyle: { fontSize: 96, marginV: 24 },
  faceFrames: [{ timeMs: 1000, boxes: [{ x: 0.35, y: 0.18, width: 0.3, height: 0.25 }] }],
});
assert.equal(passed.passed, true);
assert.equal(passed.hardGates.captionsClearOfFace.passed, true);
assert.equal(passed.hardGates.referenceMediaNotUsed.passed, true);

const rejected = await evaluateStyleQc({
  referenceAnalysis,
  userFacts: { ...facts, cutsPerMinute: 30, captionPosition: "top", bpm: 160 },
  render: {
    probe: { width: 1080, height: 1920, durationMs: 40000, avSyncDeltaMs: 400, avDurationDeltaMs: 300 },
    blackFrames: [{ startMs: 1000, endMs: 1600, durationMs: 600 }],
    inputHashes: [referenceAnalysis.source.sha256],
    assetsLicensed: false,
    styleProjectHash: "d".repeat(64),
  },
  expectedStyleProjectHash: "c".repeat(64),
  captions: [{ startMs: 0, endMs: 2000, text: "字幕" }],
  captionStyle: { fontSize: 96, marginV: 24 },
  faceFrames: [{ timeMs: 1000, boxes: [{ x: 0.35, y: 0.86, width: 0.24, height: 0.16 }] }],
});
assert.equal(rejected.passed, false);
assert.equal(rejected.metrics.cutDensityDelta > 12, true);
assert.equal(rejected.metrics.captionPositionDelta, 1);
assert.equal(rejected.hardGates.noUnexpectedBlackFrames.passed, false);
assert.equal(rejected.hardGates.audioVideoSync.passed, false);
assert.equal(rejected.hardGates.captionsClearOfFace.passed, false);
assert.equal(rejected.hardGates.referenceMediaNotUsed.passed, false);
assert.equal(rejected.hardGates.assetsLicensed.passed, false);
assert.equal(rejected.hardGates.styleProjectHashMatches.passed, false);

const outputDir = await fs.mkdtemp(join(tmpdir(), "wayne-style-qc-"));
try {
  const output = join(outputDir, "style-qc.json");
  await writeStyleQc(output, passed);
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), passed);
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=0.6", "-pix_fmt", "yuv420p", "face-input.mp4"], outputDir);
  const faceFrames = await detectFaceFrames(join(outputDir, "face-input.mp4"), { maxSamples: 3 });
  assert.ok(faceFrames.length >= 1);
  assert.ok(faceFrames.every((frame) => Number.isFinite(frame.timeMs) && Array.isArray(frame.boxes)));
} finally {
  await fs.rm(outputDir, { recursive: true, force: true });
}

console.log("style-qc.verify: reference deltas, threshold rejection, face overlap, provenance, licensing, hash, and JSON output passed");
