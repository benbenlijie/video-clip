import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerBrollTools } from "./video-broll-tools.mjs";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function workspacePath(root, relative, { existing = true } = {}) {
  if (typeof relative !== "string" || !relative || relative.includes("\0")) throw new Error("Invalid workspace path");
  const base = await fs.realpath(root);
  const target = resolve(base, relative);
  if (!target.startsWith(`${base}${sep}`)) throw new Error("Path must remain inside the edit workspace");
  let parent = existing ? target : dirname(target);
  while (true) {
    try {
      const real = await fs.realpath(parent);
      if (real !== base && !real.startsWith(`${base}${sep}`)) throw new Error("Symlink escapes the edit workspace");
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || existing) throw error;
      parent = dirname(parent);
    }
  }
  // Existing leaf symlinks must also resolve inside the workspace before writes.
  if (!existing) {
    try { return await workspacePath(base, relative); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}

export async function sandboxCommand(workDir, command, timeoutMs = 180000) {
  const node = await fs.realpath(process.execPath);
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--ro-bind", "/etc/alternatives", "/etc/alternatives", "--ro-bind", node, "/tools/node", "--ro-bind", join(portalRoot, "hyperframes-runtime"), "/tools/hyperframes", "--bind", resolve(workDir), "/work", "--chdir", "/work", "--clearenv", "--setenv", "PATH", "/tools:/usr/bin:/bin", "--setenv", "HOME", "/tmp/home", "--setenv", "LANG", "C.UTF-8", "--setenv", "HYPERFRAMES_SKIP_SKILLS", "1"];
  args.push("--dir", "/tmp/home/.cache", "--dir", "/tmp/home/.cache/hyperframes");
  for (const name of ["chrome", "fonts"]) {
    const cache = join(process.env.HOME || "/home/ben", ".cache/hyperframes", name);
    try { await fs.access(cache); args.push("--ro-bind", cache, `/tmp/home/.cache/hyperframes/${name}`); } catch { /* Optional renderer cache. */ }
  }
  args.push("--", "/usr/bin/bash", "-c", command);
  return new Promise((resolveRun, reject) => {
    const child = spawn("bwrap", args, { detached: true, env: { PATH: process.env.PATH } });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }, timeoutMs);
    const append = (chunk) => { output = (output + chunk).slice(-18000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, timedOut, output }); });
  });
}

export async function startMediaTools(workDir, auditPath) {
  const root = await fs.realpath(workDir);
  const audit = async (entry) => fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const server = new McpServer({ name: "video-editing", version: "1.0.0" });
  registerBrollTools(server, { workspaceDir: root, auditPath: join(dirname(auditPath), "broll-audit.jsonl"), cachePath: join(dirname(auditPath), "broll-cache.json") });
  const register = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async (args) => {
    try { return await handler(args); } catch (error) { await audit({ tool: name, error: error.message }); return { isError: true, content: [{ type: "text", text: error.message }] }; }
  });
  register("execute", "Run FFmpeg, FFprobe, Python, Node or HyperFrames commands in an isolated offline Linux workspace. Only /work is writable. Paths: /work, /tools/node, /tools/hyperframes/node_modules/hyperframes/bin/hyperframes.mjs. Write your own scripts; inspect and iterate.", { command: z.string().max(30000), timeoutSeconds: z.number().min(1).max(240).default(180) }, async ({ command, timeoutSeconds }) => {
    const result = await sandboxCommand(root, command, timeoutSeconds * 1000);
    await audit({ tool: "execute", command, code: result.code, timedOut: result.timedOut });
    return { isError: result.code !== 0, content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  register("write_file", "Create or update an editable script, subtitle file, composition HTML, edit plan or manifest inside the workspace. Use relative paths.", { path: z.string(), content: z.string().max(300000) }, async ({ path, content }) => {
    const target = await workspacePath(root, path, { existing: false });
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    await audit({ tool: "write_file", path });
    return { content: [{ type: "text", text: `Written ${path}` }] };
  });
  register("read_file", "Read a UTF-8 script, skill, plan, transcript, manifest or command output from this edit workspace.", { path: z.string() }, async ({ path }) => {
    const target = await workspacePath(root, path);
    if ((await fs.stat(target)).size > 350000) throw new Error("Text file exceeds 350KB; use execute to inspect a range");
    await audit({ tool: "read_file", path });
    return { content: [{ type: "text", text: await fs.readFile(target, "utf8") }] };
  });
  register("view_frame", "Actually view an image frame from original, preview or final video. Returns the image to Claude vision and records its source hash. Use after every revision. video is workspace-relative; timeSeconds is in that video's timeline.", { video: z.string(), timeSeconds: z.number().min(0) }, async ({ video, timeSeconds }) => {
    const target = await workspacePath(root, video);
    const digest = createHash("sha256").update(await fs.readFile(target)).digest("hex");
    const frame = `review-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
    const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = await sandboxCommand(root, `ffmpeg -v error -ss ${timeSeconds} -i ${quoted(`/work/${video}`)} -frames:v 1 -vf 'scale=720:1280:force_original_aspect_ratio=decrease' -q:v 3 ${quoted(`/work/${frame}`)}`, 45000);
    if (result.code !== 0) throw new Error(result.output);
    const data = await fs.readFile(join(root, frame));
    await audit({ tool: "view_frame", video, timeSeconds, sha256: digest, frame });
    return { content: [{ type: "text", text: `${video} at ${timeSeconds}s; sha256=${digest}` }, { type: "image", mimeType: "image/jpeg", data: data.toString("base64") }] };
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMediaTools(process.argv[2], process.argv[3]);
}
