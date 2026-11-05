import { join } from "node:path";
import { recoverInterruptedMultiAssetProject } from "./multi-asset-recovery.mjs";

export const WORKFLOW_MODES = new Set(["single-video-v1", "multi-asset-v1"]);
export const ASSET_ROLES = new Set(["main", "supporting", "broll", "voiceover"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
export const MAX_ASSETS = 20;
export const MAX_ASSET_BYTES = 500 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 5 * 1024 * 1024 * 1024;

function text(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function boundedText(value, name, maxLength) {
  const result = text(value);
  if (result.length > maxLength) throw new Error(`${name}不能超过 ${maxLength} 个字符`);
  return result;
}

function stringList(value, name, maxItems = 20, maxLength = 200) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name}必须是数组`);
  if (value.length > maxItems) throw new Error(`${name}不能超过 ${maxItems} 项`);
  return value.map((item) => boundedText(item, name, maxLength)).filter(Boolean);
}

export function normalizeWorkflowMode(value) {
  const mode = value == null || value === "" ? "single-video-v1" : String(value);
  if (!WORKFLOW_MODES.has(mode)) throw new Error(`不支持的 workflowMode: ${mode}`);
  return mode;
}

export function normalizeBrief(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("剪辑方案格式无效");
  const rawText = boundedText(input.rawText, "方案", 12000);
  if (!rawText) throw new Error("方案不能为空");
  const targetDurationMs = input.targetDurationMs == null || input.targetDurationMs === "" ? null : Number(input.targetDurationMs);
  if (targetDurationMs != null && (!Number.isFinite(targetDurationMs) || targetDurationMs < 1000 || targetDurationMs > 60 * 60 * 1000)) throw new Error("目标时长必须在 1 秒到 60 分钟之间");
  const aspectRatio = input.aspectRatio == null || input.aspectRatio === "" ? "both" : String(input.aspectRatio);
  if (!["both", "landscape", "portrait"].includes(aspectRatio)) throw new Error("输出画幅必须是 both、landscape 或 portrait");
  return {
    rawText,
    audience: boundedText(input.audience, "受众", 200),
    platform: boundedText(input.platform, "平台", 80),
    targetDurationMs: targetDurationMs == null ? null : Math.round(targetDurationMs),
    aspectRatio,
    mustUse: stringList(input.mustUse, "必须出现内容"),
    mustAvoid: stringList(input.mustAvoid, "必须避免内容"),
  };
}

function extensionOf(filename) {
  const name = text(filename).replaceAll("\\", "/").split("/").at(-1) || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function validateAssetUpload({ filename, byteLength, currentAssetCount = 0, currentTotalBytes = 0 } = {}) {
  const extension = extensionOf(filename);
  if (!VIDEO_EXTENSIONS.has(extension)) throw new Error("多素材入口只支持视频文件：MP4、MOV、M4V 或 WebM");
  const bytes = Number(byteLength);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("素材大小无效");
  if (bytes > MAX_ASSET_BYTES) throw new Error("单个视频素材不能超过 500MB");
  if (!Number.isInteger(Number(currentAssetCount)) || Number(currentAssetCount) < 0 || Number(currentAssetCount) >= MAX_ASSETS) throw new Error("一个项目最多上传 20 个视频素材");
  if (!Number.isSafeInteger(Number(currentTotalBytes)) || Number(currentTotalBytes) < 0 || Number(currentTotalBytes) + bytes > MAX_PROJECT_BYTES) throw new Error("一个项目的视频素材总大小不能超过 5GB");
  return { extension, bytes };
}

function normalizeRole(role) {
  const value = role == null || role === "" ? "supporting" : String(role);
  if (!ASSET_ROLES.has(value)) throw new Error(`不支持的素材角色: ${value}`);
  return value;
}

export function createAssetRecord({ id, filename, path, bytes, metadata = {}, role, label = "", licenseConfirmed = false } = {}) {
  const assetId = text(id);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(assetId)) throw new Error("素材 ID 无效");
  const name = text(filename).replaceAll("\\", "/").split("/").at(-1) || "asset.mp4";
  const durationMs = Math.round(Number(metadata.durationMs || 0));
  const width = Math.round(Number(metadata.width || 0));
  const height = Math.round(Number(metadata.height || 0));
  if (!metadata.hasVideo || durationMs <= 0 || width <= 0 || height <= 0) throw new Error("素材必须包含有效视频画面");
  const size = Number(bytes);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("素材大小无效");
  return {
    id: assetId,
    filename: name,
    path: String(path || ""),
    bytes: size,
    durationMs,
    width,
    height,
    hasVideo: true,
    hasAudio: Boolean(metadata.hasAudio),
    role: normalizeRole(role),
    label: boundedText(label, "素材名称", 120) || name,
    licenseConfirmed: licenseConfirmed === true,
    status: "ready",
    analysisStatus: "ready",
    uploadedAt: new Date().toISOString(),
  };
}

export function assetDir(project, assetId) {
  if (!project?.dir) throw new Error("项目目录不存在");
  const value = String(assetId || "");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("素材 ID 无效");
  return join(project.dir, "assets", value);
}

export function assertMultiAssetReady(project = {}) {
  if (project.workflowMode && normalizeWorkflowMode(project.workflowMode) !== "multi-asset-v1") throw new Error("当前项目不是多素材项目");
  const assets = Array.isArray(project.assets) ? project.assets : [];
  if (assets.length < 2) throw new Error("多素材项目至少需要2个视频素材");
  const failed = assets.filter((asset) => asset.status === "failed" || asset.analysisStatus === "failed");
  if (failed.length) throw new Error(`有 ${failed.length} 个素材分析失败，请先重试失败素材`);
  const pending = assets.filter((asset) => !["ready", "complete"].includes(asset.status) || !["ready", "complete"].includes(asset.analysisStatus));
  if (pending.length) throw new Error(`还有 ${pending.length} 个素材未完成分析，请等待或重试`);
  return assets;
}

export function assertAssetsLicensed(project = {}) {
  const assets = project.assets || [];
  const unlicensed = assets.filter((asset) => asset.licenseConfirmed !== true);
  if (unlicensed.length) throw new Error(`有 ${unlicensed.length} 个素材尚未确认使用许可，不能导出`);
  return true;
}

export { recoverInterruptedMultiAssetProject };
