const HARD_FILLER = /^(?:呃+|嗯+|额+|唔+|em+|uh+)$/iu;
const SOFT_PARTICLE = /^(?:啊+|呢+|吧+|嘛+|呀+|哈+|哦+|唉+|对吧)$/u;
export const FLUENCY_POLICY = {
  intraSegmentPauseMs: 250,
  intraSegmentTargetMs: 160,
  sentencePauseMs: 400,
  sentenceTargetMs: 260,
  sectionPauseMs: 800,
  sectionTargetMs: 420,
};

function normalizedWord(value) {
  return String(value || "").normalize("NFKC").replace(/[\s，。！？、；：,.!?;:"'“”‘’（）()【】\[\]《》]/gu, "");
}

function sourceRanges(timeline, transcript) {
  if (Array.isArray(timeline?.pieces) && timeline.pieces.length) {
    return timeline.pieces.map((piece) => ({
      startMs: Number(piece.src[0]),
      endMs: Number(piece.src[1]),
    })).filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs > range.startMs);
  }
  const segments = transcript?.segments || [];
  return segments.length ? [{ startMs: Number(segments[0].startMs), endMs: Math.max(...segments.map((segment) => Number(segment.endMs))) }] : [];
}

function retainedWords(transcript, ranges) {
  const result = [];
  for (const segment of transcript?.segments || []) {
    for (const word of segment.words || []) {
      const startMs = Number(word.startMs);
      const endMs = Number(word.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      let mapped = null;
      for (const [rangeIndex, range] of ranges.entries()) {
        const mappedStartMs = Math.max(startMs, range.startMs);
        const mappedEndMs = Math.min(endMs, range.endMs);
        const overlap = mappedEndMs - mappedStartMs;
        if (overlap > 0 && (!mapped || overlap > mapped.overlap)) mapped = { rangeIndex, mappedStartMs, mappedEndMs, overlap };
      }
      if (!mapped) continue;
      result.push({ ...word, startMs, endMs, segmentId: segment.id, ...mapped });
    }
  }
  return result.sort((a, b) => a.startMs - b.startMs);
}

function subtractRanges(ranges, edits) {
  return ranges.flatMap((range) => {
    const cuts = edits
      .map((edit) => ({ startMs: Math.max(range.startMs, edit.startMs), endMs: Math.min(range.endMs, edit.endMs) }))
      .filter((cut) => cut.endMs > cut.startMs)
      .sort((a, b) => a.startMs - b.startMs);
    const pieces = [];
    let cursor = range.startMs;
    for (const cut of cuts) {
      if (cut.startMs > cursor) pieces.push({ src: [cursor, cut.startMs] });
      cursor = Math.max(cursor, cut.endMs);
    }
    if (cursor < range.endMs) pieces.push({ src: [cursor, range.endMs] });
    return pieces;
  }).filter((piece) => piece.src[1] - piece.src[0] >= 1);
}

export function analyzeFluency({ transcript, timeline = null, policy = {} } = {}) {
  const thresholds = { ...FLUENCY_POLICY, ...policy };
  const ranges = sourceRanges(timeline, transcript);
  const words = retainedWords(transcript, ranges);
  const findings = [];
  const edits = [];
  for (const word of words) {
    const text = normalizedWord(word.text);
    if (SOFT_PARTICLE.test(text)) {
      findings.push({
        id: `soft-${findings.length + 1}`,
        type: "filler",
        classification: "soft",
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        action: "review",
        reason: "soft-particle-review",
      });
      continue;
    }
    if (!HARD_FILLER.test(text)) continue;
    findings.push({
      id: `filler-${findings.length + 1}`,
      type: "filler",
      classification: "hard",
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      action: "remove",
      reason: "hard-filler",
    });
    edits.push({ startMs: word.startMs - 20, endMs: word.endMs + 20, reason: "hard-filler" });
  }
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    if (previous.rangeIndex !== current.rangeIndex) continue;
    const gapMs = current.startMs - previous.endMs;
    const sameSegment = previous.segmentId === current.segmentId;
    const targetGapMs = sameSegment ? thresholds.intraSegmentTargetMs
      : gapMs > thresholds.sectionPauseMs ? thresholds.sectionTargetMs : thresholds.sentenceTargetMs;
    const thresholdMs = sameSegment ? thresholds.intraSegmentPauseMs
      : gapMs > thresholds.sectionPauseMs ? thresholds.sectionPauseMs : thresholds.sentencePauseMs;
    if (gapMs <= thresholdMs) continue;
    const leftPadMs = Math.round(targetGapMs / 2);
    const rightPadMs = targetGapMs - leftPadMs;
    const startMs = previous.endMs + leftPadMs;
    const endMs = current.startMs - rightPadMs;
    if (endMs <= startMs) continue;
    const finding = {
      id: `pause-${findings.length + 1}`,
      type: "pause",
      classification: sameSegment ? "intra-segment" : gapMs > thresholds.sectionPauseMs ? "section" : "sentence",
      startMs: previous.endMs,
      endMs: current.startMs,
      gapMs,
      targetGapMs,
      action: "clamp",
      reason: "pause-clamp",
      confidence: 0.95,
      before: previous.text,
      after: current.text,
    };
    findings.push(finding);
    edits.push({ startMs, endMs, reason: "pause-clamp", findingId: finding.id });
  }
  edits.sort((a, b) => a.startMs - b.startMs);
  const proposedPieces = subtractRanges(ranges, edits);
  const removedMs = edits.reduce((sum, edit) => sum + Math.max(0, edit.endMs - edit.startMs), 0);
  return {
    contract: "fluency-report.v1",
    sourceRanges: ranges,
    wordCount: words.length,
    findings,
    edits,
    proposedPieces,
    removedMs,
    policy: thresholds,
  };
}

export function verifyFluency({ transcript, timeline = null, policy = {} } = {}) {
  const report = analyzeFluency({ transcript, timeline, policy });
  const hardFillers = report.findings.filter((item) => item.type === "filler" && item.classification === "hard");
  const pauses = report.findings.filter((item) => item.type === "pause");
  const issues = [
    ...hardFillers.map((item) => ({ code: "hard-filler", text: item.text, startMs: item.startMs, endMs: item.endMs })),
    ...pauses.map((item) => ({ code: "long-pause", gapMs: item.gapMs, startMs: item.startMs, endMs: item.endMs })),
  ];
  return {
    contract: "fluency-qc.v1",
    passed: issues.length === 0,
    issues,
    hardFillerCount: hardFillers.length,
    pauseCount: pauses.length,
    softFillerCount: report.findings.filter((item) => item.type === "filler" && item.classification === "soft").length,
    report,
  };
}
