import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputDir = resolve(process.argv[2] || join(root, "output", "project"));
const outputPath = resolve(process.argv[3] || join(root, "output", "wayne-hook-preview.mp4"));
const frames = (await fs.readdir(inputDir)).filter((name) => /^\d{6}\.png$/.test(name)).sort();
if (!frames.length || frames.some((name, index) => name !== `${String(index).padStart(6, "0")}.png`)) {
  throw new Error(`Expected a contiguous Motion Canvas image sequence in ${inputDir}`);
}
await fs.access(outputPath).then(() => { throw new Error(`Refusing to overwrite ${outputPath}`); }, () => undefined);
await fs.mkdir(dirname(outputPath), { recursive: true });

await new Promise((resolveRun, reject) => {
  const child = spawn("ffmpeg", [
    "-hide_banner", "-y", "-framerate", "60", "-i", join(inputDir, "%06d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", outputPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-2000)}`)));
});

console.log(JSON.stringify({ outputPath, frameCount: frames.length, fps: 60 }));
