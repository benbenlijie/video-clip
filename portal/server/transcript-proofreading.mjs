import { createHash } from "node:crypto";
import { parseWhisperSrt } from "./local-whisper.mjs";

const PUNCTUATION = /[\s，。！？、；：,.!?;:"'“”‘’（）()【】\[\]《》]/gu;

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(PUNCTUATION, "");
}

export function transcriptFingerprint(transcript) {
  return createHash("sha256").update(JSON.stringify({
    text: transcript?.text || "",
    segments: (transcript?.segments || []).map(({ id, startMs, endMs, text }) => ({ id, startMs, endMs, text })),
  })).digest("hex");
}

function assertTranscriptShape(transcript, label) {
  if (!transcript || !Array.isArray(transcript.segments) || !transcript.segments.length) throw new Error(`${label} transcript segments missing`);
  let previousStart = -1;
  for (const [index, segment] of transcript.segments.entries()) {
    const startMs = Number(segment.startMs);
    const endMs = Number(segment.endMs);
    if (!segment.id || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || startMs < previousStart || typeof segment.text !== "string") {
      throw new Error(`${label} transcript segment timestamp/text invalid: ${index + 1}`);
    }
    previousStart = startMs;
  }
  if (normalized(transcript.text) !== normalized(transcript.segments.map((segment) => segment.text).join(""))) {
    throw new Error(`${label} transcript text does not match its segments`);
  }
}

function assertSameSegmentTimeline(corrected, primary) {
  if (corrected.segments.length !== primary.segments.length) throw new Error("proofread transcript must preserve original segment coverage");
  for (const [index, segment] of corrected.segments.entries()) {
    const source = primary.segments[index];
    if (segment.id !== source.id || Number(segment.startMs) !== Number(source.startMs) || Number(segment.endMs) !== Number(source.endMs)) {
      throw new Error(`proofread transcript segment timestamp/id mismatch: ${index + 1}`);
    }
  }
}

function overlappingText(transcript, segment) {
  return transcript.segments
    .filter((source) => Number(source.endMs) > Number(segment.startMs) && Number(source.startMs) < Number(segment.endMs))
    .map((source) => source.text)
    .join("");
}

function supportedBy(text, sourceText) {
  const needle = normalized(text);
  return needle && normalized(sourceText).includes(needle);
}

export function validateProofreadResult(result, primary, secondary) {
  assertTranscriptShape(primary, "primary");
  if (!secondary) {
    if (result?.status !== "manual_review_required" || !Array.isArray(result.changes) || result.changes.length || !Array.isArray(result.unresolved)) {
      throw new Error("Whisper unavailable; proofread result must retain the primary transcript for manual review");
    }
    assertTranscriptShape(result.transcript, "proofread");
    assertSameSegmentTimeline(result.transcript, primary);
    if (result.transcript.segments.some((segment, index) => segment.text !== primary.segments[index].text)) {
      throw new Error("proofread result cannot change words without the secondary audio transcript");
    }
    return { status: "manual_review_required", transcript: result.transcript, changes: [], unresolved: result.unresolved };
  }

  assertTranscriptShape(secondary, "Whisper");
  assertTranscriptShape(result?.transcript, "proofread");
  assertSameSegmentTimeline(result.transcript, primary);
  if (!Array.isArray(result.changes) || !Array.isArray(result.unresolved)) throw new Error("proofread changes/unresolved arrays missing");

  const primaryById = new Map(primary.segments.map((segment) => [segment.id, segment]));
  const changeById = new Map();
  for (const change of result.changes) {
    const source = primaryById.get(change.segmentId);
    const corrected = result.transcript.segments.find((segment) => segment.id === change.segmentId);
    if (!source || !corrected || changeById.has(change.segmentId) || typeof change.reason !== "string" || !change.reason.trim()) throw new Error("proofread change record invalid");
    if (change.before !== source.text || change.after !== corrected.text || change.before === change.after) throw new Error(`proofread change text mismatch: ${change.segmentId}`);
    const sourceWhisper = overlappingText(secondary, source);
    const primarySupported = supportedBy(change.after, source.text);
    const whisperSupported = supportedBy(change.after, sourceWhisper);
    const evidenceSupported = change.evidence === "primary" ? primarySupported
      : change.evidence === "whisper" ? whisperSupported
        : change.evidence === "both" ? primarySupported && whisperSupported : false;
    if (!evidenceSupported) throw new Error(`proofread change has no matching recognition evidence: ${change.segmentId}`);
    changeById.set(change.segmentId, change);
  }

  const unresolvedById = new Map();
  for (const item of result.unresolved) {
    const source = primaryById.get(item.segmentId);
    const corrected = result.transcript.segments.find((segment) => segment.id === item.segmentId);
    if (!source || unresolvedById.has(item.segmentId) || changeById.has(item.segmentId) || item.primaryText !== source.text || typeof item.reason !== "string" || !item.reason.trim()) {
      throw new Error("unresolved transcript item invalid");
    }
    if (corrected.text !== source.text) throw new Error(`unresolved transcript segment must preserve primary text: ${item.segmentId}`);
    const whisperText = overlappingText(secondary, source);
    if (normalized(item.secondaryText) !== normalized(whisperText) || normalized(item.primaryText) === normalized(item.secondaryText)) throw new Error(`unresolved transcript evidence mismatch: ${item.segmentId}`);
    unresolvedById.set(item.segmentId, item);
  }

  for (const [index, source] of primary.segments.entries()) {
    if (source.text !== result.transcript.segments[index].text && !changeById.has(source.id) && !unresolvedById.has(source.id)) {
      throw new Error(`proofread transcript contains an unreported change: ${source.id}`);
    }
    if (normalized(source.text) !== normalized(overlappingText(secondary, source)) && !changeById.has(source.id) && !unresolvedById.has(source.id)) {
      throw new Error(`ASR disagreement was not corrected or marked unresolved: ${source.id}`);
    }
  }
  const status = unresolvedById.size ? "needs_review" : "ready";
  if (result.status !== status) throw new Error(`proofread status must be ${status}`);
  return { status, transcript: result.transcript, changes: result.changes, unresolved: result.unresolved };
}

export function subtitlesMatchTranscript(srt, transcript, plan) {
  const cues = parseWhisperSrt(srt);
  const keeps = (plan?.segments || []).filter((cut) => cut.action !== "remove");
  if (!cues.length) return !(transcript?.segments || []).some((segment) => keeps.some((cut) => Number(cut.endMs) > Number(segment.startMs) && Number(cut.startMs) < Number(segment.endMs)));
  for (let index = 1; index < cues.length; index += 1) if (cues[index].startMs < cues[index - 1].startMs) return false;
  let cursorMs = 0;
  const editedMap = [];
  for (const cut of keeps) {
    const startMs = Number(cut.startMs);
    const endMs = Number(cut.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
    editedMap.push({ sourceStartMs: startMs, sourceEndMs: endMs, editedStartMs: cursorMs, editedEndMs: cursorMs + endMs - startMs });
    cursorMs += endMs - startMs;
  }
  const mapInSourceTime = (cue) => {
    const cut = keeps.find((item) => cue.startMs >= Number(item.startMs) && cue.endMs <= Number(item.endMs));
    return cut ? { ...cue, sourceStartMs: cue.startMs, sourceEndMs: cue.endMs } : null;
  };
  const mapInEditedTime = (cue) => {
    const range = editedMap.find((item) => cue.startMs >= item.editedStartMs && cue.endMs <= item.editedEndMs);
    if (!range) return null;
    return { ...cue, sourceStartMs: range.sourceStartMs + cue.startMs - range.editedStartMs, sourceEndMs: range.sourceStartMs + cue.endMs - range.editedStartMs };
  };
  const contentMatchesTime = (mapped) => mapped.every((cue) => {
    const overlapping = (transcript?.segments || []).filter((source) => Number(source.endMs) > cue.sourceStartMs && Number(source.startMs) < cue.sourceEndMs);
    if (!overlapping.length) return false;
    const segmentEvidence = normalized(overlapping.map((source) => source.text).join(""));
    const cueText = normalized(cue.text);
    const validWordGroups = overlapping.map((source) => Array.isArray(source.words)
      ? source.words.filter((word) => Number(word.startMs) >= 0 && Number(word.endMs) > Number(word.startMs))
      : []);
    const wordTimingUsable = validWordGroups.every((words, index) => words.length && normalized(words.map((word) => word.text || "").join("")) === normalized(overlapping[index].text));
    if (!wordTimingUsable) return segmentEvidence.includes(cueText);
    const timedEvidence = normalized(validWordGroups.flat().filter((word) => Number(word.endMs) > cue.sourceStartMs && Number(word.startMs) < cue.sourceEndMs).map((word) => word.text || "").join(""));
    return timedEvidence.includes(cueText);
  });
  const sourceMapped = cues.map(mapInSourceTime).filter(Boolean);
  const editedMapped = cues.map(mapInEditedTime).filter(Boolean);
  const timingMatches = (sourceMapped.length === cues.length && contentMatchesTime(sourceMapped))
    || (editedMapped.length === cues.length && contentMatchesTime(editedMapped));
  if (!timingMatches) return false;
  const expectedParts = [];
  for (const source of transcript?.segments || []) {
    const overlapping = keeps.filter((cut) => Number(cut.endMs) > Number(source.startMs) && Number(cut.startMs) < Number(source.endMs));
    if (!overlapping.length) continue;
    if (overlapping.some((cut) => Number(cut.startMs) <= Number(source.startMs) && Number(cut.endMs) >= Number(source.endMs))) {
      expectedParts.push(source.text);
      continue;
    }
    if (!Array.isArray(source.words) || !source.words.length) return false;
    const validWords = source.words.filter((word) => Number(word.startMs) >= 0 && Number(word.endMs) > Number(word.startMs));
    if (normalized(validWords.map((word) => word.text || "").join("")) !== normalized(source.text)) return false;
    const words = validWords.filter((word) => keeps.some((cut) => Number(cut.endMs) > Number(word.startMs) && Number(cut.startMs) < Number(word.endMs)));
    if (!words.length) return false;
    expectedParts.push(words.map((word) => word.text).join(""));
  }
  const expected = normalized(expectedParts.join(""));
  const actual = normalized(cues.map((cue) => cue.text).join(""));
  if (!expected) return actual.length === 0;
  return actual === expected;
}
