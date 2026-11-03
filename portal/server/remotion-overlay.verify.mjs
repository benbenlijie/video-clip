import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compositeRemotionPreview, renderRemotionOverlay } from "./remotion-overlay.mjs";
import { probeOutput } from "./render.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-remotion-overlay-"));
const inputPath = path.join(root, "input.mp4");
const overlayPath = path.join(root, "overlay.mov");
const previewPath = path.join(root, "preview.mp4");
const timeline = {
  contract: "timeline.v1",
  project: { id: "remotion-test", workflowId: "wayne-video-editing", goal: "Test overlay", style: "clean", sourceVersion: 1 },
  media: { assetId: "source-video", filename: "input.mp4", durationMs: 1200, width: 320, height: 180, hasAudio: true, hasVideo: true },
  transcript: null,
  assets: { broll: [] },
  segments: [{ id: "segment-1", startMs: 0, endMs: 1200, action: "keep", title: "Main", note: "" }],
  visualEvents: [{ id: "hook", type: "title_card", startMs: 0, endMs: 800, text: "Remotion output", subtext: "alpha test" }],
  brollEvents: [],
  shorts: [],
  music: null,
};

const ffmpeg = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x334433:s=320x180:r=30:d=1.2", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", inputPath]);
let ffmpegError = "";
ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk; });
const code = await new Promise((resolve, reject) => { ffmpeg.on("error", reject); ffmpeg.on("close", resolve); });
assert.equal(code, 0, ffmpegError);

try {
  const overlay = await renderRemotionOverlay({ timeline, outputPath: overlayPath });
  assert.equal(overlay.alpha, true);
  assert.equal(overlay.width, 320);
  assert.equal(overlay.height, 180);
  const preview = await compositeRemotionPreview({ inputPath, overlayPath, outputPath: previewPath });
  assert.equal(preview.width, 320);
  assert.equal(preview.height, 180);
  const probe = await probeOutput(previewPath);
  assert.equal(probe.hasAudio, true);
  assert.ok(probe.durationMs >= 1100 && probe.durationMs <= 1300);
  await assert.rejects(renderRemotionOverlay({ timeline, outputPath: overlayPath }), /overwrite/i);
  console.log("remotion-overlay.verify: actual Remotion alpha render, FFmpeg composite, and output probe passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
