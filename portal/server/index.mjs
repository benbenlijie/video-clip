import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerState, transcribeVideo } from "./transcription.mjs";
import { createProjectStore } from "./project-store.mjs";
import { writeTranscriptArtifacts } from "./edit-plan.mjs";
import { editWithClaudeCode, editorState } from "./claude-code-editor.mjs";
import { brollProviderState, searchOnlineBroll } from "./broll-search.mjs";
import { appendEditTurn, buildChatContext, completeEditTurn, createEditSession, failEditTurn } from "./edit-chat.mjs";

try {
  if (process.env.WAYNE_IGNORE_DOTENV === "1") throw new Error("portal .env disabled for isolated verification");
  const envText = await fs.readFile(new URL("../.env", import.meta.url), "utf8");
  const portalKeys = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "LLM_ANTHROPIC_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY", "TRANSCRIPTION_PROVIDER", "VOLCENGINE_ASR_MODE", "VOLCENGINE_ASR_API_KEY", "VOLCENGINE_ASR_RESOURCE_ID", "VOLCENGINE_ASR_BASE_URL", "VOLCENGINE_ASR_MODEL", "VOLCENGINE_ASR_PUBLIC_BASE_URL", "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_ASR_CLUSTER", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENTCLOUD_REGION", "TENCENTCLOUD_ASR_ENDPOINT", "TENCENTCLOUD_ASR_ENGINE_MODEL_TYPE"]);
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && portalKeys.has(match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* .env is optional. */ }

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const store = createProjectStore(resolve(process.env.WAYNE_STORAGE_DIR || join(root, "storage")));
const subscribers = new Map();
const brollSearchRequests = new Map();
const editorRuntime = editorState();
await store.loadProjects();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function configState() {
  const transcription = providerState();
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY);
  const allConfigured = anthropic && transcription.any && editorRuntime.available;
  return {
    anthropic,
    editor: editorRuntime,
    transcription: transcription.any,
    transcriptionProvider: transcription.provider,
    volcengine: transcription.volcengine,
    tencent: transcription.tencent,
    ffmpeg: true,
    brollProviders: brollProviderState(),
    mode: allConfigured ? "configured" : anthropic || transcription.any ? "partial" : "demo",
  };
}

function projectView(project) {
  const media = project.media ? { ...project.media, path: undefined } : project.media;
  const music = project.music ? { ...project.music, path: undefined } : project.music;
  const brollAssets = (project.brollAssets || []).map((asset) => ({ ...asset, path: undefined }));
  return {
    ...project,
    dir: undefined,
    media,
    music,
    brollAssets,
    config: configState(),
    artifacts: (project.artifacts || []).map((artifact) => ({ ...artifact, url: `/api/projects/${project.id}/artifacts/${encodeURIComponent(artifact.name)}` })),
  };
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
    media: project.media ? { filename: project.media.filename, durationMs: project.media.durationMs, width: project.media.width, height: project.media.height } : null,
    latestVersion,
    hasTranscript: Boolean(project.transcript),
    hasPlan: Boolean(project.plan),
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
  for (const response of subscribers.get(projectId) || []) response.write(`data: ${JSON.stringify(payload)}\n\n`);
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
  const project = { id, workflowId: "wayne-video-editing", status: "created", goal: body.goal || "", style: body.style || "Wayne / clean creator", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dir: store.projectDir(id), artifacts: [], comments: [], brollAssets: [], media: null, transcript: null, plan: null, qc: null, error: null, upload: null, editSession: null };
  await save(project);
  return project;
}

async function transitionToTranscript(project) {
  if (!project.media) throw new Error("请先上传视频");
  if (!configState().transcription) { project.status = "needs_input"; project.error = "未配置火山引擎或腾讯云转录凭证"; await save(project); throw Object.assign(new Error(project.error), { statusCode: 409, status: project.status }); }
  project.status = "transcribing"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "正在调用转录服务" });
  try {
    const result = await transcribeVideo({ videoPath: project.media.path, projectDir: project.dir, projectId: project.id });
    project.transcript = { provider: result.provider, requestId: result.requestId, ...result.transcript };
    await writeTranscriptArtifacts(project, project.transcript);
    project.status = "transcript_ready"; await save(project); publish(project.id, { type: "stage", status: project.status, message: `转录完成（${result.provider}）` });
  } catch (error) { project.status = "failed"; project.error = error.message; await save(project); publish(project.id, { type: "failed", status: project.status, message: error.message }); throw error; }
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
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const projects = [...store.projects.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit).map(projectSummary);
    return json(res, 200, { projects });
  }
  if (req.method === "POST" && url.pathname === "/api/projects") { try { return json(res, 201, projectView(await createProject(await readJson(req)))); } catch (error) { return json(res, 400, { error: error.message }); } }

  if (req.method === "GET" && segments[0] === "media" && segments[1] && ["input.mp4", "transcript-audio.wav"].includes(segments[2])) {
    const project = store.get(segments[1]); const target = project && join(project.dir, segments[2]);
    try { return serveFile(req, res, target, segments[2].endsWith("wav") ? "audio/wav" : "video/mp4"); } catch { return json(res, 404, { error: "media not found" }); }
  }

  const project = segments[0] === "api" && segments[1] === "projects" ? store.get(segments[2]) : null;
  if (!project) return json(res, 404, { error: "project not found" });
  if (req.method === "GET" && segments.length === 3) return json(res, 200, projectView(project));
  if (req.method === "POST" && segments[3] === "broll" && segments[4] === "search") {
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
    if (project.status === "rendering") return json(res, 409, { error: "项目正在渲染，请稍后再上传音乐" });
    const target = join(project.dir, `music-${randomUUID()}${extension}`);
    try {
      const upload = await parseMultipart(req, match[1].replace(/^"|"$/g, ""), target, limit);
      if (!upload.licenseConfirmed) throw new Error("请先确认你拥有该音乐的使用许可");
      const metadata = await probeMedia(target);
      if (!metadata.hasAudio || metadata.hasVideo) throw new Error("请上传纯音频文件作为配乐");
      project.music = { filename: upload.filename, path: target, licenseConfirmed: true };
      project.qc = null;
      project.status = project.plan ? "plan_ready" : project.status;
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
    const limit = 100 * 1024 * 1024;
    if (Number(req.headers["content-length"] || 0) > limit) return json(res, 413, { error: "B-roll 视频不能超过 100MB" });
    const match = String(req.headers["content-type"] || "").match(/boundary=([^;]+)/i);
    if (!match) return json(res, 415, { error: "multipart/form-data is required" });
    const filename = decodeURIComponent(String(req.headers["x-broll-filename"] || "broll.mp4"));
    const extension = extname(filename).toLowerCase();
    if (![".mp4", ".mov", ".m4v", ".webm"].includes(extension)) return json(res, 415, { error: "B-roll 支持 MP4、MOV、M4V 或 WebM 视频" });
    if (project.status === "rendering") return json(res, 409, { error: "项目正在渲染，请稍后再上传 B-roll" });
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
  if (req.method === "POST" && segments[3] === "input") {
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
    try {
      if (["planning", "rendering"].includes(project.status)) throw Object.assign(new Error("Claude Code 正在处理中，请等待本轮完成"), { statusCode: 409 });
      if (project.status === "inspecting" || (project.status === "needs_input" && !project.transcript) || (project.status === "failed" && project.media && !project.transcript)) await transitionToTranscript(project);
      else if (project.status === "failed" && project.plan) { project.status = "preview_ready"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "保留现有计划，可重新渲染" }); }
      else if (project.status === "transcript_ready" || (project.status === "needs_input" && project.transcript && !project.plan) || (project.status === "failed" && project.transcript && !project.plan)) await transitionToPlan(project);
      else if (project.status === "plan_ready" || project.status === "awaiting_review") { project.status = "preview_ready"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "计划已确认，可预览并批注" }); }
      else if (project.status === "awaiting_revision") await transitionToPlan(project);
      else throw Object.assign(new Error(`当前状态不可推进：${project.status}`), { statusCode: 409 });
      return json(res, 200, projectView(project));
    } catch (error) { return json(res, error.statusCode || 502, { error: error.message, status: project.status, config: configState() }); }
  }
  if (req.method === "POST" && segments[3] === "comments") {
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
      const appended = appendEditTurn(session, { text: body.text, timeMs: body.timeMs, rangeEndMs: body.rangeEndMs, baseVersion: session.latestVersion });
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
    if (!project.plan) return json(res, 409, { error: "请先生成并确认剪辑计划", status: project.status });
    if (["planning", "rendering"].includes(project.status)) return json(res, 409, { error: "Claude Code 正在处理中，请等待本轮完成" });
    if (project.editor?.engine !== "claude-code" || !project.editor.runId) return json(res, 409, { error: "这是旧版模板计划，请先重新生成 Claude Code 工程和预览", status: project.status });
    project.status = "rendering"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude Code / Opus 5.5 正在执行工程、审片并修正" });
    try { const result = await editWithClaudeCode(project, "render", editorProgress(project)); project.plan = result.plan; project.brollAssets = [...(project.brollAssets || []), ...(result.brollAssets || [])]; project.editor = result.editor; project.artifacts = [...(project.artifacts || []), ...result.artifacts]; project.qc = result.qc; project.status = "completed"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude Code 已导出并抽帧审阅，请观看成片验收" }); return json(res, 200, projectView(project)); } catch (error) { project.status = "failed"; project.error = error.message; await save(project); publish(project.id, { type: "failed", status: project.status, message: error.message }); return json(res, 502, { error: error.message, status: project.status }); }
  }
  return json(res, 404, { error: "route not found" });
}

createServer((req, res) => { handle(req, res).catch((error) => { if (!req.aborted && !res.writableEnded) json(res, error.statusCode || 500, { error: error.message }); }); }).listen(Number(process.env.PORT || 18787), process.env.HOST || "127.0.0.1", () => console.log(`Wayne portal API listening on http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 18787}`));
