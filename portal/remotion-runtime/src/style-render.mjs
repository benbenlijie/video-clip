import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--project-dir", "--input", "--output", "--composition"].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  for (const key of ["project-dir", "input", "output"]) if (!parsed[key]) throw new Error(`Missing ${key}`);
  return parsed;
}

const options = parseArgs(process.argv.slice(2));
const projectDir = resolve(options["project-dir"]);
const inputPath = resolve(options.input);
const outputPath = resolve(options.output);
const compositionId = options.composition || "ReferenceStyle";
const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
const entryPoint = join(projectDir, "src", "index.tsx");
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
await fs.access(entryPoint);
await fs.mkdir(dirname(outputPath), { recursive: true });
await fs.access(outputPath).then(() => { throw new Error("Refusing to overwrite an existing style render output"); }, () => undefined);

const serveUrl = await bundle({ entryPoint });
const composition = await selectComposition({ serveUrl, id: compositionId, inputProps: input, browserExecutable });
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
  browserExecutable,
});

console.log(JSON.stringify({ outputPath, compositionId, engine: "remotion", alphaExpected: true }));
