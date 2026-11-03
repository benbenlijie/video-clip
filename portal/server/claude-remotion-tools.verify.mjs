import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveAgentOutput } from "./claude-code-editor.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-claude-remotion-"));
const control = path.join(path.dirname(root), `.control-${path.basename(root)}`);
const auditPath = path.join(control, "tools-plan.jsonl");
const inputPath = path.join(root, "input.mp4");
const media = { filename: "input.mp4", durationMs: 2000, width: 320, height: 180, hasAudio: true, hasVideo: true };
const projectId = "claude-remotion-fixture";
await fs.mkdir(control, { recursive: true });
const ffmpeg = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x334433:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", inputPath]);
let ffmpegError = "";
ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk; });
assert.equal(await new Promise((resolve, reject) => { ffmpeg.on("error", reject); ffmpeg.on("close", resolve); }), 0, ffmpegError);
await fs.copyFile(inputPath, path.join(root, "broll-downloaded.mp4"));
const downloadedBrollSha256 = createHash("sha256").update(await fs.readFile(path.join(root, "broll-downloaded.mp4"))).digest("hex");

const plan = {
  summary: "Remotion comparison fixture",
  segments: [{ id: "segment-1", startMs: 0, endMs: 2000, action: "keep", title: "Hook", note: "" }],
  shorts: [],
  visualEvents: [{ id: "hook", type: "title_card", startMs: 100, endMs: 1600, text: "真实样片", subtext: "Remotion 对照" }],
  brollEvents: [{ id: "broll-1", assetId: "downloaded-broll-1", startMs: 200, endMs: 700, sourceStartMs: 100 }],
};
await Promise.all([
  fs.writeFile(path.join(root, "brief.json"), JSON.stringify({ phase: "plan", projectId, goal: "Compare Remotion overlay", style: "clean", media })),
  fs.writeFile(path.join(root, "transcript.json"), JSON.stringify({ language: "zh", segments: [] })),
  fs.writeFile(path.join(root, "assets.json"), JSON.stringify({ broll: [], music: null })),
  fs.writeFile(path.join(root, "edit-plan.json"), JSON.stringify(plan)),
  fs.writeFile(path.join(root, "captions.srt"), "1\n00:00:00,100 --> 00:00:01,600\n真实样片\n"),
  fs.writeFile(path.join(root, "source.mjs"), "export const fixture = true;\n"),
  fs.writeFile(path.join(control, "broll-audit.jsonl"), `${JSON.stringify({ tool: "download_broll", assetId: "downloaded-broll-1", filename: "broll-downloaded.mp4", path: "broll-downloaded.mp4", provider: "pixabay", providerId: "fixture", sourceUrl: "https://pixabay.com/videos/fixture/", licenseName: "Pixabay Content License", licenseUrl: "https://pixabay.com/service/license-summary/", sha256: downloadedBrollSha256, durationMs: 2000, width: 320, height: 180 })}\n`),
]);

const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("./video-agent-tools.mjs", import.meta.url).pathname, root, auditPath] });
const client = new Client({ name: "claude-remotion-tools-verify", version: "1.0.0" });
try {
  await client.connect(transport);
  await fs.writeFile(path.join(root, "remotion-preview-1.mp4"), "previous attempt output");
  const rendered = await client.callTool({ name: "render_remotion_preview", arguments: {} });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered));
  const result = JSON.parse(rendered.content.find((item) => item.type === "text").text);
  assert.equal(result.engine, "remotion");
  assert.match(result.remotionVersion, /^4\.0\./);
  assert.equal(result.width, media.width);
  assert.equal(result.height, media.height);
  assert.match(result.overlayPath, /^remotion-preview-2-overlay\.mov$/);
  assert.match(result.previewPath, /^remotion-preview-2\.mp4$/);
  assert.match(result.sha256.preview, /^[a-f0-9]{64}$/);
  assert.match(result.timelineSha256, /^[a-f0-9]{64}$/);
  assert.match(result.sourceMediaSha256, /^[a-f0-9]{64}$/);

  for (const timeSeconds of [0.2, 0.8, 1.4]) {
    const frame = await client.callTool({ name: "view_frame", arguments: { video: result.previewPath, timeSeconds } });
    assert.ok(frame.content.some((item) => item.type === "image" && item.data.length > 100));
  }
  for (const timeSeconds of [0.2, 0.8, 1.4]) {
    const frame = await client.callTool({ name: "view_frame", arguments: { video: "input.mp4", timeSeconds } });
    assert.ok(frame.content.some((item) => item.type === "image" && item.data.length > 100));
  }

  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({
    phase: "plan", main: result.previewPath, subtitle: "captions.srt", sources: ["edit-plan.json", "source.mjs"], shorts: [], broll: [],
    review: { passed: true, notes: "Inspected source and Remotion comparison frames." },
  }));
  await fs.writeFile(path.join(control, "session-plan.json"), JSON.stringify({ sessionId: "fixture", costUsd: 0 }));
  const saved = await saveAgentOutput({ id: projectId, dir: root, media, editor: { version: 1 }, artifacts: [] }, "plan", root, "11111111-1111-4111-8111-111111111111", { sessionId: "fixture", costUsd: 0 });
  assert.ok(saved.artifacts.some((artifact) => artifact.kind === "remotion-preview" && artifact.engine === "remotion" && artifact.createdBy === "claude-code"));
  const logged = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(logged.some((entry) => entry.tool === "render_remotion_preview" && entry.previewPath === result.previewPath));
  const storedPreview = saved.artifacts.find((artifact) => artifact.kind === "remotion-preview");
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(root, "artifacts", storedPreview.name))).digest("hex"), result.sha256.preview);
  console.log("claude-remotion-tools.verify: Claude MCP tool rendered, visually inspected, and persisted a Remotion comparison preview");
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(control, { recursive: true, force: true });
}
