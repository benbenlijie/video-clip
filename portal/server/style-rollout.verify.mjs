import assert from "node:assert/strict";
import { assertReferenceStyleCapability, assertStyleExportAllowed, referenceStyleConfig } from "./style-rollout.mjs";

const off = referenceStyleConfig({});
assert.deepEqual(off, {
  enabled: false,
  stage: "off",
  label: "关闭",
  capabilities: { manage: false, analyze: false, apply: false, preview: false, export: false, multi: false },
  error: null,
});

const admin = referenceStyleConfig({ REFERENCE_STYLE_ENABLED: "1" });
assert.equal(admin.enabled, true);
assert.equal(admin.stage, "admin");
assert.deepEqual(admin.capabilities, { manage: true, analyze: true, apply: false, preview: false, export: false, multi: false });

const preview = referenceStyleConfig({ REFERENCE_STYLE_ENABLED: "1", REFERENCE_STYLE_STAGE: "preview" });
assert.deepEqual(preview.capabilities, { manage: true, analyze: true, apply: true, preview: true, export: false, multi: false });

const single = referenceStyleConfig({ REFERENCE_STYLE_ENABLED: "1", REFERENCE_STYLE_STAGE: "single" });
assert.deepEqual(single.capabilities, { manage: true, analyze: true, apply: true, preview: true, export: true, multi: false });

const multi = referenceStyleConfig({ REFERENCE_STYLE_ENABLED: "1", REFERENCE_STYLE_STAGE: "multi" });
assert.deepEqual(multi.capabilities, { manage: true, analyze: true, apply: true, preview: true, export: true, multi: true });

const invalid = referenceStyleConfig({ REFERENCE_STYLE_ENABLED: "1", REFERENCE_STYLE_STAGE: "public-everything" });
assert.equal(invalid.enabled, false);
assert.match(invalid.error, /REFERENCE_STYLE_STAGE/);

assert.doesNotThrow(() => assertStyleExportAllowed({ config: preview, project: { id: "plain" } }));
assert.throws(() => assertStyleExportAllowed({ config: preview, project: { id: "styled", stylePackId: "style-1" } }), /尚未开放导出/);
assert.doesNotThrow(() => assertStyleExportAllowed({ config: single, project: { id: "styled", stylePackId: "style-1", workflowMode: "single-video-v1" } }));
assert.throws(() => assertStyleExportAllowed({ config: single, project: { id: "multi", stylePackId: "style-1", workflowMode: "multi-asset-v1" } }), /多素材/);
assert.doesNotThrow(() => assertStyleExportAllowed({ config: multi, project: { id: "multi", stylePackId: "style-1", workflowMode: "multi-asset-v1" } }));
assert.throws(() => assertReferenceStyleCapability(off, "analyze"), /未启用/);
assert.throws(() => assertReferenceStyleCapability(preview, "export"), /未开放/);
assert.doesNotThrow(() => assertReferenceStyleCapability(multi, "multi"));

console.log("style-rollout.verify: default-off stages, cumulative capabilities, and export/multi gates passed");
