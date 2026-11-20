import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await fs.mkdtemp(join(os.tmpdir(), "wayne-edit-review-"));
const workspace = join(root, "workspace");
const audit = join(root, ".edit-review", "audit.jsonl");
await fs.mkdir(workspace, { recursive: true });

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  });
}

const videoA = join(workspace, "a.mp4");
const videoB = join(workspace, "b.mp4");
await ffmpeg([
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1",
  "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1",
  "-f", "lavfi", "-i", "color=c=green:s=160x90:r=10:d=1",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
  "-map", "[v]", "-map", "3:a:0",
  "-c:v", "libx264", "-c:a", "aac", "-shortest", videoA,
]);
await ffmpeg([
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=3",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", videoB,
]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./edit-review-tools.mjs", import.meta.url).pathname, workspace, audit],
});
const client = new Client({ name: "edit-review-verify", version: "1.0.0" });

function jsonResult(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text || "unexpected tool error");
  return JSON.parse(result.content[0].text);
}

function dimension(id, score, label, timeSeconds = 1) {
  return {
    id,
    score,
    note: `${id} 的验证说明`,
    evidence: [{ video: label, timeSeconds, note: `${id} 的证据` }],
  };
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((item) => item.name).sort(),
    ["analyze_edit", "compare_edits", "extract_contact_sheet", "view_frame", "view_frame_region", "write_review_report"],
  );

  const analysis = jsonResult(await client.callTool({
    name: "analyze_edit",
    arguments: { video: "a.mp4" },
  }));
  assert.equal(analysis.contract, "talking-head-edit-analysis.v1");
  assert.equal(analysis.shots.cutCount, 2);
  assert.equal(analysis.metrics.cutsPerMinute, 40);
  assert.equal(analysis.audio.available, true);
  assert.ok(analysis.analysisPath.endsWith(".json"));
  assert.equal(await fs.stat(join(workspace, analysis.analysisPath)).then(() => true), true);

  const comparison = jsonResult(await client.callTool({
    name: "compare_edits",
    arguments: { videoA: "a.mp4", videoB: "b.mp4", labelA: "A", labelB: "B" },
  }));
  assert.equal(comparison.contract, "talking-head-edit-comparison.v1");
  assert.equal(comparison.metricDeltas.cutsPerMinute.a, 40);
  assert.equal(comparison.metricDeltas.cutsPerMinute.b, 0);
  assert.equal(comparison.metricDeltas.cutsPerMinute.bMinusA, -40);
  assert.ok(comparison.comparisonPath.endsWith(".json"));
  assert.ok(comparison.analysisPaths.A.endsWith(".json"));
  assert.ok(comparison.analysisPaths.B.endsWith(".json"));

  const sheet = await client.callTool({
    name: "extract_contact_sheet",
    arguments: { video: "a.mp4", count: 6 },
  });
  assert.equal(sheet.content[1].type, "image");
  assert.equal(sheet.content[1].mimeType, "image/jpeg");

  const frame = await client.callTool({
    name: "view_frame",
    arguments: { video: "a.mp4", timeSeconds: 1 },
  });
  assert.equal(frame.content[1].type, "image");
  assert.equal(frame.content[1].mimeType, "image/jpeg");

  const regionFrame = await client.callTool({
    name: "view_frame_region",
    arguments: {
      video: "b.mp4",
      timeSeconds: 1,
      region: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
      scale: 2,
    },
  });
  assert.equal(regionFrame.content[1].type, "image");
  assert.equal(regionFrame.content[1].mimeType, "image/png");
  const regionMeta = jsonResult(regionFrame);
  assert.equal(regionMeta.output.scale, 2);
  assert.ok(regionMeta.output.width > regionMeta.cropPx.width);

  const dimensionsA = [
    dimension("rhythmAndShots", 3, "A", 1),
    dimension("visualSupport", 2, "A", 1.2),
    dimension("captionsAndGraphics", 2, "A", 1.4),
    dimension("audioEditing", 3, "A", 1.6),
    dimension("continuityAndTechnical", 3, "A", 1.8),
    dimension("loadAndStyle", 2, "A", 2),
  ];
  const dimensionsB = [
    dimension("rhythmAndShots", 2, "B", 1),
    dimension("visualSupport", 3, "B", 1.2),
    dimension("captionsAndGraphics", 3, "B", 1.4),
    dimension("audioEditing", 3, "B", 1.6),
    dimension("continuityAndTechnical", 4, "B", 1.8),
    dimension("loadAndStyle", 3, "B", 2),
  ];
  const reviewPayload = {
    contract: "talking-head-edit-review.v1",
    mode: "pairwise",
    summary: "A 的切点更多，B 的视觉与连续性更稳；合成素材只验证流程。",
    winner: "B",
    confidence: 0.72,
    videos: [
      {
        label: "A",
        path: "a.mp4",
        analysisPath: analysis.analysisPath,
        dimensions: dimensionsA,
        hardDefects: [],
        strengths: ["切点数量更高"],
        weaknesses: ["视觉支撑证据不足"],
      },
      {
        label: "B",
        path: "b.mp4",
        analysisPath: comparison.analysisPaths.B,
        dimensions: dimensionsB,
        hardDefects: [{ video: "B", severity: "minor", code: "fixture", note: "测试硬伤" }],
        strengths: ["连续性更稳"],
        weaknesses: [],
      },
    ],
    limitations: ["使用合成视频，仅验证测量、抽帧和报告链路。"],
  };
  const report = jsonResult(await client.callTool({
    name: "write_review_report",
    arguments: { review: reviewPayload },
  }));
  assert.ok(report.jsonPath.endsWith(".json"));
  assert.ok(report.markdownPath.endsWith(".md"));
  const reportJson = JSON.parse(await fs.readFile(join(workspace, report.jsonPath), "utf8"));
  assert.equal(reportJson.computed.scores.length, 2);
  assert.ok(reportJson.computed.scores.every((item) => item.finalScore100 >= 0 && item.finalScore100 <= 100));
  assert.match(await fs.readFile(join(workspace, report.markdownPath), "utf8"), /口播视频剪辑评价/);

  const invalid = await client.callTool({
    name: "write_review_report",
    arguments: {
      review: {
        ...reviewPayload,
        videos: [{ ...reviewPayload.videos[0], dimensions: dimensionsA.slice(0, 5) }, reviewPayload.videos[1]],
      },
    },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /6|dimension/i);

  const escape = await client.callTool({
    name: "analyze_edit",
    arguments: { video: "../outside.mp4" },
  });
  assert.equal(escape.isError, true);
  assert.match(escape.content[0].text, /workspace|Path|工作区/i);

  const auditText = await fs.readFile(audit, "utf8");
  assert.match(auditText, /"tool":"analyze_edit"/);
  assert.match(auditText, /"tool":"compare_edits"/);
  assert.match(auditText, /"tool":"write_review_report"/);
  console.log("edit-review.verify: MCP measurements, frame evidence, weighted report and path guards passed");
} finally {
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
