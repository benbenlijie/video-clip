import { promises as fs } from "node:fs";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export function validateEditPlan(plan, durationMs, { requireVisualEvents = false } = {}) {
  if (!plan || !Array.isArray(plan.segments) || !Array.isArray(plan.shorts)) throw new Error("剪辑计划格式无效");
  const duration = Math.max(1, Number(durationMs) || 0);
  const segments = plan.segments.map((segment, index) => {
    const startMs = clamp(segment.startMs, 0, duration);
    const endMs = clamp(segment.endMs, 0, duration);
    if (endMs <= startMs) throw new Error(`剪辑计划区间无效: ${index + 1}`);
    const action = ["keep", "tighten", "remove"].includes(segment.action) ? segment.action : "keep";
    return { id: segment.id || `segment-${index + 1}`, startMs, endMs, action, title: String(segment.title || "未命名片段"), note: String(segment.note || "") };
  });
  const shorts = plan.shorts.slice(0, 5).map((short, index) => {
    const startMs = clamp(short.startMs, 0, duration);
    const endMs = clamp(short.endMs, 0, duration);
    if (endMs <= startMs) throw new Error(`Shorts 区间无效: ${index + 1}`);
    return { id: short.id || `short-${index + 1}`, startMs, endMs, title: String(short.title || `Short ${index + 1}`), note: String(short.note || "") };
  });
  if (shorts.length !== 5) throw new Error("剪辑计划必须包含 5 条 Shorts");
  const rawVisualEvents = Array.isArray(plan.visualEvents) ? plan.visualEvents : [];
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
  return { version: 2, summary: String(plan.summary || ""), segments, shorts, visualEvents };
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

export async function planWithClaude({ transcript, media, goal, style, comments = [] }) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY;
  if (!key) throw new Error("未配置 ANTHROPIC_API_KEY");
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const prompt = `你是 Wayne CASE 01 的剪辑导演。只返回 JSON，不要 Markdown。你必须同时决定剪辑时间线和画面上要执行的视觉设计；note 只是说明，只有 visualEvents 会被渲染器执行。\n媒体时长毫秒：${media.durationMs}\n目标：${goal}\n风格：${style}\n转录：${JSON.stringify(transcript)}\n批注：${JSON.stringify(comments)}\n输出 schema：{"summary":string,"segments":[{"id":string,"startMs":number,"endMs":number,"action":"keep"|"tighten"|"remove","title":string,"note":string}],"shorts":[{"id":string,"startMs":number,"endMs":number,"title":string,"note":string}],"visualEvents":[{"id":string,"type":"title_card"|"emphasis"|"cta","startMs":number,"endMs":number,"text":string,"subtext":string}]}。segments 应准确保留/收紧/删除停顿并覆盖内容。shorts 恰好 5 条，每条至少 1 秒。visualEvents 必须有 3 至 6 个：开头 20% 时间内放 Hook 标题卡，内容关键点至少两个强调条，结尾 20% 内放 CTA；时间必须落在被保留的片段中，文案必须来自转录或用户目标，不得杜撰事实，短句优先。每项 event 都要与相关话语同步；title_card 展示主题，emphasis 突出关键短句，cta 使用目标中明确的行动指引，目标没有具体指引时用简短互动问题。`;
  const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 5000, system: "你输出严格合法 JSON。", messages: [{ role: "user", content: prompt }] }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Claude API ${response.status}: ${payload.error?.message || "请求失败"}`);
  const text = (payload.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return extractJson(text);
}

