import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerState, transcribeVideo } from "./transcription.mjs";
import { createProjectStore } from "./project-store.mjs";
import { planWithClaude, validateEditPlan, writeTranscriptArtifacts } from "./edit-plan.mjs";
import { renderProject } from "./render.mjs";

try {
  const envText = await fs.readFile(new URL("../.env", import.meta.url), "utf8");
  const portalKeys = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "LLM_ANTHROPIC_API_KEY", "TRANSCRIPTION_PROVIDER", "VOLCENGINE_ASR_MODE", "VOLCENGINE_ASR_API_KEY", "VOLCENGINE_ASR_RESOURCE_ID", "VOLCENGINE_ASR_BASE_URL", "VOLCENGINE_ASR_MODEL", "VOLCENGINE_ASR_PUBLIC_BASE_URL", "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_ASR_CLUSTER", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENTCLOUD_REGION", "TENCENTCLOUD_ASR_ENDPOINT", "TENCENTCLOUD_ASR_ENGINE_MODEL_TYPE"]);
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && portalKeys.has(match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* .env is optional. */ }

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const store = createProjectStore(join(root, "storage"));
const subscribers = new Map();
await store.loadProjects();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function configState() {
  const transcription = providerState();
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY);
  const allConfigured = anthropic && transcription.any;
  return {
    anthropic,
    transcription: transcription.any,
    transcriptionProvider: transcription.provider,
    volcengine: transcription.volcengine,
    tencent: transcription.tencent,
    ffmpeg: true,
    mode: allConfigured ? "configured" : anthropic || transcription.any ? "partial" : "demo",
  };
}

function projectView(project) {
  const media = project.media ? { ...project.media, path: undefined } : project.media;
  return {
    ...project,
    dir: undefined,
    media,
    config: configState(),
    artifacts: (project.artifacts || []).map((artifact) => ({ ...artifact, url: `/api/projects/${project.id}/artifacts/${encodeURIComponent(artifact.name)}` })),
  };
}

function headerNumber(req, name) {
  const value = Number(req.headers[name]);
  return Number.isSafeInteger(value) ? value : NaN;
}

async function writeUploadChunk(req, project) {
  const offset = headerNumber(req, "x-upload-offset");
  const totalBytes = headerNumber(req, "x-upload-total");
  const length = headerNumber(req, "x-upload-length");
  const filename = String(req.headers["x-upload-filename"] || "upload.mp4");
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

function parseMultipart(req, boundary, destination) {
  return new Promise((resolveUpload, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 500 * 1024 * 1024) { reject(new Error("视频文件不能超过 500MB")); req.destroy(); return; }
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
        if (!filePart || filePart.content.length === 0) throw new Error("video file is required");
        await fs.writeFile(destination, filePart.content);
        resolveUpload({
          filename: filePart.header.match(/filename="([^"]+)/i)?.[1] || "upload.mp4",
          goal: parts.find((part) => /name="goal"/i.test(part.header))?.content.toString("utf8") || "",
          style: parts.find((part) => /name="style"/i.test(part.header))?.content.toString("utf8") || "",
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
  const project = { id, workflowId: "wayne-video-editing", status: "created", goal: body.goal || "", style: body.style || "Wayne / clean creator", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dir: store.projectDir(id), artifacts: [], comments: [], media: null, transcript: null, plan: null, qc: null, error: null, upload: null };
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
  project.status = "planning"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "Claude 正在生成剪辑计划" });
  try {
    project.plan = validateEditPlan(await planWithClaude({ transcript: project.transcript, media: project.media, goal: project.goal, style: project.style, comments: project.comments }), project.media.durationMs, { requireVisualEvents: true });
    await fs.writeFile(join(project.dir, "cut-list.json"), JSON.stringify(project.plan, null, 2));
    project.status = "plan_ready"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "剪辑计划已生成，等待人工确认" });
  } catch (error) { project.status = "needs_input"; project.error = error.message; await save(project); publish(project.id, { type: "needs_input", status: project.status, message: error.message }); throw Object.assign(error, { statusCode: 502 }); }
}

async function generateVisualPlan(project) {
  return validateEditPlan(
    await planWithClaude({ transcript: project.transcript, media: project.media, goal: project.goal, style: project.style, comments: project.comments }),
    project.media.durationMs,
    { requireVisualEvents: true },
  );
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, service: "wayne-portal", config: configState() });
  if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, configState());
  if (req.method === "POST" && url.pathname === "/api/projects") { try { return json(res, 201, projectView(await createProject(await readJson(req)))); } catch (error) { return json(res, 400, { error: error.message }); } }

  if (req.method === "GET" && segments[0] === "media" && segments[1] && ["input.mp4", "transcript-audio.wav"].includes(segments[2])) {
    const project = store.get(segments[1]); const target = project && join(project.dir, segments[2]);
    try { return serveFile(req, res, target, segments[2].endsWith("wav") ? "audio/wav" : "video/mp4"); } catch { return json(res, 404, { error: "media not found" }); }
  }

  const project = segments[0] === "api" && segments[1] === "projects" ? store.get(segments[2]) : null;
  if (!project) return json(res, 404, { error: "project not found" });
  if (req.method === "GET" && segments.length === 3) return json(res, 200, projectView(project));
  if (req.method === "GET" && segments[3] === "events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const list = subscribers.get(project.id) || []; list.push(res); subscribers.set(project.id, list); res.write(`data: ${JSON.stringify({ type: "snapshot", project: projectView(project) })}\n\n`);
    req.on("close", () => subscribers.set(project.id, (subscribers.get(project.id) || []).filter((item) => item !== res))); return;
  }
  if (req.method === "GET" && segments[3] === "artifacts" && segments[4]) {
    const name = decodeURIComponent(segments.slice(4).join("/")); const path = store.artifactPath(project, name);
    if (!path) return json(res, 400, { error: "invalid artifact path" });
    if (!(project.artifacts || []).some((artifact) => artifact.name === name)) return json(res, 404, { error: "artifact not found" });
    try { return serveFile(req, res, path, name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".srt") ? "application/x-subrip" : "application/json", `attachment; filename="${name.replaceAll('"', "")}"`); } catch { return json(res, 404, { error: "artifact not found" }); }
  }
  if (req.method === "POST" && segments[3] === "replan") {
    if (!project.media || !project.transcript) return json(res, 409, { error: "重新生成视觉计划需要已上传素材和转录结果", status: project.status });
    if (["planning", "rendering"].includes(project.status)) return json(res, 409, { error: "当前项目正在处理中，请稍后再试", status: project.status });
    if (!configState().anthropic) return json(res, 409, { error: "未配置 Claude 服务，无法重新生成视觉计划", status: project.status });
    const previousStatus = project.status;
    project.status = "planning";
    project.error = null;
    await save(project);
    publish(project.id, { type: "stage", status: project.status, message: "Claude 正在生成可执行视觉剪辑计划" });
    try {
      const plan = await generateVisualPlan(project);
      await fs.writeFile(join(project.dir, "cut-list.json"), JSON.stringify(plan, null, 2));
      project.plan = plan;
      project.qc = null;
      project.status = "plan_ready";
      project.error = null;
      await save(project);
      publish(project.id, { type: "stage", status: project.status, message: "视觉剪辑计划已生成，旧版成片已保留" });
      return json(res, 200, projectView(project));
    } catch (error) {
      project.status = previousStatus;
      project.error = error.message;
      await save(project);
      publish(project.id, { type: "replan_failed", status: project.status, message: error.message });
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
  if (req.method === "POST" && segments[3] === "render") {
    if (!project.plan) return json(res, 409, { error: "请先生成并确认剪辑计划", status: project.status });
    project.status = "rendering"; project.error = null; await save(project); publish(project.id, { type: "stage", status: project.status, message: "FFmpeg 正在生成主片和 Shorts" });
    try { const result = await renderProject(project); project.artifacts = [...(project.artifacts || []), ...result.artifacts]; project.qc = result.qc; project.status = "completed"; await save(project); publish(project.id, { type: "stage", status: project.status, message: "视觉编辑渲染和 QC 已完成" }); return json(res, 200, projectView(project)); } catch (error) { project.status = "failed"; project.error = error.message; await save(project); publish(project.id, { type: "failed", status: project.status, message: error.message }); return json(res, 502, { error: error.message, status: project.status }); }
  }
  return json(res, 404, { error: "route not found" });
}

createServer((req, res) => { handle(req, res).catch((error) => { if (!req.aborted && !res.writableEnded) json(res, error.statusCode || 500, { error: error.message }); }); }).listen(Number(process.env.PORT || 18787), process.env.HOST || "127.0.0.1", () => console.log(`Wayne portal API listening on http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 18787}`));
