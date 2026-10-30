import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapVisualEventsToClip, probeOutput, renderProject } from "./render.mjs";

const visualEvents = [
  { id: "hook", type: "title_card", startMs: 500, endMs: 2000, text: "Clean creator hook", subtext: "Show the promise" },
  { id: "point", type: "emphasis", startMs: 3500, endMs: 5200, text: "The key idea" },
  { id: "cta", type: "cta", startMs: 9500, endMs: 11500, text: "What do you think?", subtext: "Tell me below" },
];

assert.deepEqual(mapVisualEventsToClip(visualEvents, 4000, 7000), [
  { ...visualEvents[1], startMs: 0, endMs: 1200 },
], "an event crossing into a retained clip must be clipped and rebased to local time");
assert.deepEqual(mapVisualEventsToClip(visualEvents, 7000, 9000), [], "events outside a retained clip must not be rendered");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-visual-render-"));
try {
  const input = path.resolve("../openchatcut-src/test-assets/vibe-coding-sample.mp4");
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  const inputPath = path.join(projectDir, "input.mp4");
  await fs.copyFile(input, inputPath);
  const transcript = {
    durationMs: 12000,
    segments: [{ startMs: 500, endMs: 5000, text: "Original caption is visible" }, { startMs: 7000, endMs: 11000, text: "Closing caption" }],
  };
  const plan = {
    summary: "Hook, emphasis and CTA",
    segments: [
      { id: "keep-1", startMs: 0, endMs: 4000, action: "keep", title: "Opening", note: "" },
      { id: "remove", startMs: 4000, endMs: 5000, action: "remove", title: "Pause", note: "" },
      { id: "keep-2", startMs: 5000, endMs: 12000, action: "keep", title: "Close", note: "" },
    ],
    shorts: [
      { startMs: 0, endMs: 3000, title: "Short 1" },
      { startMs: 2000, endMs: 5000, title: "Short 2" },
      { startMs: 5000, endMs: 8000, title: "Short 3" },
      { startMs: 7000, endMs: 10000, title: "Short 4" },
      { startMs: 9000, endMs: 12000, title: "Short 5" },
    ],
    visualEvents,
  };
  const project = {
    id: "verify-project", dir: projectDir,
    media: { path: inputPath, durationMs: 12000, width: 1280, height: 720, hasVideo: true, hasAudio: true },
    transcript, plan, artifacts: [],
  };

  await assert.rejects(renderProject({ ...project, plan: { ...plan, visualEvents: [] } }), /没有视觉编辑指令/);
  const first = await renderProject(project);
  assert.equal(first.qc.passed, true);
  assert.equal(first.qc.subtitlesBurnedIn, true);
  assert.equal(first.qc.visualEventCountApplied, visualEvents.length);
  assert.deepEqual([first.qc.main.width, first.qc.main.height], [1280, 720]);
  assert.ok(first.qc.shorts.every((short) => short.probe.width === 1080 && short.probe.height === 1920));
  const captions = await fs.readFile(path.join(projectDir, "artifacts", "captions.srt"), "utf8");
  assert.match(captions, /Original caption is visible/);
  const commandLog = await fs.readFile(path.join(projectDir, "artifacts", "ffmpeg-command.log"), "utf8");
  assert.match(commandLog, /drawbox/);
  const originalSize = (await fs.stat(path.join(projectDir, "artifacts", "wayne-case-01-final.mp4"))).size;

  const second = await renderProject({ ...project, artifacts: first.artifacts });
  assert.equal(second.qc.passed, true);
  assert.ok(second.artifacts.some((artifact) => artifact.name === "wayne-case-01-final-v2.mp4"));
  assert.equal((await fs.stat(path.join(projectDir, "artifacts", "wayne-case-01-final.mp4"))).size, originalSize);
  const latest = await probeOutput(path.join(projectDir, "artifacts", "wayne-case-01-final-v2.mp4"));
  assert.equal(latest.width, 1280);
  assert.equal(latest.height, 720);
  console.log("render.verify: visual overlays, captions, aspect-ratio QC, and versioned output passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
