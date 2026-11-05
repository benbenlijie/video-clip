import { createHash } from "node:crypto";
import { assertMultiAssetReady } from "./multi-asset.mjs";
import { buildAssetInventory } from "./multi-asset-analysis.mjs";
import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";

function extractJson(value) {
  const fenced = String(value || "").match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || String(value || "").slice(String(value || "").indexOf("{"), String(value || "").lastIndexOf("}") + 1);
  if (!source || !source.includes("{")) throw new Error("Claude 未返回可解析的剪辑方案 JSON");
  try { return JSON.parse(source); } catch { throw new Error("Claude 返回的剪辑方案 JSON 无法解析"); }
}

function normalizeClip(clip, index, assetsById) {
  const id = String(clip.id || `clip-${index + 1}`);
  const sourceAssetId = String(clip.sourceAssetId || "");
  const asset = assetsById.get(sourceAssetId);
  if (!asset) throw new Error(`剪辑方案素材引用不存在: ${sourceAssetId}`);
  const sourceInMs = Number(clip.sourceInMs);
  const sourceOutMs = Number(clip.sourceOutMs);
  const timelineStartMs = Number(clip.timelineStartMs);
  const timelineEndMs = Number(clip.timelineEndMs);
  if (![sourceInMs, sourceOutMs, timelineStartMs, timelineEndMs].every(Number.isSafeInteger) || sourceInMs < 0 || sourceOutMs <= sourceInMs || sourceOutMs > Number(asset.durationMs || 0)) throw new Error(`剪辑方案源时间范围超出素材: ${id}`);
  if (timelineStartMs < 0 || timelineEndMs <= timelineStartMs || timelineEndMs - timelineStartMs !== sourceOutMs - sourceInMs) throw new Error(`剪辑方案时间轴区间无效: ${id}`);
  const track = String(clip.track || "video-main");
  if (!["video-main", "video-overlay"].includes(track)) throw new Error(`首版不支持此剪辑轨道: ${track}`);
  return {
    id,
    sourceAssetId,
    sourceInMs: Math.round(sourceInMs),
    sourceOutMs: Math.round(sourceOutMs),
    timelineStartMs: Math.round(timelineStartMs),
    timelineEndMs: Math.round(timelineEndMs),
    track,
    purpose: String(clip.purpose || "content").slice(0, 80),
    reason: String(clip.reason || "").slice(0, 500),
  };
}

function inputFingerprint(project) {
  const snapshot = {
    brief: project.brief,
    assets: (project.assets || []).map((asset) => ({
      id: asset.id,
      sha256: asset.sha256 || null,
      role: asset.role,
      label: asset.label,
      licenseConfirmed: asset.licenseConfirmed === true,
      durationMs: Number(asset.durationMs || 0),
      width: Number(asset.width || 0),
      height: Number(asset.height || 0),
      hasAudio: asset.hasAudio === true,
      transcript: asset.transcript || null,
      keyframeTimesMs: asset.visualEvidence?.keyframeTimesMs || [],
    })),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function assertPlanInputsCurrent(plan, project) {
  if (!Number.isInteger(Number(plan?.inputRevision))
    || Number(plan.inputRevision) !== Number(project.multiAssetInputRevision || 0)
    || plan.inputFingerprint !== inputFingerprint(project)) {
    throw Object.assign(new Error("素材或方案已变化，历史剪辑方案不能直接恢复或确认；请重新生成方案"), { statusCode: 409 });
  }
}

export function validateMultiAssetPlan(rawPlan, project) {
  if (project?.workflowMode !== "multi-asset-v1") throw new Error("只有多素材项目可以生成多素材方案");
  const assets = assertMultiAssetReady(project);
  const assetsById = new Map(assets.map((asset) => [String(asset.id), asset]));
  const clips = (rawPlan?.clips || []).map((clip, index) => normalizeClip(clip, index, assetsById));
  const main = clips.filter((clip) => clip.track === "video-main").sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  if (main.length < 2 || new Set(main.map((clip) => clip.sourceAssetId)).size < 2) throw new Error("多素材方案主时间轴必须至少使用两个不同视频素材");
  if (main[0].timelineStartMs !== 0) throw new Error("方案主时间轴不能有空洞");
  for (let index = 1; index < main.length; index += 1) {
    if (main[index].timelineStartMs !== main[index - 1].timelineEndMs) throw new Error("方案主时间轴不能有空洞或重叠");
  }
  for (const clip of clips.filter((item) => item.track === "video-overlay")) {
    if (!main.some((item) => clip.timelineStartMs >= item.timelineStartMs && clip.timelineEndMs <= item.timelineEndMs)) throw new Error(`B-roll 覆盖片段必须落在主画面片段内: ${clip.id}`);
  }
  const durationMs = main.at(-1).timelineEndMs;
  const target = Number(project.brief?.targetDurationMs || 0);
  const durationDeltaRatio = target ? Math.abs(durationMs - target) / target : 0;
  const warnings = target && durationDeltaRatio > 0.1 ? [{ code: "duration-target-exceeded", targetDurationMs: target, plannedDurationMs: durationMs, deltaRatio: durationDeltaRatio }] : [];
  const latestVersion = Math.max(0, Number(project.multiAssetPlan?.version) || 0, ...(project.multiAssetPlanHistory || []).map((item) => Number(item.version) || 0));
  return {
    version: latestVersion + 1,
    summary: String(rawPlan.summary || "").trim().slice(0, 2000),
    storyBeats: Array.isArray(rawPlan.storyBeats) ? rawPlan.storyBeats.slice(0, 20).map((beat) => ({ title: String(beat.title || "").slice(0, 120), purpose: String(beat.purpose || "").slice(0, 300) })) : [],
    clips,
    overlays: [],
    durationMs,
    durationDeltaRatio,
    warnings,
    inputRevision: Number(project.multiAssetInputRevision || 0),
    inputFingerprint: inputFingerprint(project),
    confirmed: false,
    generatedAt: new Date().toISOString(),
  };
}

export function confirmMultiAssetPlan(project, { version } = {}) {
  const plan = project?.multiAssetPlan;
  if (!plan || !Number.isInteger(Number(version)) || Number(version) !== Number(plan.version)) throw Object.assign(new Error("剪辑方案版本已过期，请重新加载当前方案"), { statusCode: 409 });
  assertPlanInputsCurrent(plan, project);
  return { ...project, multiAssetPlan: { ...plan, confirmed: true, confirmedAt: new Date().toISOString() }, multiAssetPreview: null, status: "plan_confirmed", error: null };
}

export function restoreMultiAssetPlan(project, { version } = {}) {
  const history = project?.multiAssetPlanHistory || [];
  const plan = history.find((item) => Number(item.version) === Number(version));
  if (!plan) throw Object.assign(new Error("找不到该历史方案版本"), { statusCode: 404 });
  assertPlanInputsCurrent(plan, project);
  const nextHistory = history.filter((item) => Number(item.version) !== Number(version));
  if (project.multiAssetPlan && Number(project.multiAssetPlan.version) !== Number(version)) nextHistory.push(project.multiAssetPlan);
  return { ...project, multiAssetPlan: { ...plan, confirmed: false, restoredAt: new Date().toISOString() }, multiAssetPlanHistory: nextHistory, multiAssetPreview: null, status: "plan_ready", qc: null, error: null };
}

export async function planMultiAssetWithClaude({ project, editRequest = "", fetchImpl = fetch } = {}) {
  if (!project || project.workflowMode !== "multi-asset-v1") throw new Error("只有多素材项目可以生成剪辑方案");
  if (!project.brief?.rawText) throw new Error("请先填写剪辑方案");
  const inventory = project.assetInventory || buildAssetInventory(project);
  const key = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY;
  if (!key) throw new Error("未配置 ANTHROPIC_API_KEY");
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const prompt = `你是视频剪辑导演。依据用户方案、逐素材转录和真实画面关键帧，生成一条有逻辑的多素材视频时间轴。只返回严格 JSON，不要 Markdown。不要编造转录、产品事实或不存在的画面。用户提供的 contact sheet 按从左到右对应所列的 source 时间点；必须结合画面和台词判断哪些片段值得使用。\n用户方案：${JSON.stringify(project.brief)}\n额外修改要求：${String(editRequest || "无").slice(0, 2000)}\n${project.multiAssetPlan ? `上一版方案：${JSON.stringify(project.multiAssetPlan)}` : ""}\n素材清单（只能引用这些 asset id，时间单位毫秒）：${JSON.stringify(inventory.assets.map((asset) => ({ id: asset.id, filename: asset.filename, label: asset.label, role: asset.role, durationMs: asset.durationMs, width: asset.width, height: asset.height, visualEvidence: asset.visualEvidence, transcript: asset.transcript })))}\n目标时长${project.brief.targetDurationMs ? `约 ${project.brief.targetDurationMs}ms，是软目标，优先贴近；偏差较大时仍如实规划` : "由内容决定"}。主轨必须连续无空洞、无重叠，至少使用两个不同素材；每个片段 sourceOutMs-sourceInMs 必须等于 timelineEndMs-timelineStartMs。首版只支持硬切，不输出复杂转场。可选 B-roll 只能作为 video-overlay 轨并完全落在某个主片段区间内。输出：{"summary":string,"storyBeats":[{"title":string,"purpose":string}],"clips":[{"id":string,"sourceAssetId":string,"sourceInMs":number,"sourceOutMs":number,"timelineStartMs":number,"timelineEndMs":number,"track":"video-main"|"video-overlay","purpose":string,"reason":string}]}`;
  const content = [{ type: "text", text: prompt }];
  for (const asset of project.assets) {
    const evidence = asset.visualEvidence;
    if (!evidence?.path || !Array.isArray(evidence.keyframeTimesMs)) throw new Error(`素材缺少真实画面关键帧：${asset.label || asset.filename}`);
    const imagePath = resolve(evidence.path);
    const assetRoot = resolve(project.dir, "assets", asset.id);
    if (imagePath !== assetRoot && !imagePath.startsWith(`${assetRoot}${sep}`)) throw new Error("素材画面证据路径无效");
    const bytes = await fs.readFile(imagePath);
    content.push({ type: "text", text: `素材 ${asset.id} / ${asset.label || asset.filename} 的关键帧联系图；从左到右源时间点（毫秒）：${evidence.keyframeTimesMs.join(", ")}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: bytes.toString("base64") } });
  }
  const response = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 6000, system: "只输出严格合法 JSON。所有时间轴片段都必须有真实素材来源。", messages: [{ role: "user", content }] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Claude API ${response.status}: ${payload.error?.message || "请求失败"}`);
  const text = (payload.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return validateMultiAssetPlan(extractJson(text), project);
}
