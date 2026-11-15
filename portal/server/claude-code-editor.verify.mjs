import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditorPrompt, EDITOR_SESSION_TIMEOUT_MS, prepareWorkspace } from "./claude-code-editor.mjs";

assert.equal(EDITOR_SESSION_TIMEOUT_MS, 30 * 60 * 1000, "Claude Code gets a 30-minute hard timeout while retaining the per-run budget cap");
const prompt = buildEditorPrompt("plan");
assert.match(prompt, /\.claude\/skills\/video-edit\/references\/editorial-grammar\.md/);
assert.match(prompt, /licensed B-roll search/);
assert.match(prompt, /HyperFrames/);
assert.match(prompt, /render_remotion_preview/);
assert.match(prompt, /view_frame/);
assert.match(prompt, /Remotion/);
assert.match(prompt, /portrait 9:16/);
assert.match(prompt, /transcript-proofread\.json/);
assert.match(prompt, /cannot directly hear the audio/);
assert.match(prompt, /captionCoverage/);
assert.match(prompt, /wordTimingStatus=estimated/);
assert.match(prompt, /If wordTimingStatus=protected/);
assert.match(prompt, /does not need to provide extra instructions/);
assert.match(prompt, /never split a word, complete noun/);
assert.match(buildEditorPrompt("plan", "remotion-main.v1"), /compose_remotion_video/);
assert.doesNotMatch(buildEditorPrompt("plan", "remotion-main.v1"), /use mcp__video__render_remotion_preview/);
assert.match(buildEditorPrompt("plan", "remotion-main.v1", { hasStylePack: true }), /style-transfer\.json/);
assert.match(buildEditorPrompt("plan", "remotion-main.v1", { hasStylePack: true }), /reusable approved StylePack/);
assert.match(buildEditorPrompt("plan", "remotion-main.v1", { hasStylePack: true }), /never use technical placeholders/);
assert.match(buildEditorPrompt("plan", "remotion-main.v1", { hasStylePack: true }), /content-copy\.json/);

const root = await mkdtemp(join(tmpdir(), "wayne-editor-"));
try {
  const project = {
    id: "test-project",
    dir: root,
    editor: { runId: "11111111-1111-4111-8111-111111111111" },
    media: { durationMs: 1000, width: 720, height: 1280 },
    transcript: { provider: "volcengine", text: "把烦做的", language: "zh", durationMs: 1000, segments: [{ id: "segment-1", startMs: 0, endMs: 1000, text: "把烦做的" }] },
    secondaryTranscript: { provider: "whisper.cpp", model: "small_q5_1", text: "把繁琐的", language: "zh", durationMs: 1000, segments: [{ id: "whisper-1", startMs: 0, endMs: 1000, text: "把繁琐的" }] },
    comments: [],
    goal: "test",
    style: "Wayne / clean creator",
  };
  const { dir } = await prepareWorkspace(project, "chat-edit", { refreshSkill: true });
  assert.equal(JSON.parse(await readFile(join(dir, "brief.json"), "utf8")).projectId, project.id);
  assert.equal(JSON.parse(await readFile(join(dir, "transcript.original.json"), "utf8")).segments[0].text, "把烦做的");
  assert.equal(JSON.parse(await readFile(join(dir, "transcript.whisper.json"), "utf8")).segments[0].text, "把繁琐的");
  assert.equal(JSON.parse(await readFile(join(dir, "brief.json"), "utf8")).compositionMode, undefined, "old projects stay in their original workflow");
  project.compositionMode = "remotion-main.v1";
  await prepareWorkspace(project, "chat-edit");
  assert.equal(JSON.parse(await readFile(join(dir, "brief.json"), "utf8")).compositionMode, "remotion-main.v1");
  assert.match(await readFile(join(dir, ".claude/skills/video-edit/references/editorial-grammar.md"), "utf8"), /BROLL_COVER/);
  assert.match(await readFile(join(dir, ".claude/skills/video-edit/SKILL.md"), "utf8"), /HyperFrames 不是可选装饰/);
  const styleProjectPath = join(root, "approved-style-project");
  await mkdir(styleProjectPath, { recursive: true });
  await writeFile(join(styleProjectPath, "StyleOverlay.tsx"), "export const reusable = true;\n");
  project.stylePack = {
    contract: "style-pack.v1",
    id: "style-reuse-test",
    version: 1,
    status: "approved",
    manifest: {
      id: "style-reuse-test",
      version: 1,
      name: "Reusable captions",
      parameters: { captionScale: 1.2 },
      styleSpec: { contract: "style-spec.v2", captions: { maxCharsPerCue: 8 } },
      sourceAnalysisId: "analysis-reuse-test",
    },
    manifestSha256: "a".repeat(64),
  };
  project.stylePackId = "style-reuse-test";
  project.styleVersion = 1;
  project.styleProjectPath = styleProjectPath;
  project.referenceAnalysis = { contract: "reference-analysis.v2", analysisId: "analysis-reuse-test", styleSpec: project.stylePack.manifest.styleSpec };
  project.styleApplication = {
    parameters: { copyCaptions: true, copyLayout: true },
    captionPolicy: { wordsPerCue: 8 },
    warnings: [],
    unsupported: [],
  };
  project.styleParameters = { captionScale: 1.2 };
  project.styleCopy = { copyCaptions: true, copyLayout: true };
  await prepareWorkspace(project, "chat-edit", { refreshSkill: true });
  const reusableBrief = JSON.parse(await readFile(join(dir, "brief.json"), "utf8"));
  assert.equal(reusableBrief.styleTransferPath, "style-transfer.json");
  const reusableTransfer = JSON.parse(await readFile(join(dir, "style-transfer.json"), "utf8"));
  assert.equal(reusableTransfer.contract, "style-transfer-brief.v1");
  assert.equal(reusableTransfer.stylePackId, "style-reuse-test");
  assert.equal(reusableTransfer.rules.doNotReuseReferenceTranscript, true);
  assert.equal(reusableTransfer.styleSpec.captions.maxCharsPerCue, 8);
  console.log("claude-code-editor.verify: skill paths, prompt contract, and refresh behavior passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
