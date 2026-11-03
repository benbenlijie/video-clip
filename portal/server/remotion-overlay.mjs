import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(portalRoot, "remotion-runtime");
const rendererPath = join(runtimeRoot, "src", "render.mjs");
const rendererNodeModules = join(runtimeRoot, "node_modules");

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function rendererEnv() {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function run(command, args, cwd, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: rendererEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} failed (${code ?? signal}): ${(stderr || stdout).slice(-4000)}`));
    });
  });
}

function rendererInput(timeline) {
  if (timeline?.contract !== "timeline.v1") throw new Error("Remotion 需要 timeline.v1 输入");
  if (!timeline.media || !Array.isArray(timeline.visualEvents)) throw new Error("timeline.v1 缺少媒体信息或视觉事件");
  const media = timeline.media;
  return {
    width: Math.max(16, Math.round(Number(media.width) || 0)),
    height: Math.max(16, Math.round(Number(media.height) || 0)),
    fps: 30,
    durationMs: Math.max(1, Math.round(Number(media.durationMs) || 0)),
    events: timeline.visualEvents.map((event) => ({
      id: String(event.id),
      type: String(event.type),
      startMs: Math.round(Number(event.startMs)),
      endMs: Math.round(Number(event.endMs)),
      text: String(event.text || ""),
      subtext: String(event.subtext || ""),
    })),
  };
}

async function probeAlpha(outputPath, expected) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt", "-of", "json", outputPath], portalRoot, 30000);
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.find((item) => item.codec_name === "prores");
  if (!stream || !String(stream.pix_fmt).startsWith("yuva") || Number(stream.width) !== expected.width || Number(stream.height) !== expected.height) {
    throw new Error("Remotion 输出未通过 ProRes 4444 alpha/尺寸检查");
  }
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", outputPath, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "4", "-f", "null", "-"], portalRoot, 30000);
  const maxima = [...stderr.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g)].map((match) => Number(match[1]));
  if (!maxima.some((value) => value === 0) || !maxima.some((value) => value > 0)) throw new Error("Remotion alpha 检查未发现透明背景和可见像素");
  return { width: Number(stream.width), height: Number(stream.height), durationMs: Math.round(Number(probe.format?.duration || 0) * 1000), codec: stream.codec_name, pixelFormat: stream.pix_fmt, alpha: true, sha256: await sha256File(outputPath) };
}

export async function remotionRuntimeAvailable() {
  try {
    await Promise.all([fs.access(rendererPath), fs.access(join(rendererNodeModules, "@remotion", "renderer", "package.json"))]);
    return true;
  } catch { return false; }
}

export async function renderRemotionOverlay({ timeline, outputPath, workDir = dirname(outputPath) }) {
  if (!(await remotionRuntimeAvailable())) throw new Error("Remotion runtime 尚未安装；请在 portal/remotion-runtime 执行 npm install");
  const props = rendererInput(timeline);
  const target = resolve(outputPath);
  await fs.mkdir(workDir, { recursive: true });
  await fs.access(target).then(() => { throw new Error("Refusing to overwrite an existing render output"); }, () => undefined);
  const inputPath = join(workDir, `.remotion-input-${randomUUID()}.json`);
  try {
    await fs.writeFile(inputPath, JSON.stringify(props), { flag: "wx" });
    await run(process.execPath, [rendererPath, "--input", inputPath, "--output", target], runtimeRoot);
    const output = await probeAlpha(target, props);
    const packageMetadata = JSON.parse(await fs.readFile(join(rendererNodeModules, "remotion", "package.json"), "utf8"));
    return { ...output, remotionVersion: String(packageMetadata.version) };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => undefined);
  }
}

export async function compositeRemotionPreview({ inputPath, overlayPath, outputPath }) {
  const target = resolve(outputPath);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.access(target).then(() => { throw new Error("Refusing to overwrite an existing preview output"); }, () => undefined);
  try {
    await run("ffmpeg", [
      "-y", "-hide_banner", "-i", resolve(inputPath), "-i", resolve(overlayPath),
      "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto:eof_action=pass[v]",
      "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
      "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", target,
    ], portalRoot);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", target], portalRoot, 30000);
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    if (!video) throw new Error("Remotion 合成预览缺少视频流");
    return { outputPath: target, width: Number(video.width), height: Number(video.height), durationMs: Math.round(Number(probe.format?.duration || 0) * 1000), sha256: await sha256File(target) };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}
