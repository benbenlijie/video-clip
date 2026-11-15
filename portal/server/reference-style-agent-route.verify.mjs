import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createServer } from "node:net";

const execFile = promisify(execFileCallback);
const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-agent-route-"));
const styleRoot = join(root, "style-library");
const fakeClaude = join(root, "fake-claude.js");
const reference = join(root, "reference.mp4");
await execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30:duration=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", reference], { timeout: 60000 });
await fs.writeFile(fakeClaude, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const dir = process.cwd();
const configIndex = process.argv.indexOf("--mcp-config");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : "";
const isReview = configPath.includes("mcp-style-review");
const phase = isReview ? "review" : "authoring";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const imageCount = Array.isArray(message.message?.content) ? message.message.content.filter((item) => item.type === "image").length : 0;
  const text = Array.isArray(message.message?.content) ? message.message.content.find((item) => item.type === "text")?.text || "" : "";
  fs.appendFileSync(process.env.VISION_COUNTS_PATH, JSON.stringify({ phase, imageCount, text }) + "\\n");
  if (!isReview) {
    fs.writeFileSync(path.join(dir, "analysis.json"), JSON.stringify({
      contract: "reference-analysis.v1",
      analysisId: "agent-analysis-fixture",
      source: { filename: "reference.mp4", durationMs: 30000, width: 160, height: 284, aspectRatio: "9:16", fps: 30, hasAudio: true, sha256: "a".repeat(64) },
      shots: [{ id: "shot-01", startMs: 0, endMs: 30000, role: "hook", layout: "full", broll: false }],
      rhythm: { hookMs: 30000, avgShotMs: 30000, cutsPerMinute: 0, punchInRatio: 0, brollRatio: 0 },
      captions: { grouping: "phrase", maxWordsPerCue: 4, position: "bottom", fontSizeRatio: 0.05, primaryColor: "#ffffff", strokeColor: "#111111", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
      overlays: [], audio: { bpm: null, voice: "unknown", sfxDensity: "none" },
      capabilities: { needsBroll: false, needsScreenshots: false, needsSplitScreen: false },
      unsupported: [], confidence: { overall: 0.8, rhythm: 0.8, captions: 0.8, layout: 0.7 }
    }, null, 2));
    fs.copyFileSync(path.join(dir, "reference.mp4"), path.join(dir, "style-proof.mov"));
    fs.writeFileSync(path.join(dir, "validation.json"), JSON.stringify({ passed: true, alpha: true, networkIsolated: true, proofSha256: "b".repeat(64), codeSha256: "c".repeat(64) }, null, 2));
    fs.mkdirSync(path.join(dir, "style-project"), { recursive: true });
    fs.writeFileSync(path.join(dir, "style-project", "style-manifest.json"), JSON.stringify({ id: "agent-style-fixture", version: 1, contract: "style-manifest.v1" }, null, 2));
  } else {
    fs.writeFileSync(path.join(dir, "style-pack.json"), JSON.stringify({ id: "agent-style-fixture", version: 1, status: "pending_approval", codeSha256: "c".repeat(64), manifest: { id: "agent-style-fixture", version: 1 } }, null, 2));
  }
  console.log(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fixture turn passed" }));
});
input.on("close", () => process.exit(0));
`);
await fs.chmod(fakeClaude, 0o755);

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const port = await freePort();
const child = (await import("node:child_process")).spawn(process.execPath, [resolve("server/index.mjs")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    WAYNE_STORAGE_DIR: join(root, "storage"),
    WAYNE_STYLE_DIR: styleRoot,
    WAYNE_STYLE_AGENT: "claude-code",
    CLAUDE_BIN: fakeClaude,
    WAYNE_IGNORE_DOTENV: "1",
    REFERENCE_STYLE_ENABLED: "1",
    REFERENCE_STYLE_STAGE: "admin",
    REFERENCE_STYLE_VISUAL_ANALYSIS: "0",
    REFERENCE_STYLE_AUDIO_ANALYSIS: "0",
    VISION_COUNTS_PATH: join(root, "vision-counts.jsonl"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(health?.status, 200, stderr);
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(reference)], { type: "video/mp4" }), "reference.mp4");
  form.append("referenceUsageConfirmed", "true");
  const response = await fetch(`http://127.0.0.1:${port}/api/reference-styles?mode=single-video-v1`, { method: "POST", body: form });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.analysis.analysisId, "agent-analysis-fixture");
  assert.equal(body.stylePack.status, "pending_approval");
  assert.equal(body.stylePack.id, "agent-style-fixture");
  const visionCounts = (await fs.readFile(join(root, "vision-counts.jsonl"), "utf8")
    .catch(() => ""))
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(visionCounts.find((entry) => entry.phase === "authoring")?.imageCount >= 10);
  assert.ok(visionCounts.find((entry) => entry.phase === "review")?.imageCount >= 8);
  assert.match(visionCounts.find((entry) => entry.phase === "authoring")?.text || "", /StyleSpec v2/);
  assert.match(visionCounts.find((entry) => entry.phase === "review")?.text || "", /update_style_spec/);
  assert.match(visionCounts.find((entry) => entry.phase === "review")?.text || "", /Do not call probe_reference, detect_reference_shots, write_reference_analysis, or create_style_project/);
  console.log("reference-style-agent-route.verify: default Claude Code branch, fake agent handoff, and pending StylePack response passed");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("close", done));
  }
  await fs.rm(root, { recursive: true, force: true });
}
