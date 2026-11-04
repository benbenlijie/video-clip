import { promises as fs } from "node:fs";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function mapEditedTimeToSource(timeMs, keep) {
  const target = Math.max(0, Number(timeMs) || 0);
  let cursor = 0;
  for (const interval of keep) {
    const length = Math.max(0, Number(interval.endMs) - Number(interval.startMs));
    if (target < cursor + length) return Math.round(Number(interval.startMs) + target - cursor);
    cursor += length;
  }
  const last = keep.at(-1);
  return last ? Math.round(Number(last.endMs)) : target;
}

/** Convert the pre-visual-editor plan format into the current executable contract. */
export function normalizeEditPlan(plan, durationMs) {
  if (!plan || Array.isArray(plan.segments) || !Array.isArray(plan.keep)) return plan;
  const keep = plan.keep
    .map((item) => ({ startMs: Number(item.startMs), endMs: Number(item.endMs) }))
    .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs);
  const segments = keep.map((item, index) => ({
    id: `segment-${index + 1}`,
    startMs: item.startMs,
    endMs: item.endMs,
    action: "keep",
    title: `保留片段 ${index + 1}`,
    note: "由旧版 keep 区间兼容转换",
  }));
  const visualEvents = [];
  if (plan.titleCard && Number.isFinite(Number(plan.titleCard.startMs)) && Number.isFinite(Number(plan.titleCard.endMs))) {
    visualEvents.push({
      id: "legacy-title-card",
      type: "title_card",
      startMs: mapEditedTimeToSource(plan.titleCard.startMs, keep),
      endMs: mapEditedTimeToSource(plan.titleCard.endMs, keep),
      text: String(plan.titleCard.text || "").trim() || "视频主题",
      subtext: "",
    });
  }
  if (!visualEvents.length) {
    for (const [index, caption] of (Array.isArray(plan.captions) ? plan.captions : []).slice(0, 3).entries()) {
      const text = String(caption.text || "").trim();
      const startMs = Number(caption.startMs);
      const endMs = Number(caption.endMs);
      if (text && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        visualEvents.push({ id: `legacy-emphasis-${index + 1}`, type: "emphasis", startMs, endMs, text, subtext: "" });
      }
    }
  }
  return {
    ...plan,
    summary: String(plan.summary || plan.brollReason || "旧版剪辑计划，已转换为可执行格式"),
    segments,
    shorts: Array.isArray(plan.shorts) ? plan.shorts : [],
    visualEvents,
    brollEvents: Array.isArray(plan.brollEvents) ? plan.brollEvents : [],
  };
}

export function normalizeCaptionStyle(style) {
  if (style != null && (typeof style !== "object" || Array.isArray(style))) throw new Error("字幕样式格式无效");
  const value = { fontSize: style?.fontSize ?? 20, marginV: style?.marginV ?? 24, outline: style?.outline ?? 1, color: style?.color ?? "#ffffff" };
  if (!Number.isFinite(value.fontSize) || value.fontSize < 8 || value.fontSize > 64 || !Number.isFinite(value.marginV) || value.marginV < 0 || value.marginV > 160 || !Number.isFinite(value.outline) || value.outline < 0 || value.outline > 5 || typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) throw new Error("字幕样式超出允许范围");
  return { ...value, color: value.color.toLowerCase() };
}

export function validateEditPlan(plan, durationMs, { requireVisualEvents = false, requireFiveShorts = true, allowCustomVisualEvents = false, brollAssets = [] } = {}) {
  plan = normalizeEditPlan(plan, durationMs);
  if (!plan || !Array.isArray(plan.segments) || (requireFiveShorts && !Array.isArray(plan.shorts))) throw new Error("剪辑计划格式无效");
  const duration = Math.max(1, Number(durationMs) || 0);
  const segments = plan.segments.map((segment, index) => {
    const startMs = clamp(segment.startMs, 0, duration);
    const endMs = clamp(segment.endMs, 0, duration);
    if (endMs <= startMs) throw new Error(`剪辑计划区间无效: ${index + 1}`);
    const action = ["keep", "tighten", "remove"].includes(segment.action) ? segment.action : "keep";
    return { id: segment.id || `segment-${index + 1}`, startMs, endMs, action, title: String(segment.title || "未命名片段"), note: String(segment.note || "") };
  });
  const shorts = (plan.shorts || []).slice(0, 5).map((short, index) => {
    const startMs = clamp(short.startMs, 0, duration);
    const endMs = clamp(short.endMs, 0, duration);
    if (endMs <= startMs) throw new Error(`Shorts 区间无效: ${index + 1}`);
    return { id: short.id || `short-${index + 1}`, startMs, endMs, title: String(short.title || `Short ${index + 1}`), note: String(short.note || "") };
  });
  if (requireFiveShorts && shorts.length !== 5) throw new Error("剪辑计划必须包含 5 条 Shorts");
  const rawVisualEvents = Array.isArray(plan.visualEvents) ? plan.visualEvents : [];
  const styledCaptions = plan.captionStyle == null ? {} : { captionStyle: normalizeCaptionStyle(plan.captionStyle) };
  const validateCaptionCoverage = (visualEvents) => {
    if (plan.captionCoverage == null) return [];
    if (!Array.isArray(plan.captionCoverage) || plan.captionCoverage.length > 100) throw new Error("字幕视觉覆盖清单无效");
    return plan.captionCoverage.map((item, index) => {
      const event = visualEvents.find((candidate) => String(candidate.id) === String(item.eventId));
      const startMs = Number(item.startMs);
      const endMs = Number(item.endMs);
      const text = String(item.text || "").trim();
      if (!event || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < Number(event.startMs) || endMs > Number(event.endMs) || endMs <= startMs || !text || text.length > 300) {
        throw new Error(`字幕视觉覆盖区间无效: ${index + 1}`);
      }
      return { eventId: String(item.eventId), startMs: Math.round(startMs), endMs: Math.round(endMs), text };
    });
  };
  if (allowCustomVisualEvents) {
    const visualEvents = rawVisualEvents.map((event, index) => {
      const startMs = event.startMs == null ? undefined : Number(event.startMs);
      const endMs = event.endMs == null ? undefined : Number(event.endMs);
      if (startMs !== undefined && (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > duration)) throw new Error(`剪辑计划视觉事件时间无效: ${index + 1}`);
      return { ...event, id: String(event.id || `visual-${index + 1}`), type: String(event.type || "visual"), ...(startMs === undefined ? {} : { startMs, endMs }) };
    });
    const rawBrollEvents = Array.isArray(plan.brollEvents) ? plan.brollEvents : [];
    const assetsById = new Map(brollAssets.map((asset) => [asset.id, asset]));
    const brollEvents = rawBrollEvents.map((event, index) => {
      const assetId = String(event.assetId || ""); const asset = assetsById.get(assetId);
      const startMs = Number(event.startMs); const endMs = Number(event.endMs); const sourceStartMs = Math.max(0, Number(event.sourceStartMs) || 0);
      if (!asset) throw new Error(`B-roll 素材不存在: ${index + 1}`);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > duration) throw new Error(`B-roll 时间超出素材范围: ${index + 1}`);
      if (sourceStartMs + endMs - startMs > Number(asset.durationMs || 0)) throw new Error(`B-roll 裁切超出素材时长: ${index + 1}`);
      if (!segments.some((segment) => segment.action !== "remove" && endMs > segment.startMs && startMs < segment.endMs)) throw new Error("B-roll 时间未落在保留片段");
      return { id: String(event.id || `broll-${index + 1}`), assetId, startMs: Math.round(startMs), endMs: Math.round(endMs), sourceStartMs: Math.round(sourceStartMs) };
    });
    return { version: 2, summary: String(plan.summary || ""), segments, shorts, visualEvents, brollEvents, ...styledCaptions, captionCoverage: validateCaptionCoverage(visualEvents) };
  }
  if (requireVisualEvents && rawVisualEvents.length < 3) throw new Error("剪辑计划必须包含可执行视觉事件");
  if (rawVisualEvents.length > 8) throw new Error("视觉事件不能超过 8 个");
  const visualEvents = rawVisualEvents.map((event, index) => {
    const startMs = Number(event.startMs);
    const endMs = Number(event.endMs);
    const type = String(event.type || "");
    const text = String(event.text || "").trim();
    const subtext = String(event.subtext || "").trim();
    if (!["title_card", "emphasis", "cta"].includes(type)) throw new Error(`视觉事件类型无效: ${index + 1}`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > duration) throw new Error(`视觉事件时间超出素材范围: ${index + 1}`);
    if (!text || text.length > 96 || subtext.length > 120) throw new Error(`视觉事件文案无效: ${index + 1}`);
    return { id: event.id || `visual-${index + 1}`, type, startMs: Math.round(startMs), endMs: Math.round(endMs), text, subtext };
  });
  if (requireVisualEvents && visualEvents.some((event) => !segments.some((segment) => segment.action !== "remove" && event.endMs > segment.startMs && event.startMs < segment.endMs))) {
    throw new Error("视觉事件时间未落在保留片段");
  }
  const rawBrollEvents = Array.isArray(plan.brollEvents) ? plan.brollEvents : [];
  if (rawBrollEvents.length > 16) throw new Error("B-roll 事件不能超过 16 个");
  const assetsById = new Map(brollAssets.map((asset) => [asset.id, asset]));
  const brollEvents = rawBrollEvents.map((event, index) => {
    const startMs = Number(event.startMs);
    const endMs = Number(event.endMs);
    const sourceStartMs = Math.max(0, Number(event.sourceStartMs) || 0);
    const asset = assetsById.get(String(event.assetId || ""));
    if (!asset) throw new Error(`B-roll 素材不存在: ${index + 1}`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > duration) throw new Error(`B-roll 时间超出素材范围: ${index + 1}`);
    if (sourceStartMs + endMs - startMs > Number(asset.durationMs || 0)) throw new Error(`B-roll 裁切超出素材时长: ${index + 1}`);
    if (!segments.some((segment) => segment.action !== "remove" && endMs > segment.startMs && startMs < segment.endMs)) throw new Error("B-roll 时间未落在保留片段");
    return { id: event.id || `broll-${index + 1}`, assetId: asset.id, startMs: Math.round(startMs), endMs: Math.round(endMs), sourceStartMs: Math.round(sourceStartMs) };
  });
  return { version: 2, summary: String(plan.summary || ""), segments, shorts, visualEvents, brollEvents, ...styledCaptions, captionCoverage: validateCaptionCoverage(visualEvents) };
}

export function buildFallbackPlan(transcript, media, goal = "") {
  const durationMs = Number(transcript?.durationMs || media?.durationMs || 12000);
  const duration = Math.max(1000, durationMs);
  const segmentSize = duration / 5;
  const segments = Array.from({ length: 5 }, (_, index) => ({
    id: `segment-${index + 1}`,
    startMs: Math.round(index * segmentSize),
    endMs: Math.round((index + 1) * segmentSize),
    action: index === 3 ? "tighten" : "keep",
    title: index === 0 ? "开场 Hook" : index === 4 ? "行动建议" : `内容段 ${index + 1}`,
    note: index === 3 ? "待审核：收紧重复表达" : "保留完整语义",
  }));
  const shorts = Array.from({ length: 5 }, (_, index) => ({
    id: `short-${index + 1}`,
    startMs: Math.round(index * duration / 5),
    endMs: Math.round(Math.min(duration, (index + 1) * duration / 5 + duration * 0.08)),
    title: `Short ${index + 1}`,
    note: goal || "从主片中抽取可发布片段",
  }));
  return validateEditPlan({ summary: "规则化草案，等待 Claude 或人工确认", segments, shorts, visualEvents: [] }, duration);
}

function formatSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function transcriptToSrt(transcript) {
  return (transcript?.segments || []).map((segment, index) => `${index + 1}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}\n${segment.text || ""}\n`).join("\n");
}

export async function writeTranscriptArtifacts(project, transcript) {
  await fs.writeFile(`${project.dir}/transcript.json`, JSON.stringify(transcript, null, 2));
  await fs.writeFile(`${project.dir}/transcript.srt`, transcriptToSrt(transcript));
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate || !candidate.includes("{")) throw new Error("Claude 未返回可解析的剪辑计划 JSON");
  try { return JSON.parse(candidate); } catch { throw new Error("Claude 返回的剪辑计划 JSON 无法解析"); }
}

export async function planWithClaude({ transcript, media, goal, style, comments = [], brollAssets = [] }) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY;
  if (!key) throw new Error("未配置 ANTHROPIC_API_KEY");
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const prompt = `你是 Wayne CASE 01 的剪辑导演。只返回 JSON，不要 Markdown。你必须同时决定剪辑时间线和画面上要执行的视觉设计；note 只是说明，只有 visualEvents 和 brollEvents 会被渲染器执行。\n媒体时长毫秒：${media.durationMs}\n目标：${goal}\n风格：${style}\n转录：${JSON.stringify(transcript)}\n批注：${JSON.stringify(comments)}\n可用 B-roll 素材（只可选择这些 id）：${JSON.stringify(brollAssets.map(({ id, filename, durationMs, width, height }) => ({ id, filename, durationMs, width, height })))}\n输出 schema：{"summary":string,"segments":[{"id":string,"startMs":number,"endMs":number,"action":"keep"|"tighten"|"remove","title":string,"note":string}],"shorts":[{"id":string,"startMs":number,"endMs":number,"title":string,"note":string}],"visualEvents":[{"id":string,"type":"title_card"|"emphasis"|"cta","startMs":number,"endMs":number,"text":string,"subtext":string}],"brollEvents":[{"id":string,"assetId":string,"startMs":number,"endMs":number,"sourceStartMs":number}]}。segments 应准确保留/收紧/删除停顿并覆盖内容。shorts 恰好 5 条，每条至少 1 秒。visualEvents 必须有 3 至 6 个：开头 20% 时间内放 Hook 标题卡，内容关键点至少两个强调条，结尾 20% 内放 CTA；时间必须落在被保留的片段中，文案必须来自转录或用户目标，不得杜撰事实，短句优先。每项 event 都要与相关话语同步。brollEvents 只能引用可用素材 id，时间落在保留片段中；每段至少 1 秒，且 sourceStartMs 加使用时长不能超过该素材时长。按内容相关性选用，最多 8 段；没有合适素材时返回空数组。`;
  const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 5000, system: "你输出严格合法 JSON。", messages: [{ role: "user", content: prompt }] }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Claude API ${response.status}: ${payload.error?.message || "请求失败"}`);
  const text = (payload.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return extractJson(text);
}
