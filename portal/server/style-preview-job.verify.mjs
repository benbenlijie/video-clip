import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { normalizeReferenceAnalysis } from "./reference-analysis.mjs";
import { saveStylePack } from "./style-pack-store.mjs";
import { validateStyleManifest } from "./style-project.mjs";
import { runStylePreview } from "./style-preview-job.mjs";
import { referenceStyleSpec } from "../test-fixtures/style-spec-v2.mjs";

async function ffmpeg(args) {
  const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  assert.equal(code, 0, stderr);
}

const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-preview-job-"));
try {
  const inputPath = join(root, "input.mp4");
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=7",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=7",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    inputPath,
  ]);
  const transcriptPath = join(root, "transcript.json");
  await fs.writeFile(transcriptPath, JSON.stringify({
    provider: "fixture",
    text: "测试字幕可以复用",
    durationMs: 6000,
    segments: [{ id: "fixture-1", startMs: 0, endMs: 5800, text: "测试字幕可以复用" }],
  }, null, 2));
  const referenceAnalysis = normalizeReferenceAnalysis({
    contract: "reference-analysis.v2",
    source: {
      filename: "reference.mp4",
      durationMs: 30000,
      width: 1080,
      height: 1920,
      aspectRatio: "9:16",
      fps: 30,
      hasAudio: true,
      sha256: "b".repeat(64),
    },
    shots: [{ id: "shot-01", startMs: 0, endMs: 30000, role: "hook", layout: "full", broll: false }],
    captions: {
      grouping: "phrase",
      maxWordsPerCue: 10,
      position: "bottom",
      fontSizeRatio: 0.06,
      primaryColor: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 4,
      keywordColor: "#ffe45c",
      animation: "fade-scale",
    },
    overlays: [
      { id: "title", type: "title_card", startMs: 0, endMs: 30000, position: "top_center", sizeRatio: 0.35, coverage: 0.2, confidence: 0.9 },
      { id: "identity", type: "identity", startMs: 0, endMs: 30000, position: "middle_right", sizeRatio: 0.3, coverage: 0.1, confidence: 0.9 },
    ],
    audio: { bpm: 90, voice: "unknown", sfxDensity: "low" },
    capabilities: { needsBroll: false, needsScreenshots: false, needsSplitScreen: false },
    unsupported: [],
    confidence: { overall: 0.9, rhythm: 0.9, captions: 0.9, layout: 0.9 },
    styleSpec: referenceStyleSpec,
  });
  const analysisPath = join(root, "reference-analysis.json");
  await fs.writeFile(analysisPath, JSON.stringify(referenceAnalysis, null, 2));
  const manifest = validateStyleManifest({
    contract: "style-manifest.v2",
    id: "style-preview-fixture",
    name: "Preview fixture",
    version: 1,
    status: "approved",
    sourceAnalysisId: referenceAnalysis.analysisId,
    supportedModes: ["single-video-v1"],
    parameters: { captionScale: 1, motionIntensity: 0.5, brollDensity: 0, colorAccent: "#ffe45c" },
    capabilities: ["captions", "title_card", "emphasis"],
    requirements: { minAssets: 1, needsMainFootage: true, needsBroll: false },
    unsupported: [],
    preview: null,
    styleSpec: referenceStyleSpec,
  });
  const styleRoot = join(root, "style-library");
  const fixtureProjectDir = join(root, "fixture-style-project");
  await fs.cp(resolve("style-project-template"), fixtureProjectDir, { recursive: true });
  await fs.writeFile(join(fixtureProjectDir, "style-manifest.json"), JSON.stringify(manifest, null, 2));
  const pack = await saveStylePack({
    root: styleRoot,
    manifest,
    projectDir: fixtureProjectDir,
    status: "approved",
  });
  const result = await runStylePreview({
    inputPath,
    outputDir: join(root, "preview"),
    stylePackId: manifest.id,
    styleVersion: 1,
    styleRoot,
    referenceAnalysisPath: analysisPath,
    transcriptPath,
    durationMs: 6000,
  });
  assert.equal(result.qc.passed, true);
  assert.equal(result.qc.audioVideoSyncDeltaMs, 0);
  assert.equal(result.qc.blackFrameCount, 0);
  assert.equal(result.style.stylePackId, manifest.id);
  assert.equal(result.style.styleProjectHash, pack.codeSha256);
  assert.match(result.style.styleApplicationSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.copy.source, "transcript");
  assert.equal(result.copy.title, "测试字幕可以复用");
  assert.equal(result.copy.identity, "");
  const derivedPlan = JSON.parse(await fs.readFile(join(root, "preview", "work", "edit-plan.json"), "utf8"));
  assert.ok(derivedPlan.visualEvents.some((event) => event.type === "title_card" && event.text === "测试字幕可以复用"));
  assert.equal(derivedPlan.visualEvents.some((event) => event.type === "emphasis"), false);
  const stored = JSON.parse(await fs.readFile(join(root, "preview", "result.json"), "utf8"));
  assert.equal(stored.output.video, "style-preview.mp4");
  assert.equal(stored.qc.styleQc.passed, true);
  console.log("style-preview-job.verify: arbitrary input, reusable StylePack, Remotion render and QC passed");
} finally {
  if (process.env.KEEP_STYLE_PREVIEW_TMP !== "1") await fs.rm(root, { recursive: true, force: true });
}
