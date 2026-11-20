import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDraftStyleProject,
  hashStyleProject,
  validateStyleManifest,
  validateStyleProject,
} from "./style-project.mjs";
import { referenceStyleSpec } from "../test-fixtures/style-spec-v2.mjs";
import { referenceStyleSpecV3 } from "../test-fixtures/style-spec-v3.mjs";

const validManifest = {
  contract: "style-manifest.v1",
  id: "style-clean-punch",
  name: "Clean punch-in / phrase captions",
  version: 1,
  status: "draft",
  sourceAnalysisId: "reference-analysis-fixture",
  supportedModes: ["single-video-v1", "multi-asset-v1"],
  parameters: {
    captionScale: 1,
    motionIntensity: 0.8,
    brollDensity: 0.5,
    colorAccent: "#c6f475",
  },
  capabilities: ["captions", "title_card", "emphasis", "punch_in", "broll_cover"],
  requirements: {
    minAssets: 2,
    needsMainFootage: true,
    needsBroll: false,
  },
  unsupported: ["multi_camera", "3d_scene"],
  preview: null,
};

assert.deepEqual(validateStyleManifest(validManifest), validManifest);
assert.throws(
  () => validateStyleManifest({ ...validManifest, supportedModes: undefined }),
  /supportedModes/i,
);
assert.throws(
  () => validateStyleManifest({
    ...validManifest,
    requirements: { minAssets: 2, needsMainFootage: false, needsBroll: false },
  }),
  /needsMainFootage|multi-asset/i,
);
assert.throws(
  () => validateStyleManifest({
    ...validManifest,
    requirements: { minAssets: 1, needsMainFootage: true, needsBroll: false },
  }),
  /minAssets|multi-asset/i,
);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-style-project-"));
try {
  const outDir = path.join(root, "style-clean-punch");
  const project = await createDraftStyleProject({
    analysis: { analysisId: "reference-analysis-fixture" },
    outDir,
    manifest: validManifest,
  });

  assert.equal(project.contract, "style-project.v1");
  assert.equal(project.status, "draft");
  assert.equal(project.manifest.id, validManifest.id);
  assert.match(project.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(project.codeSha256, /^[a-f0-9]{64}$/);
  assert.equal(validateStyleProject(project).compositionId, "ReferenceStyle");

  const manifestFile = JSON.parse(await fs.readFile(path.join(outDir, "style-manifest.json"), "utf8"));
  assert.equal(manifestFile.id, validManifest.id);
  const scaffoldFiles = [
    "package.json",
    "tsconfig.json",
    "src/index.tsx",
    "src/Root.tsx",
    "src/StyleOverlay.tsx",
    "src/CaptionLayer.tsx",
    "src/LayoutLayer.tsx",
    "src/manifest.ts",
    "README.md",
  ];
  for (const name of scaffoldFiles) assert.ok((await fs.stat(path.join(outDir, name))).isFile(), `missing ${name}`);

  const rootSource = await fs.readFile(path.join(outDir, "src/StyleOverlay.tsx"), "utf8");
  for (const token of ["captions", "layoutEvents", "styleParams", "captionStyle"]) assert.match(rootSource, new RegExp(token));
  const packageJson = JSON.parse(await fs.readFile(path.join(outDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["@remotion/captions", "@remotion/media", "react", "remotion"].sort());

  const before = project.codeSha256;
  await fs.appendFile(path.join(outDir, "src/StyleOverlay.tsx"), "\n// changed\n");
  const changed = await hashStyleProject(outDir);
  assert.notEqual(changed, before);
  assert.equal(await hashStyleProject(outDir), changed, "style project hashes must be deterministic");

  const inferred = await createDraftStyleProject({
    analysis: {
      analysisId: "reference-analysis-inferred",
      shots: [
        { layout: "punch_in", broll: false },
        { layout: "broll_cover", broll: true },
      ],
      rhythm: { punchInRatio: 0.3, brollRatio: 0.25 },
      captions: { grouping: "phrase", maxWordsPerCue: 5, fontSizeRatio: 0.06, keywordColor: "#abcdef", position: "bottom" },
      capabilities: { needsBroll: true },
      overlays: [
        { id: "title", type: "title-card", startMs: 0, endMs: 1000 },
        { id: "callout", type: "callout", startMs: 0, endMs: 1000 },
      ],
      unsupported: ["multi_camera"],
      confidence: { captions: 0.8 },
    },
    outDir: path.join(root, "style-inferred"),
  });
  assert.deepEqual(inferred.manifest.capabilities, ["captions", "title_card", "emphasis", "punch_in", "broll_cover"]);
  assert.equal(inferred.manifest.parameters.captionScale, 1.2);
  assert.equal(inferred.manifest.parameters.motionIntensity, 0.8);
  assert.equal(inferred.manifest.parameters.brollDensity, 0.25);
  assert.equal(inferred.manifest.parameters.colorAccent, "#abcdef");
  assert.equal(inferred.manifest.requirements.needsBroll, true);
  assert.deepEqual(inferred.manifest.unsupported, ["multi_camera"]);

  const styled = await createDraftStyleProject({
    analysis: {
      contract: "reference-analysis.v2",
      analysisId: "reference-analysis-style-spec-v2",
      shots: [{ layout: "full", broll: false }],
      rhythm: { punchInRatio: 0, brollRatio: 0 },
      captions: { grouping: "phrase", maxWordsPerCue: 10, fontSizeRatio: 0.06, keywordColor: "#ffe45c", position: "bottom" },
      capabilities: { needsBroll: false },
      overlays: [
        { id: "title", type: "title_card", startMs: 0, endMs: 1000 },
        { id: "identity", type: "identity_card", startMs: 0, endMs: 1000 },
      ],
      unsupported: [],
      confidence: { captions: 0.8 },
      styleSpec: referenceStyleSpec,
    },
    outDir: path.join(root, "style-spec-v2"),
  });
  assert.equal(styled.manifest.contract, "style-manifest.v2");
  assert.equal(styled.manifest.styleSpec.title.panel.opacity, 0.82);
  assert.equal(styled.manifest.styleSpec.captions.motion.enter.scaleFrom, 0.92);
  assert.equal(styled.manifest.styleSpec.effects[0].trigger, "cue_enter");

  const styledV3 = await createDraftStyleProject({
    analysis: {
      contract: "reference-analysis.v2",
      analysisId: "reference-analysis-style-spec-v3",
      shots: [{ layout: "full", broll: false }],
      rhythm: { punchInRatio: 0, brollRatio: 0 },
      captions: { grouping: "phrase", maxWordsPerCue: 10, fontSizeRatio: 0.06, keywordColor: "#ffe45c", position: "bottom" },
      capabilities: { needsBroll: false },
      overlays: [
        { id: "title", type: "title_card", startMs: 0, endMs: 1000 },
        { id: "identity", type: "identity_card", startMs: 0, endMs: 1000 },
      ],
      unsupported: [],
      confidence: { captions: 0.8 },
      styleSpec: referenceStyleSpecV3,
    },
    outDir: path.join(root, "style-spec-v3"),
  });
  assert.equal(styledV3.manifest.contract, "style-manifest.v3");
  assert.equal(styledV3.manifest.styleSpec.contract, "style-spec.v3");
  assert.equal(styledV3.manifest.styleSpec.title.primary.fontId, "noto-sans-cjk-sc-black");
  assert.equal(styledV3.manifest.styleSpec.title.primary.fontWidthScale, 0.92);
  assert.equal(styledV3.manifest.styleSpec.identity.offsetYRatio, 0.12);
  assert.equal(styledV3.manifest.styleSpec.identity.maxLines, 4);
  assert.throws(
    () => validateStyleManifest({ ...styledV3.manifest, contract: "style-manifest.v2" }),
    /cannot embed StyleSpec v3/i,
  );
  assert.throws(
    () => validateStyleManifest({ ...styledV3.manifest, styleSpec: referenceStyleSpec }),
    /requires StyleSpec v3/i,
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-project.verify: manifest rules, scaffold props, dependency allowlist, and deterministic hashes passed");
