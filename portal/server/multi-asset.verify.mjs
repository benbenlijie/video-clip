import assert from "node:assert/strict";
import {
  normalizeWorkflowMode,
  normalizeBrief,
  validateAssetUpload,
  createAssetRecord,
  assetDir,
  assertMultiAssetReady,
  assertAssetsLicensed,
  recoverInterruptedMultiAssetProject,
} from "./multi-asset.mjs";

assert.equal(normalizeWorkflowMode(), "single-video-v1");
assert.equal(normalizeWorkflowMode("multi-asset-v1"), "multi-asset-v1");
assert.throws(() => normalizeWorkflowMode("unknown"), /workflowMode/);

const brief = normalizeBrief({ rawText: "先展示问题，再展示解决方案", aspectRatio: "both", targetDurationMs: 60000 });
assert.equal(brief.rawText, "先展示问题，再展示解决方案");
assert.equal(brief.aspectRatio, "both");
assert.equal(brief.targetDurationMs, 60000);
assert.throws(() => normalizeBrief({ rawText: "" }), /方案不能为空/);

validateAssetUpload({ filename: "a.mp4", byteLength: 1024, currentAssetCount: 0, currentTotalBytes: 0 });
assert.throws(() => validateAssetUpload({ filename: "a.jpg", byteLength: 1024, currentAssetCount: 0, currentTotalBytes: 0 }), /只支持视频/);
assert.throws(() => validateAssetUpload({ filename: "a.mp4", byteLength: 501 * 1024 * 1024, currentAssetCount: 0, currentTotalBytes: 0 }), /500MB/);
assert.throws(() => validateAssetUpload({ filename: "a.mp4", byteLength: 1024, currentAssetCount: 20, currentTotalBytes: 0 }), /20/);
assert.throws(() => validateAssetUpload({ filename: "a.mp4", byteLength: 1024, currentAssetCount: 0, currentTotalBytes: 5 * 1024 * 1024 * 1024 }), /5GB/);

const project = { id: "p1", dir: "/tmp/p1", assets: [] };
const asset = createAssetRecord({ id: "asset-1", filename: "a.mp4", path: "/tmp/p1/assets/asset-1/source.mp4", bytes: 12, metadata: { durationMs: 1000, width: 1920, height: 1080, hasVideo: true, hasAudio: true }, role: "supporting", licenseConfirmed: true });
assert.equal(asset.id, "asset-1");
assert.equal(asset.status, "ready");
assert.match(assetDir(project, asset.id), /assets\/asset-1$/);
assert.throws(() => assertMultiAssetReady({ ...project, assets: [asset] }), /至少.*2/);
assert.doesNotThrow(() => assertMultiAssetReady({ ...project, assets: [asset, { ...asset, id: "asset-2" }] }));
assert.throws(() => assertMultiAssetReady({ ...project, assets: [asset, { ...asset, id: "asset-2", status: "failed" }] }), /失败/);
assert.throws(() => assertAssetsLicensed({ assets: [{ id: "x", licenseConfirmed: "true" }] }), /使用许可/);

const previousPlan = { version: 3, confirmed: true };
const previousArtifact = { name: "multi-landscape.mp4", kind: "video", planVersion: 3, inputRevision: 0 };
const interrupted = { workflowMode: "multi-asset-v1", status: "rendering_preview", multiAssetPlan: previousPlan, artifacts: [previousArtifact], multiAssetPreview: null };
assert.equal(recoverInterruptedMultiAssetProject(interrupted), true);
assert.equal(interrupted.status, "plan_confirmed");
assert.equal(interrupted.multiAssetPlan, previousPlan, "recovery keeps the confirmed plan");
assert.deepEqual(interrupted.artifacts, [previousArtifact], "recovery keeps previously saved artifacts");
assert.match(interrupted.error, /重启/);
const interruptedPlanning = { workflowMode: "multi-asset-v1", status: "planning", multiAssetPlan: previousPlan, artifacts: [previousArtifact] };
assert.equal(recoverInterruptedMultiAssetProject(interruptedPlanning), true);
assert.equal(interruptedPlanning.status, "plan_confirmed", "a previous confirmed plan remains usable after planning was interrupted");
const interruptedAnalysis = { workflowMode: "multi-asset-v1", status: "analyzing_assets", assetAnalysis: { status: "running" }, assets: [{ analysisStatus: "running" }, { analysisStatus: "ready" }] };
assert.equal(recoverInterruptedMultiAssetProject(interruptedAnalysis), true);
assert.equal(interruptedAnalysis.status, "needs_input");
assert.equal(interruptedAnalysis.assets[0].analysisStatus, "pending");
assert.equal(interruptedAnalysis.assets[1].analysisStatus, "ready", "completed asset analysis remains available");
const priorPreview = { planVersion: 3, inputRevision: 0, qc: { passed: true } };
const interruptedPreview = { workflowMode: "multi-asset-v1", status: "rendering_preview", multiAssetPlan: previousPlan, multiAssetPreview: priorPreview, artifacts: [previousArtifact] };
assert.equal(recoverInterruptedMultiAssetProject(interruptedPreview), true);
assert.equal(interruptedPreview.status, "preview_ready", "a previously passed preview remains available after a retry was interrupted");
const interruptedFinal = { workflowMode: "multi-asset-v1", status: "rendering", multiAssetPlan: previousPlan, artifacts: [previousArtifact] };
assert.equal(recoverInterruptedMultiAssetProject(interruptedFinal), true);
assert.equal(interruptedFinal.status, "completed", "a saved final output remains available after an interrupted rerender");
const legacyProject = { status: "rendering", artifacts: [] };
assert.equal(recoverInterruptedMultiAssetProject(legacyProject), false, "legacy single-video state is not changed");

console.log("multi-asset.verify: mode, brief, quotas, asset records, readiness, and restart recovery passed");
