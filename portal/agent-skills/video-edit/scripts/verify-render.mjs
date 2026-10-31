#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`verify-render: ${message}`);
  process.exitCode = 1;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const file = args.find((item) => !item.startsWith("--"));
if (!file) {
  console.error("Usage: node verify-render.mjs <file.mp4> [--width N] [--height N] [--min-duration N] [--max-duration N]");
  process.exit(2);
}

try {
  const probeResult = run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration,start_time", "-of", "json", file]);
  if (probeResult.status !== 0) throw new Error(probeResult.stderr || "ffprobe failed");
  const payload = JSON.parse(probeResult.stdout);
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(payload.format?.duration || 0);
  if (!video || !audio || duration <= 0) throw new Error("缺少有效音视频流或时长");

  const width = Number(option(args, "--width") || 0);
  const height = Number(option(args, "--height") || 0);
  const minDuration = Number(option(args, "--min-duration") || 0);
  const maxDuration = Number(option(args, "--max-duration") || 0);
  if (width && Number(video.width) !== width) throw new Error(`宽度 ${video.width} != ${width}`);
  if (height && Number(video.height) !== height) throw new Error(`高度 ${video.height} != ${height}`);
  if (minDuration && duration < minDuration) throw new Error(`时长 ${duration.toFixed(3)} < ${minDuration}`);
  if (maxDuration && duration > maxDuration) throw new Error(`时长 ${duration.toFixed(3)} > ${maxDuration}`);

  const black = run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "blackdetect=d=0.3:pix_th=0.10", "-an", "-f", "null", "-"]);
  const blackRuns = [...`${black.stderr || ""}`.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((match) => ({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) }));
  if (blackRuns.length) throw new Error(`存在意外黑帧：${JSON.stringify(blackRuns)}`);

  console.log(JSON.stringify({ ok: true, file, durationSeconds: duration, width: Number(video.width), height: Number(video.height), videoCodec: video.codec_name, audioCodec: audio.codec_name, blackRuns }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
