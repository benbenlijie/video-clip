import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { downloadWxVideo, resolveWxVideo } from "./wx-video-tools.mjs";

// 只允许视频号分享链接和它自己的媒体域；解析器由 CLI 侧统一管理。
const SHARE_HOSTS = new Set(["weixin.qq.com", "channels.weixin.qq.com"]);
const MEDIA_HOSTS = new Set(["finder.video.qq.com", "wxapp.tc.qq.com"]);
const MAX_BYTES = Number(process.env.WX_VIDEO_INGEST_MAX_BYTES || 800 * 1024 * 1024);
export const REFERENCE_MAX_SECONDS = Number(process.env.WAYNE_REFERENCE_MAX_SECONDS || 180);
export const REFERENCE_MIN_SECONDS = 30;

function badRequest(message, statusCode = 400, code = "invalid-link") {
  return Object.assign(new Error(message), { statusCode, code });
}

export function extractWechatUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s"'<>，。；（）()]+/);
  return match ? match[0].replace(/[.,;，。；)）]+$/, "") : "";
}

/** 校验并归一化分享链接。不接受任意 URL，避免把门户当成通用取流代理。 */
export function assertWechatLink(input) {
  const raw = extractWechatUrl(input);
  if (!raw) throw badRequest("没有在输入里找到视频号链接");
  let parsed;
  try { parsed = new URL(raw); } catch { throw badRequest("链接格式不正确"); }
  if (parsed.protocol !== "https:") throw badRequest("只接受 https 链接");
  const host = parsed.hostname.toLowerCase();
  if (SHARE_HOSTS.has(host)) {
    if (host === "weixin.qq.com" && !/^\/sph\/[A-Za-z0-9_-]{4,64}$/.test(parsed.pathname)) throw badRequest("只支持 weixin.qq.com/sph/ 分享链接");
    if (host === "channels.weixin.qq.com" && !parsed.pathname.startsWith("/finder-preview/")) throw badRequest("只支持视频号分享页");
    return `https://${host}${parsed.pathname}${parsed.search}`;
  }
  if (MEDIA_HOSTS.has(host) || host.endsWith(".wxapp.tc.qq.com")) {
    if (!parsed.searchParams.get("encfilekey") && !parsed.searchParams.get("token")) throw badRequest("直链缺少签名参数");
    return raw;
  }
  throw badRequest("只支持视频号分享链接（weixin.qq.com/sph/…）");
}


function runFfmpeg(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`参考片段裁剪失败：${stderr.slice(-300)}`))));
  });
}

/**
 * 风格分析只接受 30–180 秒。链接导入的长视频按需截取一段，并把裁剪信息带给调用方，
 * 不让"视频太长"变成一条无法执行的报错。
 */
export async function trimReferenceClip({ filePath, durationSeconds, startSeconds = 0 }) {
  const duration = Number(durationSeconds || 0);
  if (!duration || duration <= REFERENCE_MAX_SECONDS) return null;
  const start = Math.max(0, Math.min(Number(startSeconds) || 0, duration - REFERENCE_MAX_SECONDS));
  const target = `${filePath}.trim.mp4`;
  await runFfmpeg(["-ss", String(start), "-i", filePath, "-t", String(REFERENCE_MAX_SECONDS), "-c", "copy", "-movflags", "+faststart", target]);
  await fs.rename(target, filePath);
  return {
    originalDurationMs: Math.round(duration * 1000),
    analysisDurationMs: Math.round(REFERENCE_MAX_SECONDS * 1000),
    startMs: Math.round(start * 1000),
  };
}


/** 把链接直接下载到指定目录（项目 input.mp4 与暂存 source.mp4 共用）。 */
export async function downloadWechatVideo({ link, outDir, name = "source" }) {
  const url = assertWechatLink(link);
  const result = await downloadWxVideo({ link: url, outDir, name });
  if (Number(result.bytes) > MAX_BYTES) {
    throw badRequest(`视频超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限`, 413, "source-too-large");
  }
  return { ...result, sourceLink: url };
}

export function wechatSourcesRoot(storageRoot) {
  return join(resolve(storageRoot), "wechat-sources");
}

export function safeSourceDir(storageRoot, id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) throw badRequest("视频源不存在", 404, "source-not-found");
  const base = wechatSourcesRoot(storageRoot);
  const target = resolve(base, id);
  if (!target.startsWith(`${base}${sep}`)) throw badRequest("视频源不存在", 404, "source-not-found");
  return target;
}

function publicSource(record) {
  const { dir: _dir, path: _path, ...rest } = record;
  return rest;
}

/** 只解析元数据，不落盘。用于在 UI 里先展示标题/作者再决定是否下载。 */
export async function resolveWechatLink(link) {
  const url = assertWechatLink(link);
  const meta = await resolveWxVideo(url);
  return {
    ok: true,
    link: url,
    kind: meta.kind,
    title: meta.title || null,
    author: meta.author || null,
    publishedAt: meta.publishedAt || null,
    videoId: meta.videoId || null,
    coverUrl: meta.coverUrl || null,
    stats: meta.stats || null,
    resolver: meta.resolver || null,
  };
}

// 解析器和 CDN 都怕并发；一次只跑一个下载任务。
let ingestQueue = Promise.resolve();

export function ingestWechatSource({ link, storageRoot, mode = "single-video-v1" }) {
  const run = ingestQueue.then(() => runIngest({ link, storageRoot, mode }));
  ingestQueue = run.catch(() => undefined);
  return run;
}

async function runIngest({ link, storageRoot, mode }) {
  if (!["single-video-v1", "multi-asset-v1"].includes(mode)) throw badRequest("视频用途无效");
  const id = randomUUID();
  const dir = safeSourceDir(storageRoot, id);
  await fs.mkdir(dir, { recursive: true });
  try {
    const result = await downloadWechatVideo({ link, outDir: dir, name: "source" });
    const record = {
      id,
      dir,
      path: result.path,
      filename: "source.mp4",
      mode,
      bytes: result.bytes,
      sha256: result.sha256,
      durationSeconds: result.durationSeconds,
      width: result.width,
      height: result.height,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      verified: result.verified === true,
      title: result.title || null,
      author: result.author || null,
      publishedAt: result.publishedAt || null,
      coverUrl: result.coverUrl || null,
      sourceLink: result.sourceLink,
      resolver: result.resolver || null,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(join(dir, "source.json"), JSON.stringify(record, null, 2));
    return publicSource(record);
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (error.message && /解析|下载|直链|解析器/.test(error.message) && !error.statusCode) {
      error.statusCode = 502;
      error.code = error.code || "wechat-ingest-failed";
    }
    throw error;
  }
}

export async function readWechatSource(storageRoot, id) {
  const dir = safeSourceDir(storageRoot, id);
  try {
    const record = JSON.parse(await fs.readFile(join(dir, "source.json"), "utf8"));
    const path = join(dir, record.filename || "source.mp4");
    await fs.access(path);
    return { ...record, dir, path };
  } catch (error) {
    if (error.code === "ENOENT") throw badRequest("视频源不存在或已过期", 404, "source-not-found");
    throw error;
  }
}

export async function deleteWechatSource(storageRoot, id) {
  const dir = safeSourceDir(storageRoot, id);
  await fs.rm(dir, { recursive: true, force: true });
}

/** 清理超过 maxAgeHours 的暂存视频；服务启动时调用一次即可。 */
export async function pruneWechatSources(storageRoot, maxAgeHours = 48) {
  const base = wechatSourcesRoot(storageRoot);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    try {
      const info = await fs.stat(join(dir, "source.json"));
      if (info.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch { /* 不完整的目录留给下一次启动清理 */ }
  }
  return removed;
}
