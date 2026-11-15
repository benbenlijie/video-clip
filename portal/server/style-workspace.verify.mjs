import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "./claude-code-editor.mjs";
import { createDraftStyleProject, hashStyleProject } from "./style-project.mjs";

const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-workspace-"));
try {
  const projectDir = join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(join(projectDir, "input.mp4"), "fixture");
  const style = await createDraftStyleProject({
    analysis: { analysisId: "reference-analysis-1" },
    outDir: join(root, "approved-style"),
    manifest: {
      contract: "style-manifest.v1",
      id: "approved-style",
      name: "Approved style",
      version: 3,
      status: "approved",
      sourceAnalysisId: "reference-analysis-1",
      supportedModes: ["single-video-v1"],
      parameters: { captionScale: 1.1, motionIntensity: 0.7, colorAccent: "#c6f475" },
      capabilities: ["captions", "punch_in"],
      requirements: { minAssets: 1, needsMainFootage: true, needsBroll: false },
      unsupported: [],
      preview: null,
    },
  });
  const styleProjectHash = await hashStyleProject(style.dir);
  const project = {
    id: "workspace-style",
    dir: projectDir,
    editor: { runId: "22222222-2222-4222-8222-222222222222" },
    compositionMode: "remotion-main.v1",
    media: { filename: "input.mp4", path: join(projectDir, "input.mp4"), durationMs: 1000, width: 320, height: 180, hasAudio: true, hasVideo: true },
    transcript: { provider: "fixture", text: "用户自己的口播", durationMs: 1000, segments: [{ id: "s1", startMs: 0, endMs: 1000, text: "用户自己的口播" }] },
    comments: [],
    goal: "test",
    style: "Approved style",
    stylePackId: "approved-style",
    styleVersion: 3,
    styleProjectPath: style.dir,
    styleParameters: { captionScale: 1.1, motionIntensity: 0.7 },
    styleCopy: { copyCaptions: true, copyRhythm: false, copyLayout: true, copyBroll: false, copyAudio: false },
    stylePack: { contract: "style-pack.v1", id: "approved-style", version: 3, status: "approved", manifest: style.manifest, manifestSha256: style.manifestSha256, codeSha256: styleProjectHash },
    referenceAnalysis: {
      contract: "reference-analysis.v1",
      analysisId: "reference-analysis-1",
      source: { filename: "reference.mp4", durationMs: 42000, width: 1080, height: 1920, aspectRatio: "9:16", fps: 30, hasAudio: true, sha256: "a".repeat(64) },
      shots: [{ id: "shot-1", startMs: 0, endMs: 42000, role: "hook", layout: "punch_in", broll: false }],
      rhythm: { hookMs: 1800, avgShotMs: 3000, cutsPerMinute: 8, punchInRatio: 0.2, brollRatio: 0 },
      captions: { grouping: "phrase", maxWordsPerCue: 5, position: "bottom", fontSizeRatio: 0.05, primaryColor: "#ffffff", strokeColor: "#000000", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
      overlays: [],
      audio: { bpm: 110, voice: "human", sfxDensity: "low" },
      capabilities: { needsBroll: false, needsScreenshots: false, needsSplitScreen: false },
      unsupported: [],
      confidence: { overall: 0.8, rhythm: 0.8, captions: 0.8, layout: 0.8 },
    },
  };

  const { dir } = await prepareWorkspace(project, "plan");
  const brief = JSON.parse(await fs.readFile(join(dir, "brief.json"), "utf8"));
  assert.equal(brief.stylePackId, "approved-style");
  assert.equal(brief.styleVersion, 3);
  assert.equal(brief.styleProjectDir, "style-project");
  assert.equal(brief.styleProjectHash, styleProjectHash);
  assert.equal(brief.styleManifestSha256, style.manifestSha256);
  assert.equal(brief.styleCompositionId, "ReferenceStyle");
  assert.deepEqual(brief.styleParameters, project.styleParameters);
  assert.deepEqual(brief.styleCopy, project.styleCopy);
  assert.equal(JSON.stringify(brief).includes(root), false, "workspace brief must not expose local absolute paths");
  assert.equal(await fs.readFile(join(dir, "style-project", "style-manifest.json"), "utf8"), await fs.readFile(join(style.dir, "style-manifest.json"), "utf8"));
  assert.equal((await fs.readFile(join(dir, "reference-analysis.json"), "utf8")).includes(project.referenceAnalysis.source.sha256), true);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-workspace.verify: StyleProject copy, hash, relative brief fields, and analysis evidence passed");
