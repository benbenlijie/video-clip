import { promises as fs } from "node:fs";
import { relative, resolve } from "node:path";

export const ALLOWED_STYLE_PACKAGES = new Set([
  "react",
  "remotion",
  "@remotion/captions",
  "@remotion/media",
  "@remotion/media-utils",
]);

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const FORBIDDEN_PATTERNS = [
  ["network", /\bfetch\s*\(/],
  ["network", /\b(?:axios|got|undici|ky)\b/],
  ["network", /(?:https?|wss?):\/\//i],
  ["embedded_media", /\bdata:(?:image|video|audio)\//i],
  ["protocol_relative_url", /\burl\(\s*["']?\/\//i],
  ["child_process", /\b(?:child_process|execFile|execSync|spawnSync)\b/],
  ["child_process", /\bspawn\s*\(/],
  ["filesystem", /\bfs\.(?:writeFile|appendFile|rm|unlink|rename|mkdir|copyFile|cp)\b/],
  ["environment", /\bprocess\.(?:env|exit)\b/],
  ["dynamic_code", /\beval\s*\(/],
  ["dynamic_code", /\bnew\s+Function\b/],
  ["dynamic_import", /\bimport\s*\(/],
  ["require", /\brequire\s*\(/],
  ["absolute_path", /["']\/(?:home|tmp|Users|var|etc)\//],
  ["absolute_path", /["']file:\/\//i],
  ["renderer", /@remotion\/(?:renderer|bundler|studio|cli)\b/],
];

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function finding(code, file, source, index, message) {
  return { code, file, line: lineOf(source, index), message };
}

function staticImports(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"'`]*?\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push({ spec: match[1], index: match.index || 0 });
  }
  return specs;
}

export function scanStyleSource(source, file = "source") {
  if (typeof source !== "string") throw new Error("style source must be a string");
  const errors = [];
  for (const [code, pattern] of FORBIDDEN_PATTERNS) {
    for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g"))) {
      errors.push(finding(code, file, source, match.index || 0, `forbidden ${code} reference`));
    }
  }
  for (const { spec, index } of staticImports(source)) {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      if (spec.startsWith("/")) errors.push(finding("absolute_import", file, source, index, "absolute imports are forbidden"));
      continue;
    }
    if (!ALLOWED_STYLE_PACKAGES.has(spec)) {
      errors.push(finding("dependency", file, source, index, `unapproved style dependency: ${spec}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

async function listSourceFiles(root, current = root) {
  const result = [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) result.push(...await listSourceFiles(root, absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

export async function scanStyleProject(projectDir) {
  const root = resolve(projectDir);
  const errors = [];
  const files = await listSourceFiles(root);
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    if (MEDIA_EXTENSIONS.has(extension)) {
      errors.push({ code: "media_asset", file: rel, line: 1, message: "generated style projects may not bundle image, video, or audio assets" });
    }
    if (SOURCE_EXTENSIONS.has(extension)) {
      const source = await fs.readFile(file, "utf8");
      errors.push(...scanStyleSource(source, rel).errors);
    }
    if (rel === "package.json") {
      const pkg = JSON.parse(await fs.readFile(file, "utf8"));
      if (pkg.scripts && Object.keys(pkg.scripts).length) errors.push({ code: "package_scripts", file: rel, line: 1, message: "generated style projects may not define npm scripts" });
      for (const [name, version] of Object.entries(pkg.dependencies || {})) {
        if (!ALLOWED_STYLE_PACKAGES.has(name)) errors.push({ code: "dependency", file: rel, line: 1, message: `unapproved package dependency: ${name}` });
        if (typeof version !== "string" || !version.trim()) errors.push({ code: "dependency_version", file: rel, line: 1, message: `missing version for ${name}` });
      }
      for (const name of Object.keys(pkg.devDependencies || {})) {
        errors.push({ code: "dependency", file: rel, line: 1, message: `dev dependency is not allowed: ${name}` });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
