import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveAgentOutput, validateAgentOutput } from "./claude-code-editor.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-claude-remotion-"));
const control = path.join(path.dirname(root), `.control-${path.basename(root)}`);
const auditPath = path.join(control, "tools-plan.jsonl");
const inputPath = path.join(root, "input.mp4");
const media = { filename: "input.mp4", durationMs: 2000, width: 320, height: 180, hasAudio: true, hasVideo: true };
const projectId = "claude-remotion-fixture";
const originalTranscript = { provider: "volcengine", language: "zh", text: "把烦做的剪辑工具交给AI", durationMs: 2000, segments: [{ id: "segment-1", startMs: 100, endMs: 1600, text: "把烦做的剪辑工具交给AI" }] };
const secondaryTranscript = { provider: "whisper.cpp", model: "small_q5_1", language: "zh", text: "把繁琐的剪辑工具交给AI", durationMs: 2000, segments: [{ id: "whisper-1", startMs: 100, endMs: 1600, text: "把繁琐的剪辑工具交给AI" }] };
const transcript = { ...originalTranscript, text: secondaryTranscript.text, segments: [{ ...originalTranscript.segments[0], text: secondaryTranscript.segments[0].text }] };
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
  fs.writeFile(path.join(root, "transcript.json"), JSON.stringify(transcript)),
  fs.writeFile(path.join(root, "transcript.original.json"), JSON.stringify(originalTranscript)),
  fs.writeFile(path.join(root, "transcript.whisper.json"), JSON.stringify(secondaryTranscript)),
  fs.writeFile(path.join(root, "transcript-proofread.json"), JSON.stringify({ status: "ready", transcript, changes: [{ segmentId: "segment-1", before: originalTranscript.segments[0].text, after: transcript.segments[0].text, evidence: "whisper", reason: "Whisper 第二识别支持该口语词" }], unresolved: [] })),
  fs.writeFile(path.join(root, "assets.json"), JSON.stringify({ broll: [], music: null })),
  fs.writeFile(path.join(root, "edit-plan.json"), JSON.stringify(plan)),
  fs.writeFile(path.join(root, "captions.srt"), "1\n00:00:00,100 --> 00:00:01,600\n把繁琐的剪辑工具交给AI\n"),
  fs.writeFile(path.join(root, "source.mjs"), "export const fixture = true;\n"),
  fs.writeFile(path.join(root, "pipeline.filter"), "[0:v]null[v]\n"),
  fs.writeFile(path.join(root, "commands.log"), "ffmpeg -i input.mp4\n"),
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
    phase: "plan", main: result.previewPath, subtitle: "captions.srt", sources: ["edit-plan.json", "source.mjs", "pipeline.filter", "commands.log"], shorts: [], broll: [],
    review: { passed: true, notes: "Inspected source and Remotion comparison frames." },
  }));
  await fs.writeFile(path.join(control, "session-plan.json"), JSON.stringify({ sessionId: "fixture", costUsd: 0 }));
  const project = { id: projectId, dir: root, media, editor: { version: 1 }, artifacts: [], transcript: originalTranscript, transcription: { model: "small_q5_1" } };
  const saved = await saveAgentOutput(project, "plan", root, "11111111-1111-4111-8111-111111111111", { sessionId: "fixture", costUsd: 0 });
  assert.ok(saved.artifacts.some((artifact) => artifact.kind === "remotion-preview" && artifact.engine === "remotion" && artifact.createdBy === "claude-code"));
  assert.equal(project.transcript.segments[0].text, "把繁琐的剪辑工具交给AI");
  assert.equal(project.proofreading.status, "ready");
  assert.ok(saved.artifacts.some((artifact) => artifact.kind === "transcript-proofreading"));
  const logged = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(logged.some((entry) => entry.tool === "render_remotion_preview" && entry.previewPath === result.previewPath));
  const storedPreview = saved.artifacts.find((artifact) => artifact.kind === "remotion-preview");
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(root, "artifacts", storedPreview.name))).digest("hex"), result.sha256.preview);
  await fs.writeFile(path.join(root, "captions.srt"), "1\n00:00:00,100 --> 00:00:01,600\n把凡速的剪辑工具交给AI\n");
  await assert.rejects(validateAgentOutput(root, "plan"), /字幕文字与当前校对转录不一致/);
  await fs.writeFile(path.join(root, "captions.srt"), "1\n00:00:00,100 --> 00:00:01,600\n把繁琐的剪辑工具交给AI\n");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.sources = [...manifest.sources, "unknown.bin"];
  await fs.writeFile(path.join(root, "unknown.bin"), "fixture\n");
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(validateAgentOutput(root, "plan"), /不支持的工程源码类型/);
  console.log("claude-remotion-tools.verify: Claude MCP tool rendered, visually inspected, and persisted a Remotion comparison preview");
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(control, { recursive: true, force: true });
}
