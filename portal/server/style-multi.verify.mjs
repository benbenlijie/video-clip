import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderMultiAssetProject, subtitleForceStyle } from "./multi-asset-render.mjs";
import { toTimelineV2 } from "./timeline-v2.mjs";
import { createDraftStyleProject, hashStyleProject } from "./style-project.mjs";

assert.equal(
  subtitleForceStyle({ fontSize: 64, marginV: 120, outline: 2, color: "#c6f475" }),
  "FontName=Noto Sans CJK SC,FontSize=64,PrimaryColour=&H0075F4C6,Outline=2,Shadow=1,Alignment=2,MarginV=120",
);

async function ffmpeg(args, cwd) {
  const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { cwd });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, error);
}

const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-multi-"));
try {
  for (const [name, color] of [["a1.mp4", "0x335544"], ["a2.mp4", "0x664433"], ["cut.mp4", "0x223366"]]) {
    await ffmpeg([
      "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=1`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", name,
    ], root);
  }
  const style = await createDraftStyleProject({
    analysis: { analysisId: "multi-analysis" },
    outDir: join(root, "style-project"),
    manifest: {
      contract: "style-manifest.v1",
      id: "style-multi-layout",
      name: "Multi layout",
      version: 1,
      status: "approved",
      sourceAnalysisId: "multi-analysis",
      supportedModes: ["single-video-v1", "multi-asset-v1"],
      parameters: { captionScale: 1 },
      capabilities: ["captions", "punch_in", "split", "broll_cover"],
      requirements: { minAssets: 2, needsMainFootage: true, needsBroll: true },
      unsupported: [],
      preview: null,
    },
  });
  const styleManifest = style.manifest;
  const styleProjectHash = await hashStyleProject(style.dir);
  const assets = [
    { id: "a1", filename: "a1.mp4", path: join(root, "a1.mp4"), durationMs: 1000, width: 320, height: 180, hasAudio: true, hasVideo: true, role: "main", label: "A1", licenseConfirmed: true, sha256: "1".repeat(64), status: "ready", analysisStatus: "ready", transcript: { text: "第一段内容很长", segments: [{ startMs: 100, endMs: 900, text: "第一段内容很长" }] } },
    { id: "a2", filename: "a2.mp4", path: join(root, "a2.mp4"), durationMs: 1000, width: 320, height: 180, hasAudio: true, hasVideo: true, role: "supporting", label: "A2", licenseConfirmed: true, sha256: "2".repeat(64), status: "ready", analysisStatus: "ready", transcript: { text: "第二段内容很长", segments: [{ startMs: 100, endMs: 900, text: "第二段内容很长" }] } },
    { id: "cut", filename: "cut.mp4", path: join(root, "cut.mp4"), durationMs: 1000, width: 320, height: 180, hasAudio: true, hasVideo: true, role: "broll", label: "Cut", licenseConfirmed: true, sha256: "3".repeat(64), status: "ready", analysisStatus: "ready", transcript: { text: "", segments: [] } },
  ];
  const plan = {
    version: 2,
    confirmed: true,
    stylePackId: "style-multi-layout",
    styleVersion: 1,
    styleParameters: { captionScale: 1 },
    summary: "multi layout fixture",
    storyBeats: [],
    durationMs: 2000,
    captionStyle: { fontSize: 38, marginV: 120, outline: 2, color: "#ffffff" },
    clips: [
      { id: "c1", sourceAssetId: "a1", sourceInMs: 0, sourceOutMs: 1000, timelineStartMs: 0, timelineEndMs: 1000, track: "video-main", purpose: "hook", reason: "user", shotRole: "punch_in", layout: { type: "punch_in", params: {} } },
      { id: "c2", sourceAssetId: "a2", sourceInMs: 0, sourceOutMs: 1000, timelineStartMs: 1000, timelineEndMs: 2000, track: "video-main", purpose: "proof", reason: "user", shotRole: "split", layout: { type: "split", params: {} } },
      { id: "c3", sourceAssetId: "cut", sourceInMs: 0, sourceOutMs: 500, timelineStartMs: 1000, timelineEndMs: 1500, track: "video-overlay", purpose: "broll_cover", reason: "user", shotRole: "broll_cover", layout: { type: "broll_cover", params: {} } },
    ],
    overlays: [],
    warnings: [],
    inputRevision: 0,
    inputFingerprint: "fixture",
  };
  const project = {
    id: "style-multi",
    dir: root,
    workflowMode: "multi-asset-v1",
    goal: "style multi test",
    style: "reference",
    brief: { rawText: "用户方案", aspectRatio: "both", targetDurationMs: 2000 },
    assets,
    styleProjectPath: style.dir,
    styleCopy: { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: true, copyAudio: true },
    styleApplication: {
      parameters: { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: true, copyAudio: true },
      captionPolicy: { wordsPerCue: 3, position: "bottom", style: { fontSize: 38, marginV: 120, outline: 2, color: "#ffffff" } },
    },
    referenceAnalysis: {
      contract: "reference-analysis.v1",
      analysisId: "multi-analysis",
      source: { filename: "reference.mp4", durationMs: 2000, width: 320, height: 180, aspectRatio: "16:9", fps: 30, hasAudio: true, sha256: "f".repeat(64) },
      shots: [
        { id: "r1", startMs: 0, endMs: 1000, role: "hook", layout: "punch_in", broll: false },
        { id: "r2", startMs: 1000, endMs: 2000, role: "proof", layout: "full", broll: false },
      ],
      rhythm: { hookMs: 1000, avgShotMs: 1000, cutsPerMinute: 30, punchInRatio: 0.5, brollRatio: 0.25 },
      captions: { grouping: "phrase", maxWordsPerCue: 3, position: "bottom", fontSizeRatio: 0.0198, primaryColor: "#ffffff", strokeColor: "#000000", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
      overlays: [],
      audio: { bpm: null, voice: "human", sfxDensity: "unknown" },
      capabilities: { needsBroll: true, needsScreenshots: false, needsSplitScreen: true },
      unsupported: [],
      confidence: { overall: 0.8, rhythm: 0.8, captions: 0.8, layout: 0.8 },
    },
    stylePack: { contract: "style-pack.v1", id: styleManifest.id, version: 1, status: "approved", manifest: styleManifest, manifestSha256: style.manifestSha256, codeSha256: styleProjectHash },
    multiAssetPlan: plan,
    music: null,
    artifacts: [],
    multiAssetRevision: 0,
  };
  const styleEvidence = {
    parameters: project.styleApplication.parameters,
    captionPolicy: project.styleApplication.captionPolicy,
    styleParameters: plan.styleParameters,
    captionStyle: plan.captionStyle,
    layoutEvents: plan.clips.filter((clip) => clip.track === "video-main").map((clip, index) => ({
      id: `multi-layout-${index + 1}`,
      type: clip.layout?.type || "full",
      startMs: clip.timelineStartMs,
      endMs: clip.timelineEndMs,
      params: {},
    })),
  };
  project.styleApplicationHash = createHash("sha256").update(JSON.stringify(styleEvidence)).digest("hex");
  await assert.rejects(
    renderMultiAssetProject({ ...project, styleApplicationHash: "0".repeat(64) }, { preview: true }),
    /参数已变化/,
  );
  const timeline = toTimelineV2(project);
  assert.equal(timeline.project.stylePackId, styleManifest.id);
  assert.equal(timeline.clips[0].layout.type, "punch_in");
  assert.equal(timeline.clips[1].layout.type, "split");
  const result = await renderMultiAssetProject(project, { preview: true });
  assert.equal(result.qc.passed, true);
  assert.equal(result.qc.stylePackId, styleManifest.id);
  assert.equal(result.qc.styleQc.passed, true);
  assert.equal(result.qc.styleQc.metrics.captionWordsPerCueDelta, 0);
  assert.equal(result.qc.styleProvenance.stylePackId, styleManifest.id);
  assert.equal(result.qc.styleProvenance.styleVersion, 1);
  assert.equal(result.qc.styleProvenance.styleProjectHash, styleProjectHash);
  assert.equal(result.qc.styleProvenance.styleManifestSha256, style.manifestSha256);
  assert.match(result.qc.styleProvenance.referenceAnalysisSha256, /^[a-f0-9]{64}$/);
  assert.match(result.qc.styleProvenance.styleApplicationSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.artifacts.some((item) => item.kind === "style-qc"));
  const styleQcArtifact = result.artifacts.find((item) => item.kind === "style-qc");
  assert.deepEqual(JSON.parse(await fs.readFile(join(root, "artifacts", styleQcArtifact.name), "utf8")).styleProvenance, result.qc.styleProvenance);
  assert.equal(result.qc.styleOverlayCount, result.qc.profileCount);
  assert.ok(result.artifacts.some((item) => item.kind === "style-overlay" && item.networkIsolated === true));
  assert.ok(result.artifacts.some((item) => item.kind === "preview"));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-multi.verify: timeline layout retention, punch-in/split render, style metadata, and QC passed");
