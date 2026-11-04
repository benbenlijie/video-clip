import assert from "node:assert/strict";
import { subtitlesMatchTranscript, validateProofreadResult } from "./transcript-proofreading.mjs";

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

console.log("transcript-proofreading.verify: evidence validation, manual fallback and subtitle text QC passed");
