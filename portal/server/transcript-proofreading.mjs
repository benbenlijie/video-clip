import { createHash } from "node:crypto";
import { parseWhisperSrt } from "./local-whisper.mjs";

const PUNCTUATION = /[\s，。！？、；：,.!?;:"'“”‘’（）()【】\[\]《》]/gu;

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(PUNCTUATION, "");
}

function visibleText(value) {
  return normalized(String(value || "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]*>/g, " "));
}

export function transcriptFingerprint(transcript) {
  return createHash("sha256").update(JSON.stringify({
    text: transcript?.text || "",
    segments: (transcript?.segments || []).map(({ id, startMs, endMs, text }) => ({ id, startMs, endMs, text })),
  })).digest("hex");
}

export function findUnverifiablePartialTranscriptSegments(transcript, plan, editPieces = null) {
  const keeps = editPieces ? editPieces.map((piece) => ({ startMs: piece.src[0], endMs: piece.src[1] })) : (plan?.segments || []).filter((cut) => cut.action !== "remove");
  return (transcript?.segments || []).filter((source) => {
    const overlapping = keeps.filter((cut) => Number(cut.endMs) > Number(source.startMs) && Number(cut.startMs) < Number(source.endMs));
    if (!overlapping.length) return false;
    if (source.wordTimingStatus === "protected") return !coversInterval(overlapping.filter((cut) => cut.action !== "remove"), Number(source.startMs), Number(source.endMs));
    let retainedUntil = Number(source.startMs);
    for (const cut of overlapping.sort((a, b) => Number(a.startMs) - Number(b.startMs))) {
      if (Number(cut.startMs) > retainedUntil + 0.01) break;
      retainedUntil = Math.max(retainedUntil, Number(cut.endMs));
      if (retainedUntil >= Number(source.endMs)) return false;
    }
    const words = Array.isArray(source.words)
      ? source.words.filter((word) => Number(word.startMs) >= 0 && Number(word.endMs) > Number(word.startMs) && typeof word.text === "string" && word.text.trim())
      : [];
    return !words.length || normalized(words.map((word) => word.text).join("")) !== normalized(source.text);
  }).map((source) => source.id);
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

function coversInterval(intervals, startMs, endMs) {
  let cursor = startMs;
  for (const interval of [...intervals].sort((a, b) => Number(a.startMs) - Number(b.startMs))) {
    if (Number(interval.startMs) > cursor + 0.01) return false;
    cursor = Math.max(cursor, Number(interval.endMs));
    if (cursor >= endMs) return true;
  }
  return false;
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

export function subtitlesMatchTranscript(srt, transcript, plan, visualSourceTexts = [], editPieces = null, renderedEvents = null) {
  const cues = parseWhisperSrt(srt);
  const keeps = editPieces ? editPieces.map((piece) => ({ startMs: piece.src[0], endMs: piece.src[1] })) : (plan?.segments || []).filter((cut) => cut.action !== "remove");
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
    const ranges = [];
    let cursorMs = cue.startMs;
    while (cursorMs < cue.endMs - 0.01) {
      const range = editedMap.find((item) => cursorMs >= item.editedStartMs - 0.01 && cursorMs < item.editedEndMs - 0.01);
      if (!range) {
        if (cue.endMs - cursorMs <= 400) break;
        return null;
      }
      const endMs = Math.min(cue.endMs, range.editedEndMs);
      if (endMs <= cursorMs) return null;
      ranges.push({
        sourceStartMs: range.sourceStartMs + cursorMs - range.editedStartMs,
        sourceEndMs: range.sourceStartMs + endMs - range.editedStartMs,
      });
      cursorMs = endMs;
    }
    const lastRange = ranges.at(-1);
    if (!lastRange || cue.endMs - cursorMs > 400) return null;
    return { ...cue, sourceStartMs: ranges[0].sourceStartMs, sourceEndMs: lastRange.sourceEndMs, sourceIntervals: ranges };
  };
  const contentMatchesTime = (mapped) => mapped.every((cue) => {
    const sourceIntervals = cue.sourceIntervals || [{ sourceStartMs: cue.sourceStartMs, sourceEndMs: cue.sourceEndMs }];
    const overlapsSource = (source) => sourceIntervals.some((interval) => Number(source.endMs) > interval.sourceStartMs && Number(source.startMs) < interval.sourceEndMs);
    const overlapsInterval = (word) => sourceIntervals.some((interval) => Number(word.endMs) > interval.sourceStartMs && Number(word.startMs) < interval.sourceEndMs);
    const overlapping = (transcript?.segments || []).filter(overlapsSource);
    if (!overlapping.length) return false;
    const segmentEvidence = normalized(overlapping.map((source) => source.text).join(""));
    const cueText = normalized(cue.text);
    const validWordGroups = overlapping.map((source) => Array.isArray(source.words)
      ? source.words.filter((word) => Number(word.startMs) >= 0 && Number(word.endMs) > Number(word.startMs))
      : []);
    const wordTimingUsable = validWordGroups.every((words, index) => words.length && normalized(words.map((word) => word.text || "").join("")) === normalized(overlapping[index].text));
    if (!wordTimingUsable) return segmentEvidence.includes(cueText);
    const timedEvidence = normalized(validWordGroups.flat().filter(overlapsInterval).map((word) => word.text || "").join(""));
    return timedEvidence.includes(cueText);
  });
  const sourceMapped = cues.map(mapInSourceTime).filter(Boolean);
  const editedMapped = cues.map(mapInEditedTime).filter(Boolean);
  const timingMatches = (!editPieces && sourceMapped.length === cues.length && contentMatchesTime(sourceMapped))
    || (editedMapped.length === cues.length && contentMatchesTime(editedMapped));
  if (!timingMatches) return false;
  const retained = [];
  for (const source of transcript?.segments || []) {
    const overlapping = keeps.filter((cut) => Number(cut.endMs) > Number(source.startMs) && Number(cut.startMs) < Number(source.endMs));
    if (!overlapping.length) continue;
    const validWords = Array.isArray(source.words)
      ? source.words.filter((word) => Number(word.startMs) >= 0 && Number(word.endMs) > Number(word.startMs) && typeof word.text === "string" && word.text.trim())
      : [];
    if (validWords.length && normalized(validWords.map((word) => word.text).join("")) === normalized(source.text)) {
      for (const [index, word] of validWords.entries()) {
        if (keeps.some((cut) => Number(cut.endMs) > Number(word.startMs) && Number(cut.startMs) < Number(word.endMs))) {
          retained.push({ key: `${source.id}:word:${index}`, startMs: Number(word.startMs), endMs: Number(word.endMs), text: word.text });
        }
      }
    } else if (coversInterval(overlapping, Number(source.startMs), Number(source.endMs))) {
      retained.push({ key: `${source.id}:segment`, startMs: Number(source.startMs), endMs: Number(source.endMs), text: source.text });
    } else {
      return false;
    }
  }

  const visualEvents = new Map((plan?.visualEvents || []).map((event) => [String(event.id), event]));
  const coveredKeys = new Set();
  const coverage = Array.isArray(plan?.captionCoverage) ? plan.captionCoverage : [];
  for (const item of coverage) {
    const event = visualEvents.get(String(item.eventId));
    const startMs = Number(item.startMs);
    const endMs = Number(item.endMs);
    const text = typeof item.text === "string" ? item.text : "";
    if (!event || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < Number(event.startMs) || endMs > Number(event.endMs) || endMs <= startMs || !text.trim()) return false;
    if (!visualSourceTexts.some((sourceText) => visibleText(sourceText).includes(normalized(text)))) return false;
    if (editPieces) {
      if (Array.isArray(renderedEvents)) {
        const candidates = renderedEvents.filter((actual) => actual.sourceEventId === item.eventId && normalized(`${actual.text || ""} ${actual.subtext || ""}`).includes(normalized(text)));
        const intervals = editPieces.flatMap((piece) => {
          const start = Math.max(startMs, piece.src[0]);
          const end = Math.min(endMs, piece.src[1]);
          return end > start ? [[start - piece.src[0] + piece.out[0], end - piece.src[0] + piece.out[0]]] : [];
        });
        if (!intervals.length || intervals.some(([start, end]) => !candidates.some((actual) => actual.startMs <= start + 0.01 && actual.endMs >= end - 0.01))) return false;
      }
    }
    const words = retained.filter((word) => word.startMs >= startMs && word.endMs <= endMs);
    const segmentToken = retained.find((word) => word.key.endsWith(":segment") && word.startMs < endMs && word.endMs > startMs && !coveredKeys.has(word.key));
    if (!words.length && !segmentToken) return false;
    if (segmentToken) {
      if (startMs < segmentToken.startMs || endMs > segmentToken.endMs || !normalized(segmentToken.text).includes(normalized(text))) return false;
      const sourceText = normalized(segmentToken.text);
      const coveredText = normalized(text);
      const offset = sourceText.indexOf(coveredText);
      if (offset < 0) return false;
      const remainingText = `${sourceText.slice(0, offset)}${sourceText.slice(offset + coveredText.length)}`;
      segmentToken.text = remainingText;
      coveredKeys.add(`${segmentToken.key}:covered`);
      continue;
    }
    if (retained.some((word) => word.startMs < endMs && word.endMs > startMs && !words.includes(word))) return false;
    if (normalized(words.map((word) => word.text).join("")) !== normalized(text) || words.some((word) => coveredKeys.has(word.key))) return false;
    words.forEach((word) => coveredKeys.add(word.key));
  }

  const expected = normalized(retained.filter((word) => !coveredKeys.has(word.key)).map((word) => word.text).join(""));
  const actual = normalized(cues.map((cue) => cue.text).join(""));
  if (!expected) return actual.length === 0;
  return actual === expected;
}
