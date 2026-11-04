import { transcriptToSrt } from "./edit-plan.mjs";

export function ensureTranscriptReviewState(project) {
  if (!project?.transcript) return false;
  let changed = false;
  if (!project.primaryTranscript) {
    project.primaryTranscript = structuredClone(project.transcript);
    changed = true;
  }
  if (!project.proofreading) {
    project.proofreading = {
      status: project.secondaryTranscript ? "pending" : "manual_review_required",
      model: project.secondaryTranscript?.model || null,
      changes: [],
      unresolved: [],
      previewTranscriptSha256: null,
      previewStale: Boolean(project.plan),
      migrated: true,
    };
    changed = true;
  }
  return changed;
}

function validateSegments(input, source) {
  if (!Array.isArray(input) || input.length !== source.length) throw new Error("字幕片段必须与原始片段一一对应");
  let previousStart = -1;
  return input.map((segment, index) => {
    const original = source[index];
    const startMs = Number(segment.startMs);
    const endMs = Number(segment.endMs);
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (segment.id !== original.id || startMs !== Number(original.startMs) || endMs !== Number(original.endMs)) throw new Error(`字幕片段 id 或时间戳不能修改: ${original.id}`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > Number(original.endMs) + 60000 || startMs < previousStart) throw new Error(`字幕片段时间戳无效: ${original.id}`);
    if (!text || text.length > 2000) throw new Error(`字幕片段文字不能为空或过长: ${original.id}`);
    previousStart = startMs;
    return { ...original, text };
  });
}

export function applyTranscriptReview({ transcript, proofreading, segments, confirmedUnresolvedSegmentIds = [], now = () => new Date().toISOString() }) {
  if (!transcript || !Array.isArray(transcript.segments) || !transcript.segments.length) throw new Error("当前项目没有可审阅字幕");
  if (!proofreading || !["ready", "needs_review", "manual_review_required", "confirmed"].includes(proofreading.status)) throw new Error("字幕校对状态无效");
  const updatedSegments = validateSegments(segments, transcript.segments);
  const unresolved = Array.isArray(proofreading.unresolved) ? proofreading.unresolved : [];
  const unresolvedIds = new Set(unresolved.map((item) => item.segmentId));
  const confirmed = new Set(confirmedUnresolvedSegmentIds);
  const confirmableIds = proofreading.status === "manual_review_required" ? new Set(transcript.segments.map((segment) => segment.id)) : unresolvedIds;
  if ([...confirmed].some((id) => !confirmableIds.has(id))) throw new Error("确认列表中包含非待确认片段");
  if (proofreading.status === "manual_review_required" && (confirmed.size !== transcript.segments.length || transcript.segments.some((segment) => !confirmed.has(segment.id)))) throw new Error("Whisper 不可用时，需确认所有字幕片段");
  if (["needs_review", "manual_review_required"].includes(proofreading.status) && [...unresolvedIds].some((id) => !confirmed.has(id))) throw new Error("请编辑或明确确认所有待确认字幕");
  const manualCorrections = updatedSegments.flatMap((segment, index) => segment.text === transcript.segments[index].text ? [] : [{
    segmentId: segment.id,
    before: transcript.segments[index].text,
    after: segment.text,
    reason: "user-confirmed",
    confirmedAt: now(),
  }]);
  const confirmedAt = now();
  const resolvedUnresolved = unresolved.filter((item) => confirmed.has(item.segmentId)).map((item) => ({
    ...item,
    confirmedText: updatedSegments.find((segment) => segment.id === item.segmentId)?.text || "",
    resolution: (updatedSegments.find((segment) => segment.id === item.segmentId)?.text || "") === item.primaryText ? "kept-primary"
      : (updatedSegments.find((segment) => segment.id === item.segmentId)?.text || "") === item.secondaryText ? "used-whisper"
        : "user-corrected",
    confirmedAt,
  }));
  return {
    transcript: { ...transcript, text: updatedSegments.map((segment) => segment.text).join(""), segments: updatedSegments },
    proofreading: {
      ...proofreading,
      status: "confirmed",
      unresolved: [],
      resolvedUnresolved: [...(proofreading.resolvedUnresolved || []), ...resolvedUnresolved],
      confirmedUnresolvedSegmentIds: [...confirmed],
      manuallyReviewedSegmentIds: proofreading.status === "manual_review_required" ? [...confirmed] : [...(proofreading.manuallyReviewedSegmentIds || [])],
      manualCorrections: [...(proofreading.manualCorrections || []), ...manualCorrections],
      confirmedAt,
      previewStale: true,
    },
    srt: transcriptToSrt({ segments: updatedSegments }),
  };
}
