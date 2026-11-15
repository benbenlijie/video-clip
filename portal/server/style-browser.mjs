import { promises as fs } from "node:fs";
import os from "node:os";
import { delimiter, join, resolve } from "node:path";

const BINARY_NAMES = process.platform === "win32"
  ? ["chrome-headless-shell.exe", "chrome.exe", "msedge.exe"]
  : ["chrome-headless-shell", "chrome", "chromium", "google-chrome", "microsoft-edge"];
const SYSTEM_NAMES = process.platform === "win32"
  ? ["chrome.exe", "msedge.exe"]
  : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge", "microsoft-edge-stable"];

async function exists(path) {
  return fs.access(path).then(() => true, () => false);
}

function defaultCacheRoot(env, home) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return resolve(env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ms-playwright");
  return join(home, ".cache", "ms-playwright");
}

async function playwrightCandidates(env, home) {
  const cacheRoot = defaultCacheRoot(env, home);
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  const versions = entries
    .filter((entry) => entry.isDirectory() && /^chromium(?:[-_]headless_shell)?-\d+$/.test(entry.name))
    .sort((a, b) => Number(b.name.match(/(\d+)$/)?.[1] || 0) - Number(a.name.match(/(\d+)$/)?.[1] || 0));
  const results = [];
  for (const version of versions) {
    const versionRoot = join(cacheRoot, version.name);
    const children = await fs.readdir(versionRoot, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory()) continue;
      for (const name of BINARY_NAMES) results.push(join(versionRoot, child.name, name));
    }
  }
  return results;
}

export async function browserExecutableCandidates({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const candidates = [];
  if (env.REMOTION_BROWSER_EXECUTABLE) candidates.push(resolve(env.REMOTION_BROWSER_EXECUTABLE));
  candidates.push(...await playwrightCandidates(env, home));
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of SYSTEM_NAMES) candidates.push(join(directory, name));
  }
  return [...new Set(candidates)];
}

export async function findBrowserExecutable(options = {}) {
  for (const candidate of await browserExecutableCandidates(options)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}
