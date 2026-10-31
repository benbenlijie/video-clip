import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchBrollScenes } from "./broll-search.mjs";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOADS = 3;
const allowedHosts = new Set(["videos.pexels.com", "cdn.pixabay.com"]);
const previewHosts = new Set(["images.pexels.com", "cdn.pixabay.com"]);

function auditWriter(auditPath) {
  return async (entry) => {
    await fs.mkdir(dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
}

function validateAssetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("素材下载地址不是受允许的官方 CDN");
  return url;
}

function validatePreviewUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !previewHosts.has(url.hostname)) throw new Error("候选预览图不是受允许的官方图片 CDN");
  return url;
}

async function probeDownloaded(path) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`下载素材媒体校验失败：${stderr.slice(-500)}`));
      try {
        const payload = JSON.parse(stdout); const video = payload.streams?.find((stream) => stream.codec_type === "video");
        if (!video || Number(payload.format?.duration || 0) <= 0) throw new Error("没有有效视频流或时长");
        resolveProbe({ durationMs: Math.round(Number(payload.format.duration) * 1000), width: Number(video.width || 0), height: Number(video.height || 0) });
      } catch (error) { reject(new Error(`下载素材媒体校验失败：${error.message}`)); }
    });
  });
}

export function registerBrollTools(server, { workspaceDir, auditPath, cachePath, fetchImpl = fetch } = {}) {
  const candidates = new Map();
  const audit = auditWriter(auditPath);
  let downloadCount = 0;
  server.registerTool("search_broll", {
    description: "Search Pexels/Pixabay for concrete B-roll scenes. For portrait talking-head edits, evaluate B-roll by default and use it when it adds visual information; absence of product UI is not a reason to skip relevant generic footage. Return 1-3 scene intents with 1-2 concise English queries each. Results are visual candidates, not yet used in the timeline.",
    inputSchema: { scenes: z.array(z.object({ id: z.string().min(1).max(48), visualIntent: z.string().min(4).max(180), queries: z.array(z.string().min(2).max(100)).min(1).max(2) }).strict()).min(1).max(3), orientation: z.enum(["landscape", "portrait", "square"]).default("portrait") },
  }, async ({ scenes, orientation }) => {
    const result = await searchBrollScenes({ scenes, orientation, cachePath, fetchImpl });
    const output = { ...result, scenes: result.scenes.map((scene) => ({ ...scene, candidates: scene.candidates.map((candidate) => {
      const candidateHandle = randomUUID();
      candidates.set(candidateHandle, { ...candidate, candidateHandle });
      return { candidateHandle, provider: candidate.provider, providerId: candidate.providerId, title: candidate.title, previewUrl: candidate.previewUrl, sourceUrl: candidate.sourceUrl, creator: candidate.creator, creatorUrl: candidate.creatorUrl, width: candidate.width, height: candidate.height, durationSeconds: candidate.durationSeconds, licenseName: candidate.licenseName, licenseUrl: candidate.licenseUrl, score: candidate.score, match: candidate.match };
    }) })) };
    await audit({ tool: "search_broll", scenes: output.scenes.map((scene) => ({ id: scene.id, candidateCount: scene.candidates.length })) });
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  });

  server.registerTool("view_broll_candidate", {
    description: "View the thumbnail of a searched B-roll candidate before deciding whether to download it.",
    inputSchema: { candidateHandle: z.string().uuid() },
  }, async ({ candidateHandle }) => {
    const candidate = candidates.get(candidateHandle);
    if (!candidate) throw new Error("候选素材句柄无效或不属于当前搜索会话");
    const url = validatePreviewUrl(candidate.previewUrl);
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`候选预览图返回 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("候选预览图大小无效");
    await audit({ tool: "view_broll_candidate", candidateHandle, provider: candidate.provider, providerId: candidate.providerId });
    const mime = response.headers.get("content-type")?.split(";", 1)[0] || "image/jpeg";
    return { content: [{ type: "text", text: JSON.stringify({ candidateHandle, title: candidate.title, sourceUrl: candidate.sourceUrl, licenseName: candidate.licenseName, licenseUrl: candidate.licenseUrl }) }, { type: "image", mimeType: mime, data: Buffer.from(bytes).toString("base64") }] };
  });

  server.registerTool("download_broll", {
    description: "Download one selected candidate from the immediately preceding search into this edit workspace. The candidate's source and license metadata are persisted. Never pass an arbitrary URL.",
    inputSchema: { candidateHandle: z.string().uuid() },
  }, async ({ candidateHandle }) => {
    if (downloadCount >= MAX_DOWNLOADS) throw new Error(`本轮最多自动下载 ${MAX_DOWNLOADS} 个 B-roll 素材`);
    const candidate = candidates.get(candidateHandle);
    if (!candidate) throw new Error("候选素材句柄无效或不属于当前搜索会话");
    const url = validateAssetUrl(candidate.downloadUrl);
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("素材下载重定向缺少目标");
      const redirect = validateAssetUrl(new URL(location, url).toString());
      const redirected = await fetchImpl(redirect, { redirect: "manual", signal: AbortSignal.timeout(20000) });
      if (!redirected.ok) throw new Error(`素材 CDN 返回 HTTP ${redirected.status}`);
      return await saveResponse(redirected, redirect, candidate);
    }
    if (!response.ok) throw new Error(`素材 CDN 返回 HTTP ${response.status}`);
    return await saveResponse(response, url, candidate);
  });

  async function saveResponse(response, url, candidate) {
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_DOWNLOAD_BYTES) throw new Error("B-roll 文件超过 100MB 限制");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("B-roll 文件大小无效或超过 100MB 限制");
    const assetId = randomUUID();
    const targetName = `broll-${assetId}.mp4`;
    const target = resolve(workspaceDir, targetName);
    await fs.writeFile(target, bytes, { flag: "wx" });
    let media;
    try { media = await probeDownloaded(target); } catch (error) { await fs.rm(target, { force: true }); throw error; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset = { assetId, candidateHandle: candidate.candidateHandle, filename: targetName, path: targetName, provider: candidate.provider, providerId: candidate.providerId, sourceUrl: candidate.sourceUrl, creator: candidate.creator, creatorUrl: candidate.creatorUrl, licenseName: candidate.licenseName, licenseUrl: candidate.licenseUrl, downloadUrl: url.toString(), downloadedAt: new Date().toISOString(), sha256, bytes: bytes.byteLength, ...media };
    downloadCount += 1; candidates.delete(candidate.candidateHandle); await audit({ tool: "download_broll", ...asset });
    return { content: [{ type: "text", text: JSON.stringify(asset) }] };
  }
}

export async function startBrollTools(options) {
  const server = new McpServer({ name: "video-broll", version: "1.0.0" });
  registerBrollTools(server, options);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await startBrollTools({ workspaceDir: process.argv[2], auditPath: process.argv[3], cachePath: process.argv[4] });
}
