import { createReadStream, promises as fs, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 45 * 60 * 1000;
const STDERR_LIMIT = 8_000;
const SRT_TIME = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parsePositiveInteger(value, fallback, max) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

export function getWhisperConfig(env = process.env) {
  const storageRoot = resolve(env.WAYNE_STORAGE_DIR || join(portalRoot, "storage"));
  const cliPath = resolve(env.WAYNE_WHISPER_CLI_PATH || join(storageRoot, "whisper", "bin", "whisper-cli"));
  const modelPath = resolve(env.WAYNE_WHISPER_MODEL_PATH || join(storageRoot, "whisper", "models", "ggml-small-q5_1.bin"));
  const threads = parsePositiveInteger(env.WAYNE_WHISPER_THREADS, 8, 16);
  const timeoutMs = parsePositiveInteger(env.WAYNE_WHISPER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const valid = threads !== null && timeoutMs !== null;
  return {
    cliPath,
    modelPath,
    threads: threads || 8,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    model: "small_q5_1",
    available: Boolean(valid && existsSync(cliPath) && existsSync(modelPath)),
  };
}

export async function whisperRuntimeFingerprint(config = getWhisperConfig()) {
  const cliPath = await fs.realpath(config.cliPath);
  const modelPath = await fs.realpath(config.modelPath);
  const [cliSha256, modelSha256] = await Promise.all([fileSha256(cliPath), fileSha256(modelPath)]);
  return createHash("sha256").update(JSON.stringify({
    model: config.model || "small_q5_1",
    cliSha256,
    modelSha256,
    threads: config.threads,
    language: "zh",
    gpu: false,
  })).digest("hex");
}

function parseTimestamp(value) {
  const match = SRT_TIME.exec(value);
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  return (((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000) + Number(millis);
}

export function parseWhisperSrt(value) {
  const segments = [];
  for (const block of String(value || "").trim().split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startValue, endValue] = lines[timingIndex].split("-->").map((part) => part.trim());
    const startMs = parseTimestamp(startValue || "");
    const endMs = parseTimestamp(endValue || "");
    const text = lines.slice(timingIndex + 1).join(" ").replace(/\s+/g, " ").trim();
    if (startMs === null || endMs === null || endMs <= startMs || !text) continue;
    segments.push({ id: `whisper-${segments.length + 1}`, startMs, endMs, text });
  }
  return segments;
}

export async function runWithWhisperSlot(operation) {
  const current = whisperSlot;
  let release;
  whisperSlot = new Promise((resolveSlot) => { release = resolveSlot; });
  await current;
  try {
    return await operation();
  } finally {
    release();
  }
}

let whisperSlot = Promise.resolve();

function runWhisperProcess(command, args, timeoutMs, spawnImpl) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawnImpl(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKill.unref?.();
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT); });
    child.on("error", (error) => finish(rejectProcess, error));
    child.on("close", (code, signal) => {
      if (timedOut) return finish(rejectProcess, new Error("本地 Whisper 识别超时"));
      if (code !== 0) return finish(rejectProcess, new Error(`本地 Whisper 退出 ${code ?? signal}: ${stderr || "无错误详情"}`));
      finish(resolveProcess);
    });
  });
}

export async function transcribeWithWhisper({ audioPath, config = getWhisperConfig(), spawnImpl = spawn }) {
  if (!config.available) throw new Error("本地 Whisper CLI 或 small 模型未安装");
  const audio = await fs.realpath(audioPath);
  const [cli, model] = await Promise.all([fs.realpath(config.cliPath), fs.realpath(config.modelPath)]);
  if (extname(model).toLowerCase() !== ".bin") throw new Error("本地 Whisper 模型文件格式无效");
  const outputDir = await fs.mkdtemp(join(dirname(audio), ".whisper-output-"));
  const outputPrefix = join(outputDir, "transcript");
  const outputSrt = `${outputPrefix}.srt`;
  const args = ["-m", model, "-f", audio, "-l", "zh", "-t", String(config.threads), "-ng", "-osrt", "-of", outputPrefix, "-np"];
  const startedAt = Date.now();
  try {
    await runWithWhisperSlot(() => runWhisperProcess(cli, args, config.timeoutMs, spawnImpl));
    const segments = parseWhisperSrt(await fs.readFile(outputSrt, "utf8"));
    if (!segments.length) throw new Error("本地 Whisper 没有返回有效字幕区间");
    return {
      provider: "whisper.cpp",
      model: config.model || "small_q5_1",
      requestId: createHash("sha256").update(`${audio}:${model}`).digest("hex"),
      durationMs: segments.at(-1).endMs,
      elapsedMs: Date.now() - startedAt,
      text: segments.map((segment) => segment.text).join(" "),
      segments,
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
