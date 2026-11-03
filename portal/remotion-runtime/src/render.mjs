import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argumentsFrom(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--output"].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  if (!parsed.input || !parsed.output) throw new Error("Usage: node src/render.mjs --input <timeline.json> --output <overlay.mov>");
  return parsed;
}

function validateInput(value) {
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) || !Number.isFinite(value.durationMs) || !Number.isFinite(value.fps)) {
    throw new Error("Invalid Remotion overlay input metadata");
  }
  if (value.width < 16 || value.height < 16 || value.width > 7680 || value.height > 7680) throw new Error("Overlay dimensions are outside the supported range");
  if (value.durationMs < 1 || value.durationMs > 60 * 60 * 1000 || value.fps < 1 || value.fps > 120) throw new Error("Overlay duration or frame rate is outside the supported range");
  if (!Array.isArray(value.events) || value.events.length > 32) throw new Error("Overlay events must be an array with at most 32 items");
  for (const [index, event] of value.events.entries()) {
    if (!event || !["title_card", "emphasis", "cta"].includes(event.type)) throw new Error(`Unsupported overlay event type at index ${index}`);
    if (!Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.startMs < 0 || event.endMs <= event.startMs || event.endMs > value.durationMs) throw new Error(`Invalid overlay event range at index ${index}`);
    if (String(event.text || "").length > 96 || String(event.subtext || "").length > 120) throw new Error(`Overlay text is too long at index ${index}`);
  }
}

const options = argumentsFrom(process.argv.slice(2));
const inputPath = resolve(options.input);
const outputPath = resolve(options.output);
const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
validateInput(input);
await fs.mkdir(dirname(outputPath), { recursive: true });
await fs.access(outputPath).then(() => { throw new Error("Refusing to overwrite an existing render output"); }, () => undefined);

const serveUrl = await bundle({ entryPoint: join(runtimeRoot, "src", "index.jsx") });
const composition = await selectComposition({
  serveUrl,
  id: "wayne-overlay",
  inputProps: input,
});

await renderMedia({
  composition,
  serveUrl,
  codec: "prores",
  proResProfile: "4444",
  imageFormat: "png",
  pixelFormat: "yuva444p10le",
  outputLocation: outputPath,
  inputProps: input,
  muted: true,
  overwrite: false,
  concurrency: 2,
  logLevel: "error",
});

console.log(JSON.stringify({ outputPath, width: input.width, height: input.height, durationMs: input.durationMs, fps: input.fps, engine: "remotion", alphaExpected: true }));
