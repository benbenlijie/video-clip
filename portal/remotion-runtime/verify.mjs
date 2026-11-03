import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeRoot = path.dirname(new URL(import.meta.url).pathname);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-remotion-"));
const inputPath = path.join(temp, "timeline.json");
const outputPath = path.join(temp, "overlay.mov");
const input = {
  width: 320,
  height: 180,
  fps: 30,
  durationMs: 1200,
  events: [
    { id: "hook", type: "title_card", startMs: 0, endMs: 700, text: "真实样例", subtext: "Remotion 叠加层" },
    { id: "point", type: "emphasis", startMs: 500, endMs: 1100, text: "关键观点" },
  ],
};
await fs.writeFile(inputPath, JSON.stringify(input));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: runtimeRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr || stdout}`)));
  });
}

try {
  await run(process.execPath, ["src/render.mjs", "--input", inputPath, "--output", outputPath]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt", "-of", "json", outputPath]);
  const probe = JSON.parse(stdout);
  assert.ok(probe.streams.some((stream) => stream.codec_name === "prores" && /^yuva444p/.test(stream.pix_fmt)), `Remotion output must preserve ProRes 4444 alpha: ${JSON.stringify(probe.streams)}`);
  assert.equal(Number(probe.streams[0].width), input.width);
  assert.equal(Number(probe.streams[0].height), input.height);
  assert.ok(Number(probe.format.duration) > 1.1);
  const alpha = await run("ffmpeg", ["-hide_banner", "-i", outputPath, "-vf", "alphaextract,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
  assert.match(alpha.stderr, /lavfi\.signalstats\.YMIN=0/);
  const alphaMaxima = [...alpha.stderr.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(alphaMaxima.some((value) => value === 0), "initial frames should preserve transparent background pixels");
  assert.ok(alphaMaxima.some((value) => value > 0), "animated overlay frames should contain visible pixels");
  console.log("remotion-runtime.verify: real composition rendered as ProRes 4444 with alpha");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
