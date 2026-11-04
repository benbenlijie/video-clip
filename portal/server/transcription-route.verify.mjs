import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

async function waitForFile(file, child, serverErrors) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (child.exitCode != null) throw new Error(`portal exited before parallel passes started: ${serverErrors()}`);
    try { await fs.access(file); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}; ${serverErrors()}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-transcription-route-"));
const storage = path.join(root, "storage");
const projectId = "parallel-asr-fixture";
const projectDir = path.join(storage, projectId);
const releasePath = path.join(root, "release-parallel-passes");
const cloudStarted = path.join(root, "cloud-started");
const whisperStarted = path.join(root, "whisper-started");
const cliPath = path.join(root, "fake-whisper.mjs");
const modelPath = path.join(root, "small-q5_1.bin");
const mediaPath = path.join(projectDir, "input.mp4");
const asrPort = await freePort();
const apiPort = await freePort();
await fs.mkdir(projectDir, { recursive: true });
await fs.writeFile(modelPath, "fixture model");
await fs.writeFile(cliPath, `#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises';
const args=process.argv.slice(2); const wav=args[args.indexOf('-f')+1]; const prefix=args[args.indexOf('-of')+1];
if (!wav.endsWith('transcript-audio.wav')) process.exit(8);
await writeFile(${JSON.stringify(whisperStarted)}, 'started');
let ready=false; for(let i=0;i<500;i++){try{await access(${JSON.stringify(releasePath)});ready=true;break}catch{} await new Promise(r=>setTimeout(r,10));}
if(!ready) process.exit(9);
await writeFile(prefix+'.srt','1\\n00:00:00,100 --> 00:00:00,900\\n本地 Whisper 稿\\n');
`);
await fs.chmod(cliPath, 0o755);
const generated = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x334433:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mediaPath]);
let generatedError = "";
generated.stderr.on("data", (chunk) => { generatedError += chunk; });
const [generatedCode] = await once(generated, "close");
assert.equal(generatedCode, 0, generatedError);
await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify({
  id: projectId, workflowId: "wayne-video-editing", status: "inspecting", goal: "test parallel ASR", style: "clean",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), artifacts: [], comments: [], brollAssets: [],
  media: { filename: "input.mp4", path: mediaPath, durationMs: 1000, width: 320, height: 180, hasAudio: true, hasVideo: true },
  transcript: null, transcription: null, plan: null, qc: null, error: null, upload: null, editSession: null,
}));

const cloudServer = createServer(async (_req, res) => {
  await fs.writeFile(cloudStarted, "started");
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { await fs.access(releasePath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 1000, result: { text: "云端 ASR 稿", audio_info: { duration: 1000 }, utterances: [{ start_time: 100, end_time: 900, text: "云端 ASR 稿" }] } }));
});
cloudServer.listen(asrPort, "127.0.0.1");
await once(cloudServer, "listening");
const child = spawn(process.execPath, [path.resolve("server/index.mjs")], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    PORT: String(apiPort), HOST: "127.0.0.1", WAYNE_STORAGE_DIR: storage, WAYNE_IGNORE_DOTENV: "1",
    VOLCENGINE_ASR_MODE: "fast", VOLCENGINE_ASR_API_KEY: "fixture-key", VOLCENGINE_ASR_BASE_URL: `http://127.0.0.1:${asrPort}/asr`,
    TENCENTCLOUD_SECRET_ID: "", TENCENTCLOUD_SECRET_KEY: "",
    WAYNE_WHISPER_CLI_PATH: cliPath, WAYNE_WHISPER_MODEL_PATH: modelPath, WAYNE_WHISPER_THREADS: "2", WAYNE_WHISPER_TIMEOUT_MS: "10000",
    OPENCHATCUT_MCP_URL: "http://127.0.0.1:1/api/external-mcp/mcp",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverStderr = "";
child.stderr.on("data", (chunk) => { serverStderr = (serverStderr + chunk).slice(-5000); });
const base = `http://127.0.0.1:${apiPort}`;
try {
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(health?.status, 200, `API failed to start: ${serverStderr}`);
  const advance = fetch(`${base}/api/projects/${projectId}/advance`, { method: "POST" });
  await Promise.all([waitForFile(cloudStarted, child, () => serverStderr), waitForFile(whisperStarted, child, () => serverStderr)]);
  await fs.writeFile(releasePath, "release");
  const response = await advance;
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const project = JSON.parse(responseText);
  assert.equal(project.status, "transcript_ready");
  assert.equal(project.transcript.text, "云端 ASR 稿");
  assert.equal(project.transcription.primary.status, "complete");
  assert.equal(project.transcription.secondary.status, "complete");
  assert.equal(project.transcription.secondary.model, "small_q5_1");
  assert.equal(project.config.localWhisper.available, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(projectDir, "transcript.original.json"), "utf8")).transcript.provider, "volcengine");
  assert.equal(JSON.parse(await fs.readFile(path.join(projectDir, "transcript.whisper.json"), "utf8")).transcript.text, "本地 Whisper 稿");
  console.log("transcription-route.verify: one WAV feeds concurrently started cloud/local passes; both results persist in project state");
} finally {
  await fs.writeFile(releasePath, "release").catch(() => undefined);
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  await new Promise((resolve) => cloudServer.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
