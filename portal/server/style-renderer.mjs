import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStyleProjectSandboxed } from "./style-sandbox.mjs";
import { findBrowserExecutable } from "./style-browser.mjs";

const portalRoot = fileURLToPath(new URL("../", import.meta.url));
const remotionRuntimeRoot = join(portalRoot, "remotion-runtime");
const rendererPath = join(remotionRuntimeRoot, "src", "style-render.mjs");
const runtimeNodeModules = join(remotionRuntimeRoot, "node_modules");
function rendererEnv(extra = {}) {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function run(command, args, cwd, timeoutMs, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: rendererEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`style Remotion render failed (${code ?? signal}): ${(stderr || stdout).slice(-4000)}`));
    });
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(path));
  return hash.digest("hex");
}

export async function renderStyleProject({
  projectDir,
  props,
  outputPath,
  compositionId = "ReferenceStyle",
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!projectDir || !props || !outputPath) throw new Error("projectDir, props, and outputPath are required");
  await assertStyleProjectSandboxed(projectDir);
  const target = resolve(outputPath);
  await fs.access(target).then(() => { throw new Error("Refusing to overwrite an existing style render output"); }, () => undefined);
  const tempRoot = await fs.mkdtemp(join(os.tmpdir(), "wayne-style-render-"));
  try {
    const projectCopy = join(tempRoot, "project");
    await fs.cp(resolve(projectDir), projectCopy, { recursive: true });
    await fs.symlink(runtimeNodeModules, join(projectCopy, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const outputDir = dirname(target);
    const homeDir = join(tempRoot, "home");
    await Promise.all([fs.mkdir(outputDir, { recursive: true }), fs.mkdir(homeDir, { recursive: true })]);
    const inputPath = join(tempRoot, "input.json");
    await fs.writeFile(inputPath, JSON.stringify(props), { flag: "wx" });
    const browserExecutable = await findBrowserExecutable();
    const rendererArgs = [
      rendererPath,
      "--project-dir", projectCopy,
      "--input", inputPath,
      "--output", target,
      "--composition", compositionId,
    ];
    const command = "bwrap";
    const nodeExecutable = await fs.realpath(process.execPath);
    const nodeDir = dirname(nodeExecutable);
    const browserDir = browserExecutable ? dirname(await fs.realpath(browserExecutable)) : null;
    const roBinds = ["/usr", "/lib", "/lib64", "/bin", "/etc"];
    if (!nodeDir.startsWith("/usr/")) roBinds.push(nodeDir);
    if (!remotionRuntimeRoot.startsWith("/usr/")) roBinds.push(remotionRuntimeRoot);
    if (browserDir && !browserDir.startsWith("/usr/")) roBinds.push(browserDir);
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-net",
      "--unshare-pid",
      "--cap-drop", "ALL",
      "--tmpfs", "/",
      ...roBinds.filter((path) => !path.startsWith("/home/")).flatMap((path) => ["--ro-bind", path, path]),
      "--tmpfs", "/home",
      "--tmpfs", "/root",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      ...roBinds.filter((path) => path.startsWith("/home/")).flatMap((path) => ["--ro-bind", path, path]),
      "--bind", tempRoot, tempRoot,
      "--bind", outputDir, outputDir,
      "--chdir", tempRoot,
      nodeExecutable,
      ...rendererArgs,
    ];
    await run(command, args, tempRoot, timeoutMs, {
      HOME: homeDir,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
      XDG_CACHE_HOME: join(homeDir, ".cache"),
      ...(browserExecutable ? { REMOTION_BROWSER_EXECUTABLE: browserExecutable } : {}),
    });
    const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,pix_fmt", "-of", "json", target], tempRoot, 30000)).stdout);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    if (!video || video.codec_name !== "prores" || !String(video.pix_fmt).startsWith("yuva")) throw new Error("style render did not produce an alpha ProRes overlay");
    return {
      outputPath: target,
      codec: video.codec_name,
      pixelFormat: video.pix_fmt,
      width: Number(video.width),
      height: Number(video.height),
      durationMs: Math.round(Number(probe.format?.duration || 0) * 1000),
      alpha: true,
      isolation: "bwrap-network-namespace",
      networkIsolated: true,
      sha256: await sha256File(target),
    };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
