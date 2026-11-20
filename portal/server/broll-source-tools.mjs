import { promises as fs, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { panDownload } from "./baidu-pan-tools.mjs";
import { workspacePath } from "./workspace-path.mjs";
import { searchBrollSources } from "./broll-sources.mjs";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOADS = 6;
const MAX_CANDIDATES = 500;
const HOSTS = {
  mixkit: new Set(["assets.mixkit.co"]),
  coverr: new Set(["cdn.coverr.co"]),
  ysjf: new Set(["public.ysjf.com"]),
};

function assertInside(root, target) {
  const value = resolve(target);
  if (value !== root && !value.startsWith(`${root}${sep}`)) throw new Error("路径必须留在工作区内");
  return value;
}

function validateRemoteUrl(provider, value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !HOSTS[provider]?.has(url.hostname)) throw new Error(`${provider} 素材地址不是受允许的官方 CDN`);
  return url;
}

async function fetchBytes(url, { fetchImpl = fetch, maxBytes, provider }) {
  const request = async (target) => {
    const checked = validateRemoteUrl(provider, target.toString());
    return fetchImpl(checked, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WayneBrollSources/1.0)", Accept: "*/*" },
      signal: AbortSignal.timeout(20000),
    });
  };
  const first = await request(url);
  let response = first;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`${provider} 下载重定向缺少目标`);
    response = await request(new URL(location, url));
  }
  if (!response.ok) throw new Error(`${provider} 媒体返回 HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`${provider} 文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error(`${provider} 文件大小无效或超过限制`);
  return { bytes, contentType: response.headers.get("content-type")?.split(";", 1)[0] || "" };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function probeVideo(path) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 失败：${stderr.slice(-400)}`));
      try {
        const payload = JSON.parse(stdout);
        const video = payload.streams?.find((stream) => stream.codec_type === "video");
        if (!video || Number(payload.format?.duration || 0) <= 0) throw new Error("没有有效视频流或时长");
        resolveProbe({
          durationMs: Math.round(Number(payload.format.duration) * 1000),
          width: Number(video.width || 0),
          height: Number(video.height || 0),
        });
      } catch (error) {
        reject(new Error(`视频探测失败：${error.message}`));
      }
    });
  });
}

function safeName(value) {
  return String(value || "broll").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "broll";
}

async function writeDownload(dir, name, bytes) {
  let target = join(dir, name);
  try {
    await fs.access(target);
    target = join(dir, `${name.replace(/\.[^.]+$/, "")}-${randomUUID().slice(0, 8)}.mp4`);
  } catch { /* new file */ }
  await fs.writeFile(target, bytes, { flag: "wx" });
  return target;
}

export function registerBrollSourceTools(server, {
  workspaceDir,
  auditPath,
  fetchImpl = fetch,
  panDownloadImpl = panDownload,
} = {}) {
  const root = resolve(workspaceDir);
  const candidates = new Map();
  let downloadCount = 0;
  const audit = async (entry) => {
    if (!auditPath) return;
    await fs.mkdir(dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
  const remember = (candidate) => {
    const candidateHandle = randomUUID();
    candidates.set(candidateHandle, { ...candidate, candidateHandle });
    while (candidates.size > MAX_CANDIDATES) candidates.delete(candidates.keys().next().value);
    return candidateHandle;
  };
  const getCandidate = (handle) => {
    const candidate = candidates.get(handle);
    if (!candidate) throw new Error("候选素材句柄无效或已过期");
    return candidate;
  };

  server.registerTool("search_broll_sources", {
    description: "Search Mixkit, Coverr and 影视飓风 for B-roll. Returns previewable candidates with explicit commercial-use flags and license links. 影视飓风 candidates require a user-completed 0-yuan license order and a Baidu Pan share link before download; this tool never logs in, submits orders, or bypasses identity verification.",
    inputSchema: {
      query: z.string().min(2).max(200).describe("具体画面搜索词；Mixkit/Coverr 使用英文效果最好"),
      providers: z.array(z.enum(["mixkit", "coverr", "ysjf"])).min(1).max(3).default(["mixkit", "coverr", "ysjf"]),
      orientation: z.enum(["landscape", "portrait", "square"]).default("landscape"),
      limit: z.number().int().min(1).max(12).default(6),
      commercialOnly: z.boolean().default(false).describe("只返回明确标记为可商用的候选"),
    },
  }, async (args) => {
    const result = await searchBrollSources({ ...args, fetchImpl });
    const output = {
      ...result,
      candidates: result.candidates.map((candidate) => ({
        candidateHandle: remember(candidate),
        provider: candidate.provider,
        providerId: candidate.providerId,
        title: candidate.title,
        tags: candidate.tags,
        previewUrl: candidate.previewUrl,
        sourceUrl: candidate.sourceUrl,
        width: candidate.width,
        height: candidate.height,
        durationSeconds: candidate.durationSeconds,
        licenseName: candidate.licenseName,
        licenseUrl: candidate.licenseUrl,
        licenseNote: candidate.licenseNote,
        commercialUse: candidate.commercialUse,
        requiresOrder: candidate.requiresOrder === true,
        downloadMode: candidate.downloadMode || "direct",
        specificationId: candidate.specificationId,
        format: candidate.format,
        size: candidate.size,
        logProfile: candidate.logProfile,
        score: candidate.score,
        match: candidate.match,
        note: candidate.note || candidate.licenseNote,
      })),
    };
    await audit({ tool: "search_broll_sources", query: result.query, providers: result.providerStatus, count: output.candidates.length });
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  });

  server.registerTool("inspect_broll_candidate", {
    description: "View the thumbnail of a searched candidate before downloading. The image is returned as MCP image content so the editor can inspect the real frame rather than trusting the title.",
    inputSchema: { candidateHandle: z.string().uuid() },
  }, async ({ candidateHandle }) => {
    const candidate = getCandidate(candidateHandle);
    const url = candidate.thumbnailUrl || candidate.previewUrl;
    if (!url) throw new Error("候选素材没有可查看的缩略图");
    const preview = await fetchBytes(url, { fetchImpl, maxBytes: MAX_PREVIEW_BYTES, provider: candidate.provider });
    const metadata = {
      candidateHandle,
      provider: candidate.provider,
      providerId: candidate.providerId,
      title: candidate.title,
      sourceUrl: candidate.sourceUrl,
      licenseName: candidate.licenseName,
      licenseUrl: candidate.licenseUrl,
      licenseNote: candidate.licenseNote,
      commercialUse: candidate.commercialUse,
      requiresOrder: candidate.requiresOrder === true,
    };
    if (!preview.contentType.startsWith("image/")) {
      return { content: [{ type: "text", text: JSON.stringify({ ...metadata, previewUrl: url, note: "该候选只有视频预览，请打开 sourceUrl 查看。" }) }] };
    }
    await audit({ tool: "inspect_broll_candidate", candidateHandle, provider: candidate.provider, providerId: candidate.providerId });
    return {
      content: [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "image", mimeType: preview.contentType, data: Buffer.from(preview.bytes).toString("base64") },
      ],
    };
  });

  server.registerTool("download_broll_candidate", {
    description: "Download one inspected candidate into the workspace downloads/ directory and probe it with ffprobe. Mixkit Restricted clips require allowRestricted=true and are personal-use only. 影视飓风 requires shareUrl from the user's own completed official order; the share URL is never written to the audit log.",
    inputSchema: {
      candidateHandle: z.string().uuid(),
      licenseAcknowledged: z.boolean().default(false),
      allowRestricted: z.boolean().default(false),
      shareUrl: z.string().min(2).optional().describe("影视飓风：用户完成官网 0 元订单后拿到的百度网盘分享链接（可含 pwd）"),
      match: z.string().max(120).default("").describe("影视飓风：只下载文件名包含该子串的视频"),
      index: z.string().max(80).default("").describe("影视飓风：按 1 起���的序号，如 1,3,5"),
    },
  }, async ({ candidateHandle, licenseAcknowledged, allowRestricted, shareUrl, match, index }) => {
    if (!licenseAcknowledged) throw new Error("请先确认该素材的使用许可；影视飓风还需完成官方 0 元订单");
    if (downloadCount >= MAX_DOWNLOADS) throw new Error(`本轮最多下载 ${MAX_DOWNLOADS} 个 B-roll 素材`);
    const candidate = getCandidate(candidateHandle);
    if (candidate.commercialUse === false && !allowRestricted) throw new Error(`${candidate.licenseName} 不是可商用许可；如仅个人使用，请显式设置 allowRestricted=true`);
    const dir = assertInside(root, await workspacePath(root, "downloads", { existing: false }));
    await fs.mkdir(dir, { recursive: true });
    let target;
    let downloadedName;
    if (candidate.provider === "ysjf") {
      if (!shareUrl) throw new Error("影视飓风下载需要 shareUrl：请先在官网登录、提交 0 元授权订单，再提供百度网盘分享链接");
      if (!match && !index) throw new Error("影视飓风下载必须用 match 或 index 选择单条视频，不能整包下载");
      const result = await panDownloadImpl({
        target: shareUrl,
        outDir: dir,
        videosOnly: true,
        pick: 1,
        match,
        index,
        jobs: 8,
      });
      const first = Array.isArray(result?.downloaded) ? result.downloaded.find((item) => item?.path) : null;
      if (!first) throw new Error("百度网盘没有匹配到可下载的视频文件");
      target = assertInside(root, isAbsolute(first.path) ? first.path : resolve(root, first.path));
      downloadedName = first.name || basename(target);
    } else {
      const { bytes } = await fetchBytes(candidate.downloadUrl, { fetchImpl, maxBytes: MAX_DOWNLOAD_BYTES, provider: candidate.provider });
      downloadedName = `${candidate.provider}-${safeName(candidate.providerId)}.mp4`;
      target = await writeDownload(dir, downloadedName, bytes);
    }
    let media;
    try { media = await probeVideo(target); }
    catch (error) { await fs.rm(target, { force: true }).catch(() => undefined); throw error; }
    const sha256 = await sha256File(target);
    const relativePath = relative(root, target);
    const output = {
      candidateHandle,
      provider: candidate.provider,
      providerId: candidate.providerId,
      title: candidate.title,
      filename: downloadedName,
      path: relativePath,
      bytes: (await fs.stat(target)).size,
      sha256,
      ...media,
      sourceUrl: candidate.sourceUrl,
      licenseName: candidate.licenseName,
      licenseUrl: candidate.licenseUrl,
      commercialUse: candidate.commercialUse,
      requiresOrder: candidate.requiresOrder === true,
      specificationId: candidate.specificationId,
      logProfile: candidate.logProfile,
      downloadedAt: new Date().toISOString(),
    };
    downloadCount += 1;
    candidates.delete(candidateHandle);
    await audit({
      tool: "download_broll_candidate",
      provider: candidate.provider,
      providerId: candidate.providerId,
      path: relativePath,
      sha256,
      licenseName: candidate.licenseName,
      commercialUse: candidate.commercialUse,
      requiresOrder: candidate.requiresOrder === true,
      shareUrlRedacted: candidate.provider === "ysjf" && Boolean(shareUrl),
    });
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  });

  return server;
}

export async function startBrollSourceTools(workDir, auditPath) {
  const root = await fs.realpath(workDir);
  await fs.mkdir(root, { recursive: true });
  const server = new McpServer({ name: "broll-sources", version: "1.0.0" });
  registerBrollSourceTools(server, { workspaceDir: root, auditPath });
  await server.connect(new StdioServerTransport());
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const workDir = process.argv[2] || process.cwd();
  const auditPath = process.argv[3] || join(workDir, ".audit", "broll-sources.jsonl");
  await startBrollSourceTools(workDir, auditPath);
}
