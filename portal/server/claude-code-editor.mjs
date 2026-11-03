import { promises as fs, constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeOutput, detectBlackFrames } from "./render.mjs";
import { validateEditPlan } from "./edit-plan.mjs";
import { workspacePath } from "./video-agent-tools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EDITOR_MODEL = "claude-opus-5-5";
export const EDITOR_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const activeProjects = new Set();
const controlDir = (dir) => join(dirname(dir), `.control-${basename(dir)}`);

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function editorState() {
  return { engine: "claude-code", model: EDITOR_MODEL, available: spawnSync("claude", ["--version"], { timeout: 5000, encoding: "utf8" }).status === 0 && spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0 };
}

function agentEnvironment() {
  const env = { ...process.env };
  // Portal credentials are authoritative; inherited subscription/relay auth must not override them.
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|VOLCENGINE_|TENCENTCLOUD_|PEXELS_|PIXABAY_|LLM_)/.test(key)) delete env[key];
  env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_MODEL = EDITOR_MODEL;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  return env;
}

export async function prepareWorkspace(project, phase, options = {}) {
  const projectDir = resolve(project.dir);
  const runsRoot = join(projectDir, "agent-runs");
  await fs.mkdir(runsRoot, { recursive: true });
  const runId = ["render", "chat-edit"].includes(phase) || (phase === "plan" && project.editor?.runId) ? project.editor.runId : randomUUID();
  if (!runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error("请先让 Claude Code 生成并审阅预览，再导出成片");
  const dir = join(runsRoot, runId);
  await fs.mkdir(dir, { recursive: true });
  const skillRoot = join(dir, ".claude", "skills", "video-edit");
  // Always refresh the project adapter before a planning/replan turn. Existing
  // workspaces otherwise keep stale skill instructions after an upgrade.
  if (phase === "plan" || options.refreshSkill) {
    await fs.rm(skillRoot, { recursive: true, force: true });
    await fs.cp(join(root, "agent-skills/video-edit"), skillRoot, { recursive: true });
  }
  if (phase === "plan") {
    if (!project.editor?.runId) await fs.copyFile(project.media.path, join(dir, "input.mp4"), fsConstants.COPYFILE_FICLONE);
    for (const skill of ["hyperframes", "hyperframes-cli"]) {
      // Prefer installed skills, without installing or changing global Claude configuration.
      const installed = join(process.env.HOME || "/home/ben", ".agents/skills", skill);
      await fs.cp(installed, join(dir, `.claude/skills/${skill}`), { recursive: true, dereference: true });
    }
    const assets = [];
    for (const [index, asset] of (project.brollAssets || []).entries()) {
      const name = `broll-${index + 1}${extname(asset.path) || ".mp4"}`;
      await fs.rm(join(dir, name), { force: true });
      await fs.copyFile(asset.path, join(dir, name), fsConstants.COPYFILE_FICLONE);
      assets.push({ id: asset.id, filename: asset.filename, path: name, durationMs: asset.durationMs, width: asset.width, height: asset.height, licenseConfirmed: asset.licenseConfirmed, licenseName: asset.licenseName, licenseUrl: asset.licenseUrl, sourceUrl: asset.sourceUrl, sha256: asset.sha256 });
    }
    if (project.music?.path) {
      const musicName = `music${extname(project.music.path)}`;
      await fs.rm(join(dir, musicName), { force: true });
      await fs.copyFile(project.music.path, join(dir, musicName), fsConstants.COPYFILE_FICLONE);
    }
    await fs.writeFile(join(dir, "assets.json"), JSON.stringify({ broll: assets, music: project.music ? { path: `music${extname(project.music.path)}`, licenseConfirmed: project.music.licenseConfirmed } : null }, null, 2));
  }
  await fs.writeFile(join(dir, "transcript.json"), JSON.stringify(project.transcript, null, 2));
  await fs.writeFile(join(dir, "brief.json"), JSON.stringify({ phase, projectId: project.id, goal: project.goal, style: project.style, comments: project.comments || [], media: { ...project.media, path: "input.mp4" }, approvedPlan: ["render", "chat-edit"].includes(phase) ? project.plan : undefined, chatTurn: options.chatTurn || undefined, chatContext: options.chatContext || undefined, latestVersion: project.editSession?.latestVersion || project.editor?.version || 1 }, null, 2));
  return { dir, runId };
}

export async function invokeClaudeCode({ dir, phase, onEvent = () => {}, budgetUsd = phase === "plan" ? 4 : 6, timeoutMs = EDITOR_SESSION_TIMEOUT_MS, sessionId = null, resume = false }) {
  await fs.mkdir(controlDir(dir), { recursive: true });
  const auditPath = join(controlDir(dir), `tools-${phase}.jsonl`);
  const configPath = join(controlDir(dir), `mcp-${phase}.json`);
  await fs.writeFile(auditPath, "");
  const toolEnv = { PATH: process.env.PATH, HOME: process.env.HOME || "/home/ben", PEXELS_API_KEY: process.env.PEXELS_API_KEY || "", PIXABAY_API_KEY: process.env.PIXABAY_API_KEY || "" };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { video: { command: process.execPath, args: [join(root, "server/video-agent-tools.mjs"), dir, auditPath], env: toolEnv } } }));
  const prompt = buildEditorPrompt(phase);
  const args = ["--bare", "--restricted", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", configPath, "--model", EDITOR_MODEL, "--effort", "high", "--permission-mode", "dontAsk", "--tools", "Read,Skill", "--allowedTools", "Read,Skill,mcp__video__*", "--max-budget-usd", String(budgetUsd)];
  if (resume && sessionId) args.push("--resume", sessionId);
  else if (sessionId) args.push("--session-id", sessionId);
  if (phase !== "chat-edit") args.push("--no-session-persistence");
  args.push("--output-format", "stream-json", "--verbose", "--print", prompt);
  let result;
  const models = new Set();
  const events = [];
  await new Promise((resolveRun, reject) => {
    const child = spawn("claude", args, { cwd: dir, env: agentEnvironment(), detached: true });
    let pending = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } }, timeoutMs);
    const record = (line) => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === "assistant") {
        if (event.message?.model) models.add(event.message.model);
        for (const item of event.message?.content || []) {
          if (item.type === "tool_use") { const entry = { at: new Date().toISOString(), tool: item.name }; events.push(entry); onEvent(entry); }
          if (item.type === "text" && item.text) onEvent({ message: item.text.slice(0, 500) });
        }
      }
      if (event.type === "result") result = event;
    };
    child.stdout.on("data", (chunk) => { pending += chunk; const lines = pending.split("\n"); pending = lines.pop(); lines.forEach(record); if (pending.length > 2000000) { pending = ""; } });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (pending) record(pending); if (timedOut) reject(new Error("Claude Code 会话超时，已保留工程，可重试")); else if (code !== 0 || !result || result.is_error || result.subtype !== "success") reject(new Error(`Claude Code 未完成：${result?.result || result?.errors?.join("; ") || stderr || result?.subtype || code}`)); else resolveRun(); });
  });
  if (!models.size || [...models].some((model) => !model.startsWith(EDITOR_MODEL))) throw new Error(`Claude Code 未确认使用指定 Opus 5.5 模型：${[...models].join(", ") || "无模型证据"}`);
  const brollAuditPath = join(controlDir(dir), "broll-audit.jsonl");
  const downloads = (await fs.readFile(brollAuditPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const receipt = { engine: "claude-code", model: EDITOR_MODEL, reportedModels: [...models], phase, sessionId: result.session_id, costUsd: result.total_cost_usd, turns: result.num_turns, events, brollDownloads: downloads.filter((entry) => entry.tool === "download_broll") };
  await fs.writeFile(join(controlDir(dir), `session-${phase}.json`), JSON.stringify(receipt, null, 2));
  return receipt;
}

export function buildEditorPrompt(phase) {
  const remotionInstruction = ["plan", "chat-edit"].includes(phase)
    ? "After edit-plan.json is stable, use mcp__video__render_remotion_preview for one comparison render when the Remotion runtime is available. Inspect at least two moments in its returned preview with mcp__video__view_frame. Use a second comparison render only after changing visualEvents. This is a separate design comparison; do not claim it is the normal Wayne preview or final export. If the tool fails, record the reason and continue with the standard Wayne preview."
    : "Do not create an additional Remotion comparison during the final export phase.";
  return `/video-edit\nUse this skill for the ${phase} phase. Start by reading .claude/skills/video-edit/SKILL.md with mcp__video__read_file. The project references are inside that skill directory: read .claude/skills/video-edit/references/public-skill-audit.md, .claude/skills/video-edit/references/editorial-grammar.md, and .claude/skills/video-edit/references/verification.md. Then read brief.json, transcript.json and assets.json. Use the project adapter rules, not a generic downloaded skill. You must operate the actual tools and visually inspect real video frames. Implement the edit yourself; do not just describe a plan. Read the HyperFrames skill when using that tool. Run .claude/skills/video-edit/scripts/verify-render.mjs on the preview or final when applicable. For portrait 9:16 talking-head footage, do not default to a talking-head-only edit: evaluate at least one licensed B-roll search for each concrete visual intent, and use 1–3 B-roll inserts when the visual adds information; absence of product UI is not a reason to skip generic but relevant scene-setting footage. Use HyperFrames for at least one executable animated overlay or transition in every plan when the runtime is available. Keep title/emphasis cards short, compact and inside the portrait safe area; prefer split-screen, B-roll cover, punch-in, kinetic phrase captions and motion accents over large persistent text panels. ${remotionInstruction} End only after writing manifest.json with phase=${phase}, actual output paths and honest visual review. Keep work bounded: at most two repair cycles and no unrelated exploration. ${phase === "render" ? "An approved preview and editable sources already exist in this workspace. Read them and apply the user's timestamped feedback." : phase === "chat-edit" ? "This is a continuation turn. Read the latest approved version and the chat turn in brief.json. Apply only the user's latest request, preserve unrelated decisions, generate a new low-resolution preview, and leave the prior version intact." : "Produce a complete low-resolution edited preview and editable sources for approval, not a final delivery."}`;
}

export async function validateAgentOutput(dir, phase) {
  const manifest = JSON.parse(await fs.readFile(await workspacePath(dir, "manifest.json"), "utf8"));
  if (manifest.phase !== phase || manifest.review?.passed !== true || typeof manifest.review.notes !== "string" || !manifest.review.notes.trim()) throw new Error("缺少真实阶段产物或视觉审查说明");
  const mainPath = await workspacePath(dir, manifest.main);
  if (extname(mainPath) !== ".mp4") throw new Error("主视频必须是 MP4");
  const probe = await probeOutput(mainPath);
  const brief = JSON.parse(await fs.readFile(await workspacePath(dir, "brief.json"), "utf8"));
  const hash = createHash("sha256").update(await fs.readFile(mainPath)).digest("hex");
  const audit = (await fs.readFile(join(controlDir(dir), `tools-${phase}.jsonl`), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const frames = audit.filter((event) => event.tool === "view_frame" && event.video === manifest.main && event.sha256 === hash && !event.error);
  if (new Set(frames.map((frame) => frame.timeSeconds)).size < 3) throw new Error("最终版本缺少至少三张实际送入 Claude 视觉的审片帧");
  if (Math.max(...frames.map((frame) => frame.timeSeconds)) - Math.min(...frames.map((frame) => frame.timeSeconds)) < probe.durationMs / 2000) throw new Error("审片帧必须覆盖至少一半成片时长");
  if (phase === "plan" && new Set(audit.filter((event) => event.tool === "view_frame" && event.video === "input.mp4" && !event.error).map((event) => event.timeSeconds)).size < 3) throw new Error("缺少原片视觉检查");
  if (probe.avSyncDeltaMs === null || probe.avDurationDeltaMs === null || probe.avSyncDeltaMs > 250 || probe.avDurationDeltaMs > 250) throw new Error("音视频同步检查未通过");
  const blackFrames = await detectBlackFrames(mainPath);
  if (blackFrames.length) throw new Error("成片存在持续黑帧，需要 Claude Code 修正");
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) throw new Error("缺少可编辑工程源码");
  const subtitle = await workspacePath(dir, manifest.subtitle);
  if (extname(subtitle) !== ".srt" || !(await fs.readFile(subtitle, "utf8")).includes("-->")) throw new Error("缺少最终时间线字幕");
  const files = [{ path: manifest.main, kind: ["plan", "chat-edit"].includes(phase) ? "preview" : "video", ...probe }, { path: manifest.subtitle, kind: "subtitle" }];
  const currentPlanSha256 = await sha256File(await workspacePath(dir, "edit-plan.json"));
  const currentSourceSha256 = await sha256File(await workspacePath(dir, "input.mp4"));
  const remotionComparisons = [];
  for (const entry of audit.filter((event) => event.tool === "render_remotion_preview" && !event.error)) {
    if (entry.editPlanSha256 !== currentPlanSha256 || entry.sourceMediaSha256 !== currentSourceSha256) {
      remotionComparisons.push({ status: "stale", remotionVersion: entry.remotionVersion });
      continue;
    }
    const previewPath = await workspacePath(dir, entry.previewPath);
    const previewSha256 = await sha256File(previewPath);
    if (previewSha256 !== entry.sha256?.preview || entry.qc?.passed !== true) throw new Error("Remotion 对照预览的哈希或 QC 记录无效");
    const reviewFrames = audit.filter((event) => event.tool === "view_frame" && event.video === entry.previewPath && event.sha256 === previewSha256 && !event.error);
    if (new Set(reviewFrames.map((frame) => frame.timeSeconds)).size < 2) throw new Error("Remotion 对照预览需要至少两张真实审查帧");
    files.push({ path: entry.previewPath, kind: "remotion-preview", engine: "remotion", createdBy: "claude-code", width: entry.width, height: entry.height, durationMs: entry.durationMs, sha256: previewSha256 });
    remotionComparisons.push({ status: "reviewed", engine: "remotion", remotionVersion: entry.remotionVersion, previewSha256, timelineSha256: entry.timelineSha256, frames: reviewFrames.map(({ timeSeconds, sha256 }) => ({ timeSeconds, sha256 })) });
  }
  const brollAudit = (await fs.readFile(join(controlDir(dir), "broll-audit.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const downloaded = new Map(brollAudit.filter((entry) => entry.tool === "download_broll").map((entry) => [entry.assetId, entry]));
  const hyperframesSource = (manifest.sources || []).find((source) => /hyperframes|\.html$/i.test(source));
  const hyperframesExecuted = audit.some((event) => event.tool === "execute" && /hyperframes/i.test(String(event.command || "")));
  if (["plan", "render", "chat-edit"].includes(phase) && probe.height > probe.width && (!manifest.hyperframes?.rendered || !hyperframesSource || !hyperframesExecuted)) {
    throw new Error("竖屏预览必须包含实际执行并审片的 HyperFrames 动效");
  }
  const providersConfigured = Boolean(process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY);
  if (phase === "plan" && probe.height > probe.width && probe.durationMs >= 15000 && providersConfigured && (!Array.isArray(manifest.broll) || manifest.broll.length === 0)) {
    throw new Error("当前已配置 B-roll 提供商，竖屏长口播至少需要一段经过审查的 B-roll");
  }
  for (const event of Array.isArray(manifest.broll) ? manifest.broll : []) {
    if (!downloaded.has(event.assetId)) throw new Error(`B-roll ${event.assetId} 没有对应下载证据`);
    const reviewTime = Number(event.reviewTimeSeconds);
    const reviews = Number.isFinite(reviewTime)
      ? frames.filter((frame) => Math.abs(Number(frame.timeSeconds) - reviewTime) <= 0.35)
      : frames.filter((frame) => Number(frame.timeSeconds) >= Number(event.startMs) / 1000 && Number(frame.timeSeconds) <= Number(event.endMs) / 1000);
    if (!reviews.length) throw new Error(`B-roll ${event.assetId} 缺少插入区间的最终审片帧`);
  }
  for (const source of manifest.sources) {
    if (![".py", ".mjs", ".js", ".css", ".html", ".json", ".ass", ".srt", ".md", ".txt"].includes(extname(source))) throw new Error("不支持的工程源码类型");
    await workspacePath(dir, source); files.push({ path: source, kind: "source" });
  }
  for (const short of manifest.shorts || []) {
    if (!["render", "chat-edit"].includes(phase) || !Number.isInteger(short.slot) || short.slot < 1 || short.slot > 5) throw new Error("Shorts 清单无效");
    const path = await workspacePath(dir, short.path);
    const shortProbe = await probeOutput(path);
    if (shortProbe.width !== 1080 || shortProbe.height !== 1920) throw new Error("Shorts 必须为 1080×1920");
    files.push({ ...short, kind: "short", ...shortProbe });
  }
  return { manifest, files, qc: { passed: true, main: probe, engine: "claude-code", model: EDITOR_MODEL, subtitlesBurnedIn: true, audioVideoSyncChecked: true, noUnexpectedBlackFrames: true, visualReview: { method: "claude-code-vision", frames: frames.map(({ timeSeconds, sha256 }) => ({ timeSeconds, sha256 })), notes: manifest.review.notes }, remotionComparisons: remotionComparisons.length ? remotionComparisons : null, requiresHumanReview: true } };
}

export async function saveAgentOutput(project, phase, dir, runId, receipt) {
  const output = await validateAgentOutput(dir, phase);
  const planData = JSON.parse(await fs.readFile(await workspacePath(dir, "edit-plan.json"), "utf8"));
  const brollAudit = (await fs.readFile(join(controlDir(dir), "broll-audit.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const brollAssets = brollAudit.filter((entry) => entry.tool === "download_broll").map((entry) => ({ id: entry.assetId, filename: entry.filename, path: join(dir, entry.path), durationMs: entry.durationMs, width: entry.width, height: entry.height, licenseConfirmed: true, sourceUrl: entry.sourceUrl, licenseName: entry.licenseName, licenseUrl: entry.licenseUrl, sha256: entry.sha256, provider: entry.provider, providerId: entry.providerId }));
  const plan = validateEditPlan(planData, project.media.durationMs, { requireFiveShorts: false, allowCustomVisualEvents: true, brollAssets: [...(project.brollAssets || []), ...brollAssets] });
  const version = phase === "render" ? project.editor.version : Math.max(0, ...(project.artifacts || []).map((artifact) => artifact.version || 1)) + 1;
  const artifactsDir = join(resolve(project.dir), "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifacts = [];
  const files = [...output.files, ...brollAssets.map((asset) => ({ path: asset.path.replace(`${dir}/`, ""), kind: "broll", assetId: asset.id, sourceUrl: asset.sourceUrl, licenseName: asset.licenseName, licenseUrl: asset.licenseUrl, provider: asset.provider, providerId: asset.providerId, sha256: asset.sha256 })), { path: "edit-plan.json", kind: "plan" }, { path: `session-${phase}.json`, kind: "agent-log", control: true }, { path: `tools-${phase}.jsonl`, kind: "agent-log", control: true }];
  for (const [index, file] of files.entries()) {
    const name = `cc-v${version}-${phase}-${index + 1}${extname(file.path)}`;
      await fs.copyFile(file.control ? join(controlDir(dir), file.path) : resolve(dir, file.path), join(artifactsDir, name), fsConstants.COPYFILE_EXCL);
    const { path: _path, control: _control, ...metadata } = file;
    artifacts.push({ ...metadata, name, version });
  }
  const qc = { ...output.qc, version };
  const qcName = `cc-v${version}-${phase}-qc.json`;
  await fs.writeFile(join(artifactsDir, qcName), JSON.stringify(qc, null, 2), { flag: "wx" });
  artifacts.push({ name: qcName, kind: "qc", version });
  const persistedBrollAssets = brollAssets.map((asset) => ({ ...asset, path: join(artifactsDir, `cc-v${version}-${phase}-${files.findIndex((file) => file.assetId === asset.id) + 1}${extname(asset.path)}`) }));
  return { plan, artifacts, brollAssets: persistedBrollAssets, qc, editor: { engine: "claude-code", model: EDITOR_MODEL, runId, version, phase, sessionId: receipt.sessionId, costUsd: receipt.costUsd } };
}

export async function editWithClaudeCode(project, phase, onEvent, options = {}) {
  if (activeProjects.has(project.id)) throw Object.assign(new Error("当前项目已有 Claude Code 会话在执行"), { statusCode: 409 });
  activeProjects.add(project.id);
  try {
    const { dir, runId } = await prepareWorkspace(project, phase, options);
    // Persist the workspace identity before starting Claude Code. A timeout can
    // happen after files were written but before saveAgentOutput returns; the
    // next retry must still be able to reopen this exact workspace.
    if (phase === "plan" && project.editor?.runId !== runId) {
      project.editor = { ...project.editor, engine: "claude-code", model: EDITOR_MODEL, runId, phase };
      if (typeof options.persistProject === "function") await options.persistProject(project);
    }
    const chatSessionId = phase === "chat-edit" ? (options.sessionId || randomUUID()) : null;
    const receipt = await invokeClaudeCode({ dir, phase, onEvent, sessionId: chatSessionId, resume: Boolean(options.sessionId) });
    return await saveAgentOutput(project, phase, dir, runId, receipt);
  } finally { activeProjects.delete(project.id); }
}
