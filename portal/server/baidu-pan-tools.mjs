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
export const downloaderScript = join(portalRoot, "agent-skills", "baidu-pan-download", "scripts", "baidu_pan_dl.py");

const LIST_TIMEOUT_MS = Number(process.env.BAIDU_PAN_LIST_TIMEOUT_MS || 180000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.BAIDU_PAN_DOWNLOAD_TIMEOUT_MS || 7200000);

function pythonBin() {
  return process.env.BAIDU_PAN_PYTHON || "python3";
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

/** 运行 Python 下载器，返回 { code, json, stderr }。stdout 只承载一个 JSON 对象，日志在 stderr。 */
export async function runBaiduPanCli(args, { cwd = portalRoot, timeoutMs = LIST_TIMEOUT_MS, env = process.env } = {}) {
  const child = spawn(pythonBin(), [downloaderScript, ...args, "--json"], {
    cwd,
    env,
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
  return {
    code,
    json: lastJson(stdout),
    stderr: timedOut ? `${stderr}\n[timeout after ${timeoutMs}ms]` : stderr,
    timedOut,
  };
}

function unwrap(result, fallback) {
  const { code, json, stderr } = result;
  if (!json) throw new Error(`${fallback}没有返回 JSON：${stderr.slice(-400) || `exit ${code}`}`);
  if (json.ok !== true) throw new Error(`${json.code || "failed"}: ${json.error || fallback}`);
  return { ...json, logs: stderr.slice(-2000) };
}

/** 账号信息：uk、昵称、会员等级、容量。 */
export async function panWhoami(options = {}) {
  return unwrap(await runBaiduPanCli(["whoami"], options), "获取账号信息");
}

/** 列分享或网盘目录。target 可以是分享链接（可带 pwd），也可以是 / 开头的网盘路径。 */
export async function panList({ target, videosOnly = false, limit = 0 }, options = {}) {
  const args = ["list", String(target)];
  if (videosOnly) args.push("--videos");
  if (limit) args.push("--limit", String(limit));
  return unwrap(await runBaiduPanCli(args, { ...options, timeoutMs: options.timeoutMs ?? LIST_TIMEOUT_MS }), "列举文件");
}

/** 下载到指定绝对目录；调用方负责把目录限制在工作区内。 */
export async function panDownload(
  { target, outDir, pick = 0, index = "", match = "", videosOnly = false, jobs = 8, force = false, dryRun = false, panDir },
  options = {},
) {
  const args = ["download", String(target), "--out", String(outDir)];
  if (pick) args.push("--pick", String(pick));
  if (index) args.push("--index", String(index));
  if (match) args.push("--match", String(match));
  if (videosOnly) args.push("--videos");
  if (jobs) args.push("--jobs", String(jobs));
  if (force) args.push("--force");
  if (dryRun) args.push("--dry-run");
  if (panDir) args.push("--pan-dir", String(panDir));
  const result = await runBaiduPanCli(args, { ...options, timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS });
  if (result.json?.ok === false && result.json?.downloaded?.length) {
    // 部分成功：把已下到的文件也报出来，不要把成功的那部分丢掉
    return { ...result.json, logs: result.stderr.slice(-2000) };
  }
  return unwrap(result, "下载");
}

/** 探测本地视频文件。 */
export async function panProbe(filePath, options = {}) {
  return unwrap(await runBaiduPanCli(["probe", String(filePath)], options), "探测文件");
}

function assertInside(root, target) {
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("路径必须留在工作区内");
  return target;
}

export async function startBaiduPanTools(workDir, auditPath) {
  const root = await fs.realpath(workDir);
  const audit = async (entry) => {
    if (!auditPath) return;
    await fs.mkdir(dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
  const wrap = (name, handler) => async (args) => {
    try {
      const payload = await handler(args || {});
      await audit({ tool: name, ok: true, ...(payload?.outDir ? { outDir: payload.outDir } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (error) {
      await audit({ tool: name, ok: false, error: error.message });
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  };

  const server = new McpServer({ name: "baidu-pan", version: "1.0.0" });

  server.registerTool(
    "baidu_pan_whoami",
    {
      description:
        "查看当前百度网盘登录账号：uk、昵称、是否超级会员、总容量与已用容量。用于确认 Cookie 登录态是否有效；调用下载前先跑一次，能提前发现「登录已失效」而不是下到一半才失败。",
      inputSchema: {},
    },
    wrap("baidu_pan_whoami", () => panWhoami()),
  );

  server.registerTool(
    "baidu_pan_list",
    {
      description:
        "列举百度网盘分享链接或网盘目录的内容（名称/大小/是否视频），不下载。target 支持 `https://pan.baidu.com/s/xxx?pwd=xxxx` 形式，或 `/我的资源/xxx` 这样的网盘路径。先列后下可以避免下错文件，也能把总大小报给用户。",
      inputSchema: {
        target: z.string().min(2).describe("分享链接（含提取码）或 / 开头的网盘路径"),
        videosOnly: z.boolean().default(false).describe("只保留视频文件"),
        limit: z.number().int().min(0).default(0).describe("最多返回多少条，0 表示不限制"),
      },
    },
    wrap("baidu_pan_list", ({ target, videosOnly, limit }) => panList({ target, videosOnly, limit })),
  );

  server.registerTool(
    "baidu_pan_download",
    {
      description:
        "把百度网盘分享或网盘目录里的文件下载到工作区并校验（大小 + ffprobe 视频流）。默认写入 downloads/。多线程 Range 分片，直链必须用 pan.baidu.com 的 UA 才不会 403。别人的分享会先转存到自己网盘再下，因此可能占用网盘空间。",
      inputSchema: {
        target: z.string().min(2).describe("分享链接（含提取码）或 / 开头的网盘路径"),
        subdir: z.string().default("downloads").describe("工作区内的子目录，默认 downloads/"),
        pick: z.number().int().min(0).default(0).describe("只下前 N 个文件"),
        index: z.string().default("").describe("按 1 起算的序号挑选，如 \"1,3,5\""),
        match: z.string().default("").describe("文件名包含该子串才下"),
        videosOnly: z.boolean().default(false).describe("只下视频"),
        jobs: z.number().int().min(1).max(16).default(8).describe("每个文件的分片线程数"),
        force: z.boolean().default(false).describe("覆盖同名文件"),
        dryRun: z.boolean().default(false).describe("只列出将要下载的文件，不落盘"),
        panDir: z.string().default("").describe("转存目标网盘目录（别人的分享时使用），默认 /来自分享/<分享名>"),
      },
    },
    wrap("baidu_pan_download", async (args) => {
      const dir = assertInside(root, await workspacePath(root, args.subdir, { existing: false }));
      await fs.mkdir(dir, { recursive: true });
      const result = await panDownload({
        target: args.target,
        outDir: dir,
        pick: args.pick,
        index: args.index,
        match: args.match,
        videosOnly: args.videosOnly,
        jobs: args.jobs,
        force: args.force,
        dryRun: args.dryRun,
        panDir: args.panDir || undefined,
      });
      const downloaded = (result.downloaded || []).map((item) => ({
        ...item,
        path: assertInside(root, resolve(item.path)),
      }));
      return { ...result, outDir: dir, downloaded };
    }),
  );

  server.registerTool(
    "baidu_pan_probe",
    {
      description: "用 ffprobe 检查工作区内某个文件：时长、宽高、编码、字节数。下载后想确认「真的是视频」时使用。",
      inputSchema: { path: z.string().describe("工作区内的相对路径") },
    },
    wrap("baidu_pan_probe", async ({ path }) => panProbe(await workspacePath(root, path))),
  );

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 省略参数时以当前目录作为工作区，便于直接写进 .mcp.json。
  const workDir = process.argv[2] || process.cwd();
  const auditPath = process.argv[3] || join(workDir, ".audit", "baidu-pan.jsonl");
  await fs.mkdir(workDir, { recursive: true });
  const server = await startBaiduPanTools(workDir, auditPath);
  await server.connect(new StdioServerTransport());
}
