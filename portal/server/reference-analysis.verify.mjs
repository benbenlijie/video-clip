import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  analyzeReference,
  analyzeReferenceAudio,
  analyzeReferenceVisuals,
  extractReferenceFrames,
  normalizeReferenceAnalysis,
  validateReferenceAnalysis,
} from "./reference-analysis.mjs";

const execFileAsync = promisify(execFile);

const portrait = {
  contract: "reference-analysis.v1",
  source: {
    filename: "reference.mp4",
    durationMs: 42000,
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    fps: 30,
    hasAudio: true,
    sha256: "a".repeat(64),
  },
  shots: [
    { id: "shot-01", startMs: 0, endMs: 1800, role: "hook", layout: "full", broll: false },
    { id: "shot-02", startMs: 1800, endMs: 6000, role: "context", layout: "punch_in", broll: false },
  ],
  rhythm: {
    hookMs: 1800,
    avgShotMs: 2100,
    cutsPerMinute: 18,
    punchInRatio: 0.35,
    brollRatio: 0.22,
  },
  captions: {
    grouping: "phrase",
    maxWordsPerCue: 4,
    position: "bottom",
    fontSizeRatio: 0.052,
    primaryColor: "#ffffff",
    strokeColor: "#111111",
    strokeWidth: 2,
    keywordColor: "#c6f475",
    animation: "scale_pop",
  },
  overlays: [],
  audio: { bpm: 112, voice: "human", sfxDensity: "medium" },
  capabilities: { needsBroll: false, needsScreenshots: false, needsSplitScreen: false },
  unsupported: [],
  confidence: { overall: 0.82, rhythm: 0.94, captions: 0.86, layout: 0.68 },
};

const richStyleSpec = {
  contract: "style-spec.v2",
  canvas: {
    aspectRatio: "9:16",
    safeArea: { topRatio: 0.06, rightRatio: 0.07, bottomRatio: 0.12, leftRatio: 0.07 },
  },
  title: {
    anchor: "top_center",
    widthRatio: 1,
    maxLines: 2,
    panel: { enabled: true, color: "#f2efe4", opacity: 0.82, radiusRatio: 0, paddingXRatio: 0.04, paddingYRatio: 0.015, blurPx: 0 },
    primary: { fontFamily: "sans", fontWeight: 900, fontSizeRatio: 0.064, lineHeight: 1.14, letterSpacingRatio: 0.004, color: "#e3cc6b", strokeColor: "#29271f", strokeWidthRatio: 0.004, shadowOpacity: 0.45, shadowBlurRatio: 0.012, shadowOffsetYRatio: 0.003 },
    secondary: { fontFamily: "sans", fontWeight: 800, fontSizeRatio: 0.055, lineHeight: 1.14, letterSpacingRatio: 0.002, color: "#ffffff", strokeColor: "#29271f", strokeWidthRatio: 0.004, shadowOpacity: 0.45, shadowBlurRatio: 0.012, shadowOffsetYRatio: 0.003 },
    motion: {
      enter: { type: "fade", durationMs: 180, delayMs: 0, easing: "ease-out", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
      exit: { type: "none", durationMs: 0, delayMs: 0, easing: "linear", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
    },
  },
  identity: {
    anchor: "middle_right",
    maxWidthRatio: 0.42,
    panel: { enabled: false, color: "#000000", opacity: 0, radiusRatio: 0, paddingXRatio: 0, paddingYRatio: 0, blurPx: 0 },
    primary: { fontFamily: "sans", fontWeight: 900, fontSizeRatio: 0.035, lineHeight: 1.2, letterSpacingRatio: 0, color: "#ffe45c", strokeColor: "#000000", strokeWidthRatio: 0.004, shadowOpacity: 0.6, shadowBlurRatio: 0.01, shadowOffsetYRatio: 0.002 },
    secondary: { fontFamily: "sans", fontWeight: 700, fontSizeRatio: 0.026, lineHeight: 1.25, letterSpacingRatio: 0, color: "#ffffff", strokeColor: "#000000", strokeWidthRatio: 0.003, shadowOpacity: 0.5, shadowBlurRatio: 0.008, shadowOffsetYRatio: 0.002 },
    motion: {
      enter: { type: "fade", durationMs: 140, delayMs: 0, easing: "ease-out", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
      exit: { type: "none", durationMs: 0, delayMs: 0, easing: "linear", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
    },
  },
  captions: {
    grouping: "phrase",
    maxCharsPerCue: 10,
    anchor: "bottom_center",
    maxWidthRatio: 0.86,
    panel: { enabled: true, color: "#f3f0e7", opacity: 0.72, radiusRatio: 0.04, paddingXRatio: 0.03, paddingYRatio: 0.01, blurPx: 0 },
    typography: { fontFamily: "sans", fontWeight: 800, fontSizeRatio: 0.06, lineHeight: 1.08, letterSpacingRatio: 0, color: "#ffffff", strokeColor: "#000000", strokeWidthRatio: 0.0045, shadowOpacity: 0.5, shadowBlurRatio: 0.008, shadowOffsetYRatio: 0 },
    highlight: { strategy: "keyword", color: "#ffe45c", strokeColor: "#000000", scalePeak: 1.08, durationMs: 140 },
    motion: {
      enter: { type: "fade-scale", durationMs: 160, delayMs: 0, easing: "ease-out", scaleFrom: 0.92, translateYRatio: 0.008, stagger: "none", staggerMs: 0 },
      exit: { type: "fade", durationMs: 80, delayMs: 0, easing: "ease-in", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
    },
  },
  effects: [
    { id: "caption-pop", target: "captions", trigger: "cue_enter", type: "scale", durationMs: 160, delayMs: 0, easing: "ease-out", intensity: 0.12 },
  ],
};

const styled = normalizeReferenceAnalysis({
  ...portrait,
  contract: "reference-analysis.v2",
  styleSpec: richStyleSpec,
});
assert.equal(styled.contract, "reference-analysis.v2");
assert.equal(styled.styleSpec.title.panel.opacity, 0.82);
assert.equal(styled.styleSpec.title.primary.strokeWidthRatio, 0.004);
assert.equal(styled.styleSpec.captions.panel.enabled, true);
assert.equal(styled.styleSpec.captions.motion.enter.scaleFrom, 0.92);
assert.equal(styled.styleSpec.effects[0].target, "captions");
assert.equal(styled.analysisId, normalizeReferenceAnalysis(portrait).analysisId);

assert.deepEqual(validateReferenceAnalysis(portrait), normalizeReferenceAnalysis(portrait));
assert.notEqual(
  normalizeReferenceAnalysis({ ...portrait, captions: { ...portrait.captions, primaryColor: "#ffffff" } }).analysisId,
  normalizeReferenceAnalysis({ ...portrait, captions: { ...portrait.captions, primaryColor: "#ff0000" } }).analysisId,
);
assert.notEqual(
  normalizeReferenceAnalysis(portrait).analysisId,
  normalizeReferenceAnalysis({ ...portrait, source: { ...portrait.source, sha256: "b".repeat(64) } }).analysisId,
);

const landscape = {
  ...portrait,
  source: { ...portrait.source, width: 1920, height: 1080, aspectRatio: "16:9" },
};
assert.equal(validateReferenceAnalysis(landscape).source.aspectRatio, "16:9");

assert.doesNotThrow(() => validateReferenceAnalysis({
  ...portrait,
  source: { ...portrait.source, durationMs: 30000 },
  shots: [{ id: "only", startMs: 0, endMs: 30000, role: "context", layout: "full", broll: false }],
}));
assert.doesNotThrow(() => validateReferenceAnalysis({
  ...portrait,
  source: { ...portrait.source, durationMs: 180000 },
  shots: [{ id: "only", startMs: 0, endMs: 180000, role: "context", layout: "full", broll: false }],
}));
assert.throws(() => validateReferenceAnalysis({ ...portrait, shots: [] }), /shots/i);
assert.throws(() => validateReferenceAnalysis({ ...portrait, shots: [{ ...portrait.shots[0], endMs: 0 }] }), /time|时间/i);
assert.throws(() => validateReferenceAnalysis({ ...portrait, source: { ...portrait.source, durationMs: 29999 } }), /duration|时长/i);
assert.throws(() => validateReferenceAnalysis({ ...portrait, source: { ...portrait.source, width: 1920, height: 1920 } }), /aspect|aspectRatio|画幅/i);
assert.throws(() => validateReferenceAnalysis({ ...portrait, transcript: "reference words must not be persisted" }), /reference text|reference words|transcript|文案/i);
assert.throws(() => validateReferenceAnalysis({ ...portrait, sourceText: "hidden reference copy" }), /reference text|sourceText|文案/i);
assert.throws(
  () => validateReferenceAnalysis({ ...portrait, overlays: [{ id: "o1", type: "callout", text: "reference subtitle text" }] }),
  /reference text|overlay|文案/i,
);

const calls = [];
const analyzed = await analyzeReference({
  videoPath: "/tmp/private/reference.mp4",
  workDir: "/tmp/private/work",
  mode: "single-video-v1",
  probeImpl: async (path) => {
    calls.push(["probe", path]);
    return { filename: "reference.mp4", durationMs: 42000, width: 1080, height: 1920, fps: 30, hasAudio: true, sha256: "b".repeat(64) };
  },
  shotDetector: async () => {
    calls.push(["shots"]);
    return [
      { id: "shot-01", startMs: 0, endMs: 1800, role: "hook", layout: "full", broll: false },
      { id: "shot-02", startMs: 1800, endMs: 6000, role: "context", layout: "punch_in", broll: false },
    ];
  },
  visualAnalyzer: null,
  audioAnalyzer: null,
});
assert.equal(analyzed.contract, "reference-analysis.v1");
assert.equal(analyzed.source.aspectRatio, "9:16");
assert.equal(analyzed.shots.length, 2);
assert.deepEqual(calls, [["probe", "/tmp/private/reference.mp4"], ["shots"]]);
assert.equal(JSON.stringify(analyzed).includes("/tmp/private"), false, "local paths must not leak into analysis");
assert.equal(typeof analyzed.analysisId, "string");

const visualCalls = [];
const visuallyAnalyzed = await analyzeReference({
  videoPath: "/tmp/private/reference.mp4",
  workDir: "/tmp/private/work",
  mode: "single-video-v1",
  probeImpl: async () => ({ filename: "reference.mp4", durationMs: 42000, width: 1080, height: 1920, fps: 30, hasAudio: true, sha256: "c".repeat(64) }),
  shotDetector: async () => [
    { id: "shot-01", startMs: 0, endMs: 1800, role: "hook", layout: "full", broll: false },
    { id: "shot-02", startMs: 1800, endMs: 6000, role: "unknown", layout: "full", broll: false },
  ],
  visualAnalyzer: async ({ shots }) => {
    visualCalls.push(shots.map((shot) => shot.id));
    return {
      shots: [
        { index: 0, id: "evil", startMs: 9999, endMs: 99999, role: "teaser", layout: "punch_in", broll: false },
        { index: 1, id: "evil-2", startMs: 9999, endMs: 99999, role: "proof", layout: "broll_cover", broll: true },
      ],
      captions: { grouping: "phrase", maxWordsPerCue: 5, position: "bottom", fontSizeRatio: 0.055, primaryColor: "#Ffffff", strokeColor: "#111111", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
      overlays: [{ id: "o1", type: "callout", startMs: 200, endMs: 1600, position: "top_right", sizeRatio: 0.2 }],
      capabilities: { needsBroll: true, needsScreenshots: false, needsSplitScreen: false },
      unsupported: ["multi_camera"],
      confidence: { overall: 0.86, rhythm: 0.8, captions: 0.84, layout: 0.78 },
    };
  },
  audioAnalyzer: async () => ({ bpm: 112, voice: "human", sfxDensity: "medium" }),
});
assert.deepEqual(visualCalls, [["shot-01", "shot-02"]]);
assert.deepEqual(visuallyAnalyzed.shots.map(({ startMs, endMs, role, layout, broll }) => ({ startMs, endMs, role, layout, broll })), [
  { startMs: 0, endMs: 1800, role: "teaser", layout: "punch_in", broll: false },
  { startMs: 1800, endMs: 6000, role: "proof", layout: "broll_cover", broll: true },
]);
assert.equal(visuallyAnalyzed.captions.maxWordsPerCue, 5);
assert.equal(visuallyAnalyzed.capabilities.needsBroll, true);
assert.equal(visuallyAnalyzed.audio.bpm, 112);
assert.equal(visuallyAnalyzed.audio.sfxDensity, "medium");
assert.equal(visuallyAnalyzed.overlays[0].position, "top_right");
assert.deepEqual(visuallyAnalyzed.unsupported, ["multi_camera"]);
assert.equal(JSON.stringify(visuallyAnalyzed).includes("reference subtitle text"), false);

const fallback = await analyzeReference({
  videoPath: "/tmp/private/reference.mp4",
  workDir: "/tmp/private/work",
  mode: "single-video-v1",
  probeImpl: async () => ({ filename: "reference.mp4", durationMs: 42000, width: 1080, height: 1920, fps: 30, hasAudio: true, sha256: "d".repeat(64) }),
  shotDetector: async () => [{ id: "shot-01", startMs: 0, endMs: 42000, role: "hook", layout: "full", broll: false }],
  visualAnalyzer: async () => { throw new Error("provider unavailable"); },
  audioAnalyzer: null,
});
assert.ok(fallback.unsupported.includes("visual-analysis-failed"));
assert.ok(fallback.confidence.overall < 0.5);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-reference-analysis-"));
try {
  const videoPath = path.join(root, "reference.mp4");
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6", "-pix_fmt", "yuv420p", videoPath]);
  const shots = [
    { id: "shot-01", startMs: 0, endMs: 3000, role: "hook", layout: "full", broll: false },
    { id: "shot-02", startMs: 3000, endMs: 6000, role: "unknown", layout: "full", broll: false },
  ];
  const frames = await extractReferenceFrames({ videoPath, workDir: root, shots, maxFrames: 2, width: 160 });
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((frame) => frame.shotIndex), [0, 1]);
  assert.ok(frames.every((frame) => frame.bytes > 0 && frame.timeMs > 0));
  const continuousFrames = await extractReferenceFrames({
    videoPath,
    workDir: path.join(root, "continuous"),
    shots: [{ id: "shot-01", startMs: 0, endMs: 6000, role: "hook", layout: "full", broll: false }],
    maxFrames: 4,
    width: 160,
  });
  assert.equal(continuousFrames.length, 4);
  assert.deepEqual(continuousFrames.map((frame) => frame.timeMs), [750, 2250, 3750, 5250]);

  let captured;
  const visual = await analyzeReferenceVisuals({
    videoPath,
    workDir: path.join(root, "visual"),
    shots,
    probe: { durationMs: 6000, width: 320, height: 180, fps: 30, hasAudio: true },
    apiKey: "test-key",
    model: "test-vision-model",
    baseUrl: "https://anthropic.example",
    maxFrames: 2,
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({
          shots: [{ index: 0, role: "hook", layout: "full", broll: false }],
          captions: { position: "bottom", fontSizeRatio: 0.05 },
          overlays: [],
          confidence: { overall: 0.7, captions: 0.6, layout: 0.8 },
          unsupported: [],
        }) }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://anthropic.example/v1/messages");
  assert.equal(captured.body.model, "test-vision-model");
  assert.ok(captured.body.messages[0].content.filter((item) => item.type === "image").length >= 1);
  assert.equal(JSON.stringify(captured.body).includes("testsrc"), false);
  assert.equal(visual.captions.position, "bottom");
  assert.equal(visual.confidence.overall, 0.7);

  const clickPath = path.join(root, "clicks.mp4");
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:size=160x90:rate=30:duration=8",
    "-f", "lavfi", "-i", "aevalsrc=if(lt(mod(t\\,0.5)\\,0.02)\\,0.8*sin(2*PI*1000*t)\\,0):s=16000:d=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clickPath,
  ]);
  const audio = await analyzeReferenceAudio({ videoPath: clickPath, workDir: path.join(root, "audio"), hasAudio: true });
  assert.ok(audio.bpm >= 116 && audio.bpm <= 124, `expected ~120 BPM, got ${audio.bpm}`);
  assert.equal(audio.voice, "unknown");
  assert.ok(["low", "medium", "high"].includes(audio.sfxDensity));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("reference-analysis.verify: contract, VLM/audio merge, frame/beat extraction, privacy, fallback, and injection seams passed");
