import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { workspacePath } from "./workspace-path.mjs";

const serverRoot = dirname(fileURLToPath(import.meta.url));
const portalRoot = resolve(serverRoot, "..");
export const downloaderScript = join(portalRoot, "agent-skills", "wx-video-download", "scripts", "wx_video_dl.py");

const RESOLVE_TIMEOUT_MS = Number(process.env.WX_VIDEO_RESOLVE_TIMEOUT_MS || 120000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.WX_VIDEO_DOWNLOAD_TIMEOUT_MS || 1800000);

function pythonBin() {
  return process.env.WX_VIDEO_PYTHON || "python3";
}

function lastJson(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* keep scanning upward */ }
  }
  return null;
}

/** 运行 Python 下载器，返回 { code, json, stderr }。stdout 只承载一个 JSON 对象。 */
export async function runWxVideoCli(args, { cwd = portalRoot, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  const child = spawn(pythonBin(), [downloaderScript, ...args, "--json"], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  }, timeoutMs);
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-262144); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
  const code = await new Promise((resolveRun, rejectRun) => {
    child.on("error", rejectRun);
    child.on("close", resolveRun);
  }).finally(() => clearTimeout(timer));
  return { code, json: lastJson(stdout), stderr: timedOut ? `${stderr}\n[timeout after ${timeoutMs}ms]` : stderr, timedOut };
}

/** 解析分享链接，返回元数据与直链（不落盘）。 */
export async function resolveWxVideo(link, options = {}) {
  const { code, json, stderr } = await runWxVideoCli(["resolve", String(link)], { ...options, timeoutMs: options.timeoutMs ?? RESOLVE_TIMEOUT_MS });
  if (!json) throw new Error(`解析器没有返回 JSON：${stderr.slice(-400) || `exit ${code}`}`);
  if (json.ok !== true) throw new Error(json.error || `解析失败（exit ${code}）`);
  return json;
}

/** 下载到指定绝对目录；调用方负责把目录限制在工作区内。 */
export async function downloadWxVideo({ link, outDir, name, metaPath, force = false }, options = {}) {
  const args = ["download", String(link), "--out", String(outDir)];
  if (name) args.push("--name", String(name));
  if (metaPath) args.push("--meta", String(metaPath));
  if (force) args.push("--force");
  const { code, json, stderr } = await runWxVideoCli(args, { ...options, timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS });
  if (!json) throw new Error(`下载器没有返回 JSON：${stderr.slice(-400) || `exit ${code}`}`);
  if (json.ok !== true) throw new Error(`${json.code || "download-failed"}: ${json.error}`);
  return { ...json, logs: stderr.slice(-2000) };
}

/** 探测本地视频文件。 */
export async function probeWxVideo(filePath, options = {}) {
  const { code, json, stderr } = await runWxVideoCli(["probe", String(filePath)], options);
  if (!json) throw new Error(`探测失败：${stderr.slice(-400) || `exit ${code}`}`);
  if (json.ok !== true) throw new Error(json.error || `探测失败（exit ${code}）`);
  return json;
}

function assertInside(root, target) {
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("路径必须留在工作区内");
  return target;
}

/** 把工作区里的 downloads/ 列出来，按修改时间倒序。 */
export async function listWxVideos(root, subdir = "downloads") {
  const dir = await workspacePath(root, subdir);
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mp4|mov|m4v|mkv|webm)$/i.test(entry.name)) continue;
    const info = await fs.stat(join(dir, entry.name));
    files.push({ name: entry.name, path: join(dir, entry.name), bytes: info.size, modifiedAt: info.mtime.toISOString() });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function startWxVideoTools(workDir, auditPath) {
  const root = await fs.realpath(workDir);
  const audit = async (entry) => {
    if (!auditPath) return;
    await fs.mkdir(dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
  const wrap = (name, handler) => async (args) => {
    try {
      const payload = await handler(args || {});
      await audit({ tool: name, ok: true, ...(payload?.path ? { path: payload.path } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (error) {
      await audit({ tool: name, ok: false, error: error.message });
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  };

  const server = new McpServer({ name: "wx-video", version: "1.0.0" });

  server.registerTool(
    "resolve_video",
    {
      description:
        "解析视频号分享链接为元数据 + 带签名的媒体直链，不写文件。用于先确认标题/作者/清晰度，或把直链交给别的下载器。官方网页端没有媒体字段，必须经解析器；不要用返回的直链做长期存储。",
      inputSchema: { link: z.string().min(4).describe("视频号分享链接或整段分享口令") },
    },
    wrap("resolve_video", ({ link }) => resolveWxVideo(link)),
  );

  server.registerTool(
    "download_video",
    {
      description:
        "把视频号分享链接下载到工作区并校验（ffprobe 视频流 + SHA-256）。默认写入 downloads/，返回绝对路径、字节数、时长、分辨率、编码和哈希。只有解析器返回直链时才可能成功；直播回放/私享内容会明确失败。",
      inputSchema: {
        link: z.string().min(4).describe("视频号分享链接、分享口令，或已经拿到的 stodownload 直链"),
        subdir: z.string().default("downloads").describe("工作区内的子目录，默认 downloads/"),
        fileName: z.string().optional().describe("文件名（不含扩展名），默认用标题"),
        writeMeta: z.boolean().default(false).describe("是否在视频旁写一份同名 .json 元数据"),
        force: z.boolean().default(false).describe("同名文件是否覆盖"),
      },
    },
    wrap("download_video", async ({ link, subdir, fileName, writeMeta, force }) => {
      const dir = assertInside(root, await workspacePath(root, subdir, { existing: false }));
      await fs.mkdir(dir, { recursive: true });
      const result = await downloadWxVideo({ link, outDir: dir, name: fileName, force });
      const inside = assertInside(root, await fs.realpath(result.path));
      let metaPath;
      if (writeMeta) {
        metaPath = inside.replace(/\.(mp4|mov|m4v|mkv|webm)$/i, ".json");
        await fs.writeFile(metaPath, `${JSON.stringify({ ...result, path: inside }, null, 2)}\n`);
      }
      return { ...result, path: inside, metaPath };
    }),
  );

  server.registerTool(
    "probe_video",
    {
      description: "用 ffprobe 检查工作区内某个视频文件：时长、宽高、编码、字节数、SHA-256；没有视频流时明确报错。",
      inputSchema: { path: z.string().describe("工作区内的相对路径") },
    },
    wrap("probe_video", async ({ path }) => probeWxVideo(await workspacePath(root, path))),
  );

  server.registerTool(
    "list_videos",
    {
      description: "列出工作区 downloads/ 里已下载的视频，按修改时间倒序。",
      inputSchema: { subdir: z.string().default("downloads") },
    },
    wrap("list_videos", async ({ subdir }) => ({ ok: true, files: await listWxVideos(root, subdir) })),
  );

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 省略参数时以当前目录作为工作区，便于直接写进 .mcp.json。
  const workDir = process.argv[2] || process.cwd();
  const auditPath = process.argv[3] || join(workDir, ".audit", "wx-video.jsonl");
  await fs.mkdir(workDir, { recursive: true });
  const server = await startWxVideoTools(workDir, auditPath);
  await server.connect(new StdioServerTransport());
}
