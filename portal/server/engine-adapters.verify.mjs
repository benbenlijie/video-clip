import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const root = path.resolve("server");
const storage = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-engine-adapter-"));
const port = await freePort();
const project = {
  id: "timeline-fixture",
  workflowId: "wayne-video-editing",
  status: "plan_ready",
  goal: "test timeline export",
  style: "clean",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  artifacts: [],
  comments: [],
  brollAssets: [],
  media: { filename: "/private/wayne/input.mp4", path: "/private/wayne/input.mp4", durationMs: 10000, width: 1920, height: 1080, hasAudio: true, hasVideo: true },
  transcript: { language: "en", segments: [{ startMs: 0, endMs: 1200, text: "Hello" }] },
  plan: {
    summary: "A short edit",
    segments: [{ id: "segment-1", startMs: 0, endMs: 1200, action: "keep", title: "Main", note: "Keep" }],
    shorts: [],
    visualEvents: [{ id: "hook", type: "title_card", startMs: 0, endMs: 800, text: "Hello", subtext: "" }],
    brollEvents: [{ id: "broll-1", assetId: "asset-1", startMs: 200, endMs: 600, sourceStartMs: 500 }],
  },
  brollAssets: [{ id: "asset-1", filename: "cutaway.mp4", path: "/private/wayne/cutaway.mp4", durationMs: 5000, width: 1280, height: 720, licenseConfirmed: true, licenseName: "Pexels" }],
};
const missingPlan = { ...project, id: "no-plan", plan: null };
const seed = async (value) => {
  const dir = path.join(storage, value.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(value));
};
await seed(project);
await seed(missingPlan);
const mediaPath = path.join(storage, project.id, "input.mp4");
await fs.mkdir(path.dirname(mediaPath), { recursive: true });
const sampleVideo = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x334433:s=320x180:r=30:d=1.2", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mediaPath]);
let sampleError = "";
sampleVideo.stderr.on("data", (chunk) => { sampleError += chunk; });
const sampleCode = await new Promise((resolve, reject) => { sampleVideo.on("error", reject); sampleVideo.on("close", resolve); });
assert.equal(sampleCode, 0, sampleError);
project.media = { ...project.media, filename: "input.mp4", path: mediaPath, durationMs: 1200, width: 320, height: 180 };
await fs.writeFile(path.join(storage, project.id, "project.json"), JSON.stringify(project));

const child = spawn(process.execPath, [path.join(root, "index.mjs")], {
  cwd: path.resolve("."),
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WAYNE_STORAGE_DIR: storage, WAYNE_IGNORE_DOTENV: "1", OPENCHATCUT_MCP_URL: "http://127.0.0.1:1/api/external-mcp/mcp" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;
try {
  let health;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, `API failed to start: ${stderr}`);

  const enginesResponse = await fetch(`${base}/api/engines`);
  assert.equal(enginesResponse.status, 200);
  const engines = await enginesResponse.json();
  assert.equal(engines.engines.wayne.enabled, true);
  assert.equal(typeof engines.engines.remotion.enabled, "boolean");
  assert.equal(engines.engines.openchatcut.mode, "disabled");
  assert.equal(engines.engines.motionCanvas.mode, "template-authoring-only");

  const sidecarProbe = await fetch(`${base}/api/engines/openchatcut/probe`, { method: "POST" });
  assert.equal(sidecarProbe.status, 503);
  assert.equal((await sidecarProbe.json()).status, "offline");

  const openChatCutProjects = await fetch(`${base}/api/engines/openchatcut/projects`);
  assert.equal(openChatCutProjects.status, 503);
  const forwardedProjects = await fetch(`${base}/api/engines/openchatcut/projects`, { headers: { "X-Forwarded-For": "203.0.113.10" } });
  assert.equal(forwardedProjects.status, 403);
  const publicOriginProjects = await fetch(`${base}/api/engines/openchatcut/projects`, { headers: { Origin: "https://watchdeep.net" } });
  assert.equal(publicOriginProjects.status, 403);

  const timelineResponse = await fetch(`${base}/api/projects/${project.id}/timeline`);
  assert.equal(timelineResponse.status, 200);
  const timeline = await timelineResponse.json();
  assert.equal(timeline.contract, "timeline.v1");
  assert.equal(timeline.visualEvents[0].id, "hook");
  assert.equal(timeline.media.filename, "input.mp4");
  assert.equal(timeline.assets.broll[0].id, "asset-1");
  assert.equal(timeline.assets.broll[0].licenseConfirmed, true);
  assert.equal(JSON.stringify(timeline).includes("/private/wayne/input.mp4"), false);
  assert.equal(JSON.stringify(timeline).includes("/private/wayne/cutaway.mp4"), false);

  const missingTimeline = await fetch(`${base}/api/projects/${missingPlan.id}/timeline`);
  assert.equal(missingTimeline.status, 409);

  const remotionResponse = await fetch(`${base}/api/projects/${project.id}/render/remotion-preview`, { method: "POST" });
  if (engines.engines.remotion.enabled) {
    assert.equal(remotionResponse.status, 200);
    const renderedProject = await remotionResponse.json();
    assert.ok(renderedProject.artifacts.some((item) => item.kind === "overlay" && item.engine === "remotion"));
    assert.ok(renderedProject.artifacts.some((item) => item.kind === "remotion-preview" && item.engine === "remotion"));
    assert.ok(renderedProject.artifacts.some((item) => item.kind === "render-manifest" && item.engine === "remotion"));
    assert.ok(renderedProject.artifacts.some((item) => item.kind === "render-log" && item.engine === "remotion"));
    assert.ok(renderedProject.artifacts.some((item) => item.kind === "timeline" && item.engine === "remotion"));
    const manifestArtifact = renderedProject.artifacts.find((item) => item.kind === "render-manifest");
    const manifestResponse = await fetch(`${base}/api/projects/${project.id}/artifacts/${encodeURIComponent(manifestArtifact.name)}`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.engineVersion, "4.0.539");
    assert.match(manifest.inputs.timelineSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.inputs.sourceMediaSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.artifacts.find((item) => item.kind === "overlay").sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.artifacts.find((item) => item.kind === "timeline").sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.artifacts.find((item) => item.kind === "render-log").sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(manifest).includes(storage), false, "render manifest must not leak local paths");
  } else {
    assert.equal(remotionResponse.status, 503);
  }
  console.log("engine-adapters.verify: engine capability API, local-only OpenChatCut listing, and path-safe timeline endpoint passed");
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  await fs.rm(storage, { recursive: true, force: true });
}
