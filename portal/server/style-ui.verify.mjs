import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultStyleCopy, gateStylePanelState, pickStylePackForAnalysis, selectStyleProof, stylePanelState } from "../src/style-pack-state.mjs";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../src/ReferenceStylePanel.tsx", import.meta.url), "utf8");

assert.equal((appSource.match(/<main className="app-shell">/g) || []).length, 1);
assert.equal((appSource.match(/<ReferenceStylePanel\b/g) || []).length, 1);
assert.equal((appSource.match(/<ReviewWorkspace\b/g) || []).length, 1);
assert.doesNotMatch(appSource, /<(?:ReferenceStylePanel|ReviewWorkspace)\b[^>]*\bkey=\{project\.id\}/);
assert.match(appSource, /<ReferenceStylePanel\b[^>]*\bkey=\{`reference-style-\$\{project\.id\}`\}/);
assert.match(appSource, /<ReviewWorkspace\b[^>]*\bkey=\{`review-\$\{project\.id\}`\}/);
assert.match(panelSource, /referenceUsageConfirmed/);
assert.match(panelSource, /我确认拥有这条参考视频的分析和使用许可/);

assert.equal(stylePanelState({}).key, "empty");
assert.equal(stylePanelState({ reference: { analysisId: "r1" } }).key, "analyzed");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, busy: true }).key, "generating");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, error: "no key" }).key, "error");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, error: "no key" }).canGenerate, true);
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, stylePack: { id: "s1", version: 1, status: "pending_approval" } }).key, "pending");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, stylePack: { id: "s1", version: 1, status: "approved" } }).key, "approved");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, stylePack: { id: "s1", version: 1, status: "approved" }, projectStyleId: "s1", projectStyleVersion: 1 }).key, "applied");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, stylePack: { id: "s1", version: 2, status: "approved" }, projectStyleId: "s1", projectStyleVersion: 1 }).key, "stale");
assert.equal(stylePanelState({ reference: { analysisId: "r1" }, stylePack: { id: "s1", version: 1, status: "rejected" } }).key, "rejected");
assert.deepEqual(defaultStyleCopy({ capabilities: { needsBroll: false } }), { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: false, copyAudio: true });
assert.deepEqual(defaultStyleCopy({ capabilities: { needsBroll: true } }), { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: true, copyAudio: true });
assert.equal(pickStylePackForAnalysis([
  { id: "s1", version: 1, status: "approved", manifest: { sourceAnalysisId: "a1" } },
  { id: "s1", version: 2, status: "pending_approval", manifest: { sourceAnalysisId: "a1" } },
  { id: "s2", version: 3, status: "approved", manifest: { sourceAnalysisId: "other" } },
], "a1")?.version, 2);
assert.equal(pickStylePackForAnalysis([], "a1"), null);
assert.deepEqual(
  gateStylePanelState(stylePanelState({ reference: { analysisId: "r1" }, stylePack: { id: "s1", version: 1, status: "approved" } }), { manage: true, analyze: true, apply: false, preview: false }),
  { key: "approved", label: "可应用", detail: "风格包已审批，可以应用到当前口播项目。", canAnalyze: true, canGenerate: false, canApprove: false, canApply: false, canPreview: false },
);
assert.equal(selectStyleProof({ artifacts: [] }, { manifest: { preview: { video: "preview.mp4" } } }), null);
assert.deepEqual(selectStyleProof({
  artifacts: [
    { kind: "style-preview", name: "old.mp4", url: "/api/old", generatedAt: "2026-01-01T00:00:00.000Z" },
    { kind: "preview", name: "main.mp4", url: "/api/main" },
    { kind: "style-preview", name: "new.mp4", url: "/api/new", generatedAt: "2026-02-01T00:00:00.000Z" },
  ],
}), { name: "new.mp4", url: "/api/new", generatedAt: "2026-02-01T00:00:00.000Z" });
assert.equal(selectStyleProof({
  styleVersion: 2,
  artifacts: [
    { kind: "style-preview", name: "v1.mp4", url: "/api/v1", styleVersion: 1, generatedAt: "2026-02-02T00:00:00.000Z" },
  ],
}), null);
assert.equal(selectStyleProof({
  styleVersion: 2,
  artifacts: [
    { kind: "style-preview", name: "v1.mp4", url: "/api/v1", styleVersion: 1, generatedAt: "2026-02-02T00:00:00.000Z" },
    { kind: "style-preview", name: "v2.mp4", url: "/api/v2", styleVersion: 2, generatedAt: "2026-02-01T00:00:00.000Z" },
  ],
})?.name, "v2.mp4");
assert.equal(selectStyleProof({
  styleVersion: 2,
  styleApplicationHash: "a".repeat(64),
  artifacts: [
    { kind: "style-preview", name: "stale.mp4", url: "/api/stale", styleVersion: 2, styleProvenance: { styleApplicationSha256: "b".repeat(64) } },
  ],
}), null);
assert.equal(selectStyleProof({
  styleVersion: 2,
  styleApplicationHash: "a".repeat(64),
  artifacts: [
    { kind: "style-preview", name: "current.mp4", url: "/api/current", styleVersion: 2, styleProvenance: { styleApplicationSha256: "a".repeat(64) } },
  ],
})?.name, "current.mp4");

console.log("style-ui.verify: panel states, copy defaults, analysis lookup, and proof selection passed");
