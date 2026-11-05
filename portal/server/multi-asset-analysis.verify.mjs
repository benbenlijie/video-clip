import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeMultiAssetProject, buildAssetInventory } from "./multi-asset-analysis.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-multi-analysis-"));
try {
  const project = {
    id: "p1",
    dir: root,
    workflowMode: "multi-asset-v1",
    brief: { rawText: "先提出问题，再展示解决方式" },
    assets: [
      { id: "a1", filename: "one.mp4", path: path.join(root, "one.mp4"), durationMs: 3000, width: 1920, height: 1080, hasAudio: true, role: "main", status: "ready", analysisStatus: "pending" },
      { id: "a2", filename: "two.mp4", path: path.join(root, "two.mp4"), durationMs: 4000, width: 1080, height: 1920, hasAudio: false, role: "supporting", status: "ready", analysisStatus: "pending" },
    ],
  };
  const fixture = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", project.assets[0].path]);
  let fixtureError = "";
  fixture.stderr.on("data", (chunk) => { fixtureError += chunk; });
  const [fixtureCode] = await once(fixture, "close");
  assert.equal(fixtureCode, 0, fixtureError);
  const silentFixture = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", project.assets[1].path]);
  let silentFixtureError = "";
  silentFixture.stderr.on("data", (chunk) => { silentFixtureError += chunk; });
  const [silentFixtureCode] = await once(silentFixture, "close");
  assert.equal(silentFixtureCode, 0, silentFixtureError);
  let calls = 0;
  let transcribedAssetIds = [];
  const result = await analyzeMultiAssetProject(project, {
    transcribe: async ({ videoPath }) => { calls += 1; transcribedAssetIds.push(path.basename(videoPath)); return { primary: { provider: "fixture", transcript: { text: "第一段口播", durationMs: 3000, segments: [{ startMs: 100, endMs: 900, text: "第一段口播" }] } }, secondary: null, audioSha256: "a".repeat(64) }; },
    persist: async () => undefined,
    onAsset: async () => undefined,
  });
  assert.equal(calls, 1, "silent assets must not be submitted to speech recognition");
  assert.deepEqual(transcribedAssetIds, ["one.mp4"]);
  assert.equal(result.status, "ready");
  assert.equal(project.assets[0].analysisStatus, "ready");
  assert.equal(project.assets[0].visualEvidence.keyframeTimesMs.length, 3);
  assert.ok((await fs.stat(project.assets[0].visualEvidence.path)).size > 0);
  assert.equal(project.assets[1].analysisStatus, "ready", "silent video is valid visual material and must not fail analysis");
  assert.equal(project.assets[1].transcript.text, "");
  assert.match(await fs.readFile(path.join(root, "assets", "a1", "transcript.json"), "utf8"), /第一段口播/);
  const inventory = await buildAssetInventory(project);
  assert.equal(inventory.assets.length, 2);
  assert.equal(inventory.assets[0].transcript.segments[0].text, "第一段口播");
  assert.equal(inventory.assets[0].visualEvidence.keyframeTimesMs.length, 3);
  assert.equal(inventory.assets[1].transcript.text, "");
  assert.equal(JSON.stringify(inventory).includes(root), false, "inventory must not expose local paths");

  const failedProject = { ...project, assets: [{ ...project.assets[0], analysisStatus: "failed" }, project.assets[1]] };
  await assert.rejects(analyzeMultiAssetProject(failedProject, { transcribe: async () => { throw new Error("fixture ASR failure"); }, persist: async () => undefined, onAsset: async () => undefined }), /fixture ASR failure/);
  assert.equal(failedProject.assets[0].analysisStatus, "failed");
  assert.throws(() => buildAssetInventory(failedProject), /分析失败/);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("multi-asset-analysis.verify: isolated transcript paths, retry, failure gating, and path privacy passed");
