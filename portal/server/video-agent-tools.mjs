import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compositeRemotionPreview, remotionRuntimeAvailable, renderRemotionOverlay } from "./remotion-overlay.mjs";
import { detectBlackFrames, probeOutput } from "./render.mjs";
import { toTimelineV1 } from "./timeline-contract.mjs";
import { registerBrollTools } from "./video-broll-tools.mjs";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

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
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--dev", "/dev", "--proc", "/proc", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--ro-bind", "/etc/alternatives", "/etc/alternatives", "--ro-bind", node, "/tools/node", "--ro-bind", join(portalRoot, "hyperframes-runtime"), "/tools/hyperframes", "--bind", resolve(workDir), "/work", "--chdir", "/work", "--clearenv", "--setenv", "PATH", "/tools:/usr/bin:/bin", "--setenv", "HOME", "/tmp/home", "--setenv", "LANG", "C.UTF-8", "--setenv", "HYPERFRAMES_SKIP_SKILLS", "1"];
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
  let remotionPreviewCount = 0;
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
  register("render_remotion_preview", "Render a comparison preview from the current edit-plan.json and input.mp4 using the Wayne timeline.v1 contract. Takes no paths or arbitrary code. Call after the plan is ready, inspect the returned MP4 with view_frame, and use the result only as a visual-design comparison; the normal Wayne preview and final export remain authoritative. At most two comparison renders per edit run.", {}, async () => {
    if (remotionPreviewCount >= 2) throw new Error("每轮最多生成两次 Remotion 对照预览");
    if (!(await remotionRuntimeAvailable())) throw new Error("Remotion runtime 尚未安装，本轮继续使用 Wayne 默认渲染流程");
    const [brief, transcript, assets, plan, brollAuditText] = await Promise.all([
      fs.readFile(await workspacePath(root, "brief.json"), "utf8").then(JSON.parse),
      fs.readFile(await workspacePath(root, "transcript.json"), "utf8").then(JSON.parse),
      fs.readFile(await workspacePath(root, "assets.json"), "utf8").then(JSON.parse),
      fs.readFile(await workspacePath(root, "edit-plan.json"), "utf8").then(JSON.parse),
      fs.readFile(join(dirname(auditPath), "broll-audit.jsonl"), "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error)),
    ]);
    const inputPath = await workspacePath(root, "input.mp4");
    const downloadedBroll = [];
    for (const line of brollAuditText.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.tool !== "download_broll" || !entry.assetId || !entry.filename) continue;
      const assetPath = await workspacePath(root, entry.filename);
      const sha256 = await sha256File(assetPath);
      if (entry.sha256 && entry.sha256 !== sha256) throw new Error(`B-roll 素材校验失败: ${entry.assetId}`);
      downloadedBroll.push({
        id: String(entry.assetId),
        filename: String(entry.filename),
        path: assetPath,
        durationMs: Number(entry.durationMs) || 1,
        width: Number(entry.width) || 1,
        height: Number(entry.height) || 1,
        licenseConfirmed: true,
        licenseName: entry.licenseName || null,
        licenseUrl: entry.licenseUrl || null,
        sourceUrl: entry.sourceUrl || null,
        sha256,
      });
    }
    const brollAssets = new Map((assets.broll || []).map((asset) => [String(asset.id), asset]));
    for (const asset of downloadedBroll) brollAssets.set(asset.id, asset);
    const timeline = toTimelineV1({
      id: brief.projectId || `claude-${root.split(sep).at(-1)}`,
      workflowId: "wayne-video-editing",
      goal: brief.goal,
      style: brief.style,
      editor: { version: brief.latestVersion },
      media: { ...brief.media, filename: "input.mp4", path: inputPath },
      transcript,
      plan,
      brollAssets: [...brollAssets.values()],
      music: assets.music?.path ? assets.music : null,
    });
    if (!timeline.visualEvents.length) throw new Error("当前剪辑计划没有 Hook、重点或 CTA，无法生成 Remotion 对照预览");

    const planText = await fs.readFile(await workspacePath(root, "edit-plan.json"), "utf8");
    const timelineSha256 = createHash("sha256").update(JSON.stringify(timeline)).digest("hex");
    const editPlanSha256 = createHash("sha256").update(planText).digest("hex");
    const sourceMediaSha256 = await sha256File(inputPath);
    let sequence;
    let overlayRelative;
    let previewRelative;
    let outputAvailable = false;
    do {
      sequence = ++remotionPreviewCount;
      overlayRelative = `remotion-preview-${sequence}-overlay.mov`;
      previewRelative = `remotion-preview-${sequence}.mp4`;
      const exists = await Promise.all([overlayRelative, previewRelative].map(async (relative) => {
        try { await workspacePath(root, relative); return true; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
      }));
      if (exists.some(Boolean)) continue;
      outputAvailable = true;
      break;
    } while (remotionPreviewCount < 10000);
    if (!outputAvailable) throw new Error("Remotion 预览输出编号已耗尽");
    const overlayPath = await workspacePath(root, overlayRelative, { existing: false });
    const previewPath = await workspacePath(root, previewRelative, { existing: false });
    try {
      const overlay = await renderRemotionOverlay({ timeline, outputPath: overlayPath, workDir: root });
      const preview = await compositeRemotionPreview({ inputPath, overlayPath, outputPath: previewPath });
      const blackFrames = await detectBlackFrames(previewPath);
      const durationDeltaMs = Math.abs(preview.durationMs - timeline.media.durationMs);
      const audioVideo = timeline.media.hasAudio ? await probeOutput(previewPath) : null;
      const qc = {
        passed: preview.width === timeline.media.width
          && preview.height === timeline.media.height
          && durationDeltaMs <= 250
          && blackFrames.length === 0
          && (!timeline.media.hasAudio || (audioVideo?.avSyncDeltaMs !== null && audioVideo?.avSyncDeltaMs <= 250 && audioVideo?.avDurationDeltaMs !== null && audioVideo?.avDurationDeltaMs <= 250)),
        checks: ["prores-alpha", "dimensions", "duration", ...(timeline.media.hasAudio ? ["audio-video-sync"] : []), "black-frames"],
        durationDeltaMs,
        audioVideoSyncDeltaMs: audioVideo?.avSyncDeltaMs ?? null,
        audioVideoDurationDeltaMs: audioVideo?.avDurationDeltaMs ?? null,
        blackFrameCount: blackFrames.length,
      };
      if (!qc.passed) throw new Error("Remotion 对照预览未通过 alpha、尺寸、时长、音画同步或黑帧检查");
      const result = {
        engine: "remotion",
        remotionVersion: overlay.remotionVersion,
        overlayPath: overlayRelative,
        previewPath: previewRelative,
        width: preview.width,
        height: preview.height,
        durationMs: preview.durationMs,
        timelineSha256,
        editPlanSha256,
        sourceMediaSha256,
        sha256: { overlay: overlay.sha256, preview: preview.sha256 },
        qc,
      };
      await audit({ tool: "render_remotion_preview", ...result });
      await fs.rm(overlayPath, { force: true });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      await fs.rm(overlayPath, { force: true }).catch(() => undefined);
      await fs.rm(previewPath, { force: true }).catch(() => undefined);
      throw error;
    }
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
