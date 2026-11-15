import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { referenceStyleSpec } from "../test-fixtures/style-spec-v2.mjs";
import * as styleAgentTools from "./style-agent-tools.mjs";

assert.equal(typeof styleAgentTools.buildStyleProofProps, "function");
const proofProps = styleAgentTools.buildStyleProofProps({
  manifest: {
    capabilities: ["captions", "title_card", "emphasis"],
    parameters: { captionScale: 1.4, motionIntensity: 0.5, brollDensity: 0, colorAccent: "#ffe45c" },
  },
  analysis: { styleSpec: referenceStyleSpec },
  width: 360,
  height: 640,
});
assert.equal(proofProps.visualEvents.find((event) => event.type === "title_card").position, "top_center");
assert.equal(proofProps.visualEvents.find((event) => event.type === "emphasis").position, "middle_right");
assert.ok(proofProps.captions.some((caption) => Array.isArray(caption.keywords) && caption.keywords.length > 0));

const execFile = promisify(execFileCallback);
const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-agent-"));
const styleRoot = join(root, "style-library");
const audit = join(root, "audit.jsonl");
const reference = join(root, "reference.mp4");

await execFile("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30:duration=30",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", reference,
], { timeout: 60000 });
await fs.writeFile(join(root, "brief.json"), JSON.stringify({
  referenceId: "style-agent-fixture",
  mode: "single-video-v1",
  sourceFilename: "reference.mp4",
  referenceUsageConfirmedAt: new Date().toISOString(),
}));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./style-agent-tools.mjs", import.meta.url).pathname, root, audit],
  env: { ...process.env, WAYNE_STYLE_DIR: styleRoot },
});
const client = new Client({ name: "style-agent-tools-verify", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((item) => item.name).sort(), [
    "analyze_reference_audio",
    "begin_style_revision",
    "create_style_project",
    "detect_reference_shots",
    "extract_reference_frames",
    "extract_reference_motion_windows",
    "probe_reference",
    "read_file",
    "save_style_pack",
    "update_style_spec",
    "validate_style_project",
    "view_frame",
    "write_reference_analysis",
    "write_style_file",
  ]);

  const probe = JSON.parse((await client.callTool({ name: "probe_reference", arguments: {} })).content[0].text);
  assert.equal(probe.width, 180);
  assert.equal(probe.height, 320);
  const shots = JSON.parse((await client.callTool({ name: "detect_reference_shots", arguments: {} })).content[0].text);
  assert.ok(shots.length >= 1);
  const frames = await client.callTool({ name: "extract_reference_frames", arguments: { maxFrames: 2 } });
  assert.ok(frames.content.some((item) => item.type === "image" && item.data.length > 100));
  const motionWindows = await client.callTool({ name: "extract_reference_motion_windows", arguments: { maxWindows: 2, secondsPerWindow: 2 } });
  assert.equal(motionWindows.content.filter((item) => item.type === "image").length, 2);
  assert.ok(motionWindows.content.some((item) => item.type === "text" && /startMs=/.test(item.text)));
  const audio = JSON.parse((await client.callTool({ name: "analyze_reference_audio", arguments: {} })).content[0].text);
  assert.ok("bpm" in audio && "sfxDensity" in audio);

  const visualFacts = {
    shots: [{ id: "shot-01", startMs: 0, endMs: 30000, role: "hook", layout: "full", broll: false }],
    captions: { grouping: "phrase", maxWordsPerCue: 4, position: "bottom", fontSizeRatio: 0.05, primaryColor: "#ffffff", strokeColor: "#111111", strokeWidth: 2, keywordColor: "#c6f475", animation: "pop" },
    overlays: [
      { id: "title-01", type: "title_card", startMs: 0, endMs: 30000, position: "top", sizeRatio: 0.8, coverage: 0.12 },
      { id: "identity-01", type: "identity", startMs: 0, endMs: 30000, position: "middle_right", sizeRatio: 0.3, coverage: 0.12 },
    ],
    capabilities: { needsBroll: false, needsScreenshots: false, needsSplitScreen: false },
    unsupported: [],
    confidence: { overall: 0.8, rhythm: 0.8, captions: 0.8, layout: 0.7 },
    styleSpec: referenceStyleSpec,
  };
  const missingCaptionEvidence = await client.callTool({
    name: "write_reference_analysis",
    arguments: { ...visualFacts, captions: {}, unsupported: [] },
  });
  assert.equal(missingCaptionEvidence.isError, true);
  assert.match(missingCaptionEvidence.content[0].text, /caption evidence/i);
  const unknownLayout = await client.callTool({
    name: "write_reference_analysis",
    arguments: {
      ...visualFacts,
      shots: [{ id: "shot-01", startMs: 0, endMs: 30000, role: "hook", layout: "unknown", broll: false }],
    },
  });
  assert.equal(unknownLayout.isError, true);
  assert.match(unknownLayout.content[0].text, /layout is incomplete/i);
  const missingHeaderEvidence = await client.callTool({
    name: "write_reference_analysis",
    arguments: {
      ...visualFacts,
      overlays: [{ id: "badge", type: "badge", startMs: 0, endMs: 30000, position: "bottom-center", sizeRatio: 0.15, coverage: 0.1 }],
      unsupported: [],
    },
  });
  assert.equal(missingHeaderEvidence.isError, true);
  assert.match(missingHeaderEvidence.content[0].text, /header evidence is incomplete/i);
  const written = await client.callTool({ name: "write_reference_analysis", arguments: visualFacts });
  const writtenAnalysis = JSON.parse(written.content[0].text);
  assert.equal(writtenAnalysis.contract, "reference-analysis.v2");
  assert.equal(writtenAnalysis.source.hasAudio, true);
  assert.equal(writtenAnalysis.source.sha256, probe.sha256);
  assert.deepEqual(writtenAnalysis.audio, audio);
  assert.equal(writtenAnalysis.captions.position, "bottom");
  assert.equal(writtenAnalysis.styleSpec.title.panel.opacity, 0.82);
  assert.equal(writtenAnalysis.styleSpec.captions.motion.enter.scaleFrom, 0.92);
  const project = JSON.parse((await client.callTool({ name: "create_style_project", arguments: { name: "Agent fixture style" } })).content[0].text);
  assert.equal(project.compositionId, "ReferenceStyle");
  assert.ok(project.manifest.capabilities.includes("captions"));
  assert.ok(project.manifest.capabilities.includes("title_card"));
  assert.ok(project.manifest.capabilities.includes("emphasis"));
  const staleManifestPath = join(root, "style-project", "style-manifest.json");
  const staleManifest = JSON.parse(await fs.readFile(staleManifestPath, "utf8"));
  staleManifest.capabilities = staleManifest.capabilities.filter((capability) => capability !== "emphasis");
  await fs.writeFile(staleManifestPath, JSON.stringify(staleManifest, null, 2));
  const adjustedStyleSpec = JSON.parse(JSON.stringify(referenceStyleSpec));
  adjustedStyleSpec.title.panel.color = "#e8e4d8";
  adjustedStyleSpec.captions.panel.enabled = true;
  adjustedStyleSpec.captions.maxCharsPerCue = 12;
  const updatedSpec = JSON.parse((await client.callTool({ name: "update_style_spec", arguments: { styleSpec: adjustedStyleSpec } })).content[0].text);
  assert.equal(updatedSpec.styleSpec.title.panel.color, "#e8e4d8");
  const updatedAnalysis = JSON.parse(await fs.readFile(join(root, "analysis.json"), "utf8"));
  const updatedManifest = JSON.parse(await fs.readFile(join(root, "style-project", "style-manifest.json"), "utf8"));
  assert.equal(updatedAnalysis.analysisId, writtenAnalysis.analysisId);
  assert.equal(updatedManifest.sourceAnalysisId, writtenAnalysis.analysisId);
  assert.equal(updatedManifest.styleSpec.captions.maxCharsPerCue, 12);
  assert.ok(updatedManifest.capabilities.includes("emphasis"));
  const source = await client.callTool({ name: "read_file", arguments: { path: "style-project/src/StyleOverlay.tsx" } });
  assert.match(source.content[0].text, /export function StyleOverlay/);
  await client.callTool({ name: "write_style_file", arguments: { path: "style-project/src/StyleOverlay.tsx", content: `${source.content[0].text}\n// style agent fixture\n` } });
  const validation = JSON.parse((await client.callTool({ name: "validate_style_project", arguments: {} })).content[0].text);
  assert.equal(validation.alpha, true);
  assert.equal(validation.networkIsolated, true);
  for (const timeSeconds of [0.5, 1.5, 2.5]) {
    const frame = await client.callTool({ name: "view_frame", arguments: { video: "style-proof.mov", timeSeconds } });
    assert.ok(frame.content.some((item) => item.type === "image" && item.data.length > 100));
  }
  const ungatedPack = JSON.parse((await client.callTool({ name: "save_style_pack", arguments: {} })).content[0].text);
  assert.equal(ungatedPack.status, "deferred_for_review");
  const validationFile = JSON.parse(await fs.readFile(join(root, "validation.json"), "utf8"));
  await fs.mkdir(join(root, ".control"), { recursive: true });
  await fs.writeFile(join(root, ".control", "style-review-gate.json"), JSON.stringify({
    contract: "style-review-gate.v1",
    proofSha256: validationFile.proofSha256,
    codeSha256: validationFile.codeSha256,
    reviewedAt: new Date().toISOString(),
  }));
  const pack = JSON.parse((await client.callTool({ name: "save_style_pack", arguments: {} })).content[0].text);
  assert.equal(pack.status, "pending_approval");
  assert.equal(pack.id, project.id);
  assert.ok((await fs.stat(join(root, "style-pack.json"))).isFile());
  const revision = JSON.parse((await client.callTool({ name: "begin_style_revision", arguments: {} })).content[0].text);
  assert.equal(revision.version, 2);
  assert.equal(revision.revalidateRequired, true);
  assert.match(await fs.readFile(audit, "utf8"), /"tool":"save_style_pack"/);
  console.log("style-agent-tools.verify: Claude Code MCP probe, shots, frames, analysis, StyleProject, sandbox proof, inspection, and persistence passed");
} finally {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
