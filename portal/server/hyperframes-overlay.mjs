import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(portalRoot, "hyperframes-runtime");
const cliPath = join(runtimeRoot, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const gsapPath = join(runtimeRoot, "node_modules", "gsap", "dist", "gsap.min.js");

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`HyperFrames render failed (${code}): ${(stderr || stdout).slice(-2000)}`)));
  });
}

function htmlText(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function compositionHTML(events, durationMs, width, height) {
  const poster = events[0]?.startMs === 0 ? `<div id="poster" class="poster"><strong>WAYNE / HYBRID EDIT</strong></div>` : "";
  const clips = events.map((event, index) => {
    const start = Math.max(0, event.startMs / 1000);
    const duration = Math.max(0.001, (event.endMs - event.startMs) / 1000);
    const type = ["title_card", "emphasis", "cta"].includes(event.type) ? event.type : "emphasis";
    const visibleAtZero = index === 0 && start === 0 ? ' style="opacity:1"' : "";
    return `<section id="event-${index}" class="clip event event-${type}" data-start="${start.toFixed(3)}" data-duration="${duration.toFixed(3)}" data-track-index="${index}" data-title="${htmlText(event.text)}" data-subtext="${htmlText(event.subtext || "")}"${visibleAtZero}></section>`;
  }).join("\n");
  const duration = Math.max(0.1, durationMs / 1000);
  const orientation = height > width ? "portrait" : "landscape";
  return `<!doctype html>
<html lang="zh-CN" data-resolution="${orientation}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=${width},height=${height}">
  <style>
    :root { --ink: #f1f3ea; --mint: #c6f475; --orange: #f58c53; --panel: rgba(17,19,17,.91); }
    * { box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: transparent; }
    [data-composition-id="wayne-overlay"] { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
    .poster { position: absolute; z-index: 1; top: 4%; left: 4%; padding: ${Math.round(height * .012)}px ${Math.round(width * .014)}px; color: var(--mint); background: rgba(17,19,17,.94); border-left: ${Math.max(4, Math.round(width * .003))}px solid var(--orange); border-top: 2px solid var(--mint); }
    .poster strong { display: block; font: 500 ${Math.max(30, Math.round(height * .028))}px/1.2 Manrope,sans-serif; letter-spacing: .13em; }
    .event { position: absolute; opacity: 0; pointer-events: none; color: var(--ink); background: linear-gradient(118deg,var(--panel),rgba(25,28,25,.78)); border-left: ${Math.max(6, Math.round(width * .006))}px solid var(--mint); border-top: ${Math.max(3, Math.round(height * .004))}px solid var(--orange); box-shadow: 0 24px 90px rgba(0,0,0,.24); }
    .event::before { content: attr(data-title); position: absolute; left: ${Math.round(width * .035)}px; right: ${Math.round(width * .035)}px; top: ${Math.round(height * .045)}px; color: var(--ink); font: 800 ${Math.round(height * .076)}px/1.02 Manrope,sans-serif; letter-spacing: -.055em; overflow-wrap: anywhere; }
    .event::after { content: attr(data-subtext); position: absolute; left: ${Math.round(width * .038)}px; right: ${Math.round(width * .04)}px; bottom: ${Math.round(height * .035)}px; color: var(--mint); font: 600 ${Math.round(height * .03)}px/1.15 Manrope,sans-serif; overflow-wrap: anywhere; }
    .event-title { top: 10.5%; left: 8.5%; width: 82%; height: 30%; padding: ${Math.round(height * .045)}px ${Math.round(width * .045)}px; }
    .event-emphasis { left: 8%; bottom: 12%; width: 86%; height: 22%; border-left-color: var(--orange); }
    .event-emphasis::before { font-size: ${Math.round(height * .067)}px; }
    .event-cta { right: 8%; bottom: 11%; width: 77%; height: 29%; border-left-color: var(--orange); }
  </style>
</head>
<body>
  <main id="wayne-overlay" data-composition-id="wayne-overlay" data-start="0" data-duration="${duration.toFixed(3)}" data-width="${width}" data-height="${height}">
    ${poster}
    ${clips}
  </main>
  <script src="./gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    ${poster ? 'tl.to("#poster", { opacity: 0, duration: 0.12, ease: "none" }, 2);' : ""}
    ${events.map((event, index) => {
      const start = Math.max(0, event.startMs / 1000);
      const eventDuration = Math.max(.001, (event.endMs - event.startMs) / 1000);
      const inDuration = Math.min(.42, eventDuration * .35);
      const outDuration = Math.min(.24, eventDuration * .2);
      const outAt = Math.max(start + inDuration, start + eventDuration - outDuration);
      const visibleAtZero = index === 0 && start === 0;
      return `tl.fromTo("#event-${index}", { y: ${visibleAtZero ? 0 : height > width ? 48 : 34}, opacity: ${visibleAtZero ? 1 : 0}, scale: .97 }, { y: 0, opacity: 1, scale: 1, duration: ${inDuration.toFixed(3)}, ease: "power3.out" }, ${start.toFixed(3)}); tl.to("#event-${index}", { y: -18, opacity: 0, duration: ${outDuration.toFixed(3)}, ease: "power2.in" }, ${outAt.toFixed(3)});`;
    }).join("\n    ")}
    window.__timelines["wayne-overlay"] = tl;
  </script>
</body>
</html>`;
}

export async function renderHyperframesOverlay({ events, durationMs, width, height, outputPath, workDir }) {
  if (!Array.isArray(events) || events.length === 0) return null;
  await fs.access(cliPath);
  await fs.access(gsapPath);
  await fs.mkdir(workDir, { recursive: true });
  const sourcePath = join(workDir, "index.html");
  await fs.writeFile(sourcePath, compositionHTML(events, durationMs, width, height), "utf8");
  await fs.copyFile(gsapPath, join(workDir, "gsap.min.js"));
  const result = await run(process.execPath, [cliPath, "render", "--output", outputPath, "--format", "mov", "--quality", "draft", "--fps", "30", "--workers", "1"], workDir);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt", "-of", "json", outputPath], workDir);
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.find((item) => item.codec_name === "prores" && String(item.pix_fmt).startsWith("yuva"));
  if (!stream || Number(stream.width) !== width || Number(stream.height) !== height) {
    throw new Error("HyperFrames 必须产出尺寸匹配且带透明通道的 ProRes 4444 MOV");
  }
  return { sourcePath, outputPath, durationMs, width, height, hasAlpha: true, cliOutput: result.stdout };
}
