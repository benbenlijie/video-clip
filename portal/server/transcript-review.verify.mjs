import assert from "node:assert/strict";
import { applyTranscriptReview, ensureTranscriptReviewState } from "./transcript-review.mjs";

const legacy = { transcript: { text: "legacy transcript", segments: [{ id: "segment-1", startMs: 0, endMs: 1000, text: "legacy transcript" }] }, plan: { segments: [] } };
assert.equal(ensureTranscriptReviewState(legacy), true);
assert.equal(legacy.primaryTranscript.text, "legacy transcript");
assert.equal(legacy.proofreading.status, "manual_review_required");
assert.equal(legacy.proofreading.previewStale, true, "legacy plans need a new transcript-bound preview");
assert.equal(ensureTranscriptReviewState(legacy), false, "migration is idempotent");

const transcript = {
  provider: "volcengine", language: "zh", durationMs: 3000, text: "把繁琐的剪辑工具交给AI然后检查字幕",
  segments: [
    { id: "segment-1", startMs: 100, endMs: 1400, text: "把繁琐的剪辑工具交给AI" },
    { id: "segment-2", startMs: 1500, endMs: 2800, text: "然后检查字幕" },
  ],
};
const proofreading = {
  status: "needs_review", model: "small_q5_1", changes: [],
  unresolved: [{ segmentId: "segment-2", primaryText: "然后检查字幕", secondaryText: "然后检查字母", reason: "末字识别不同" }],
};
const submitted = transcript.segments.map((segment) => ({ ...segment, text: segment.id === "segment-2" ? "然后检查字幕。" : segment.text }));
const originalSnapshot = structuredClone(transcript);
const autoApplied = applyTranscriptReview({ transcript, proofreading: { ...proofreading, status: "ready", changes: [{ segmentId: "segment-1", before: "把烦做的剪辑工具交给AI", after: "把繁琐的剪辑工具交给AI", evidence: "whisper", reason: "测试建议" }], unresolved: [] }, segments: transcript.segments, confirmedUnresolvedSegmentIds: [] });
assert.equal(autoApplied.proofreading.status, "confirmed", "high-confidence corrections should not add a confirmation step");
const result = applyTranscriptReview({ transcript, proofreading, segments: submitted, confirmedUnresolvedSegmentIds: ["segment-2"], now: () => "2026-11-04T03:00:00.000Z" });
assert.equal(result.transcript.segments[1].text, "然后检查字幕。");
assert.equal(result.transcript.text, "把繁琐的剪辑工具交给AI然后检查字幕。");
assert.equal(result.proofreading.status, "confirmed");
assert.deepEqual(result.proofreading.unresolved, []);
assert.equal(result.proofreading.previewStale, true);
assert.equal(result.proofreading.manualCorrections[0].before, "然后检查字幕");
assert.equal(result.proofreading.resolvedUnresolved[0].resolution, "user-corrected");
assert.equal(result.proofreading.resolvedUnresolved[0].secondaryText, "然后检查字母");
assert.deepEqual(transcript, originalSnapshot, "review edits must not mutate the caller's original transcript");

assert.throws(() => applyTranscriptReview({ transcript, proofreading, segments: submitted, confirmedUnresolvedSegmentIds: [] }), /确认|confirm/i);
assert.throws(() => applyTranscriptReview({ transcript, proofreading, segments: [{ ...submitted[0], endMs: -1 }, submitted[1]], confirmedUnresolvedSegmentIds: ["segment-2"] }), /时间|timestamp/i);
assert.throws(() => applyTranscriptReview({ transcript, proofreading, segments: submitted.slice(1), confirmedUnresolvedSegmentIds: ["segment-2"] }), /segment|片段/);

const manualProofreading = { status: "manual_review_required", changes: [], unresolved: [] };
assert.throws(() => applyTranscriptReview({ transcript, proofreading: manualProofreading, segments: transcript.segments, confirmedUnresolvedSegmentIds: [] }), /所有|全部|confirm/i);
const manuallyConfirmed = applyTranscriptReview({ transcript, proofreading: manualProofreading, segments: transcript.segments, confirmedUnresolvedSegmentIds: ["segment-1", "segment-2"] });
assert.equal(manuallyConfirmed.proofreading.status, "confirmed");
assert.deepEqual(manuallyConfirmed.proofreading.manuallyReviewedSegmentIds.sort(), ["segment-1", "segment-2"]);

const autoChangeProofreading = { status: "ready", changes: [{ segmentId: "segment-1", before: "把烦做的剪辑工具交给AI", after: "把繁琐的剪辑工具交给AI", evidence: "whisper", reason: "双重识别一致" }], unresolved: [] };
assert.equal(applyTranscriptReview({ transcript, proofreading: autoChangeProofreading, segments: transcript.segments, confirmedUnresolvedSegmentIds: [] }).proofreading.status, "confirmed", "high-confidence dual-source corrections need no blocking manual confirmation");

console.log("transcript-review.verify: confirmed edits, immutable source, timestamp validation and manual fallback passed");
