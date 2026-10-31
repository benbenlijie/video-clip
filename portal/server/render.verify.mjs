import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBlackFrames, mapBrollEventsToClip, mapVisualEventsToClip, probeOutput, renderProject } from "./render.mjs";

const visualEvents = [
  { id: "hook", type: "title_card", startMs: 500, endMs: 2000, text: "Clean creator hook", subtext: "Show the promise" },
  { id: "point", type: "emphasis", startMs: 3500, endMs: 5200, text: "The key idea" },
  { id: "cta", type: "cta", startMs: 9500, endMs: 11500, text: "What do you think?", subtext: "Tell me below" },
];

assert.deepEqual(mapVisualEventsToClip(visualEvents, 4000, 7000), [
  { ...visualEvents[1], startMs: 0, endMs: 1200 },
], "an event crossing into a retained clip must be clipped and rebased to local time");
assert.deepEqual(mapVisualEventsToClip(visualEvents, 7000, 9000), [], "events outside a retained clip must not be rendered");
const brollEvent = { id: "screen-cutaway", assetId: "screen-demo", startMs: 4000, endMs: 7000, sourceStartMs: 500 };
assert.deepEqual(mapBrollEventsToClip([brollEvent], 5000, 7000), [{ ...brollEvent, startMs: 0, endMs: 2000, sourceStartMs: 1500 }], "trimmed edit ranges preserve both output and source offsets");
assert.deepEqual(mapBrollEventsToClip([brollEvent], 0, 3500), [], "B-roll outside a retained clip is not applied");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-visual-render-"));
try {
  const input = path.resolve("../openchatcut-src/test-assets/vibe-coding-sample.mp4");
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir, { recursive: true });
  const inputPath = path.join(projectDir, "input.mp4");
  await fs.copyFile(input, inputPath);
  const musicPath = path.join(projectDir, "licensed-music.wav");
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", musicPath]);
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`music fixture ffmpeg exited ${code}`)));
  });
  const blackPath = path.join(projectDir, "black-fixture.mp4");
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=0.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", blackPath]);
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`black fixture ffmpeg exited ${code}`)));
  });
  assert.ok((await detectBlackFrames(blackPath)).length > 0, "QC should find sustained black frames in a real video file");
  const brollPath = path.join(projectDir, "screen-demo.mp4");
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", brollPath]);
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`broll fixture ffmpeg exited ${code}`)));
  });
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
    brollEvents: [{ id: "cutaway", assetId: "screen-demo", startMs: 6000, endMs: 7000, sourceStartMs: 0 }],
    visualEvents,
  };
  const project = {
    id: "verify-project", dir: projectDir,
    media: { path: inputPath, durationMs: 12000, width: 1280, height: 720, hasVideo: true, hasAudio: true },
    transcript, plan, artifacts: [],
    brollAssets: [{ id: "screen-demo", filename: "screen-demo.mp4", path: brollPath, durationMs: 2000, width: 320, height: 240, licenseConfirmed: true }],
    music: { filename: "licensed-music.wav", path: musicPath },
  };

  await assert.rejects(renderProject({ ...project, plan: { ...plan, visualEvents: [] } }), /没有视觉编辑指令/);
  let first;
  try { first = await renderProject(project); } catch (error) {
    console.error(JSON.stringify(JSON.parse(await fs.readFile(path.join(projectDir, "artifacts", "qc.json"), "utf8")), null, 2));
    throw error;
  }
  assert.equal(first.qc.passed, true);
  assert.equal(first.qc.subtitlesBurnedIn, true);
  assert.equal(first.qc.visualEventCountApplied, visualEvents.length);
  assert.equal(first.qc.musicMixed, true, "an uploaded music bed must be mixed into outputs and reported by QC");
  assert.equal(first.qc.hyperframesRendered, true, "the finished render must use a verified transparent HyperFrames overlay");
  assert.ok(first.artifacts.some((item) => item.name === "hyperframes-overlay-landscape.html"), "the reusable HyperFrames source must be delivered");
  assert.ok(first.artifacts.some((item) => item.name === "hyperframes-overlay-landscape.mov"), "the composited transparent layer must be delivered");
  assert.ok(first.artifacts.some((item) => item.name === "hyperframes-gsap.min.js"), "the source must include its pinned GSAP runtime");
  assert.equal(first.qc.audioVideoSyncChecked, true, "QC must compare output audio/video timing");
  assert.equal(first.qc.noUnexpectedBlackFrames, true, "QC must inspect the main video and all Shorts for black frames");
  assert.equal(first.qc.brollEventCountApplied, 1, "uploaded B-roll planned into a retained segment must be rendered");
  assert.deepEqual([first.qc.main.width, first.qc.main.height], [1280, 720]);
  assert.ok(first.qc.shorts.every((short) => short.probe.width === 1080 && short.probe.height === 1920));
  const captions = await fs.readFile(path.join(projectDir, "artifacts", "captions.srt"), "utf8");
  assert.match(captions, /Original caption is visible/);
  const commandLog = await fs.readFile(path.join(projectDir, "artifacts", "ffmpeg-command.log"), "utf8");
  assert.match(commandLog, /hyperframes-landscape\.mov/);
  assert.match(commandLog, /amix/, "the audio render must include the supplied music bed");
  assert.match(commandLog, /overlay=/, "the render must cut to the uploaded B-roll at its planned timestamp");
  const originalSize = (await fs.stat(path.join(projectDir, "artifacts", "wayne-case-01-final.mp4"))).size;

  const second = await renderProject({ ...project, artifacts: first.artifacts });
  assert.equal(second.qc.passed, true);
  assert.ok(second.artifacts.some((artifact) => artifact.name === "wayne-case-01-final-v2.mp4"));
  assert.equal((await fs.stat(path.join(projectDir, "artifacts", "wayne-case-01-final.mp4"))).size, originalSize);
  const latest = await probeOutput(path.join(projectDir, "artifacts", "wayne-case-01-final-v2.mp4"));
  assert.equal(latest.width, 1280);
  assert.equal(latest.height, 720);
  console.log("render.verify: HyperFrames overlays, B-roll, music, captions, QC, and versioned outputs passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
