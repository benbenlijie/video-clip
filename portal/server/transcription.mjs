import { promises as fs } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function config() {
  return {
    provider: process.env.TRANSCRIPTION_PROVIDER || "volcengine",
    volcengine: {
      mode: process.env.VOLCENGINE_ASR_MODE || "standard",
      apiKey: process.env.VOLCENGINE_ASR_API_KEY || "",
      appId: process.env.VOLCENGINE_APP_ID || "",
      accessToken: process.env.VOLCENGINE_ACCESS_TOKEN || "",
      cluster: process.env.VOLCENGINE_ASR_CLUSTER || "",
      publicBaseUrl: process.env.VOLCENGINE_ASR_PUBLIC_BASE_URL || "",
      resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID || "volc.bigasr.auc_turbo",
      baseUrl: process.env.VOLCENGINE_ASR_BASE_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      model: process.env.VOLCENGINE_ASR_MODEL || "bigmodel",
    },
    tencent: {
      secretId: process.env.TENCENTCLOUD_SECRET_ID || "",
      secretKey: process.env.TENCENTCLOUD_SECRET_KEY || "",
      region: process.env.TENCENTCLOUD_REGION || "ap-guangzhou",
      endpoint: process.env.TENCENTCLOUD_ASR_ENDPOINT || "asr.tencentcloudapi.com",
      engine: process.env.TENCENTCLOUD_ASR_ENGINE_MODEL_TYPE || "16k_zh",
    },
  };
}

export function providerState() {
  const cfg = config();
  const volcengineStandard = Boolean(cfg.volcengine.appId && cfg.volcengine.accessToken && cfg.volcengine.cluster && cfg.volcengine.publicBaseUrl);
  const volcengineFast = Boolean(cfg.volcengine.apiKey);
  const volcengine = volcengineStandard || volcengineFast;
  const tencent = Boolean(cfg.tencent.secretId && cfg.tencent.secretKey);
  return { provider: cfg.provider, volcengine, volcengineMode: cfg.volcengine.mode, volcengineStandard, volcengineFast, tencent, any: volcengine || tencent };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}

async function extractAudio(videoPath, outputPath) {
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath]);
  return fs.readFile(outputPath);
}

function normalizeUtterances(raw, fallbackText = "") {
  const list = raw?.result?.utterances || raw?.utterances || raw?.Result?.Sentences || raw?.Data?.Result?.Sentences || [];
  const segments = [];
  for (const [index, item] of list.entries()) {
    const startMs = Number(item.start_time ?? item.StartTime ?? item.StartTimeMs ?? item.startTime ?? 0);
    const endMs = Number(item.end_time ?? item.EndTime ?? item.EndTimeMs ?? item.endTime ?? startMs);
    const words = (item.words || item.Words || []).map((word) => ({
      startMs: Number(word.start_time ?? word.StartTime ?? word.startTime ?? 0),
      endMs: Number(word.end_time ?? word.EndTime ?? word.endTime ?? 0),
      text: word.text ?? word.Word ?? "",
      confidence: word.confidence == null ? undefined : Number(word.confidence),
    }));
    segments.push({ id: `segment-${index + 1}`, startMs, endMs, text: item.text ?? item.Text ?? "", words, speaker: item.additions?.speaker ?? item.SpeakerId ?? undefined });
  }
  const text = raw?.result?.text || raw?.text || raw?.Result?.Result || raw?.Data?.Result?.Result || fallbackText || segments.map((s) => s.text).join("");
  const durationMs = Number(raw?.audio_info?.duration ?? raw?.AudioInfo?.Duration ?? segments.at(-1)?.endMs ?? 0);
  return { text, durationMs, segments };
}

async function transcribeVolcengineFast(audioBytes) {
  const cfg = config().volcengine;
  const requestId = randomUUID();
  const headers = { "Content-Type": "application/json", "X-Api-Resource-Id": cfg.resourceId, "X-Api-Request-Id": requestId, "X-Api-Sequence": "-1" };
  if (cfg.apiKey) headers["X-Api-Key"] = cfg.apiKey;
  else { headers["X-Api-App-Key"] = cfg.appId; headers["X-Api-Access-Key"] = cfg.accessToken; }
  const response = await fetch(cfg.baseUrl, { method: "POST", headers, body: JSON.stringify({ user: { uid: "wayne-portal" }, audio: { data: audioBytes.toString("base64") }, request: { model_name: cfg.model, show_utterances: true, enable_itn: true, enable_punc: true, enable_ddc: true } }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`火山引擎 ASR ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  if (payload.code && Number(payload.code) !== 1000 && payload.resp?.code !== 1000) throw new Error(`火山引擎 ASR: ${payload.message || payload.resp?.message || "识别失败"}`);
  return { provider: "volcengine", requestId, raw: payload, transcript: normalizeUtterances(payload) };
}

function standardVolcHeaders(token) {
  return { "Content-Type": "application/json", Authorization: `Bearer; ${token}` };
}

async function volcengineStandardRequest(cfg, path, body) {
  const response = await fetch(`https://openspeech.bytedance.com/api/v1/auc/${path}`, { method: "POST", headers: standardVolcHeaders(cfg.accessToken), body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.resp?.code && Number(payload.resp.code) !== 1000 && Number(payload.resp.code) >= 3000) {
    throw new Error(`火山引擎标准版 ASR ${response.status}: ${payload.resp?.message || JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

async function transcribeVolcengineStandard({ projectId, audioUrl }) {
  const cfg = config().volcengine;
  if (!cfg.appId || !cfg.accessToken || !cfg.cluster) throw new Error("火山引擎标准版缺少 APP_ID、ACCESS_TOKEN 或 CLUSTER");
  if (!/^https:\/\//i.test(audioUrl)) throw new Error("火山引擎标准版需要公网 HTTPS 音频 URL，请配置 VOLCENGINE_ASR_PUBLIC_BASE_URL");
  const submit = await volcengineStandardRequest(cfg, "submit", {
    app: { appid: cfg.appId, token: cfg.accessToken, cluster: cfg.cluster },
    user: { uid: projectId },
    audio: { url: audioUrl, format: "wav", rate: 16000, channel: 1 },
    additions: { use_itn: "True", use_punc: "True", use_ddc: "True", with_speaker_info: "False", enable_query: "True" },
  });
  const taskId = submit.resp?.id;
  if (!taskId) throw new Error(`火山引擎标准版未返回任务 ID: ${submit.resp?.message || "unknown"}`);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = await volcengineStandardRequest(cfg, "query", { appid: cfg.appId, token: cfg.accessToken, cluster: cfg.cluster, id: taskId });
    const code = Number(result.resp?.code);
    if (code === 1000) return { provider: "volcengine", requestId: String(taskId), raw: result, transcript: normalizeUtterances(result.resp) };
    if (code >= 1000 && code < 2000) throw new Error(`火山引擎标准版任务失败: ${result.resp?.message || code}`);
  }
  throw new Error("火山引擎标准版查询超时");
}

function sha256(input) { return createHash("sha256").update(input).digest("hex"); }
function hmac(key, input, encoding) { return createHmac("sha256", key).update(input).digest(encoding); }

function tencentAuthorization({ secretId, secretKey, region, action, payload, timestamp }) {
  const service = "asr"; const host = "asr.tencentcloudapi.com"; const algorithm = "TC3-HMAC-SHA256";
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function tencentRequest(cfg, action, requestBody) {
  const timestamp = Math.floor(Date.now() / 1000); const payload = JSON.stringify(requestBody);
  const headers = { "Content-Type": "application/json; charset=utf-8", Host: cfg.endpoint, "X-TC-Action": action, "X-TC-Version": "2019-06-14", "X-TC-Region": cfg.region, "X-TC-Timestamp": String(timestamp), Authorization: tencentAuthorization({ ...cfg, action, payload, timestamp }) };
  const response = await fetch(`https://${cfg.endpoint}/`, { method: "POST", headers, body: payload });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Response?.Error) throw new Error(`腾讯云 ASR ${response.status}: ${result.Response?.Error?.Message || JSON.stringify(result).slice(0, 500)}`);
  return result;
}

async function transcribeTencent(audioBytes) {
  const cfg = config().tencent;
  const created = await tencentRequest(cfg, "CreateRecTask", { EngineModelType: cfg.engine, ChannelNum: 1, ResTextFormat: 1, SourceType: 1, Data: audioBytes.toString("base64"), ConvertNumMode: 1 });
  const taskId = created.Response?.Data?.TaskId;
  if (!taskId) throw new Error("腾讯云 ASR 未返回 TaskId");
  let result;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await tencentRequest(cfg, "DescribeTaskStatus", { TaskId: taskId });
    const data = result.Response?.Data || result.Response || {};
    if (data.Status === 2 || data.Status === "success" || data.StatusStr === "success") {
      return { provider: "tencent", requestId: String(taskId), raw: result, transcript: normalizeUtterances(data) };
    }
    if (data.Status === 3 || data.Status === "failed" || data.ErrorMsg) throw new Error(`腾讯云 ASR 任务失败: ${data.ErrorMsg || data.StatusStr || "unknown"}`);
  }
  throw new Error("腾讯云 ASR 任务轮询超时");
}

export async function transcribeVideo({ videoPath, projectDir, projectId }) {
  const audioPath = `${projectDir}/transcript-audio.wav`;
  const audio = await extractAudio(videoPath, audioPath);
  const cfg = config(); const state = providerState(); const errors = [];
  const standardAudioUrl = cfg.volcengine.publicBaseUrl ? `${cfg.volcengine.publicBaseUrl.replace(/\/$/, "")}/media/${projectId}/transcript-audio.wav` : "";
  const tryVolc = cfg.provider !== "tencent" && state.volcengine;
  const tryTencent = state.tencent;
  const attempts = [];
  if (tryVolc) {
    if (state.volcengineStandard && cfg.volcengine.mode !== "fast") attempts.push(() => transcribeVolcengineStandard({ projectId, audioUrl: standardAudioUrl }));
    if (state.volcengineFast) attempts.push(() => transcribeVolcengineFast(audio));
  }
  if (tryTencent) attempts.push(() => transcribeTencent(audio));
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      await fs.writeFile(`${projectDir}/transcript.json`, JSON.stringify({ ...result.transcript, provider: result.provider, requestId: result.requestId }, null, 2));
      return result;
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(errors.length ? `转录服务失败：${errors.join("；")}` : "未配置火山引擎或腾讯云转录凭证");
}
