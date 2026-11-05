import assert from "node:assert/strict";
import { confirmMultiAssetPlan, restoreMultiAssetPlan, validateMultiAssetPlan } from "./multi-asset-plan.mjs";

const project = {
  id: "p1", workflowMode: "multi-asset-v1", brief: { rawText: "先提出问题，再展示产品", targetDurationMs: 6000 },
  assets: [
    { id: "a1", filename: "one.mp4", durationMs: 4000, role: "main", status: "ready", analysisStatus: "ready", licenseConfirmed: true, transcript: { text: "遇到问题", segments: [{ startMs: 0, endMs: 1000, text: "遇到问题" }] } },
    { id: "a2", filename: "two.mp4", durationMs: 5000, role: "supporting", status: "ready", analysisStatus: "ready", licenseConfirmed: true, transcript: { text: "这是解决方法", segments: [{ startMs: 0, endMs: 1500, text: "这是解决方法" }] } },
  ],
};
const rawPlan = {
  summary: "先讲问题，再展示解决方法",
  clips: [
    { id: "c1", sourceAssetId: "a1", sourceInMs: 0, sourceOutMs: 3000, timelineStartMs: 0, timelineEndMs: 3000, track: "video-main", purpose: "hook", reason: "从口播提取问题" },
    { id: "c2", sourceAssetId: "a2", sourceInMs: 0, sourceOutMs: 3000, timelineStartMs: 3000, timelineEndMs: 6000, track: "video-main", purpose: "solution", reason: "展示产品方案" },
  ],
  overlays: [],
};
const plan = validateMultiAssetPlan(rawPlan, project);
assert.equal(plan.durationMs, 6000);
assert.equal(plan.inputRevision, 0);
assert.equal(plan.confirmed, false);
assert.equal(plan.clips.length, 2);
assert.throws(() => validateMultiAssetPlan({ ...rawPlan, clips: rawPlan.clips.map((clip) => ({ ...clip, sourceAssetId: "missing" })) }, project), /素材引用/);
assert.throws(() => validateMultiAssetPlan({ ...rawPlan, clips: [{ ...rawPlan.clips[0], sourceOutMs: 5000, timelineEndMs: 5000 }, { ...rawPlan.clips[1], timelineStartMs: 5000, timelineEndMs: 8000 }] }, project), /超出素材/);
assert.throws(() => validateMultiAssetPlan({ ...rawPlan, clips: [{ ...rawPlan.clips[0], timelineEndMs: 2500 }, { ...rawPlan.clips[1], timelineStartMs: 3000, timelineEndMs: 6000 }] }, project), /时间轴/);
const longPlan = validateMultiAssetPlan({ ...rawPlan, clips: [{ ...rawPlan.clips[0], timelineEndMs: 3000 }, { ...rawPlan.clips[1], sourceOutMs: 5000, timelineStartMs: 3000, timelineEndMs: 8000 }] }, project);
assert.ok(longPlan.warnings.some((warning) => warning.code === "duration-target-exceeded"), "soft target deviations must be reviewable warnings");
assert.equal(longPlan.durationMs, 8000);
const confirmed = confirmMultiAssetPlan({ ...project, multiAssetPlan: plan }, { version: plan.version });
assert.equal(confirmed.multiAssetPlan.confirmed, true);
assert.throws(() => confirmMultiAssetPlan({ ...project, multiAssetPlan: plan }, { version: 2 }), /已过期/);
const revised = validateMultiAssetPlan({ ...rawPlan, summary: "第二版方案" }, { ...project, multiAssetPlan: plan });
const restored = restoreMultiAssetPlan({ ...project, multiAssetPlan: revised, multiAssetPlanHistory: [plan] }, { version: plan.version });
assert.equal(restored.multiAssetPlan.summary, plan.summary);
assert.equal(restored.multiAssetPlan.confirmed, false, "a restored version must be reviewed and confirmed again");
const restoredAgain = restoreMultiAssetPlan(restored, { version: revised.version });
assert.equal(restoredAgain.multiAssetPlan.summary, revised.summary, "the replaced plan remains available for another rollback");
assert.equal(validateMultiAssetPlan(rawPlan, restored).version, 3, "new plan versions must remain monotonic after rollback");
assert.doesNotThrow(() => confirmMultiAssetPlan({ ...project, multiAssetRevision: 1, multiAssetPlan: plan }, { version: plan.version }), "music-only changes invalidate previews but leave the story plan valid");
assert.throws(() => confirmMultiAssetPlan({ ...project, multiAssetInputRevision: 1, multiAssetPlan: plan }, { version: plan.version }), /素材或方案已变化/);
assert.throws(() => restoreMultiAssetPlan({ ...project, multiAssetInputRevision: 1, multiAssetPlan: revised, multiAssetPlanHistory: [plan] }, { version: plan.version }), /素材或方案已变化/);

console.log("multi-asset-plan.verify: source ranges, gapless timeline, duration tolerance, and confirmation passed");
