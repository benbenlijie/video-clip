import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeOutput } from "./render.mjs";
import { renderMultiAssetProject } from "./multi-asset-render.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-multi-render-"));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`)));
});
try {
  const source = path.join(root, "fixture.mp4");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  const musicPath = path.join(root, "music.wav");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "pcm_s16le", musicPath]);
  const assetsDir = path.join(root, "assets");
  await fs.mkdir(assetsDir, { recursive: true });
  const paths = [path.join(assetsDir, "a1.mp4"), path.join(assetsDir, "a2.mp4")];
  await fs.copyFile(source, paths[0]);
  await fs.copyFile(source, paths[1]);
  const overlayPath = path.join(assetsDir, "a3.mp4");
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=green:s=320x240:r=30:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", overlayPath]);
  const project = {
    id: "verify-multi", dir: root, workflowMode: "multi-asset-v1", goal: "test edit", style: "clean",
    brief: { rawText: "先开场，再展示内容", aspectRatio: "both", targetDurationMs: 2000 },
    assets: [...paths.map((assetPath, index) => ({ id: `a${index + 1}`, filename: `a${index + 1}.mp4`, path: assetPath, bytes: 1000, durationMs: 2000, width: 320, height: 240, hasVideo: true, hasAudio: true, role: "supporting", licenseConfirmed: true, status: "ready", analysisStatus: "ready", transcript: { text: `素材 ${index + 1}`, durationMs: 2000, segments: [{ startMs: 100, endMs: 700, text: `素材 ${index + 1}` }] } })), { id: "a3", filename: "a3.mp4", path: overlayPath, bytes: 500, durationMs: 1000, width: 320, height: 240, hasVideo: true, hasAudio: false, role: "broll", licenseConfirmed: true, status: "ready", analysisStatus: "ready", transcript: { text: "", durationMs: 1000, segments: [] } }],
    multiAssetPlan: {
      confirmed: true,
      summary: "使用两段素材组合",
      clips: [
        { id: "c1", sourceAssetId: "a1", sourceInMs: 0, sourceOutMs: 1000, timelineStartMs: 0, timelineEndMs: 1000, track: "video-main", purpose: "hook", reason: "开场" },
        { id: "broll-1", sourceAssetId: "a3", sourceInMs: 0, sourceOutMs: 500, timelineStartMs: 500, timelineEndMs: 1000, track: "video-overlay", purpose: "cutaway", reason: "覆盖镜头" },
        { id: "c2", sourceAssetId: "a2", sourceInMs: 500, sourceOutMs: 1500, timelineStartMs: 1000, timelineEndMs: 2000, track: "video-main", purpose: "content", reason: "主体" },
      ],
      overlays: [],
    },
    artifacts: [], music: { path: musicPath, filename: "music.wav", licenseConfirmed: true },
  };
  await assert.rejects(renderMultiAssetProject({ ...project, multiAssetPlan: { ...project.multiAssetPlan, confirmed: false } }), /用户确认/);
  const preview = await renderMultiAssetProject(project, { preview: true });
  assert.equal(preview.qc.passed, true);
  assert.deepEqual(preview.profiles.map((item) => [item.id, item.probe.width, item.probe.height]), [["landscape", 960, 540], ["portrait", 540, 960]]);
  assert.equal(preview.artifacts.filter((item) => item.kind === "preview").length, 2);
  assert.ok(preview.artifacts.some((item) => item.kind === "qc"));
  const result = await renderMultiAssetProject(project);
  assert.equal(result.qc.passed, true);
  assert.deepEqual(result.profiles.map((item) => [item.id, item.probe.width, item.probe.height]), [["landscape", 1920, 1080], ["portrait", 1080, 1920]]);
  assert.equal(result.artifacts.filter((item) => item.kind === "video").length, 2);
  assert.equal(result.qc.sourceAssetCount, 2);
  assert.equal(result.qc.musicMixed, true);
  const sampledPixel = await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.7", "-i", path.join(root, "artifacts", "multi-landscape.mp4"), "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`sample frame ffmpeg exited ${code}`)));
  });
  assert.equal(sampledPixel.length, 3);
  assert.ok(sampledPixel[1] > sampledPixel[0] * 1.4 && sampledPixel[1] > sampledPixel[2] * 1.4, `the late B-roll overlay should be visible at 0.7s; pixel=${[...sampledPixel]}`);
  const secondClipCaptions = await fs.readFile(path.join(root, "render-work", "multi-v1", "landscape", "captions-2.srt"), "utf8");
  assert.match(secondClipCaptions, /00:00:00,000 --> 00:00:00,200/, "caption times for a later source clip must be clipped and rebased to that clip's local timeline");
  for (const item of result.artifacts.filter((artifact) => artifact.kind === "video")) {
    const probe = await probeOutput(path.join(root, "artifacts", item.name));
    assert.ok(probe.durationMs >= 1900 && probe.durationMs <= 2200);
  }
  const firstLandscape = path.join(root, "artifacts", "multi-landscape.mp4");
  const firstBytes = await fs.readFile(firstLandscape);
  const second = await renderMultiAssetProject(project);
  assert.ok(second.artifacts.some((item) => item.name === "multi-landscape-v2.mp4"));
  assert.deepEqual(await fs.readFile(firstLandscape), firstBytes, "a later render must preserve prior profile artifacts");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("multi-asset-render.verify: confirmed plan, dual profiles, source mapping, subtitles, and QC passed");
