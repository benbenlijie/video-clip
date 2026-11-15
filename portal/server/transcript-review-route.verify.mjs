import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { transcriptFingerprint } from "./transcript-proofreading.mjs";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-transcript-review-route-"));
const port = await freePort();
const project = {
  id: "transcript-review-fixture", workflowId: "wayne-video-editing", status: "plan_ready", goal: "review transcript", style: "clean",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), artifacts: [], comments: [], brollAssets: [],
  media: { filename: "input.mp4", path: "unused", durationMs: 3000, width: 720, height: 1280, hasAudio: true, hasVideo: true },
  transcript: { provider: "volcengine", language: "zh", durationMs: 3000, text: "把繁琐的剪辑工具交给AI然后检查字幕", segments: [{ id: "segment-1", startMs: 100, endMs: 1400, text: "把繁琐的剪辑工具交给AI", words: [{ startMs: 100, endMs: 1400, text: "把繁琐的剪辑工具交给AI" }] }, { id: "segment-2", startMs: 1500, endMs: 2800, text: "然后检查字幕", words: [{ startMs: 1500, endMs: 2200, text: "然后检查" }, { startMs: 2200, endMs: 2800, text: "字幕" }] }] },
  proofreading: { status: "needs_review", model: "small_q5_1", changes: [], unresolved: [{ segmentId: "segment-2", primaryText: "然后检查字幕", secondaryText: "然后检查字母", reason: "末字识别不同" }], previewTranscriptSha256: "previous-preview-hash", previewStale: false },
  plan: { segments: [{ startMs: 0, endMs: 3000, action: "keep" }] }, qc: { passed: true },
};
const projectDir = path.join(storage, project.id);
await fs.mkdir(projectDir, { recursive: true });
await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project));
await fs.writeFile(path.join(projectDir, "transcript-audio.wav"), Buffer.from("RIFFfixture"));
await fs.writeFile(path.join(projectDir, "transcript.original.json"), JSON.stringify(project.transcript));
await fs.writeFile(path.join(projectDir, "transcript.srt"), "previous srt");
const originalBytes = await fs.readFile(path.join(projectDir, "transcript.original.json"));
const legacyProjectDir = path.join(storage, "legacy-transcript-fixture");
await fs.mkdir(legacyProjectDir, { recursive: true });
const legacyProject = { ...project, id: "legacy-transcript-fixture", status: "completed", proofreading: undefined, primaryTranscript: undefined, secondaryTranscript: undefined, transcription: undefined };
await fs.writeFile(path.join(legacyProjectDir, "project.json"), JSON.stringify(legacyProject));

const child = spawn(process.execPath, [path.resolve("server/index.mjs")], {
  cwd: path.resolve("."),
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WAYNE_STORAGE_DIR: storage, WAYNE_IGNORE_DOTENV: "1", OPENCHATCUT_MCP_URL: "http://127.0.0.1:1/api/external-mcp/mcp" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
const base = `http://127.0.0.1:${port}`;
try {
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(health?.status, 200, `API failed to start: ${stderr}`);
  const migrated = await (await fetch(`${base}/api/projects/${legacyProject.id}`)).json();
  assert.equal(migrated.proofreading.status, "manual_review_required");
  assert.equal(migrated.proofreading.previewStale, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(legacyProjectDir, "project.json"), "utf8")).proofreading, undefined, "opening a legacy project must not persist a bulk migration on GET");
  await assert.rejects(fs.access(path.join(legacyProjectDir, "transcript.original.json")), "legacy transcript backup is created only when a user confirms a correction");
  const legacyReview = await fetch(`${base}/api/projects/${legacyProject.id}/transcript`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segments: legacyProject.transcript.segments, confirmedUnresolvedSegmentIds: legacyProject.transcript.segments.map((segment) => segment.id) }) });
  assert.equal(legacyReview.status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(legacyProjectDir, "transcript.original.json"), "utf8")).text, legacyProject.transcript.text);
  const audio = await fetch(`${base}/api/projects/${project.id}/transcript-audio`, { headers: { Range: "bytes=0-3" } });
  assert.equal(audio.status, 206);
  assert.equal(await audio.text(), "RIFF");

  const renderUrl = `${base}/api/projects/${project.id}/render`;
  const unresolvedRender = await fetch(renderUrl, { method: "POST" });
  assert.equal(unresolvedRender.status, 409);
  assert.match((await unresolvedRender.json()).error, /字幕.*待确认/);

  const url = `${base}/api/projects/${project.id}/transcript`;
  const editedSegments = project.transcript.segments.map((segment) => ({ ...segment, text: segment.id === "segment-2" ? "然后确认字幕" : segment.text }));
  const rejected = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segments: editedSegments, confirmedUnresolvedSegmentIds: [] }) });
  assert.equal(rejected.status, 400);
  assert.equal((await (await fetch(`${base}/api/projects/${project.id}`)).json()).transcript.segments[1].text, "然后检查字幕");

  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segments: editedSegments, confirmedUnresolvedSegmentIds: ["segment-2"] }) });
  assert.equal(response.status, 200, await response.text());
  const updated = JSON.parse(await (await fetch(`${base}/api/projects/${project.id}`)).text());
  assert.equal(updated.transcript.segments[1].text, "然后确认字幕");
  assert.equal(updated.transcript.segments[1].wordTimingStatus, "estimated", "manual text corrections must mark reconstructed word timings as estimates");
  assert.equal(updated.transcript.segments[1].words.map((word) => word.text).join(""), "然后确认字幕", "corrected caption text must be covered by remapped word timings");
  assert.ok(updated.transcript.segments[1].words.every((word) => word.startMs >= 1500 && word.endMs <= 2800 && word.endMs > word.startMs));
  assert.deepEqual(updated.transcript.segments[0].words, project.transcript.segments[0].words, "unchanged transcript segments retain their word timestamps");
  assert.equal(updated.proofreading.status, "confirmed");
  assert.equal(updated.proofreading.previewStale, true);
  assert.equal(updated.proofreading.resolvedUnresolved[0].resolution, "user-corrected");
  assert.equal(updated.qc, null);
  const stalePreviewRender = await fetch(renderUrl, { method: "POST" });
  assert.equal(stalePreviewRender.status, 409);
  assert.match((await stalePreviewRender.json()).error, /预览.*未更新/);
  assert.match(await fs.readFile(path.join(projectDir, "transcript.srt"), "utf8"), /然后确认字幕/);
  assert.deepEqual(await fs.readFile(path.join(projectDir, "transcript.original.json")), originalBytes);
  assert.equal(project.proofreading.previewTranscriptSha256, "previous-preview-hash");

  console.log("transcript-review-route.verify: audio seek route, confirmation gate, SRT persistence and stale-preview marker passed");
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  await fs.rm(storage, { recursive: true, force: true });
}
