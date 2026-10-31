import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderHyperframesOverlay } from "./hyperframes-overlay.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-hyperframes-"));
try {
  const events = [
    { id: "hook", type: "title_card", startMs: 0, endMs: 1200, text: "一开始就说清价值", subtext: "再用真实素材证明" },
    { id: "point", type: "emphasis", startMs: 1500, endMs: 2800, text: "让关键观点留下来" },
    { id: "cta", type: "cta", startMs: 3000, endMs: 4500, text: "你怎么看？", subtext: "欢迎评论交流" },
  ];
  const overlay = await renderHyperframesOverlay({ events, durationMs: 5000, width: 1920, height: 1080, outputPath: path.join(root, "overlay.mov"), workDir: root });
  assert.equal(overlay.hasAlpha, true);
  const html = await fs.readFile(overlay.sourcePath, "utf8");
  assert.match(html, /data-composition-id="wayne-overlay"/);
  assert.match(html, /#c6f475/i, "the animation should reuse the portal accent color");
  assert.match(html, /一开始就说清价值/);
  assert.match(html, /window\.__timelines\["wayne-overlay"\]/);
  assert.ok((await fs.stat(overlay.outputPath)).size > 1000);
  const probe = await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt:stream_tags=alpha_mode", "-of", "json", overlay.outputPath]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  assert.ok(probe.streams?.some((stream) => stream.codec_name === "prores" && String(stream.pix_fmt).startsWith("yuva")), "HyperFrames should produce a ProRes 4444 overlay with a decoded alpha plane");
  const alphaCheck = await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-i", overlay.outputPath, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(stderr)));
  });
  assert.match(String(alphaCheck), /lavfi\.signalstats\.YAVG/);
  assert.match(String(alphaCheck), /lavfi\.signalstats\.YAVG=[1-9]/, "an animated overlay frame should contain non-transparent pixels");
  console.log("hyperframes.verify: animated ProRes 4444 overlay rendered with an FFmpeg-readable alpha plane");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
