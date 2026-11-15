import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDraftStyleProject } from "./style-project.mjs";
import { approveStylePack, assertStylePackCompatible, loadStylePack, rejectStylePack, saveStylePack, stylePackRoot } from "./style-pack-store.mjs";

assert.equal(path.basename(stylePackRoot), "style-library");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-style-pack-"));
const manifest = {
  contract: "style-manifest.v1",
  id: "style-clean-punch",
  name: "Clean punch-in",
  version: 1,
  status: "draft",
  sourceAnalysisId: "analysis-1",
  supportedModes: ["single-video-v1", "multi-asset-v1"],
  parameters: { captionScale: 1, motionIntensity: 0.8 },
  capabilities: ["captions", "punch_in", "broll_cover"],
  requirements: { minAssets: 2, needsMainFootage: true, needsBroll: false },
  unsupported: [],
  preview: null,
};

try {
  const projectDir = path.join(root, "source-v1");
  const styleProject = await createDraftStyleProject({
    analysis: { analysisId: "analysis-1" },
    outDir: projectDir,
    manifest,
  });
  const saved = await saveStylePack({
    root,
    manifest: styleProject.manifest,
    projectDir,
    status: "approved",
  });
  assert.equal(saved.version, 1);
  assert.equal(saved.status, "approved");
  assert.equal(saved.manifestSha256, styleProject.manifestSha256);
  assert.equal((await fs.stat(path.join(root, "styles", manifest.id, "v1", "style-manifest.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(root, "styles", manifest.id, "v1", "style-project", "src", "StyleOverlay.tsx"))).isFile(), true);
  assert.equal((await fs.stat(path.join(root, "styles", manifest.id, "v1", "approval.json"))).isFile(), true);

  assertStylePackCompatible(saved, "single-video-v1");
  assertStylePackCompatible(saved, "multi-asset-v1");
  const loaded = await loadStylePack(manifest.id, 1, { root });
  assert.equal(loaded.status, "approved");
  assert.equal(loaded.manifest.id, manifest.id);

  await assert.rejects(
    saveStylePack({ root, manifest: styleProject.manifest, projectDir, status: "approved" }),
    /already exists|immutable|存在/,
  );

  const projectDirV2 = path.join(root, "source-v2");
  const version2 = await createDraftStyleProject({
    analysis: { analysisId: "analysis-1" },
    outDir: projectDirV2,
    manifest: { ...manifest, version: 2, status: "pending_approval" },
  });
  const savedV2 = await saveStylePack({ root, manifest: version2.manifest, projectDir: projectDirV2, status: "pending_approval" });
  assert.equal(savedV2.version, 2);
  assert.equal((await loadStylePack(manifest.id, 2, { root })).version, 2);
  assert.equal((await rejectStylePack(manifest.id, 2, { root, reason: "caption too large" })).status, "rejected");
  await assert.rejects(approveStylePack(manifest.id, 2, { root }), /cannot be approved|rejected|status/i);

  const singleOnly = await createDraftStyleProject({
    analysis: { analysisId: "analysis-1" },
    outDir: path.join(root, "source-single"),
    manifest: {
      ...manifest,
      version: 3,
      supportedModes: ["single-video-v1"],
      requirements: { minAssets: 1, needsMainFootage: true, needsBroll: false },
    },
  });
  const savedSingle = await saveStylePack({ root, manifest: singleOnly.manifest, projectDir: singleOnly.dir, status: "approved" });
  assert.throws(() => assertStylePackCompatible(savedSingle, "multi-asset-v1"), /multi-asset|supportedModes/i);

  await fs.appendFile(path.join(root, "styles", manifest.id, "v2", "style-project", "src", "StyleOverlay.tsx"), "\n// tampered\n");
  await assert.rejects(loadStylePack(manifest.id, 2, { root }), /hash|mismatch|不一致/i);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-pack.verify: immutable versions, approval metadata, mode compatibility, and hash validation passed");
