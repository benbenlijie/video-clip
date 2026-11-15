import assert from "node:assert/strict";
import { subtitlesMatchTranscript, validateProofreadResult } from "./transcript-proofreading.mjs";
import * as proofreading from "./transcript-proofreading.mjs";

const primary = {
  provider: "volcengine", language: "zh", durationMs: 3000, text: "把烦做的剪辑工具交给AI然后检查字幕",
  segments: [
    { id: "segment-1", startMs: 100, endMs: 1400, text: "把烦做的剪辑工具交给AI" },
    { id: "segment-2", startMs: 1500, endMs: 2800, text: "然后检查字幕" },
  ],
};
const secondary = {
  provider: "whisper.cpp", model: "small_q5_1", language: "zh", durationMs: 2800, text: "把繁琐的剪辑工具交给AI然后检查字幕",
  segments: [
    { id: "whisper-1", startMs: 100, endMs: 1400, text: "把繁琐的剪辑工具交给AI" },
    { id: "whisper-2", startMs: 1500, endMs: 2800, text: "然后检查字幕" },
  ],
};
const corrected = {
  status: "ready",
  transcript: {
    language: "zh", durationMs: 3000, text: "把繁琐的剪辑工具交给AI然后检查字幕",
    segments: [
      { id: "segment-1", startMs: 100, endMs: 1400, text: "把繁琐的剪辑工具交给AI" },
      { id: "segment-2", startMs: 1500, endMs: 2800, text: "然后检查字幕" },
    ],
  },
  changes: [{ segmentId: "segment-1", before: "把烦做的剪辑工具交给AI", after: "把繁琐的剪辑工具交给AI", evidence: "whisper", reason: "第二份声学转录与原音一致" }],
  unresolved: [],
};

const accepted = validateProofreadResult(corrected, primary, secondary);
assert.equal(accepted.status, "ready");
assert.equal(accepted.transcript.segments[0].text, "把繁琐的剪辑工具交给AI");

const unresolved = validateProofreadResult({
  ...corrected,
  status: "needs_review",
  transcript: { ...corrected.transcript, text: "把繁琐的剪辑工具交给AI然后检查字幕", segments: [{ ...corrected.transcript.segments[0], text: "把繁琐的剪辑工具交给AI" }, corrected.transcript.segments[1]] },
  changes: [corrected.changes[0]],
  unresolved: [{ segmentId: "segment-2", primaryText: "然后检查字幕", secondaryText: "然后检查字母", reason: "fixture ambiguity" }],
}, primary, { ...secondary, text: "把繁琐的剪辑工具交给AI然后检查字母", segments: [{ ...secondary.segments[0], text: "把繁琐的剪辑工具交给AI" }, { ...secondary.segments[1], text: "然后检查字母" }] });
assert.equal(unresolved.status, "needs_review");
assert.equal(unresolved.unresolved[0].segmentId, "segment-2");
assert.throws(() => validateProofreadResult({
  ...corrected,
  status: "needs_review",
  transcript: { ...corrected.transcript, text: "把繁琐的剪辑工具交给AI然后检查字母", segments: [corrected.transcript.segments[0], { ...corrected.transcript.segments[1], text: "然后检查字母" }] },
  changes: [corrected.changes[0]],
  unresolved: [{ segmentId: "segment-2", primaryText: "然后检查字幕", secondaryText: "然后检查字母", reason: "冲突待确认" }],
}, primary, { ...secondary, text: "把繁琐的剪辑工具交给AI然后检查字母", segments: [secondary.segments[0], { ...secondary.segments[1], text: "然后检查字母" }] }), /preserve primary|保留 primary/i);

assert.throws(() => validateProofreadResult({
  ...corrected,
  transcript: { ...corrected.transcript, text: "把没听见的内容补上然后检查字幕", segments: [{ ...corrected.transcript.segments[0], text: "把没听见的内容补上" }, corrected.transcript.segments[1]] },
  changes: [{ ...corrected.changes[0], after: "把没听见的内容补上" }],
}, primary, secondary), /evidence|来源|识别稿/);
assert.throws(() => validateProofreadResult({ ...corrected, changes: [] }, primary, secondary), /change|修改|遗漏/);
assert.throws(() => validateProofreadResult({ ...corrected, status: "ready", changes: [corrected.changes[0]], unresolved: [] }, primary, { ...secondary, text: "把繁琐的剪辑工具交给AI然后检查字母", segments: [secondary.segments[0], { ...secondary.segments[1], text: "然后检查字母" }] }), /unresolved|分歧|disagreement/i, "every ASR text disagreement must be changed with evidence or recorded as unresolved");
assert.throws(() => validateProofreadResult({ ...corrected, transcript: { ...corrected.transcript, segments: [{ ...corrected.transcript.segments[0], endMs: 100 }, corrected.transcript.segments[1]] } }, primary, secondary), /时间|timestamp|segment/i);

const manual = validateProofreadResult({ status: "manual_review_required", transcript: primary, changes: [], unresolved: [] }, primary, null);
assert.equal(manual.status, "manual_review_required");
assert.deepEqual(manual.transcript, primary);

const fullKeep = { segments: [{ startMs: 0, endMs: 3000, action: "keep" }] };
const validSrt = "1\n00:00:00,100 --> 00:00:01,400\n把繁琐的剪辑工具交给AI\n\n2\n00:00:01,500 --> 00:00:02,800\n然后检查字幕\n";
assert.equal(subtitlesMatchTranscript(validSrt, accepted.transcript, fullKeep), true);
assert.equal(subtitlesMatchTranscript(validSrt.replace("繁琐", "凡速"), accepted.transcript, fullKeep), false, "subtitle typo must fail text QC");
assert.equal(subtitlesMatchTranscript(validSrt.replace("然后检查字幕", ""), accepted.transcript, fullKeep), false, "missing full-keep caption text must fail QC");
const splitTranscript = { text: "你好世界", segments: [{ id: "hello", startMs: 0, endMs: 1000, text: "你好" }, { id: "world", startMs: 2000, endMs: 3000, text: "世界" }] };
const splitPlan = { segments: [{ startMs: 0, endMs: 1000, action: "keep" }, { startMs: 2000, endMs: 3000, action: "keep" }] };
assert.equal(subtitlesMatchTranscript("1\n00:00:02,000 --> 00:00:02,500\n你好\n\n2\n00:00:00,000 --> 00:00:00,500\n世界\n", splitTranscript, splitPlan), false, "cue text in the wrong retained time range must fail QC");
assert.equal(subtitlesMatchTranscript("1\n00:00:01,500 --> 00:00:02,500\n你好\n", { text: "你好", segments: [{ id: "hello", startMs: 0, endMs: 3000, text: "你好" }] }, { segments: [{ startMs: 0, endMs: 1000, action: "keep" }, { startMs: 2000, endMs: 3000, action: "keep" }] }), false, "a cue in removed footage must fail QC");
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,400\n把繁琐的剪辑工具交给AI\n", accepted.transcript, { segments: [{ startMs: 100, endMs: 1400, action: "keep" }, { startMs: 1500, endMs: 2800, action: "remove" }] }), true, "subtitle text may omit removed footage");
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:00,650\n把繁琐\n", { ...accepted.transcript, segments: [{ ...accepted.transcript.segments[0], words: [{ startMs: 100, endMs: 300, text: "把" }, { startMs: 300, endMs: 650, text: "繁琐" }, { startMs: 650, endMs: 900, text: "的" }, { startMs: 900, endMs: 1000, text: "剪辑" }, { startMs: 1000, endMs: 1100, text: "工具" }, { startMs: 1100, endMs: 1200, text: "交给" }, { startMs: 1200, endMs: 1300, text: "AI" }] }, accepted.transcript.segments[1]] }, { segments: [{ startMs: 100, endMs: 650, action: "keep" }] }), true, "partial trims with word timestamps compare their retained words exactly");
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,000\n把\n", accepted.transcript, { segments: [{ startMs: 100, endMs: 650, action: "keep" }] }), false, "a partial transcript segment without word timing cannot silently pass incomplete captions");
assert.equal(typeof proofreading.findUnverifiablePartialTranscriptSegments, "function", "the subtitle validator must report corrected segments whose word timings no longer match");
const correctedWithStaleWords = { text: "校对后的字幕", segments: [{ id: "corrected-segment", startMs: 100, endMs: 1400, text: "校对后的字幕", words: [{ startMs: 100, endMs: 1400, text: "旧识别文字" }] }] };
assert.deepEqual(proofreading.findUnverifiablePartialTranscriptSegments(correctedWithStaleWords, { segments: [{ startMs: 300, endMs: 900, action: "keep" }] }), ["corrected-segment"]);
assert.deepEqual(proofreading.findUnverifiablePartialTranscriptSegments(correctedWithStaleWords, { segments: [{ startMs: 100, endMs: 1400, action: "keep" }] }), [], "keeping the full corrected segment does not require word-level timing");
assert.deepEqual(proofreading.findUnverifiablePartialTranscriptSegments(correctedWithStaleWords, { segments: [{ startMs: 100, endMs: 700, action: "keep" }, { startMs: 700, endMs: 1400, action: "keep" }] }), [], "adjacent cuts that retain the full segment do not invalidate it");
const protectedWithLaterWords = { ...correctedWithStaleWords, segments: [{ ...correctedWithStaleWords.segments[0], words: [{ startMs: 100, endMs: 700, text: "校对" }, { startMs: 700, endMs: 1400, text: "后的字幕" }], wordTimingStatus: "protected" }] };
assert.deepEqual(proofreading.findUnverifiablePartialTranscriptSegments(protectedWithLaterWords, { segments: [{ startMs: 100, endMs: 800, action: "keep" }] }), ["corrected-segment"], "protected segments stay all-or-nothing even if later timing happens to resemble the corrected text");
assert.deepEqual(proofreading.findUnverifiablePartialTranscriptSegments(protectedWithLaterWords, { segments: [{ startMs: 100, endMs: 1400, action: "keep" }] }), [], "a fully retained protected segment passes the final alignment guard");

const cutWithCaptionTail = { segments: [{ startMs: 0, endMs: 1000, action: "keep" }, { startMs: 2000, endMs: 3000, action: "keep" }] };
const cutTailTranscript = { text: "你好世界", segments: [{ id: "hello", startMs: 0, endMs: 1000, text: "你好" }, { id: "world", startMs: 2000, endMs: 3000, text: "世界" }] };
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,200\n你好\n\n2\n00:00:01,000 --> 00:00:02,000\n世界\n", cutTailTranscript, cutWithCaptionTail), true, "readability extensions may clamp at the end of their retained clip");

const visualCoverage = {
  segments: [{ startMs: 0, endMs: 3000, action: "keep" }],
  visualEvents: [{ id: "visual-world", startMs: 2000, endMs: 3000, type: "emphasis", text: "世界", subtext: "" }],
  captionCoverage: [{ eventId: "visual-world", startMs: 2000, endMs: 3000, text: "世界" }],
};
const visuallyCaptionedTranscript = { text: "你好世界", segments: [
  { id: "hello", startMs: 0, endMs: 1000, text: "你好", words: [{ startMs: 100, endMs: 500, text: "你" }, { startMs: 500, endMs: 1000, text: "好" }] },
  { id: "world", startMs: 2000, endMs: 3000, text: "世界", words: [{ startMs: 2000, endMs: 2500, text: "世" }, { startMs: 2500, endMs: 3000, text: "界" }] },
] };
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,000\n你好\n", visuallyCaptionedTranscript, visualCoverage, ["<div>世界</div>"]), true, "exact spoken words shown by a timed visual event can cover omitted SRT text");
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,000\n你好\n", visuallyCaptionedTranscript, visualCoverage, ["<div>世界</div>"], [{ src: [0, 3000], out: [0, 3000] }]), true, "Wayne captions may validate visual coverage from the saved source without Remotion event records");
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,000\n你好\n", visuallyCaptionedTranscript, visualCoverage, ["<div>字幕</div>"]), false, "visual coverage must exist in the declared overlay source");
const actualPieces = [{ src: [0, 1000], out: [0, 1000] }, { src: [3000, 4000], out: [1000, 2000] }];
const actualTranscript = { text: "你好世界", segments: [{ id: "one", startMs: 100, endMs: 900, text: "你好" }, { id: "two", startMs: 3100, endMs: 3900, text: "世界" }] };
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:00,900\n你好\n\n2\n00:00:03,100 --> 00:00:03,900\n世界\n", actualTranscript, { segments: actualPieces.map((piece) => ({ startMs: piece.src[0], endMs: piece.src[1], action: "keep" })) }, [], actualPieces), false, "a composed two-second video must reject uncut source SRT timestamps");
const contiguousPieceTranscript = {
  text: "甲乙",
  segments: [{ id: "piece-split", startMs: 100, endMs: 1900, text: "甲乙", words: [{ startMs: 100, endMs: 1000, text: "甲" }, { startMs: 1000, endMs: 1900, text: "乙" }] }],
};
const contiguousPieces = [{ src: [0, 1000], out: [0, 1000] }, { src: [1000, 2000], out: [1000, 2000] }];
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,900\n甲乙\n", contiguousPieceTranscript, { segments: contiguousPieces.map((piece) => ({ startMs: piece.src[0], endMs: piece.src[1], action: "keep" })) }, [], contiguousPieces), true, "a caption may cross contiguous timeline pieces such as a punch-in split");
const fullyRetainedCorrectedSegment = {
  text: "把繁琐的剪辑工作交给AI",
  segments: [{ id: "corrected-full", startMs: 100, endMs: 1900, text: "把繁琐的剪辑工作交给AI", words: [{ startMs: 100, endMs: 900, text: "把烦做的剪辑工具" }, { startMs: 900, endMs: 1900, text: "交给AI" }] }],
};
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,900\n把繁琐的剪辑工作交给AI\n", fullyRetainedCorrectedSegment, { segments: contiguousPieces.map((piece) => ({ startMs: piece.src[0], endMs: piece.src[1], action: "keep" })) }, [], contiguousPieces), true, "a fully retained corrected segment may use its approved text when old word tokens are stale");
const coverageMap = [{ src: [0, 3000], out: [0, 3000] }];
const wrongEventCoverage = { ...visualCoverage, visualEvents: [{ id: "other", startMs: 0, endMs: 300, type: "emphasis", text: "世界" }, { id: "wrong", startMs: 2000, endMs: 3000, type: "emphasis", text: "概述" }], captionCoverage: [{ eventId: "wrong", startMs: 2000, endMs: 3000, text: "世界" }] };
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,000\n你好\n", visuallyCaptionedTranscript, wrongEventCoverage, ["世界 概述"], coverageMap, [{ sourceEventId: "other", startMs: 0, endMs: 300, text: "世界" }, { sourceEventId: "wrong", startMs: 2000, endMs: 3000, text: "概述" }]), false, "a word displayed by another event cannot cover missing subtitles");
assert.equal(subtitlesMatchTranscript("1\n00:00:00,100 --> 00:00:01,000\n你好\n", visuallyCaptionedTranscript, visualCoverage, ["世界"], coverageMap, [{ sourceEventId: "visual-world", startMs: 2000, endMs: 3000, text: "世界" }]), true);

console.log("transcript-proofreading.verify: evidence validation, manual fallback and subtitle text QC passed");
