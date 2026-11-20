import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeRemotionMain } from "./remotion-main.mjs";
import { createDraftStyleProject, hashStyleProject } from "./style-project.mjs";
import { compositeRemotionPreview } from "./remotion-overlay.mjs";

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

async function centerPixel(path, seconds, width, height) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(seconds), "-i", path,
      "-vf", `crop=1:1:${Math.floor(width / 2)}:${Math.floor(height / 2)},format=rgba`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]);
    const chunks = [];
    let error = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).subarray(0, 4)) : reject(new Error(error)));
  });
}

const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-single-"));
try {
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "input.mp4",
  ], root);
  await fs.copyFile(join(root, "input.mp4"), join(root, "base.mp4"));

  const style = await createDraftStyleProject({
    analysis: { analysisId: "style-single-analysis" },
    outDir: join(root, "style-project"),
    manifest: {
      contract: "style-manifest.v1",
      id: "style-single",
      name: "Single style",
      version: 1,
      status: "approved",
      sourceAnalysisId: "style-single-analysis",
      supportedModes: ["single-video-v1"],
      parameters: { captionScale: 1, motionIntensity: 0.8, colorAccent: "#c6f475" },
      capabilities: ["captions", "emphasis", "punch_in"],
      requirements: { minAssets: 1, needsMainFootage: true, needsBroll: false },
      unsupported: [],
      preview: null,
    },
  });
  const styleProjectHash = await hashStyleProject(style.dir);
  const transcript = { provider: "fixture", text: "你好世界朋友", language: "zh", durationMs: 2000, segments: [{ id: "one", startMs: 100, endMs: 1900, text: "你好世界朋友" }] };
  const plan = {
    summary: "用户内容",
    stylePackId: "style-single",
    styleVersion: 1,
    styleParameters: { captionScale: 1, motionIntensity: 0.8 },
    layoutEvents: [{ id: "layout-1", type: "punch_in", startMs: 0, endMs: 1800, params: {} }],
    segments: [{ id: "keep", startMs: 0, endMs: 2000, action: "keep", title: "用户内容", note: "" }],
    shorts: [],
    visualEvents: [{ id: "emphasis", type: "emphasis", startMs: 100, endMs: 900, text: "你好", subtext: "" }],
    brollEvents: [],
    captionStyle: { fontSize: 26, marginV: 18, outline: 2, color: "#c6f475" },
  };
  const brief = {
    phase: "plan",
    projectId: "style-single",
    compositionMode: "remotion-main.v1",
    stylePackId: "style-single",
    styleVersion: 1,
    styleProjectDir: "style-project",
    styleProjectHash,
    styleManifestSha256: style.manifestSha256,
    styleCompositionId: "ReferenceStyle",
    styleApplication: { parameters: { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: false, copyAudio: true }, captionPolicy: { wordsPerCue: 4 } },
    media: { durationMs: 2000, width: 320, height: 180, hasAudio: true, hasVideo: true },
    styleParameters: plan.styleParameters,
    referenceAnalysisPath: "reference-analysis.json",
    styleQc: { requireFaceEvidence: false },
  };
  const referenceAnalysis = {
    contract: "reference-analysis.v1",
    analysisId: "style-single-analysis",
    source: { filename: "reference.mp4", durationMs: 2000, width: 320, height: 180, aspectRatio: "16:9", fps: 30, hasAudio: true, sha256: "f".repeat(64) },
    shots: [{ id: "ref-1", startMs: 0, endMs: 2000, role: "hook", layout: "punch_in", broll: false }],
    rhythm: { hookMs: 2000, avgShotMs: 2000, cutsPerMinute: 0, punchInRatio: 0.9, brollRatio: 0 },
    captions: { grouping: "phrase", maxWordsPerCue: 4, position: "bottom", fontSizeRatio: 0.1444, primaryColor: "#ffffff", strokeColor: "#000000", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
    overlays: [{ id: "overlay-1" }],
    audio: { bpm: null, voice: "human", sfxDensity: "unknown" },
    capabilities: { needsBroll: false, needsScreenshots: false, needsSplitScreen: false },
    unsupported: [],
    confidence: { overall: 0.8, rhythm: 0.8, captions: 0.8, layout: 0.8 },
  };
  await Promise.all([
    fs.writeFile(join(root, "brief.json"), JSON.stringify(brief)),
    fs.writeFile(join(root, "edit-plan.json"), JSON.stringify(plan)),
    fs.writeFile(join(root, "transcript.json"), JSON.stringify(transcript)),
    fs.writeFile(join(root, "timeline.json"), JSON.stringify({ pieces: [{ src: [0, 2000], out: [0, 2000] }] })),
    fs.writeFile(join(root, "reference-analysis.json"), JSON.stringify(referenceAnalysis)),
  ]);
  await fs.writeFile(join(root, "captions.srt"), "1\n00:00:00,100 --> 00:00:01,900\n你好世界朋友\n");

  const result = await composeRemotionMain({ root, baseVideo: "base.mp4", phase: "plan" });
  assert.equal(result.stylePackId, "style-single");
  assert.equal(result.styleVersion, 1);
  assert.equal(result.styleProjectHash, styleProjectHash);
  assert.equal(result.styleProvenance.stylePackId, "style-single");
  assert.equal(result.styleProvenance.styleVersion, 1);
  assert.equal(result.styleProvenance.styleProjectHash, styleProjectHash);
  assert.match(result.styleProvenance.styleManifestSha256, /^[a-f0-9]{64}$/);
  assert.match(result.styleProvenance.referenceAnalysisSha256, /^[a-f0-9]{64}$/);
  assert.match(result.styleProvenance.styleApplicationSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sourceFiles.referenceAnalysis, "reference-analysis.json");
  assert.equal(result.captionMode, "style-project");
  assert.equal(result.layoutEvents.length, 1);
  assert.ok((await fs.stat(join(root, result.overlayPath))).isFile());
  assert.ok((await fs.stat(join(root, result.outputPath))).isFile());
  assert.equal(result.captionStyle.fontSize, 26);
  assert.equal(result.qc.passed, true);
  assert.equal(result.qc.isolation, "bwrap-network-namespace");
  assert.equal(result.qc.styleQc.passed, true);
  assert.equal(result.qc.styleQc.metrics.captionWordsPerCueDelta, 2, "a complete six-character phrase may exceed the four-character target within the three-character semantic tolerance");
  assert.ok((await fs.stat(join(root, result.styleQcPath))).isFile());
  assert.deepEqual(JSON.parse(await fs.readFile(join(root, result.styleQcPath), "utf8")).styleProvenance, result.styleProvenance);

  const layoutOffPath = join(root, "layout-off.mp4");
  const layoutOnPath = join(root, "layout-on.mp4");
  await compositeRemotionPreview({
    inputPath: join(root, "base.mp4"),
    overlayPath: join(root, result.overlayPath),
    outputPath: layoutOffPath,
    durationMs: 2000,
    phase: "plan",
  });
  await compositeRemotionPreview({
    inputPath: join(root, "base.mp4"),
    overlayPath: join(root, result.overlayPath),
    outputPath: layoutOnPath,
    layoutEvents: plan.layoutEvents,
    durationMs: 2000,
    phase: "plan",
  });
  assert.notDeepEqual(
    await centerPixel(layoutOnPath, 1, 320, 180),
    await centerPixel(layoutOffPath, 1, 320, 180),
    "punch-in layout must transform the base frame, not only draw an overlay border",
  );

  const audit = [{ tool: "compose_remotion_video", ...result }];
  const { validateRemotionComposition } = await import("./remotion-main.mjs");
  const manifest = { compositionMode: "remotion-main.v1", phase: "plan", main: result.outputPath, subtitle: "captions.srt", sources: [], shorts: [], broll: [], review: { passed: true, notes: "style fixture" } };
  const validated = await validateRemotionComposition({ dir: root, phase: "plan", manifest, audit });
  assert.ok(validated.files.some((file) => file.kind === "style-qc" && file.path === result.styleQcPath));
  await assert.rejects(
    validateRemotionComposition({ dir: root, phase: "plan", manifest, audit: [{ tool: "compose_remotion_video", ...result, qc: { ...result.qc, networkIsolated: false } }] }),
    /网络|隔离|sandbox|network/i,
  );
  await assert.rejects(
    validateRemotionComposition({
      dir: root,
      phase: "plan",
      manifest,
      audit: [{ tool: "compose_remotion_video", ...result, styleProvenance: { ...result.styleProvenance, styleApplicationSha256: "0".repeat(64) } }],
    }),
    /来源证据/,
  );
  await fs.appendFile(join(root, "style-project", "src", "StyleOverlay.tsx"), "\n// stale style\n");
  await assert.rejects(validateRemotionComposition({ dir: root, phase: "plan", manifest, audit }), /style.*hash|风格.*哈希|过期|不一致/i);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-single.verify: style project selection, layout mapping, caption ownership, style hash, and stale rejection passed");
