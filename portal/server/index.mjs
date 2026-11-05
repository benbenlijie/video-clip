import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerState, transcribeVideo } from "./transcription.mjs";
import { getWhisperConfig } from "./local-whisper.mjs";
import { REMOTION_MAIN_MODE } from "./remotion-main.mjs";
import { createProjectStore } from "./project-store.mjs";
import { writeTranscriptArtifacts } from "./edit-plan.mjs";
import { applyTranscriptReview, ensureTranscriptReviewState } from "./transcript-review.mjs";
import { subtitlesMatchTranscript, transcriptFingerprint } from "./transcript-proofreading.mjs";
import { editWithClaudeCode, editorState } from "./claude-code-editor.mjs";
import { brollProviderState, searchOnlineBroll } from "./broll-search.mjs";
import { appendEditTurn, buildChatContext, completeEditTurn, createEditSession, failEditTurn } from "./edit-chat.mjs";
import { createRenderManifest, getEngineAvailability, toTimelineV1 } from "./timeline-contract.mjs";
import { compositeRemotionPreview, remotionRuntimeAvailable, renderRemotionOverlay } from "./remotion-overlay.mjs";
import { detectBlackFrames, probeOutput } from "./render.mjs";
import { listOpenChatCutProjects, probeOpenChatCut } from "./openchatcut-sidecar.mjs";
import { assetDir, createAssetRecord, normalizeBrief, normalizeWorkflowMode, validateAssetUpload } from "./multi-asset.mjs";
import { toTimelineV2 } from "./timeline-v2.mjs";
import { analyzeMultiAssetProject, buildAssetInventory } from "./multi-asset-analysis.mjs";
import { confirmMultiAssetPlan, planMultiAssetWithClaude, restoreMultiAssetPlan } from "./multi-asset-plan.mjs";
import { renderMultiAssetProject } from "./multi-asset-render.mjs";
import { sanitizePublicResponse } from "./public-error.mjs";
import { recoverInterruptedMultiAssetProject } from "./multi-asset-recovery.mjs";

try {
  if (process.env.WAYNE_IGNORE_DOTENV === "1") throw new Error("portal .env disabled for isolated verification");
  const envText = await fs.readFile(new URL("../.env", import.meta.url), "utf8");
  const portalKeys = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "LLM_ANTHROPIC_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY", "OPENCHATCUT_MCP_URL", "OPENCHATCUT_MCP_TOKEN", "TRANSCRIPTION_PROVIDER", "VOLCENGINE_ASR_MODE", "VOLCENGINE_ASR_API_KEY", "VOLCENGINE_ASR_RESOURCE_ID", "VOLCENGINE_ASR_BASE_URL", "VOLCENGINE_ASR_MODEL", "VOLCENGINE_ASR_PUBLIC_BASE_URL", "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_ASR_CLUSTER", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENTCLOUD_REGION", "TENCENTCLOUD_ASR_ENDPOINT", "TENCENTCLOUD_ASR_ENGINE_MODEL_TYPE", "WAYNE_WHISPER_CLI_PATH", "WAYNE_WHISPER_MODEL_PATH", "WAYNE_WHISPER_THREADS", "WAYNE_WHISPER_TIMEOUT_MS"]);
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && portalKeys.has(match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* .env is optional. */ }

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const store = createProjectStore(resolve(process.env.WAYNE_STORAGE_DIR || join(root, "storage")));
const subscribers = new Map();
const brollSearchRequests = new Map();
const activeTranscriptions = new Set();
const activeAssetAnalyses = new Set();
const assetUploadLocks = new Map();
const editorRuntime = editorState();
const engineAvailability = getEngineAvailability({ remotion: await remotionRuntimeAvailable() });
let openchatcutAvailability = { ...engineAvailability.openchatcut };
await store.loadProjects();

for (const project of store.projects.values()) if (recoverInterruptedMultiAssetProject(project)) await store.saveProject(project);

function availableEngines() {
  return { ...engineAvailability, openchatcut: openchatcutAvailability };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(sanitizePublicResponse(body)));
}

function isLoopbackClient(req) {
  const address = String(req.socket.remoteAddress || "").replace(/^::ffff:/i, "").split("%")[0];
  if (address === "::1") return true;
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 127 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function isLoopbackPortalRequest(req) {
  if (!isLoopbackClient(req) || req.headers["x-forwarded-for"]) return false;
  const isLocalUrl = (value) => {
    if (!value) return true;
    try { return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname.replace(/^\[|\]$/g, "")); }
    catch { return false; }
  };
  return isLocalUrl(`http://${req.headers.host || ""}`)
    && isLocalUrl(req.headers.origin)
    && isLocalUrl(req.headers.referer);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function configState() {
  const transcription = providerState();
  const whisper = getWhisperConfig();
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY);
  const allConfigured = anthropic && transcription.any && editorRuntime.available;
  return {
    anthropic,
    editor: editorRuntime,
    transcription: transcription.any,
    transcriptionProvider: transcription.provider,
    volcengine: transcription.volcengine,
    tencent: transcription.tencent,
    localWhisper: { available: whisper.available, model: whisper.model, threads: whisper.threads },
    ffmpeg: true,
    engines: availableEngines(),
    brollProviders: brollProviderState(),
    mode: allConfigured ? "configured" : anthropic || transcription.any ? "partial" : "demo",
  };
}

function projectView(project) {
  const media = project.media ? { ...project.media, path: undefined } : project.assets?.length ? { filename: `${project.assets.length} 段素材`, durationMs: project.assets.reduce((total, asset) => total + (Number(asset.durationMs) || 0), 0), width: 0, height: 0 } : null;
  const music = project.music ? { ...project.music, path: undefined } : project.music;
  const brollAssets = (project.brollAssets || []).map((asset) => ({ ...asset, path: undefined }));
  const assets = (project.assets || []).map((asset) => ({ ...asset, path: undefined, visualEvidence: asset.visualEvidence ? { ...asset.visualEvidence, path: undefined } : undefined }));
  return sanitizePublicResponse({
    ...project,
    workflowMode: normalizeWorkflowMode(project.workflowMode),
    multiAssetPlan: project.multiAssetPlan ? { ...project.multiAssetPlan } : null,
    multiAssetPreview: project.multiAssetPreview ? { ...project.multiAssetPreview } : null,
    dir: undefined,
    media,
    music,
    brollAssets,
    assets,
    config: configState(),
    artifacts: (project.artifacts || []).map((artifact) => ({ ...artifact, url: `/api/projects/${project.id}/artifacts/${encodeURIComponent(artifact.name)}`, streamUrl: `/media/${project.id}/artifacts/${encodeURIComponent(artifact.name)}` })),
  });
}

function projectSummary(project) {
  const latestVersion = project.editSession?.latestVersion || project.editor?.version || project.qc?.version || 1;
  return {
    id: project.id,
    status: project.status,
    goal: project.goal,
    style: project.style,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    error: project.error,
    media: project.media ? { filename: project.media.filename, durationMs: project.media.durationMs, width: project.media.width, height: project.media.height } : project.assets?.length ? { filename: `${project.assets.length} 段素材`, durationMs: project.assets.reduce((total, asset) => total + (Number(asset.durationMs) || 0), 0) } : null,
    latestVersion,
    hasTranscript: Boolean(project.transcript || project.assets?.some((asset) => asset.transcript)),
    hasPlan: Boolean(project.plan || project.multiAssetPlan),
    hasPreview: Boolean((project.artifacts || []).some((artifact) => artifact.kind === "preview")),
    hasFinal: Boolean((project.artifacts || []).some((artifact) => artifact.kind === "video")),
  };
}

function headerNumber(req, name) {
  const value = Number(req.headers[name]);
  return Number.isSafeInteger(value) ? value : NaN;
}

function allowBrollSearch(req) {
  const now = Date.now();
  const address = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const recent = (brollSearchRequests.get(address) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 20) { brollSearchRequests.set(address, recent); return false; }
  recent.push(now);
  brollSearchRequests.set(address, recent);
  if (brollSearchRequests.size > 5000) {
    for (const [ip, times] of brollSearchRequests) if (!times.some((time) => now - time < 60 * 60 * 1000)) brollSearchRequests.delete(ip);
    while (brollSearchRequests.size > 5000) brollSearchRequests.delete(brollSearchRequests.keys().next().value);
  }
  return true;
}

async function withAssetUploadLock(key, operation) {
  const previous = assetUploadLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  assetUploadLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    if (assetUploadLocks.get(key) === current) assetUploadLocks.delete(key);
    release();
  }
}

async function writeUploadChunk(req, project) {
  const offset = headerNumber(req, "x-upload-offset");
  const totalBytes = headerNumber(req, "x-upload-total");
  const length = headerNumber(req, "x-upload-length");
  let filename = String(req.headers["x-upload-filename"] || "upload.mp4");
  if (req.headers["x-upload-filename-encoding"] === "uri") {
    try { filename = decodeURIComponent(filename); }
    catch { throw Object.assign(new Error("上传文件名编码无效，请重新选择视频"), { statusCode: 400 }); }
  }
  const maxChunkBytes = 8 * 1024 * 1024;
  const bodyLength = Number.isSafeInteger(length) ? length : headerNumber(req, "content-length");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(bodyLength) || bodyLength <= 0 || bodyLength > maxChunkBytes) {
    throw Object.assign(new Error("分块上传参数无效"), { statusCode: 400 });
  }
  if (offset + bodyLength > totalBytes) throw Object.assign(new Error("分块超出文件大小"), { statusCode: 400 });
  const upload = project.upload || { filename, totalBytes, receivedBytes: 0 };
  if (upload.totalBytes !== totalBytes || upload.filename !== filename) throw Object.assign(new Error("上传文件与当前项目不匹配"), { statusCode: 409 });
  if (offset < upload.receivedBytes && offset + bodyLength <= upload.receivedBytes) {
    for await (const _chunk of req) { /* Drain a retried chunk before reusing the connection. */ }
    return { receivedBytes: upload.receivedBytes, totalBytes };
  }
  if (offset !== upload.receivedBytes) throw Object.assign(new Error(`上传位置不匹配，应从 ${upload.receivedBytes} 字节继续`), { statusCode: 409, receivedBytes: upload.receivedBytes });
  const output = createWriteStream(join(project.dir, "input.mp4.part"), { flags: offset === 0 ? "w" : "r+", start: offset });
  let received = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; callback(null, chunk); } });
  try { await pipeline(req, counter, output); } catch (error) { if (req.aborted || req.destroyed) throw Object.assign(error, { requestAborted: true }); throw error; }
  await fs.truncate(join(project.dir, "input.mp4.part"), offset + received);
  if (received !== bodyLength) throw Object.assign(new Error(`分块大小不匹配，收到 ${received} 字节，期望 ${bodyLength} 字节`), { statusCode: 400 });
  project.upload = { filename, totalBytes, receivedBytes: offset + received };
  await save(project);
  return { receivedBytes: project.upload.receivedBytes, totalBytes };
}

async function completeChunkedUpload(project) {
  const upload = project.upload;
  if (!upload) throw Object.assign(new Error("没有待完成的分块上传"), { statusCode: 409 });
  if (upload.receivedBytes !== upload.totalBytes) throw Object.assign(new Error(`上传尚未完成，还缺少 ${upload.totalBytes - upload.receivedBytes} 字节`), { statusCode: 409, receivedBytes: upload.receivedBytes });
  const partPath = join(project.dir, "input.mp4.part");
  const metadata = await probeMedia(partPath);
  const inputPath = join(project.dir, "input.mp4");
  await fs.rename(partPath, inputPath);
  project.media = { filename: upload.filename, path: inputPath, ...metadata };
  project.upload = null;
  project.status = "inspecting";
  project.error = null;
  await save(project);
  publish(project.id, { type: "stage", status: project.status, message: "已读取真实媒体信息" });
  return project;
}

async function writeAssetUploadChunk(req, project, asset) {
  const offset = headerNumber(req, "x-upload-offset");
  const totalBytes = headerNumber(req, "x-upload-total");
  const length = headerNumber(req, "x-upload-length");
  const bodyLength = Number.isSafeInteger(length) ? length : headerNumber(req, "content-length");
  const maxChunkBytes = 8 * 1024 * 1024;
  if (!asset?.upload || asset.status !== "uploading") throw Object.assign(new Error("素材当前没有待续传的上传"), { statusCode: 409 });
  if (!Number.isSafeInteger(offset) || offset < 0 || totalBytes !== asset.upload.totalBytes || !Number.isSafeInteger(bodyLength) || bodyLength <= 0 || bodyLength > maxChunkBytes) throw Object.assign(new Error("素材分块上传参数无效"), { statusCode: 400 });
  if (offset + bodyLength > totalBytes) throw Object.assign(new Error("素材分块超出文件大小"), { statusCode: 400 });
  const receivedBytes = Number(asset.upload.receivedBytes || 0);
  if (offset < receivedBytes && offset + bodyLength <= receivedBytes) {
    const chunks = [];
    let replayLength = 0;
    for await (const chunk of req) { chunks.push(chunk); replayLength += chunk.length; }
    if (replayLength !== bodyLength) throw Object.assign(new Error("重试分块大小与原上传不一致"), { statusCode: 409, receivedBytes });
    const replay = Buffer.concat(chunks, replayLength);
    const handle = await fs.open(join(assetDir(project, asset.id), "source.part"), "r");
    let stored;
    try { stored = Buffer.alloc(replayLength); await handle.read(stored, 0, replayLength, offset); }
    finally { await handle.close(); }
    if (!stored.equals(replay)) throw Object.assign(new Error("重试分块内容与已确认素材不一致，请重新开始上传"), { statusCode: 409, receivedBytes });
    return { receivedBytes, totalBytes };
  }
  if (offset !== receivedBytes) throw Object.assign(new Error(`素材上传位置不匹配，应从 ${receivedBytes} 字节继续`), { statusCode: 409, receivedBytes });
  const directory = assetDir(project, asset.id);
  const partPath = join(directory, "source.part");
  const output = createWriteStream(partPath, { flags: offset === 0 ? "w" : "r+", start: offset });
  let received = 0;
  const chunkHash = createHash("sha256");
  const counter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; chunkHash.update(chunk); callback(null, chunk); } });
  try { await pipeline(req, counter, output); } catch (error) { if (req.aborted || req.destroyed) throw Object.assign(error, { requestAborted: true }); throw error; }
  await fs.truncate(partPath, offset + received);
  if (received !== bodyLength) throw Object.assign(new Error(`素材分块大小不匹配，收到 ${received} 字节，期望 ${bodyLength} 字节`), { statusCode: 400 });
  asset.upload.receivedBytes = offset + received;
  asset.upload.chunkHashes = [...(asset.upload.chunkHashes || []).filter((item) => item.offset !== offset), { offset, length: received, sha256: chunkHash.digest("hex") }];
  await save(project);
  return { receivedBytes: asset.upload.receivedBytes, totalBytes };
}

async function completeAssetUpload(project, asset) {
  if (!asset?.upload || asset.status !== "uploading") throw Object.assign(new Error("素材没有待完成的上传"), { statusCode: 409 });
  if (asset.upload.receivedBytes !== asset.upload.totalBytes) throw Object.assign(new Error(`素材上传尚未完成，还缺少 ${asset.upload.totalBytes - asset.upload.receivedBytes} 字节`), { statusCode: 409, receivedBytes: asset.upload.receivedBytes });
  const directory = assetDir(project, asset.id);
  const partPath = join(directory, "source.part");
  const sourcePath = join(directory, `source${extname(asset.filename).toLowerCase()}`);
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  const uploadPath = sourceStat ? sourcePath : partPath;
  const stat = sourceStat || await fs.stat(partPath);
  if (stat.size !== asset.upload.totalBytes) throw Object.assign(new Error("素材文件大小与已确认上传字节不一致，请重新续传"), { statusCode: 409 });
  const metadata = await probeMedia(uploadPath);
  const record = createAssetRecord({ id: asset.id, filename: asset.filename, path: sourcePath, bytes: asset.upload.totalBytes, metadata, role: asset.role, label: asset.label, licenseConfirmed: asset.licenseConfirmed });
  record.sha256 = await sha256File(uploadPath);
  record.chunkHashes = (asset.upload.chunkHashes || []).map((item) => ({ ...item }));
  record.analysisStatus = "pending";
  if (uploadPath !== sourcePath) await fs.rename(partPath, sourcePath);
  project.assets = project.assets.map((item) => item.id === asset.id ? record : item);
  archiveMultiAssetPlan(project);
  project.assetAnalysis = { status: "pending", completed: project.assets.filter((item) => item.analysisStatus === "ready").length, failed: 0 };
  project.status = "assets_ready";
  project.error = null;
  await save(project);
  publish(project.id, { type: "asset_uploaded", assetId: asset.id, status: project.status, message: `素材“${record.label}”已上传，等待分析` });
  return project;
}

async function save(project) {
  project.updatedAt = new Date().toISOString();
  return store.saveProject(project);
}

async function recoverInterruptedChatEdits() {
  for (const project of store.projects.values()) {
    if (project.status !== "chat_editing") continue;
    const runningTurn = project.editSession?.turns?.find((turn) => turn.status === "running");
    if (runningTurn && project.editSession) project.editSession = failEditTurn(project.editSession, runningTurn.id, "服务在本轮完成前重启，请重新发送修改要求");
    project.status = "chat_ready";
    project.error = "上一轮对话修改在服务重启前未完成，当前版本未改变，可以重新发送修改要求";
    await save(project);
  }
}

await recoverInterruptedChatEdits();

function publish(projectId, event) {
  const project = store.get(projectId);
  const payload = project ? { ...event, project: projectView(project) } : event;
  for (const response of subscribers.get(projectId) || []) response.write(`data: ${JSON.stringify(sanitizePublicResponse(payload))}\n\n`);
}

function archiveMultiAssetPlan(project) {
  project.multiAssetRevision = Number(project.multiAssetRevision || 0) + 1;
  project.multiAssetInputRevision = Number(project.multiAssetInputRevision || 0) + 1;
  if (project.multiAssetPlan) {
    const history = project.multiAssetPlanHistory || [];
    if (!history.some((item) => Number(item.version) === Number(project.multiAssetPlan.version))) project.multiAssetPlanHistory = [...history, project.multiAssetPlan];
  }
  project.multiAssetPlan = null;
  project.multiAssetPreview = null;
  project.multiAssetPreviewReview = null;
  project.qc = null;
}

async function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 2_000_000) reject(new Error("request too large")); });
    req.on("end", () => { try { resolveBody(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

function parseMultipart(req, boundary, destination, maxBytes = 500 * 1024 * 1024) {
  return new Promise((resolveUpload, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) { reject(new Error(`上传文件不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        const marker = Buffer.from(`--${boundary}`);
        const parts = [];
        let cursor = 0;
        while (cursor < body.length) {
          const start = body.indexOf(marker, cursor);
          if (start < 0) break;
          const headerStart = start + marker.length + 2;
          const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
          if (headerEnd < 0) break;
          const contentStart = headerEnd + 4;
          const markerStart = body.indexOf(marker, contentStart);
          const contentEnd = markerStart >= 0 ? markerStart - 2 : body.length;
          parts.push({ header: body.subarray(headerStart, headerEnd).toString("utf8"), content: body.subarray(contentStart, contentEnd) });
          cursor = Math.max(contentEnd + 2, contentStart);
        }
        const filePart = parts.find((part) => /filename=/i.test(part.header));
        if (!filePart || filePart.content.length === 0) throw new Error("请提供上传文件");
        await fs.writeFile(destination, filePart.content);
        resolveUpload({
          filename: filePart.header.match(/filename="([^"]+)/i)?.[1] || "upload.mp4",
          goal: parts.find((part) => /name="goal"/i.test(part.header))?.content.toString("utf8") || "",
          style: parts.find((part) => /name="style"/i.test(part.header))?.content.toString("utf8") || "",
          licenseConfirmed: parts.find((part) => /name="licenseConfirmed"/i.test(part.header))?.content.toString("utf8") === "true",
        });
      } catch (error) { reject(error); }
    });
  });
}

function probeMedia(path) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "ffprobe failed"));
      try {
        const payload = JSON.parse(stdout);
        const video = payload.streams?.find((item) => item.codec_type === "video");
        const audio = payload.streams?.find((item) => item.codec_type === "audio");
        resolveProbe({ durationMs: Math.round(Number(payload.format?.duration || 0) * 1000), width: video?.width || 0, height: video?.height || 0, hasVideo: Boolean(video), hasAudio: Boolean(audio) });
      } catch { reject(new Error("invalid ffprobe output")); }
    });
  });
}

async function serveFile(req, res, path, contentType, disposition = "inline") {
  const stat = await fs.stat(path);
  const range = req.headers.range;
  const common = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Disposition": disposition };
  if (!range) { res.writeHead(200, { ...common, "Content-Length": stat.size }); return createReadStream(path).pipe(res); }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); return res.end(); }
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
  const end = match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); return res.end(); }
  res.writeHead(206, { ...common, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
  return createReadStream(path, { start, end }).pipe(res);
}

async function createProject(body = {}) {
  const id = randomUUID();
  const workflowMode = normalizeWorkflowMode(body.workflowMode);
  const brief = workflowMode === "multi-asset-v1" ? normalizeBrief(body.brief || { rawText: body.goal || "" }) : null;
  const project = { id, workflowId: "wayne-video-editing", workflowMode, compositionMode: REMOTION_MAIN_MODE, status: "created", goal: body.goal || brief?.rawText || "", style: body.style || "Wayne / clean creator", brief, assets: [], assetAnalysis: { status: "pending", completed: 0, failed: 0 }, outputProfiles: brief ? (brief.aspectRatio === "both" ? ["landscape", "portrait"] : [brief.aspectRatio]) : [], multiAssetPlan: null, multiAssetPlanHistory: [], multiAssetPreview: null, multiAssetRevision: 0, multiAssetInputRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dir: store.projectDir(id), artifacts: [], comments: [], brollAssets: [], media: null, transcript: null, transcription: null, proofreading: null, plan: null, qc: null, error: null, upload: null, editSession: null };
  await save(project);
  return project;
}

async function transitionToTranscript(project) {
  if (!project.media) throw new Error("请先上传视频");
  if (activeTranscriptions.has(project.id)) throw Object.assign(new Error("云端 ASR 与本地 Whisper 正在并行识别，请稍候"), { statusCode: 409 });
  if (!configState().transcription) { project.status = "needs_input"; project.error = "未配置火山引擎或腾讯云转录凭证"; await save(project); throw Object.assign(new Error(project.error), { statusCode: 409, status: project.status }); }
  activeTranscriptions.add(project.id);
  const whisperConfig = getWhisperConfig();
  const startedAt = new Date().toISOString();
  project.status = "transcribing";
  project.error = null;
  project.transcription = {
    status: "running",
    model: whisperConfig.available ? whisperConfig.model : null,
    primary: { status: "running" },
    secondary: { status: whisperConfig.available ? "running" : "unavailable", ...(whisperConfig.available ? {} : { error: "本地 Whisper CLI 或 small 模型未安装" }) },
    startedAt,
  };
  await save(project);
  publish(project.id, { type: "stage", status: project.status, message: "云端 ASR 与本地 Whisper 正在并行识别" });
  try {
    const result = await transcribeVideo({
      videoPath: project.media.path,
      projectDir: project.dir,
      projectId: project.id,
      onPass: ({ pass, status, error }) => {
        const key = pass === "primary" ? "primary" : "secondary";
      project.transcription = { ...project.transcription, [key]: { status, ...(error ? { error } : {}) }, updatedAt: new Date().toISOString() };
      project.status = "transcribing";
      publish(project.id, { type: "transcription_pass", pass, status, message: pass === "primary" ? "云端 ASR" : "本地 Whisper", error });
      },
    });
    project.transcription = {
      status: result.primary ? (result.secondaryStatus === "complete" ? "ready" : "manual_review_required") : "failed",
      audioSha256: result.audioSha256,
      model: result.model,
      primary: { status: result.primaryStatus, ...(result.primary ? { provider: result.primary.provider, requestId: result.primary.requestId } : {}), ...(result.primaryError ? { error: result.primaryError } : {}) },
      secondary: { status: result.secondaryStatus, ...(result.secondary ? { provider: result.secondary.provider, model: result.secondary.model, elapsedMs: result.secondary.elapsedMs } : {}), ...(result.secondaryError ? { error: result.secondaryError } : {}) },
      startedAt,
      completedAt: new Date().toISOString(),
    };
    project.secondaryTranscript = result.secondary || null;
    if (!result.primary) throw new Error(result.primaryError || "云端 ASR 未返回转录结果");
    project.transcript = { provider: result.primary.provider, requestId: result.primary.requestId, ...result.primary.transcript };
    project.primaryTranscript = structuredClone(project.transcript);
    project.proofreading = result.secondary ? null : { status: "manual_review_required", model: result.model, changes: [], unresolved: [] };
    await writeTranscriptArtifacts(project, project.transcript);
    project.status = "transcript_ready"; await save(project); publish(project.id, { type: "stage", status: project.status, message: `并行识别完成（${result.primary.provider}${result.secondary ? " + Whisper small" : "；需人工校对"}）` });
  } catch (error) { project.transcription = { ...project.transcription, status: "failed", completedAt: new Date().toISOString() }; project.status = "failed"; project.error = error.message; await save(project); publish(project.id, { type: "failed", status: project.status, message: error.message }); throw error; }
  finally { activeTranscriptions.delete(project.id); }
}

async function transitionToPlan(project) {
  if (!project.transcript) throw new Error("请先完成转录");
  if (!configState().anthropic) { project.status = "needs_input"; project.error = "未配置 ANTHROPIC_API_KEY，无法生成剪辑计划"; await save(project); throw Object.assign(new Error(project.error), { statusCode: 409, status: project.status }); }
  if (!editorRuntime.available) throw new Error("本机 Claude Code 或媒体隔离工具不可用");
  project.status = "planning"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude Code / Opus 5.5 正在检查素材、编写工程并审阅真实预览" });
  try {
    const result = await editWithClaudeCode(project, "plan", editorProgress(project), { persistProject: save });
    project.plan = result.plan;
    project.brollAssets = [...(project.brollAssets || []), ...(result.brollAssets || [])];
    project.editor = result.editor;
    project.artifacts = [...(project.artifacts || []), ...result.artifacts];
    project.qc = null;
    await fs.writeFile(join(project.dir, "cut-list.json"), JSON.stringify(project.plan, null, 2));
    project.status = "plan_ready"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude Code 已生成并抽帧审阅预览，等待人工确认" });
  } catch (error) { project.status = "needs_input"; project.error = error.message; await save(project); publish(project.id, { type: "needs_input", status: project.status, message: error.message }); throw Object.assign(error, { statusCode: 502 }); }
}

function editorProgress(project) {
  return (event) => {
    project.editor = { ...project.editor, engine: "claude-code", model: editorRuntime.model, activity: [...(project.editor?.activity || []), { at: new Date().toISOString(), ...event }].slice(-12) };
    publish(project.id, { type: "agent_activity", ...event });
  };
}

function ensureEditSession(project) {
  const session = createEditSession(project);
  project.editSession = session;
  return session;
}

async function runChatEdit(project, turn) {
  try {
    const session = ensureEditSession(project);
    const result = await editWithClaudeCode(project, "chat-edit", editorProgress(project), { chatTurn: turn, chatContext: buildChatContext(session), sessionId: session.sessionId });
    project.plan = result.plan;
    project.brollAssets = [...(project.brollAssets || []), ...(result.brollAssets || [])];
    project.editor = { ...result.editor, version: turn.resultVersion, phase: "chat-edit", sessionId: result.editor.sessionId || session.sessionId };
    project.artifacts = [...(project.artifacts || []), ...result.artifacts];
    project.qc = result.qc;
    project.editSession = completeEditTurn(project.editSession, turn.id, { resultVersion: turn.resultVersion, sessionId: result.editor.sessionId, assistantText: `已生成 v${turn.resultVersion} 预览，QC 已通过。你可以继续对话修改，或确认导出正式成片。` });
    project.status = "chat_ready";
    project.error = null;
    await fs.writeFile(join(project.dir, "cut-list.json"), JSON.stringify(project.plan, null, 2));
    await save(project);
    publish(project.id, { type: "chat_completed", status: project.status, message: `对话修改完成，已生成 v${turn.resultVersion}` });
  } catch (error) {
    project.editSession = failEditTurn(project.editSession, turn.id, error.message);
    project.status = "chat_ready";
    project.error = error.message;
    await save(project);
    publish(project.id, { type: "chat_failed", status: project.status, message: error.message });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, service: "wayne-portal", config: configState() });
  if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, configState());
  if (req.method === "GET" && url.pathname === "/api/engines") return json(res, 200, { engines: availableEngines() });
  if (req.method === "POST" && url.pathname === "/api/engines/openchatcut/probe") {
    if (!isLoopbackClient(req)) return json(res, 403, { error: "OpenChatCut sidecar probe 仅允许本机请求" });
    try {
      const result = await probeOpenChatCut();
      openchatcutAvailability = { enabled: result.status === "ready", mode: result.status, license: "AGPL-3.0-or-later", toolCount: result.toolCount };
      if (result.status !== "ready") return json(res, 409, result);
      return json(res, 200, result);
    } catch (error) {
      openchatcutAvailability = { enabled: false, mode: "offline", license: "AGPL-3.0-or-later" };
      const message = error.message === "The operation was aborted due to timeout" ? "OpenChatCut sidecar 连接超时" : error.message;
      return json(res, error.message.includes("仅允许本机") ? 400 : 503, { status: "offline", error: message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/engines/openchatcut/projects") {
    if (!isLoopbackPortalRequest(req)) return json(res, 403, { error: "OpenChatCut 工程列表仅允许本机 Wayne 页面读取" });
    try {
      const projects = await listOpenChatCutProjects();
      return json(res, 200, { projects });
    } catch (error) {
      const message = error.message === "The operation was aborted due to timeout" ? "OpenChatCut 工程列表读取超时" : error.message;
      return json(res, 503, { error: message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const projects = [...store.projects.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit).map(projectSummary);
    return json(res, 200, { projects });
  }
  if (req.method === "POST" && url.pathname === "/api/projects") { try { return json(res, 201, projectView(await createProject(await readJson(req)))); } catch (error) { return json(res, 400, { error: error.message }); } }

  if (req.method === "GET" && segments[0] === "media" && segments[1] && segments[2] === "assets" && segments[3] && segments[4] === "transcript-audio.wav") {
    const project = store.get(segments[1]);
    const asset = (project?.assets || []).find((item) => item.id === segments[3]);
    const target = asset && join(assetDir(project, asset.id), "transcript-audio.wav");
    try { return serveFile(req, res, target, "audio/wav"); } catch { return json(res, 404, { error: "asset transcript audio not found" }); }
  }
  if (req.method === "GET" && segments[0] === "media" && segments[1] && segments[2] === "artifacts" && segments[3]) {
    const project = store.get(segments[1]);
    let name;
    try { name = decodeURIComponent(segments.slice(3).join("/")); } catch { return json(res, 400, { error: "invalid artifact path" }); }
    const artifact = (project?.artifacts || []).find((item) => item.name === name);
    const target = artifact && store.artifactPath(project, name);
    if (!target) return json(res, 404, { error: "artifact not found" });
    const contentType = name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".webm") ? "video/webm" : name.endsWith(".wav") ? "audio/wav" : "application/octet-stream";
    try { return serveFile(req, res, target, contentType, "inline"); } catch { return json(res, 404, { error: "artifact not found" }); }
  }
  if (req.method === "GET" && segments[0] === "media" && segments[1] && ["input.mp4", "transcript-audio.wav"].includes(segments[2])) {
    const project = store.get(segments[1]); const target = project && join(project.dir, segments[2]);
    try { return serveFile(req, res, target, segments[2].endsWith("wav") ? "audio/wav" : "video/mp4"); } catch { return json(res, 404, { error: "media not found" }); }
  }

  const project = segments[0] === "api" && segments[1] === "projects" ? store.get(segments[2]) : null;
  if (!project) return json(res, 404, { error: "project not found" });
  ensureTranscriptReviewState(project);
  if (req.method === "POST" && segments[3] === "assets" && segments.length === 4) {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "素材库上传仅适用于多素材项目" });
    if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理，请等待完成后再管理素材" });
    try {
      const asset = await withAssetUploadLock(`${project.id}:assets`, async () => {
        if (activeAssetAnalyses.has(project.id) || ["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，不能添加新素材"), { statusCode: 409 });
        const body = await readJson(req);
        const filename = String(body.filename || "").replaceAll("\\", "/").split("/").at(-1) || "";
        const totalBytes = Number(body.totalBytes);
        const currentTotalBytes = (project.assets || []).reduce((total, item) => total + Number(item.bytes || item.upload?.totalBytes || 0), 0);
        const { extension } = validateAssetUpload({ filename, byteLength: totalBytes, currentAssetCount: project.assets?.length || 0, currentTotalBytes });
        const role = String(body.role || "supporting");
        if (!["main", "supporting", "broll", "voiceover"].includes(role)) throw new Error("素材角色无效");
        const id = randomUUID();
        const dir = assetDir(project, id);
        await fs.mkdir(dir, { recursive: true });
        const record = { id, filename, path: join(dir, `source${extension}`), bytes: 0, expectedBytes: totalBytes, durationMs: 0, width: 0, height: 0, hasVideo: true, hasAudio: false, role, label: String(body.label || filename).slice(0, 120), licenseConfirmed: body.licenseConfirmed === true, status: "uploading", analysisStatus: "pending", upload: { totalBytes, receivedBytes: 0, chunkHashes: [] }, createdAt: new Date().toISOString() };
        archiveMultiAssetPlan(project);
        project.assetAnalysis = { ...(project.assetAnalysis || {}), status: "pending" };
        project.assets = [...(project.assets || []), record];
        project.status = "uploading_assets";
        project.error = null;
        await save(project);
        publish(project.id, { type: "asset_upload_started", assetId: id, status: project.status, message: `开始上传素材“${record.label}”` });
        return record;
      });
      return json(res, 201, projectView(project));
    } catch (error) {
      return json(res, error.statusCode || 400, { error: error.message });
    }
  }
  if (req.method === "GET" && segments[3] === "assets" && segments.length === 4) return json(res, 200, { assets: projectView(project).assets || [] });
  if (req.method === "POST" && segments[3] === "assets" && segments[5] === "chunk") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "素材分块上传仅适用于多素材项目" });
    const asset = (project.assets || []).find((item) => item.id === segments[4]);
    if (!asset) return json(res, 404, { error: "素材不存在" });
    try { return json(res, 200, { ...await withAssetUploadLock(`${project.id}:assets`, () => {
      if (activeAssetAnalyses.has(project.id) || ["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，不能同时修改上传内容"), { statusCode: 409 });
      return writeAssetUploadChunk(req, project, asset);
    }), status: project.status, assetId: asset.id }); }
    catch (error) { if (error.requestAborted || req.aborted) return; return json(res, error.statusCode || 400, { error: error.message, receivedBytes: error.receivedBytes ?? asset.upload?.receivedBytes ?? 0 }); }
  }
  if (req.method === "POST" && segments[3] === "assets" && segments[5] === "complete") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "素材上传仅适用于多素材项目" });
    const asset = (project.assets || []).find((item) => item.id === segments[4]);
    if (!asset) return json(res, 404, { error: "素材不存在" });
    try { return json(res, 201, projectView(await withAssetUploadLock(`${project.id}:assets`, () => {
      if (activeAssetAnalyses.has(project.id) || ["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，不能同时完成上传"), { statusCode: 409 });
      return completeAssetUpload(project, asset);
    }))); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message, receivedBytes: error.receivedBytes ?? asset.upload?.receivedBytes ?? 0 }); }
  }
  if (req.method === "PUT" && segments[3] === "assets" && segments[4] && segments.length === 5) {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "素材管理仅适用于多素材项目" });
    if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理，请等待本轮完成后再管理素材" });
    const asset = (project.assets || []).find((item) => item.id === segments[4]);
    if (!asset || asset.status === "uploading") return json(res, 404, { error: "已上传素材不存在" });
    try {
      const body = await readJson(req);
      if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，请稍后修改素材"), { statusCode: 409 });
      if (body.role != null) {
        if (!["main", "supporting", "broll", "voiceover"].includes(String(body.role))) throw new Error("素材角色无效");
        asset.role = String(body.role);
      }
      if (body.label != null) asset.label = String(body.label).trim().slice(0, 120) || asset.filename;
      if (body.licenseConfirmed != null) asset.licenseConfirmed = body.licenseConfirmed === true;
      if (body.retryAnalysis === true) { asset.analysisStatus = "pending"; asset.analysisError = null; project.assetAnalysis = { ...(project.assetAnalysis || {}), status: "pending" }; }
      archiveMultiAssetPlan(project);
      if (project.assetAnalysis?.status === "ready" && project.assets.every((item) => ["ready", "complete"].includes(item.analysisStatus))) {
        project.assetInventory = buildAssetInventory(project);
        await fs.writeFile(join(project.dir, "asset-inventory.json"), JSON.stringify(project.assetInventory, null, 2));
      }
      project.status = "assets_ready";
      await save(project);
      publish(project.id, { type: "asset_updated", assetId: asset.id, status: project.status });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === "DELETE" && segments[3] === "assets" && segments[4] && segments.length === 5) {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "素材管理仅适用于多素材项目" });
    try {
      await withAssetUploadLock(`${project.id}:assets`, async () => {
        if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，不能删除素材"), { statusCode: 409 });
        const asset = (project.assets || []).find((item) => item.id === segments[4]);
        if (!asset) throw Object.assign(new Error("素材不存在"), { statusCode: 404 });
        if (!["uploading", "failed"].includes(asset.status) && asset.analysisStatus !== "failed") throw Object.assign(new Error("只能移除未完成或失败的素材；已完成素材请先创建新项目"), { statusCode: 409 });
        await fs.rm(assetDir(project, asset.id), { recursive: true, force: true });
        project.assets = project.assets.filter((item) => item.id !== asset.id);
        project.assetAnalysis = { status: "pending", completed: project.assets.filter((item) => item.analysisStatus === "ready").length, failed: project.assets.filter((item) => item.analysisStatus === "failed").length };
        archiveMultiAssetPlan(project);
        project.status = project.assets.length ? "assets_ready" : "created";
        project.error = null;
        await save(project);
        publish(project.id, { type: "asset_removed", assetId: asset.id, status: project.status, message: `已移除未完成素材“${asset.label || asset.filename}”` });
      });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
  }
  if (req.method === "PUT" && segments[3] === "brief") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "方案编辑仅适用于多素材项目" });
    if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理，请稍后修改方案" });
    try {
      const body = await readJson(req);
      if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，请稍后修改方案"), { statusCode: 409 });
      project.brief = normalizeBrief(body);
      project.goal = project.brief.rawText;
      project.outputProfiles = project.brief.aspectRatio === "both" ? ["landscape", "portrait"] : [project.brief.aspectRatio];
      archiveMultiAssetPlan(project);
      if (project.assetAnalysis?.status === "ready") {
        project.assetInventory = buildAssetInventory(project);
        await fs.writeFile(join(project.dir, "asset-inventory.json"), JSON.stringify(project.assetInventory, null, 2));
      }
      project.status = "assets_ready";
      project.error = null;
      await save(project);
      publish(project.id, { type: "brief_updated", status: project.status });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === "GET" && segments[3] === "assets" && ["media", "contact-sheet"].includes(segments[5])) {
    const asset = (project.assets || []).find((item) => item.id === segments[4]);
    const target = segments[5] === "contact-sheet" ? asset?.visualEvidence?.path : asset?.path;
    if (!target || asset.status !== "ready") return json(res, 404, { error: "素材文件不存在" });
    if (segments[5] === "contact-sheet") {
      try { return serveFile(req, res, target, "image/jpeg"); } catch { return json(res, 404, { error: "素材关键帧不存在" }); }
    }
    const contentType = ({ ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm" })[extname(asset.filename).toLowerCase()] || "application/octet-stream";
    try { return serveFile(req, res, asset.path, contentType); } catch { return json(res, 404, { error: "素材文件不存在" }); }
  }
  if (req.method === "GET" && segments.length === 3) return json(res, 200, projectView(project));
  if (req.method === "GET" && segments[3] === "transcript-audio") {
    try { return serveFile(req, res, join(project.dir, "transcript-audio.wav"), "audio/wav"); }
    catch { return json(res, 404, { error: "transcript audio not found" }); }
  }
  if (req.method === "POST" && segments[3] === "transcript") {
    if (["transcribing", "planning", "rendering", "chat_editing"].includes(project.status)) return json(res, 409, { error: "当前识别或剪辑任务仍在运行，暂时不能修改字幕" });
    if (!project.transcript || !project.proofreading) return json(res, 409, { error: "该项目还没有可审阅的转录稿" });
    try {
      const body = await readJson(req);
      const result = applyTranscriptReview({
        transcript: project.transcript,
        proofreading: project.proofreading,
        segments: body.segments,
        confirmedUnresolvedSegmentIds: body.confirmedUnresolvedSegmentIds,
      });
      const nextProofreading = { ...result.proofreading, previewTranscriptSha256: project.proofreading.previewTranscriptSha256 || null };
      nextProofreading.previewStale = Boolean(project.plan && nextProofreading.previewTranscriptSha256 !== transcriptFingerprint(result.transcript));
      if (project.proofreading.migrated) {
        try { await fs.writeFile(join(project.dir, "transcript.original.json"), JSON.stringify(project.primaryTranscript, null, 2), { flag: "wx" }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        nextProofreading.migrated = false;
      }
      await fs.writeFile(join(project.dir, "transcript.reviewed.json"), JSON.stringify(result.transcript, null, 2));
      await writeTranscriptArtifacts(project, result.transcript);
      project.transcript = result.transcript;
      project.proofreading = nextProofreading;
      project.qc = null;
      project.status = project.plan ? "preview_ready" : "transcript_ready";
      project.error = null;
      await save(project);
      publish(project.id, { type: "transcript_reviewed", status: project.status, message: project.proofreading.previewStale ? "字幕校对已保存；预览字幕需要重新生成" : "字幕校对已确认" });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, 400, { error: error.message, status: project.status }); }
  }
  if (req.method === "GET" && segments[3] === "timeline") {
    if (project.workflowMode === "multi-asset-v1") {
      try { return json(res, 200, toTimelineV2(project)); }
      catch (error) { return json(res, 409, { error: error.message, status: project.status }); }
    }
    if (!project.media || !project.plan) return json(res, 409, { error: "生成标准时间线需要已上传媒体和剪辑计划", status: project.status });
    try { return json(res, 200, toTimelineV1(project)); }
    catch (error) { return json(res, 422, { error: error.message, status: project.status }); }
  }
  if (req.method === "POST" && segments[3] === "analyze") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "素材分析仅适用于多素材项目" });
    try {
      await withAssetUploadLock(`${project.id}:assets`, async () => {
        if (activeAssetAnalyses.has(project.id) || project.status === "analyzing_assets") throw Object.assign(new Error("当前已有素材分析任务正在运行"), { statusCode: 409 });
        if (["planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在制作，请等待当前任务完成"), { statusCode: 409 });
        if ((project.assets || []).some((asset) => asset.status !== "ready")) throw Object.assign(new Error("所有素材上传完成后才能开始分析"), { statusCode: 409 });
        if (project.assets.some((asset) => asset.hasAudio) && !configState().transcription) throw Object.assign(new Error("含音轨素材需要配置火山引擎或腾讯云转录凭证"), { statusCode: 409 });
        activeAssetAnalyses.add(project.id);
        archiveMultiAssetPlan(project);
        project.status = "analyzing_assets";
        project.error = null;
        await save(project);
        publish(project.id, { type: "stage", status: project.status, message: "正在逐条分析视频素材" });
      });
    } catch (error) { return json(res, error.statusCode || 409, { error: error.message }); }
    try {
      await analyzeMultiAssetProject(project, {
        transcribe: transcribeVideo,
        persist: save,
        publicMediaBaseUrl: process.env.VOLCENGINE_ASR_PUBLIC_BASE_URL || "",
        onAsset: async ({ asset, status, pass, error }) => {
          project.assetAnalysis = { ...(project.assetAnalysis || {}), currentAssetId: asset.id, currentStatus: status };
          await save(project);
          publish(project.id, { type: "asset_analysis", assetId: asset.id, pass, status, error, message: `${asset.label}：${pass === "primary" ? "云端转录" : pass === "secondary" ? "本地校对" : status}` });
        },
      });
      project.assetInventory = buildAssetInventory(project);
      await fs.writeFile(join(project.dir, "asset-inventory.json"), JSON.stringify(project.assetInventory, null, 2));
      project.status = "transcript_ready";
      await save(project);
      publish(project.id, { type: "stage", status: project.status, message: "所有素材分析完成，可以生成剪辑方案" });
      return json(res, 200, projectView(project));
    } catch (error) {
      project.assetAnalysis = { ...(project.assetAnalysis || {}), status: "failed", error: error.message };
      project.status = "needs_input";
      project.error = error.message;
      await save(project).catch(() => undefined);
      publish(project.id, { type: "failed", status: project.status, message: error.message });
      return json(res, 502, { error: error.message, status: project.status, project: projectView(project) });
    } finally {
      activeAssetAnalyses.delete(project.id);
    }
  }
  if (req.method === "POST" && segments[3] === "plan" && segments.length === 4) {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "多素材方案仅适用于多素材项目" });
    if (activeAssetAnalyses.has(project.id) || project.status === "analyzing_assets") return json(res, 409, { error: "素材分析尚未完成，不能生成方案" });
    if (project.assetAnalysis?.status !== "ready") return json(res, 409, { error: "请先完成所有素材的分析" });
    if (["planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在制作，请等待当前任务完成" });
    if (!configState().anthropic) return json(res, 409, { error: "未配置 ANTHROPIC_API_KEY，无法生成剪辑方案" });
    project.status = "planning";
    project.error = null;
    await save(project);
    publish(project.id, { type: "stage", status: project.status, message: "Claude 正在依据方案、逐素材转录和真实素材信息编排故事线" });
    try {
      const body = await readJson(req);
      project.assetInventory = buildAssetInventory(project);
      const previousPlan = project.multiAssetPlan;
      const nextPlan = await planMultiAssetWithClaude({ project, editRequest: body.request });
      const planFiles = await fs.readdir(project.dir);
      const storedVersions = planFiles.map((name) => Number(name.match(/^multi-plan-v(\d+)\.json$/)?.[1] || 0));
      nextPlan.version = Math.max(nextPlan.version, 1 + Math.max(0, ...storedVersions));
      const planPath = join(project.dir, `multi-plan-v${nextPlan.version}.json`);
      await fs.writeFile(planPath, JSON.stringify(nextPlan, null, 2), { flag: "wx" });
      if (previousPlan && !project.multiAssetPlanHistory?.some((item) => Number(item.version) === Number(previousPlan.version))) project.multiAssetPlanHistory = [...(project.multiAssetPlanHistory || []), previousPlan];
      project.multiAssetPlan = nextPlan;
      project.multiAssetPreview = null;
      project.plan = null;
      project.qc = null;
      project.status = "plan_ready";
      await save(project);
      publish(project.id, { type: "stage", status: project.status, message: "方案已生成，请检查故事顺序和素材来源后确认" });
      return json(res, 200, projectView(project));
    } catch (error) {
      project.status = "needs_input";
      project.error = error.message;
      await save(project);
      publish(project.id, { type: "needs_input", status: project.status, message: error.message });
      return json(res, 502, { error: error.message, status: project.status, project: projectView(project) });
    }
  }
  if (req.method === "POST" && segments[3] === "plan" && segments[4] === "confirm") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "多素材方案仅适用于多素材项目" });
    if (["planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在制作，请等待本轮完成后确认方案" });
    try {
      const body = await readJson(req);
      const confirmed = confirmMultiAssetPlan(project, body);
      Object.assign(project, confirmed);
      project.qc = null;
      await save(project);
      publish(project.id, { type: "plan_confirmed", status: project.status, message: "方案已确认，可以生成横屏和竖屏成片" });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
  }
  if (req.method === "POST" && segments[3] === "plan" && segments[4] === "restore") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "多素材方案仅适用于多素材项目" });
    if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理，请等待本轮完成后恢复方案" });
    try {
      const body = await readJson(req);
      const restored = restoreMultiAssetPlan(project, body);
      Object.assign(project, restored);
      await save(project);
      publish(project.id, { type: "plan_restored", status: project.status, message: `已恢复历史方案 v${body.version}，请重新检查并确认` });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
  }
  if (req.method === "POST" && segments[3] === "preview" && segments.length === 4) {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "多素材预览仅适用于多素材项目" });
    if (!project.multiAssetPlan?.confirmed) return json(res, 409, { error: "请先检查并确认剪辑方案" });
    if (["planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在制作，请等待当前任务完成" });
    project.status = "rendering_preview";
    project.error = null;
    await save(project);
    publish(project.id, { type: "stage", status: project.status, message: "正在生成横屏和竖屏低分辨率预览" });
    try {
      const result = await renderMultiAssetProject(project, { preview: true });
      project.artifacts = [...(project.artifacts || []), ...result.artifacts];
      project.multiAssetPreview = { planVersion: project.multiAssetPlan.version, inputRevision: Number(project.multiAssetRevision || 0), qc: result.qc, profiles: result.profiles, generatedAt: new Date().toISOString() };
      project.multiAssetPreviewReview = null;
      project.status = "preview_ready";
      await save(project);
      publish(project.id, { type: "stage", status: project.status, message: "横竖屏预览已生成，请播放检查后再导出" });
      return json(res, 200, projectView(project));
    } catch (error) {
      project.status = "failed";
      project.error = error.message;
      await save(project);
      publish(project.id, { type: "failed", status: project.status, message: error.message });
      return json(res, 502, { error: error.message, status: project.status, project: projectView(project) });
    }
  }
  if (req.method === "POST" && segments[3] === "preview" && segments[4] === "reviewed") {
    if (project.workflowMode !== "multi-asset-v1") return json(res, 409, { error: "多素材预览审阅仅适用于多素材项目" });
    if (!project.multiAssetPreview?.qc?.passed || Number(project.multiAssetPreview.planVersion) !== Number(project.multiAssetPlan?.version) || Number(project.multiAssetPreview.inputRevision) !== Number(project.multiAssetRevision || 0)) return json(res, 409, { error: "当前方案和素材配置还没有通过 QC 的预览" });
    try {
      const body = await readJson(req);
      if (["planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理，暂时不能修改预览检查状态" });
      if (Number(body.planVersion) !== Number(project.multiAssetPlan.version) || Number(project.multiAssetPreview.inputRevision) !== Number(project.multiAssetRevision || 0)) return json(res, 409, { error: "方案或素材配置已更新，请检查最新预览" });
      const valid = new Set(project.multiAssetPreview.profiles.map((profile) => profile.id));
      const profiles = [...new Set((Array.isArray(body.profiles) ? body.profiles : []).map(String))];
      if (profiles.some((profile) => !valid.has(profile))) return json(res, 400, { error: "预览画幅无效" });
      project.multiAssetPreviewReview = { planVersion: project.multiAssetPlan.version, inputRevision: Number(project.multiAssetRevision || 0), profiles, reviewedAt: new Date().toISOString() };
      await save(project);
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === "POST" && segments[3] === "broll" && segments[4] === "search") {
    if (project.workflowMode === "multi-asset-v1") return json(res, 409, { error: "多素材项目请先把 B-roll 上传到素材库，并将角色设为 B-roll" });
    try {
      const providers = brollProviderState();
      if (!providers.pexels && !providers.pixabay) return json(res, 503, { error: "尚未配置 PEXELS_API_KEY 或 PIXABAY_API_KEY", providers });
      if (!allowBrollSearch(req)) return json(res, 429, { error: "当前 IP 的 B-roll 搜索已达到每小时 20 次限制，请稍后重试" });
      const body = await readJson(req);
      const text = String(body.text || project.transcript?.text || project.goal || "");
      const result = await searchOnlineBroll({ text, orientation: body.orientation || "landscape", cachePath: join(root, "storage", ".broll-search-cache.json") });
      return json(res, 200, result);
    } catch (error) {
      const status = error.statusCode || (/未配置/.test(error.message) ? 503 : /请提供/.test(error.message) ? 400 : 502);
      return json(res, status, { error: error.message, providers: brollProviderState() });
    }
  }
  if (req.method === "POST" && segments[3] === "music") {
    const limit = 50 * 1024 * 1024;
    if (Number(req.headers["content-length"] || 0) > limit) return json(res, 413, { error: "音乐文件不能超过 50MB" });
    const match = String(req.headers["content-type"] || "").match(/boundary=([^;]+)/i);
    if (!match) return json(res, 415, { error: "multipart/form-data is required" });
    const filename = decodeURIComponent(String(req.headers["x-music-filename"] || "music.mp3"));
    const extension = extname(filename).toLowerCase();
    if (![".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"].includes(extension)) return json(res, 415, { error: "支持 MP3、WAV、M4A、AAC、OGG 或 FLAC 音频" });
    if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理，请稍后再上传音乐" });
    const target = join(project.dir, `music-${randomUUID()}${extension}`);
    try {
      const upload = await parseMultipart(req, match[1].replace(/^"|"$/g, ""), target, limit);
      if (!upload.licenseConfirmed) throw new Error("请先确认你拥有该音乐的使用许可");
      const metadata = await probeMedia(target);
      if (!metadata.hasAudio || metadata.hasVideo) throw new Error("请上传纯音频文件作为配乐");
      if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，请稍后修改配乐"), { statusCode: 409 });
      const musicSha256 = await sha256File(target);
      if (["analyzing_assets", "planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) throw Object.assign(new Error("项目正在处理，请稍后修改配乐"), { statusCode: 409 });
      project.music = { filename: upload.filename, path: target, licenseConfirmed: true, sha256: musicSha256 };
      project.qc = null;
      if (project.workflowMode === "multi-asset-v1") {
        project.multiAssetRevision = Number(project.multiAssetRevision || 0) + 1;
        project.multiAssetPreview = null;
        project.multiAssetPreviewReview = null;
        if (project.multiAssetPlan?.confirmed) project.status = "plan_confirmed";
      } else project.status = project.plan ? "plan_ready" : project.status;
      project.error = null;
      await save(project);
      publish(project.id, { type: "music", status: project.status, message: "已添加授权配乐" });
      return json(res, 200, projectView(project));
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      return json(res, error.statusCode || 400, { error: error.message });
    }
  }
  if (req.method === "POST" && segments[3] === "broll") {
    if (project.workflowMode === "multi-asset-v1") return json(res, 409, { error: "多素材项目请把 B-roll 作为视频素材上传到素材库" });
    const limit = 100 * 1024 * 1024;
    if (Number(req.headers["content-length"] || 0) > limit) return json(res, 413, { error: "B-roll 视频不能超过 100MB" });
    const match = String(req.headers["content-type"] || "").match(/boundary=([^;]+)/i);
    if (!match) return json(res, 415, { error: "multipart/form-data is required" });
    const filename = decodeURIComponent(String(req.headers["x-broll-filename"] || "broll.mp4"));
    const extension = extname(filename).toLowerCase();
    if (![".mp4", ".mov", ".m4v", ".webm"].includes(extension)) return json(res, 415, { error: "B-roll 支持 MP4、MOV、M4V 或 WebM 视频" });
    if (["rendering", "rendering_preview"].includes(project.status)) return json(res, 409, { error: "项目正在渲染，请稍后再上传 B-roll" });
    const target = join(project.dir, `broll-${randomUUID()}${extension}`);
    try {
      const upload = await parseMultipart(req, match[1].replace(/^"|"$/g, ""), target, limit);
      if (!upload.licenseConfirmed) throw new Error("请先确认你拥有该 B-roll 素材的使用许可");
      const metadata = await probeMedia(target);
      if (!metadata.hasVideo || metadata.durationMs <= 0) throw new Error("请上传包含有效画面的 B-roll 视频");
      const asset = { id: randomUUID(), filename: upload.filename, path: target, durationMs: metadata.durationMs, width: metadata.width, height: metadata.height, licenseConfirmed: true };
      project.brollAssets = [...(project.brollAssets || []), asset];
      project.plan = null;
      project.qc = null;
      if (project.transcript) project.status = "transcript_ready";
      project.error = null;
      await save(project);
      publish(project.id, { type: "broll", status: project.status, message: "B-roll 素材已保存，重新生成剪辑计划后可供 Claude 选用" });
      return json(res, 201, projectView(project));
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      return json(res, error.statusCode || 400, { error: error.message });
    }
  }
  if (req.method === "GET" && segments[3] === "events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const list = subscribers.get(project.id) || []; list.push(res); subscribers.set(project.id, list); res.write(`data: ${JSON.stringify({ type: "snapshot", project: projectView(project) })}\n\n`);
    req.on("close", () => subscribers.set(project.id, (subscribers.get(project.id) || []).filter((item) => item !== res))); return;
  }
  if (req.method === "GET" && segments[3] === "artifacts" && segments[4]) {
    const name = decodeURIComponent(segments.slice(4).join("/")); const path = store.artifactPath(project, name);
    if (!path) return json(res, 400, { error: "invalid artifact path" });
    if (!(project.artifacts || []).some((artifact) => artifact.name === name)) return json(res, 404, { error: "artifact not found" });
    const contentType = name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".webm") ? "video/webm" : name.endsWith(".srt") ? "application/x-subrip" : name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".js") ? "application/javascript" : "application/json";
    try { return serveFile(req, res, path, contentType, `attachment; filename="${name.replaceAll('"', "")}"`); } catch { return json(res, 404, { error: "artifact not found" }); }
  }
  if (req.method === "POST" && segments[3] === "replan") {
    if (!project.media || !project.transcript) return json(res, 409, { error: "重新生成视觉计划需要已上传素材和转录结果", status: project.status });
    if (["planning", "rendering"].includes(project.status)) return json(res, 409, { error: "当前项目正在处理中，请稍后再试", status: project.status });
    if (!configState().anthropic) return json(res, 409, { error: "未配置 Claude 服务，无法重新生成视觉计划", status: project.status });
    try {
      await transitionToPlan(project);
      return json(res, 200, projectView(project));
    } catch (error) {
      return json(res, error.statusCode || 502, { error: error.message, status: project.status, project: projectView(project) });
    }
  }
  if (req.method === "POST" && segments[3] === "render" && segments[4] === "remotion-preview") {
    if (!engineAvailability.remotion.enabled) return json(res, 503, { error: "Remotion runtime 尚未安装", engine: engineAvailability.remotion });
    if (!project.media?.path || !project.plan) return json(res, 409, { error: "Remotion 对照预览需要已上传媒体和剪辑计划", status: project.status });
    if (["planning", "rendering", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在编辑或导出，请等待当前任务完成", status: project.status });
    const timeline = toTimelineV1(project);
    const version = Math.max(1, Number(project.editor?.version) || 1);
    const runId = randomUUID();
    const workDir = join(project.dir, "render-work", `remotion-${runId}`);
    const overlayPath = join(workDir, "overlay.mov");
    const previewPath = join(workDir, "preview.mp4");
    try {
      const overlay = await renderRemotionOverlay({ timeline, outputPath: overlayPath, workDir });
      const preview = await compositeRemotionPreview({ inputPath: project.media.path, overlayPath, outputPath: previewPath });
      const probe = await probeOutput(previewPath);
      const blackFrames = await detectBlackFrames(previewPath);
      const qcPassed = overlay.alpha && probe.width === project.media.width && probe.height === project.media.height && probe.avSyncDeltaMs !== null && probe.avSyncDeltaMs <= 250 && probe.avDurationDeltaMs !== null && probe.avDurationDeltaMs <= 250 && blackFrames.length === 0;
      if (!qcPassed) throw new Error("Remotion 对照预览未通过尺寸、alpha、音视频同步或黑帧检查");

      const artifactsDir = join(project.dir, "artifacts");
      await fs.mkdir(artifactsDir, { recursive: true });
      const prefix = `remotion-v${version}-${runId}`;
      const names = { timeline: `${prefix}-timeline.json`, overlay: `${prefix}-overlay.mov`, preview: `${prefix}-preview.mp4`, manifest: `${prefix}-manifest.json`, log: `${prefix}-render-log.json` };
      const timelineText = `${JSON.stringify(timeline, null, 2)}\n`;
      const sourceMediaSha256 = await sha256File(project.media.path);
      const timelineSha256 = createHash("sha256").update(timelineText).digest("hex");
      const checks = ["prores-alpha", "dimensions", "audio-video-sync", "black-frames"];
      const log = {
        engine: "remotion",
        engineVersion: overlay.remotionVersion,
        renderer: "@remotion/renderer.renderMedia",
        timelineContract: timeline.contract,
        timelineSha256,
        sourceMediaSha256,
        outputSha256: { overlay: overlay.sha256, preview: preview.sha256 },
        parameters: { width: overlay.width, height: overlay.height, durationMs: overlay.durationMs, fps: 30, eventCount: timeline.visualEvents.length },
        qc: { passed: qcPassed, checks, audioVideoSyncDeltaMs: probe.avSyncDeltaMs, audioVideoDurationDeltaMs: probe.avDurationDeltaMs, blackFrameCount: blackFrames.length },
        completedAt: new Date().toISOString(),
      };
      const logText = `${JSON.stringify(log, null, 2)}\n`;
      await fs.writeFile(join(artifactsDir, names.timeline), timelineText, { flag: "wx" });
      await fs.copyFile(overlayPath, join(artifactsDir, names.overlay), fsConstants.COPYFILE_EXCL);
      await fs.copyFile(previewPath, join(artifactsDir, names.preview), fsConstants.COPYFILE_EXCL);
      await fs.writeFile(join(artifactsDir, names.log), logText, { flag: "wx" });
      const manifest = createRenderManifest({
        timeline,
        engine: "remotion",
        engineVersion: overlay.remotionVersion,
        status: "completed",
        inputs: { timelineSha256, sourceMediaSha256 },
        artifacts: [
          { name: names.timeline, kind: "timeline", version, sha256: timelineSha256 },
          { name: names.overlay, kind: "overlay", version, width: overlay.width, height: overlay.height, durationMs: overlay.durationMs, sha256: overlay.sha256 },
          { name: names.preview, kind: "preview", version, width: preview.width, height: preview.height, durationMs: preview.durationMs, sha256: preview.sha256 },
          { name: names.log, kind: "render-log", version, sha256: createHash("sha256").update(logText).digest("hex") },
        ],
        qc: { passed: qcPassed, checks },
      });
      await fs.writeFile(join(artifactsDir, names.manifest), JSON.stringify(manifest, null, 2), { flag: "wx" });
      project.artifacts = [...(project.artifacts || []),
        { name: names.timeline, kind: "timeline", engine: "remotion", version },
        { name: names.overlay, kind: "overlay", engine: "remotion", version, width: overlay.width, height: overlay.height, durationMs: overlay.durationMs },
        { name: names.preview, kind: "remotion-preview", engine: "remotion", version, width: preview.width, height: preview.height, durationMs: preview.durationMs },
        { name: names.log, kind: "render-log", engine: "remotion", version, sha256: createHash("sha256").update(logText).digest("hex") },
        { name: names.manifest, kind: "render-manifest", engine: "remotion", version },
      ];
      project.remotionPreview = { engine: "remotion", version, checkedAt: new Date().toISOString(), qc: manifest.qc };
      project.error = null;
      await save(project);
      return json(res, 200, projectView(project));
    } catch (error) {
      return json(res, 502, { error: error.message, engine: "remotion", project: projectView(project) });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (req.method === "POST" && segments[3] === "input") {
    if (project.workflowMode === "multi-asset-v1") return json(res, 409, { error: "多素材项目请通过素材库上传视频" });
    if (segments[4] === "chunk") {
      try {
        const result = await writeUploadChunk(req, project);
        return json(res, 200, { ...result, status: project.status });
      } catch (error) {
        if (error.requestAborted || req.aborted) return;
        return json(res, error.statusCode || 400, { error: error.message, receivedBytes: error.receivedBytes ?? project.upload?.receivedBytes ?? 0 });
      }
    }
    if (segments[4] === "complete") {
      try { return json(res, 201, projectView(await completeChunkedUpload(project))); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message, receivedBytes: error.receivedBytes ?? project.upload?.receivedBytes ?? 0 }); }
    }
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > 500 * 1024 * 1024) return json(res, 413, { error: "视频文件不能超过 500MB" });
    const match = String(req.headers["content-type"] || "").match(/boundary=([^;]+)/i); if (!match) return json(res, 415, { error: "multipart/form-data is required" });
    try { const path = join(project.dir, "input.mp4"); const upload = await parseMultipart(req, match[1].replace(/^"|"$/g, ""), path); const metadata = await probeMedia(path); project.media = { filename: upload.filename, path, ...metadata }; project.goal = upload.goal || project.goal; project.style = upload.style || project.style; project.status = "inspecting"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "已读取真实媒体信息" }); return json(res, 201, projectView(project)); } catch (error) { if (error.message === "aborted" || req.aborted || req.destroyed) { project.error = "上传连接中断，请重试"; await save(project); return; } project.status = "failed"; project.error = error.message; await save(project); return json(res, 400, { error: error.message, status: project.status }); }
  }
  if (req.method === "POST" && segments[3] === "advance") {
    if (project.workflowMode === "multi-asset-v1") return json(res, 409, { error: "多素材项目请使用素材分析、方案和预览专用流程" });
    try {
      if (["planning", "rendering"].includes(project.status)) throw Object.assign(new Error("Claude Code 正在处理中，请等待本轮完成"), { statusCode: 409 });
      if (project.status === "inspecting" || project.status === "transcribing" || (project.status === "needs_input" && !project.transcript) || (project.status === "failed" && project.media && !project.transcript)) await transitionToTranscript(project);
      else if (project.status === "failed" && project.plan) { project.status = "preview_ready"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "保留现有计划，可重新渲染" }); }
      else if (project.status === "transcript_ready" || (project.status === "needs_input" && project.transcript && !project.plan) || (project.status === "failed" && project.transcript && !project.plan)) await transitionToPlan(project);
      else if (project.status === "plan_ready" || project.status === "awaiting_review") { project.status = "preview_ready"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "计划已确认，可预览并批注" }); }
      else if (project.status === "awaiting_revision") await transitionToPlan(project);
      else throw Object.assign(new Error(`当前状态不可推进：${project.status}`), { statusCode: 409 });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, error.statusCode || 502, { error: error.message, status: project.status, config: configState() }); }
  }
  if (req.method === "POST" && segments[3] === "comments") {
    if (project.workflowMode === "multi-asset-v1") return json(res, 409, { error: "多素材项目请在方案审核区直接修改故事顺序或镜头来源" });
    if (["transcribing", "planning", "rendering", "chat_editing"].includes(project.status)) return json(res, 409, { error: "项目正在处理中，暂时不能添加批注" });
    try { const body = await readJson(req); const text = String(body.text || "").trim(); if (!text) throw new Error("批注内容不能为空"); project.comments = [...(project.comments || []), { id: randomUUID(), timeMs: Math.max(0, Number(body.timeMs) || 0), text, createdAt: new Date().toISOString() }]; project.status = "awaiting_revision"; await save(project); publish(project.id, { type: "comment", comment: project.comments.at(-1), status: project.status }); return json(res, 201, projectView(project)); } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === "GET" && segments[3] === "chat") {
    return json(res, 200, projectView({ ...project, editSession: ensureEditSession(project) }));
  }
  if (req.method === "POST" && segments[3] === "chat" && segments[4] === "messages") {
    if (!project.media || !project.transcript || !project.editor?.runId || !project.plan) return json(res, 409, { error: "请先完成一次 Claude Code 剪辑并生成可编辑版本", status: project.status });
    if (["planning", "rendering", "chat_editing"].includes(project.status)) return json(res, 409, { error: "当前已有编辑任务正在执行，请稍后再试", status: project.status });
    if (!configState().anthropic || !editorRuntime.available) return json(res, 409, { error: "Claude Code 服务当前不可用", status: project.status });
    try {
      const body = await readJson(req);
      const session = ensureEditSession(project);
      const appended = appendEditTurn(session, { text: body.text, timeMs: body.timeMs, rangeEndMs: body.rangeEndMs, baseVersion: body.baseVersion ?? session.latestVersion });
      project.editSession = appended.session;
      project.status = "chat_editing";
      project.error = null;
      await save(project);
      publish(project.id, { type: "chat_started", status: project.status, message: `正在基于 v${appended.turn.baseVersion} 生成 v${appended.turn.resultVersion}` });
      void runChatEdit(project, appended.turn);
      return json(res, 202, projectView(project));
    } catch (error) { return json(res, error.statusCode || 400, { error: error.message, status: project.status }); }
  }
  if (req.method === "POST" && segments[3] === "render") {
    if (project.workflowMode === "multi-asset-v1") {
      if (!project.multiAssetPlan?.confirmed) return json(res, 409, { error: "请先检查并确认多素材剪辑方案", status: project.status });
      if (!project.multiAssetPreview?.qc?.passed || Number(project.multiAssetPreview.planVersion) !== Number(project.multiAssetPlan.version) || Number(project.multiAssetPreview.inputRevision) !== Number(project.multiAssetRevision || 0)) return json(res, 409, { error: "请先生成并检查当前方案和素材配置的横竖屏预览", status: project.status });
      const expectedReviewedProfiles = project.multiAssetPreview.profiles.map((profile) => profile.id).sort();
      const reviewedProfiles = project.multiAssetPreviewReview?.planVersion === project.multiAssetPlan.version && Number(project.multiAssetPreviewReview.inputRevision) === Number(project.multiAssetRevision || 0) ? [...new Set(project.multiAssetPreviewReview.profiles || [])].sort() : [];
      if (JSON.stringify(reviewedProfiles) !== JSON.stringify(expectedReviewedProfiles)) return json(res, 409, { error: "请逐个播放检查当前方案的所有横竖屏预览后，再导出正式成片", status: project.status });
      if (["planning", "rendering", "rendering_preview", "chat_editing"].includes(project.status)) return json(res, 409, { error: "当前已有制作任务，请等待本轮完成后再导出" });
      project.status = "rendering";
      project.error = null;
      await save(project);
      publish(project.id, { type: "stage", status: project.status, message: "正在以正式分辨率渲染横屏和竖屏成片并执行 QC" });
      try {
        const result = await renderMultiAssetProject(project);
        project.artifacts = [...(project.artifacts || []), ...result.artifacts];
        project.qc = result.qc;
        project.editor = { engine: "wayne-multi-asset", model: "claude-plan + ffmpeg-render", version: result.qc.version, phase: "multi-asset-render" };
        project.status = "completed";
        await save(project);
        publish(project.id, { type: "stage", status: project.status, message: "横屏和竖屏成片已生成并通过 QC，请观看验收" });
        return json(res, 200, projectView(project));
      } catch (error) {
        project.status = "failed";
        project.error = error.message;
        await save(project);
        publish(project.id, { type: "failed", status: project.status, message: error.message });
        return json(res, 502, { error: error.message, status: project.status, project: projectView(project) });
      }
    }
    if (!project.plan) return json(res, 409, { error: "请先生成并确认剪辑计划", status: project.status });
    if (["planning", "rendering", "chat_editing"].includes(project.status) || project.editSession?.status === "running") return json(res, 409, { error: "当前已有制作任务，请等待本轮完成后再导出" });
    if (["needs_review", "manual_review_required"].includes(project.proofreading?.status)) return json(res, 409, { error: "字幕仍有待确认内容，请先完成字幕校对", status: project.status });
    if (project.proofreading?.previewStale || (project.proofreading?.previewTranscriptSha256 && project.proofreading.previewTranscriptSha256 !== transcriptFingerprint(project.transcript))) return json(res, 409, { error: "字幕已修改，预览字幕尚未更新；请先在对话中让 Claude 重新生成预览", status: project.status });
    if (project.editor?.engine !== "claude-code" || !project.editor.runId) return json(res, 409, { error: "这是旧版模板计划，请先重新生成 Claude Code 工程和预览", status: project.status });
    project.status = "rendering"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude Code / Opus 5.5 正在执行工程、审片并修正" });
    try { const result = await editWithClaudeCode(project, "render", editorProgress(project)); project.plan = result.plan; project.brollAssets = [...(project.brollAssets || []), ...(result.brollAssets || [])]; project.editor = result.editor; project.artifacts = [...(project.artifacts || []), ...result.artifacts]; project.qc = result.qc; project.status = "completed"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude Code 已导出并抽帧审阅，请观看成片验收" }); return json(res, 200, projectView(project)); } catch (error) { project.status = "failed"; project.error = error.message; await save(project); publish(project.id, { type: "failed", status: project.status, message: error.message }); return json(res, 502, { error: error.message, status: project.status }); }
  }
  return json(res, 404, { error: "route not found" });
}

createServer((req, res) => { handle(req, res).catch((error) => { if (!req.aborted && !res.writableEnded) json(res, error.statusCode || 500, { error: error.message }); }); }).listen(Number(process.env.PORT || 18787), process.env.HOST || "127.0.0.1", () => console.log(`Wayne portal API listening on http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 18787}`));
