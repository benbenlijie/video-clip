import { assertAssetsLicensed, assertMultiAssetReady } from "./multi-asset.mjs";

export const TIMELINE_V2 = "timeline.v2";
const ALLOWED_TRACKS = new Set(["video-main", "video-overlay"]);
const LAYOUT_TYPES = new Set(["full", "punch_in", "split", "broll_cover", "unknown"]);
const PROFILE_SPECS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export function createOutputProfiles(brief = {}) {
  const aspectRatio = brief.aspectRatio || "both";
  const ids = aspectRatio === "both" ? ["landscape", "portrait"] : [aspectRatio];
  if (ids.some((id) => !PROFILE_SPECS[id])) throw new Error("输出画幅无效");
  return ids.map((id) => ({ id, ...PROFILE_SPECS[id], fps: 30, codec: "h264", audioCodec: "aac" }));
}

function safeAsset(asset) {
  return {
    id: String(asset.id),
    filename: String(asset.filename || "asset.mp4").replaceAll("\\", "/").split("/").at(-1),
    durationMs: Math.round(Number(asset.durationMs) || 0),
    width: Math.round(Number(asset.width) || 0),
    height: Math.round(Number(asset.height) || 0),
    hasAudio: Boolean(asset.hasAudio),
    hasVideo: Boolean(asset.hasVideo),
    role: String(asset.role || "supporting"),
    label: String(asset.label || asset.filename || ""),
    licenseConfirmed: Boolean(asset.licenseConfirmed),
    sha256: asset.sha256 ? String(asset.sha256) : null,
    transcriptRef: `assets/${String(asset.id)}/transcript.json`,
    visualEvidence: asset.visualEvidence ? { filename: String(asset.visualEvidence.filename || "contact-sheet.jpg"), keyframeTimesMs: (asset.visualEvidence.keyframeTimesMs || []).map((time) => Math.max(0, Math.round(Number(time) || 0))), width: Math.max(1, Number(asset.visualEvidence.width) || 1), height: Math.max(1, Number(asset.visualEvidence.height) || 1) } : null,
  };
}

function normalizeClip(clip, index) {
  const sourceInMs = Number(clip.sourceInMs);
  const sourceOutMs = Number(clip.sourceOutMs);
  const timelineStartMs = Number(clip.timelineStartMs);
  const timelineEndMs = Number(clip.timelineEndMs);
  if (![sourceInMs, sourceOutMs, timelineStartMs, timelineEndMs].every(Number.isSafeInteger)) throw new Error(`时间轴区间无效: ${index + 1}`);
  if (sourceInMs < 0 || sourceOutMs <= sourceInMs) throw new Error(`源时间范围无效: ${index + 1}`);
  if (timelineStartMs < 0 || timelineEndMs <= timelineStartMs || timelineEndMs - timelineStartMs !== sourceOutMs - sourceInMs) throw new Error(`时间轴区间无效: ${index + 1}`);
  const track = String(clip.track || "video-main");
  if (!ALLOWED_TRACKS.has(track)) throw new Error(`不支持的时间轴轨道: ${track}`);
  const result = {
    id: String(clip.id || `clip-${index + 1}`),
    sourceAssetId: String(clip.sourceAssetId || ""),
    sourceInMs: Math.round(sourceInMs),
    sourceOutMs: Math.round(sourceOutMs),
    timelineStartMs: Math.round(timelineStartMs),
    timelineEndMs: Math.round(timelineEndMs),
    track,
    purpose: String(clip.purpose || "content").slice(0, 80),
    reason: String(clip.reason || "").slice(0, 500),
    ...(clip.audioPolicy ? { audioPolicy: String(clip.audioPolicy) } : {}),
  };
  if (clip.shotRole != null) {
    if (!LAYOUT_TYPES.has(String(clip.shotRole))) throw new Error(`镜头角色无效: ${result.id}`);
    result.shotRole = String(clip.shotRole);
  }
  if (clip.layout != null) {
    if (typeof clip.layout !== "object" || Array.isArray(clip.layout) || !LAYOUT_TYPES.has(String(clip.layout.type))) throw new Error(`布局类型无效: ${result.id}`);
    result.layout = { type: String(clip.layout.type), params: clip.layout.params ? { ...clip.layout.params } : {} };
  }
  return result;
}

export function validateTimelineV2(timeline, project) {
  if (!timeline || timeline.contract !== TIMELINE_V2) throw new Error("需要 timeline.v2 契约");
  if (timeline.project?.id !== String(project.id)) throw new Error("时间轴项目 ID 不匹配");
  if (timeline.project?.stylePackId != null && !/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(timeline.project.stylePackId))) throw new Error("时间轴 stylePackId 无效");
  if (timeline.project?.styleVersion != null && (!Number.isInteger(Number(timeline.project.styleVersion)) || Number(timeline.project.styleVersion) < 1)) throw new Error("时间轴 styleVersion 无效");
  if (timeline.project?.styleParameters != null && (typeof timeline.project.styleParameters !== "object" || Array.isArray(timeline.project.styleParameters))) throw new Error("时间轴 styleParameters 无效");
  const assets = assertMultiAssetReady(project);
  const assetById = new Map(assets.map((asset) => [String(asset.id), asset]));
  const clips = (timeline.clips || []).map(normalizeClip);
  if (!clips.length) throw new Error("时间轴至少需要一个主视频片段");
  for (const clip of clips) {
    const asset = assetById.get(clip.sourceAssetId);
    if (!asset) throw new Error(`时间轴素材引用不存在: ${clip.sourceAssetId}`);
    if (clip.sourceOutMs > Number(asset.durationMs || 0)) throw new Error(`源时间范围超出素材时长: ${clip.id}`);
  }
  const main = clips.filter((clip) => clip.track === "video-main").sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  if (main.length < 2) throw new Error("多素材主时间轴至少需要引用 2 个素材片段");
  if (main[0].timelineStartMs !== 0) throw new Error("主时间轴不能有空洞");
  for (let index = 1; index < main.length; index += 1) {
    if (main[index].timelineStartMs !== main[index - 1].timelineEndMs) throw new Error("主时间轴不能有空洞或重叠");
  }
  const overlays = clips.filter((clip) => clip.track === "video-overlay");
  for (const overlay of overlays) {
    if (!main.some((clip) => overlay.timelineStartMs >= clip.timelineStartMs && overlay.timelineEndMs <= clip.timelineEndMs)) throw new Error(`覆盖轨片段必须落在主画面片段内: ${overlay.id}`);
  }
  const profiles = Array.isArray(timeline.profiles) ? timeline.profiles : [];
  if (!profiles.length || profiles.some((profile) => {
    const expected = PROFILE_SPECS[profile.id];
    return !expected || profile.width !== expected.width || profile.height !== expected.height || profile.fps !== 30 || profile.codec !== "h264" || profile.audioCodec !== "aac";
  })) throw new Error("输出规格无效");
  if (profiles.length > 2 || new Set(profiles.map((item) => item.id)).size !== profiles.length) throw new Error("输出规格重复或过多");
  assertAssetsLicensed(project);
  const totalDurationMs = main.at(-1).timelineEndMs;
  if (timeline.durationMs !== totalDurationMs) throw new Error("时间轴总时长与主轨不一致");
  return { ...timeline, assets: timeline.assets.map((asset) => ({ ...asset })), profiles: profiles.map((profile) => ({ ...profile })), clips };
}

export function toTimelineV2(project) {
  if (project?.workflowMode !== "multi-asset-v1") throw new Error("只有多素材项目可以生成 timeline.v2");
  const assets = assertMultiAssetReady(project);
  const clips = (project.multiAssetPlan?.clips || []).map(normalizeClip);
  const main = clips.filter((clip) => clip.track === "video-main").sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const durationMs = main.at(-1)?.timelineEndMs || 0;
  const timeline = {
    contract: TIMELINE_V2,
    project: {
      id: String(project.id),
      workflowMode: project.workflowMode,
      goal: String(project.goal || ""),
      style: String(project.style || ""),
      version: Math.max(1, Number(project.multiAssetPlan?.version) || 1),
      ...(project.multiAssetPlan?.stylePackId ? { stylePackId: String(project.multiAssetPlan.stylePackId) } : {}),
      ...(project.multiAssetPlan?.styleVersion ? { styleVersion: Number(project.multiAssetPlan.styleVersion) } : {}),
      ...(project.multiAssetPlan?.styleParameters ? { styleParameters: { ...project.multiAssetPlan.styleParameters } } : {}),
    },
    brief: { ...project.brief },
    assets: assets.map(safeAsset),
    audio: {
      sourcePolicy: "retain-source-audio-or-silence",
      music: project.music?.path ? { filename: String(project.music.filename || "music"), licenseConfirmed: Boolean(project.music.licenseConfirmed), sha256: project.music.sha256 || null } : null,
    },
    profiles: createOutputProfiles(project.brief),
    durationMs,
    clips,
    overlays: Array.isArray(project.multiAssetPlan?.overlays) ? project.multiAssetPlan.overlays.map((event) => ({ ...event })) : [],
    summary: String(project.multiAssetPlan?.summary || ""),
    warnings: Array.isArray(project.multiAssetPlan?.warnings) ? project.multiAssetPlan.warnings.map((item) => ({ ...item })) : [],
  };
  return validateTimelineV2(timeline, project);
}
