import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createDraftStyleProject } from "./style-project.mjs";
import { assertStyleProjectSandboxed } from "./style-sandbox.mjs";
import { renderStyleProject } from "./style-renderer.mjs";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-style-sandbox-"));
const manifest = {
  contract: "style-manifest.v1",
  id: "style-sandbox-render",
  name: "Sandbox render",
  version: 1,
  status: "draft",
  sourceAnalysisId: "analysis-sandbox",
  supportedModes: ["single-video-v1", "multi-asset-v1"],
  parameters: { captionScale: 1, motionIntensity: 0.8, colorAccent: "#c6f475" },
  capabilities: ["captions", "punch_in"],
  requirements: { minAssets: 2, needsMainFootage: true, needsBroll: false },
  unsupported: [],
  preview: null,
};

async function frameDigest(path, seconds) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(seconds), "-i", path,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  return createHash("sha256").update(stdout).digest("hex");
}

try {
  const project = await createDraftStyleProject({
    analysis: { analysisId: "analysis-sandbox" },
    outDir: path.join(root, "safe-project"),
    manifest,
  });
  await assertStyleProjectSandboxed(project.dir);
  const outputPath = path.join(root, "overlay.mov");
  const result = await renderStyleProject({
    projectDir: project.dir,
    compositionId: "ReferenceStyle",
    outputPath,
    props: {
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1000,
      captions: [{ id: "c1", startMs: 0, endMs: 900, text: "hello" }],
      visualEvents: [{ id: "v1", type: "emphasis", startMs: 100, endMs: 800, text: "accent" }],
      layoutEvents: [{ id: "l1", type: "punch_in", startMs: 0, endMs: 900 }],
      styleParams: { captionScale: 1, motionIntensity: 0.8, brollDensity: 0.5, colorAccent: "#c6f475" },
    },
  });
  assert.equal(result.alpha, true);
  assert.equal(result.isolation, "bwrap-network-namespace");
  assert.equal(result.networkIsolated, true);
  const probe = JSON.parse((await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", outputPath])).stdout);
  const stream = probe.streams.find((item) => item.codec_name === "prores");
  assert.ok(stream);
  assert.ok(String(stream.pix_fmt).startsWith("yuva"));
  assert.equal(Number(stream.width), 320);
  assert.equal(Number(stream.height), 180);

  const repeatPath = path.join(root, "overlay-repeat.mov");
  await renderStyleProject({
    projectDir: project.dir,
    compositionId: "ReferenceStyle",
    outputPath: repeatPath,
    props: {
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1000,
      captions: [{ id: "c1", startMs: 0, endMs: 900, text: "hello" }],
      visualEvents: [{ id: "v1", type: "emphasis", startMs: 100, endMs: 800, text: "accent" }],
      layoutEvents: [{ id: "l1", type: "punch_in", startMs: 0, endMs: 900 }],
      styleParams: { captionScale: 1, motionIntensity: 0.8, brollDensity: 0.5, colorAccent: "#c6f475" },
    },
  });
  for (const seconds of [0.1, 0.5, 0.8]) {
    assert.equal(await frameDigest(outputPath, seconds), await frameDigest(repeatPath, seconds), `repeat render frame differs at ${seconds}s`);
  }

  const unsafe = await createDraftStyleProject({
    analysis: { analysisId: "analysis-unsafe" },
    outDir: path.join(root, "unsafe-project"),
    manifest: { ...manifest, id: "style-sandbox-unsafe", sourceAnalysisId: "analysis-unsafe" },
  });
  await fs.appendFile(path.join(unsafe.dir, "src", "StyleOverlay.tsx"), '\nfetch("https://evil.example");\n');
  await assert.rejects(assertStyleProjectSandboxed(unsafe.dir), /policy|forbidden|fetch|network/i);
  await assert.rejects(
    renderStyleProject({
      projectDir: unsafe.dir,
      compositionId: "ReferenceStyle",
      outputPath: path.join(root, "unsafe.mov"),
      props: {},
    }),
    /policy|forbidden|fetch|network/i,
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-sandbox.verify: policy gate, bwrap network isolation, alpha ProRes, deterministic frames, dimensions, and unsafe rejection passed");
