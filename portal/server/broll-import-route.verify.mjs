import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-broll-import-"));
const storage = path.join(root, "storage");
const projectId = "broll-import-fixture";
const projectDir = path.join(storage, projectId);
const videoPath = path.join(root, "candidate.mp4");
const preloadPath = path.join(root, "fake-provider-fetch.mjs");
await fs.mkdir(projectDir, { recursive: true });
const generated = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
assert.equal(generated.status, 0, generated.stderr?.toString());
await fs.writeFile(preloadPath, `
import { readFile } from "node:fs/promises";
const realFetch = globalThis.fetch;
const video = await readFile(${JSON.stringify(videoPath)});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ scenes: [{ id: "finance", visualIntent: "family reviewing long-term finances together", queries: ["family finance planning"] }] }) }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "pixabay.com") {
    return new Response(JSON.stringify({ hits: [{ id: 4242, tags: "family finance planning", pageURL: "https://pixabay.com/videos/id-4242/", user: "Fixture", user_id: 1, downloads: 10, videos: { large: { url: "https://cdn.pixabay.com/video/fixture.mp4", width: 320, height: 240, thumbnail: "https://cdn.pixabay.com/video/fixture.jpg" } } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "cdn.pixabay.com") {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return new Response(video, { status: 200, headers: { "content-length": String(video.length), "content-type": "video/mp4" } });
  }
  return realFetch(input, init);
};
`);
await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify({
  id: projectId,
  workflowId: "wayne-video-editing",
  workflowMode: "single-video-v1",
  compositionMode: "remotion-main.v1",
  status: "plan_ready",
  goal: "family finance planning",
  style: "reference style",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  artifacts: [],
  comments: [],
  brollAssets: [],
  media: { filename: "input.mp4", durationMs: 2000, width: 320, height: 480, hasAudio: true, hasVideo: true },
  transcript: { provider: "fixture", text: "family finance planning explanation", segments: [{ id: "one", startMs: 0, endMs: 2000, text: "family finance planning explanation" }] },
  plan: { summary: "stale", segments: [], shorts: [], visualEvents: [], brollEvents: [] },
  qc: { passed: true },
  error: null,
  upload: null,
  editSession: null,
}));
const otherProjectId = "broll-import-other";
const otherProjectDir = path.join(storage, otherProjectId);
await fs.mkdir(otherProjectDir, { recursive: true });
const projectFixture = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
await fs.writeFile(path.join(otherProjectDir, "project.json"), JSON.stringify({ ...projectFixture, id: otherProjectId }));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--import", preloadPath, "server/index.mjs"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    WAYNE_STORAGE_DIR: storage,
    WAYNE_IGNORE_DOTENV: "1",
    PEXELS_API_KEY: "",
    PIXABAY_API_KEY: "fixture-key",
    ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_MODEL: "fixture-model",
    OPENCHATCUT_MCP_URL: "http://127.0.0.1:1/api/external-mcp/mcp",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
try {
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; } } catch { /* Wait for bind. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(healthy, true, stderr);
  const searchResponse = await fetch(`${base}/api/projects/${projectId}/broll/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "family finance planning explanation", orientation: "landscape" }),
  });
  const searchText = await searchResponse.text();
  assert.equal(searchResponse.status, 200, searchText);
  const candidate = JSON.parse(searchText).scenes[0].candidates[0];
  assert.match(candidate.candidateHandle, /^[a-f0-9-]{36}$/i);
  const crossProject = await fetch(`${base}/api/projects/${otherProjectId}/broll/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidateHandle: candidate.candidateHandle }),
  });
  assert.equal(crossProject.status, 400, "candidate handles must be bound to the project that searched them");
  const secondSearchResponse = await fetch(`${base}/api/projects/${projectId}/broll/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "family finance planning explanation", orientation: "landscape" }),
  });
  const secondCandidate = JSON.parse(await secondSearchResponse.text()).scenes[0].candidates[0];
  const importOne = (candidateHandle) => fetch(`${base}/api/projects/${projectId}/broll/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidateHandle }),
  });
  const concurrent = await Promise.all([importOne(candidate.candidateHandle), importOne(secondCandidate.candidateHandle)]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 400], "concurrent duplicate imports must resolve to one asset");
  const importResponse = concurrent.find((response) => response.status === 201);
  const importText = await importResponse.text();
  const imported = JSON.parse(importText);
  assert.equal(imported.status, "transcript_ready");
  assert.equal(imported.plan, null);
  assert.equal(imported.qc, null);
  assert.equal(imported.brollAssets.length, 1);
  assert.equal(imported.brollAssets[0].provider, "pixabay");
  assert.equal(imported.brollAssets[0].providerId, "4242");
  assert.equal(imported.brollAssets[0].durationMs, 1000);
  assert.equal(imported.brollAssets[0].licenseConfirmed, true);
  assert.equal("path" in imported.brollAssets[0], false);
  assert.match(imported.brollAssets[0].sha256, /^[a-f0-9]{64}$/);
  const persisted = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
  assert.equal(persisted.plan, null);
  assert.equal(persisted.brollAssets[0].providerId, "4242");
  const duplicate = await fetch(`${base}/api/projects/${projectId}/broll/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidateHandle: candidate.candidateHandle }),
  });
  assert.equal(duplicate.status, 400);
  console.log("broll-import-route.verify: searched candidate imported with provenance, stale plan invalidated, public paths redacted");
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}
