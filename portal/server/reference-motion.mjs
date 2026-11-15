import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function extractReferenceMotionSheets({
  videoPath,
  outDir,
  durationMs,
  maxWindows = 5,
  secondsPerWindow = 2.5,
  fps = 4,
  columns = 5,
  frameWidth = 360,
} = {}) {
  if (!videoPath || !outDir) throw new Error("videoPath and outDir are required");
  const duration = Math.max(1, Number(durationMs) || 0);
  const count = Math.max(1, Math.min(6, Math.round(Number(maxWindows) || 5)));
  const windowMs = Math.max(500, Math.min(duration, Number(secondsPerWindow) * 1000 || 2500));
  const sampleFps = Math.max(1, Math.min(8, Number(fps) || 4));
  const gridColumns = Math.max(1, Math.min(6, Math.round(Number(columns) || 5)));
  const framesPerWindow = Math.max(1, Math.round(windowMs / 1000 * sampleFps));
  const gridRows = Math.max(1, Math.ceil(framesPerWindow / gridColumns));
  const maxStart = Math.max(0, duration - windowMs);
  const width = Math.max(180, Math.min(480, Math.round(Number(frameWidth) || 360)));
  await fs.mkdir(outDir, { recursive: true });
  const sheets = [];
  for (let index = 0; index < count; index += 1) {
    const startMs = Math.round(count === 1 ? 0 : index * maxStart / (count - 1));
    const endMs = Math.min(duration, startMs + windowMs);
    const target = join(outDir, `motion-window-${String(index + 1).padStart(2, "0")}.jpg`);
    await execFile("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", (startMs / 1000).toFixed(3),
      "-t", ((endMs - startMs) / 1000).toFixed(3),
      "-i", videoPath,
      "-vf", `fps=${sampleFps},scale=${width}:-2,tile=${gridColumns}x${gridRows}:padding=8:margin=0`,
      "-frames:v", "1",
      "-q:v", "3",
      target,
    ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`motion contact sheet ${index + 1} was not created`);
    sheets.push({
      index,
      startMs,
      endMs,
      framesPerWindow,
      sampleFps,
      path: target,
      bytes: stat.size,
      mimeType: "image/jpeg",
    });
  }
  return sheets;
}
