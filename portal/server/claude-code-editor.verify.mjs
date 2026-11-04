import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  assert.match(await readFile(join(dir, ".claude/skills/video-edit/references/editorial-grammar.md"), "utf8"), /BROLL_COVER/);
  assert.match(await readFile(join(dir, ".claude/skills/video-edit/SKILL.md"), "utf8"), /HyperFrames 不是可选装饰/);
  console.log("claude-code-editor.verify: skill paths, prompt contract, and refresh behavior passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
