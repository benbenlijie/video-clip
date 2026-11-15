import assert from "node:assert/strict";
import { applyTranscriptReview, ensureTranscriptReviewState } from "./transcript-review.mjs";
const timingModule = await import("./transcript-word-timing.mjs").catch(() => ({}));
assert.equal(typeof timingModule.remapWordTimings, "function", "manual transcript edits need an ASR-anchored word timing remapper");
const { remapWordTimings } = timingModule;

assert.deepEqual(remapWordTimings({ previousText: "甲乙丙", nextText: "甲丁丙", words: [{ startMs: 100, endMs: 400, text: "甲乙丙" }], startMs: 100, endMs: 400 }), [
  { startMs: 100, endMs: 200, text: "甲" },
  { startMs: 200, endMs: 300, text: "丁" },
  { startMs: 300, endMs: 400, text: "丙" },
], "a one-character correction changes only the original character's time span");
assert.deepEqual(remapWordTimings({ previousText: "甲乙丙", nextText: "甲乙新丙", words: [{ startMs: 100, endMs: 400, text: "甲乙丙" }], startMs: 100, endMs: 400 }), [
  { startMs: 100, endMs: 175, text: "甲" },
  { startMs: 175, endMs: 250, text: "乙" },
  { startMs: 250, endMs: 325, text: "新" },
  { startMs: 325, endMs: 400, text: "丙" },
], "inserted characters share the nearest ASR word's original time range");
assert.deepEqual(remapWordTimings({ previousText: "乙丙", nextText: "甲乙丙", words: [{ startMs: 0, endMs: 300, text: "乙丙" }], startMs: 0, endMs: 300 }), [
  { startMs: 0, endMs: 100, text: "甲" },
  { startMs: 100, endMs: 200, text: "乙" },
  { startMs: 200, endMs: 300, text: "丙" },
], "a leading insertion borrows time from the nearest ASR word");
assert.deepEqual(remapWordTimings({ previousText: "甲乙", nextText: "甲乙丙", words: [{ startMs: 0, endMs: 300, text: "甲乙" }], startMs: 0, endMs: 300 }), [
  { startMs: 0, endMs: 100, text: "甲" },
  { startMs: 100, endMs: 200, text: "乙" },
  { startMs: 200, endMs: 300, text: "丙" },
], "a trailing insertion borrows time from the nearest ASR word");
assert.deepEqual(remapWordTimings({ previousText: "甲乙丙丁", nextText: "甲丙丁", words: [{ startMs: 100, endMs: 500, text: "甲乙丙丁" }], startMs: 100, endMs: 500 }), [
  { startMs: 100, endMs: 200, text: "甲" },
  { startMs: 300, endMs: 400, text: "丙" },
  { startMs: 400, endMs: 500, text: "丁" },
], "deleting a character leaves unchanged characters at their original positions");
assert.deepEqual(remapWordTimings({ previousText: "A👩🏽‍💻B", nextText: "A👩🏽‍💻D", words: [{ startMs: 0, endMs: 300, text: "A👩🏽‍💻B" }], startMs: 0, endMs: 300 }), [
  { startMs: 0, endMs: 100, text: "A" },
  { startMs: 100, endMs: 200, text: "👩🏽‍💻" },
  { startMs: 200, endMs: 300, text: "D" },
], "Unicode grapheme clusters stay intact while mapping changed text");
assert.deepEqual(remapWordTimings({ previousText: "哈哈哈", nextText: "哈哈呀", words: [{ startMs: 0, endMs: 300, text: "哈哈哈" }], startMs: 0, endMs: 300 }), [
  { startMs: 0, endMs: 100, text: "哈" },
  { startMs: 100, endMs: 200, text: "哈" },
  { startMs: 200, endMs: 300, text: "呀" },
], "repeated graphemes retain a monotonic alignment");
assert.deepEqual(remapWordTimings({ previousText: "甲乙!", nextText: "甲，乙。", words: [{ startMs: 0, endMs: 200, text: "甲乙" }], startMs: 0, endMs: 200 }), [
  { startMs: 0, endMs: 100, text: "甲" },
  { startMs: 100, endMs: 200, text: "乙" },
], "punctuation-only changes keep the spoken-word timing positions");
assert.equal(remapWordTimings({ previousText: "甲乙", nextText: "甲丙", words: [{ startMs: 900, endMs: 1200, text: "甲乙" }], startMs: 100, endMs: 500 }), null, "word timing outside the source segment is not guessed");
assert.equal(remapWordTimings({ previousText: "甲乙", nextText: "甲丙", words: [null], startMs: 100, endMs: 500 }), null, "malformed ASR word entries use protected fallback instead of throwing");

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

const timedTranscript = { text: "甲乙丙", segments: [{ id: "timed", startMs: 100, endMs: 400, text: "甲乙丙", words: [{ startMs: 100, endMs: 400, text: "甲乙丙" }] }] };
const timedEdit = applyTranscriptReview({ transcript: timedTranscript, proofreading: { status: "confirmed", changes: [], unresolved: [] }, segments: [{ ...timedTranscript.segments[0], text: "甲丁丙" }] });
assert.deepEqual(timedEdit.transcript.segments[0].words, [
  { startMs: 100, endMs: 200, text: "甲" },
  { startMs: 200, endMs: 300, text: "丁" },
  { startMs: 300, endMs: 400, text: "丙" },
]);
assert.equal(timedEdit.transcript.segments[0].wordTimingStatus, "estimated");
const noTimingEdit = applyTranscriptReview({ transcript, proofreading: { status: "confirmed", changes: [], unresolved: [] }, segments: [{ ...transcript.segments[0], text: "改过的内容" }, transcript.segments[1]] });
assert.equal(noTimingEdit.transcript.segments[0].wordTimingStatus, "protected", "unavailable source word times protect the utterance instead of inventing precision");

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
