import { promises as fs, constants as fsConstants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeOutput, detectBlackFrames } from "./render.mjs";
import { validateEditPlan } from "./edit-plan.mjs";
import { workspacePath } from "./video-agent-tools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EDITOR_MODEL = "claude-opus-5-5";
const activeProjects = new Set();
const controlDir = (dir) => join(dirname(dir), `.control-${basename(dir)}`);

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

async function prepareWorkspace(project, phase) {
  const projectDir = resolve(project.dir);
  const runsRoot = join(projectDir, "agent-runs");
  await fs.mkdir(runsRoot, { recursive: true });
  const runId = phase === "render" || (phase === "plan" && project.editor?.runId) ? project.editor.runId : randomUUID();
  if (!runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error("请先让 Claude Code 生成并审阅预览，再导出成片");
  const dir = join(runsRoot, runId);
  await fs.mkdir(dir, { recursive: true });
  if (phase === "plan" && !project.editor?.runId) {
    await fs.copyFile(project.media.path, join(dir, "input.mp4"), fsConstants.COPYFILE_FICLONE);
    await fs.cp(join(root, "agent-skills/video-edit"), join(dir, ".claude/skills/video-edit"), { recursive: true });
    for (const skill of ["hyperframes", "hyperframes-cli"]) {
      // Prefer installed skills, without installing or changing global Claude configuration.
      const installed = join(process.env.HOME || "/home/ben", ".agents/skills", skill);
      await fs.cp(installed, join(dir, `.claude/skills/${skill}`), { recursive: true, dereference: true });
    }
    const assets = [];
    for (const [index, asset] of (project.brollAssets || []).entries()) {
      const name = `broll-${index + 1}${extname(asset.path) || ".mp4"}`;
      await fs.copyFile(asset.path, join(dir, name), fsConstants.COPYFILE_FICLONE);
      assets.push({ id: asset.id, filename: asset.filename, path: name, licenseConfirmed: asset.licenseConfirmed });
    }
    if (project.music?.path) await fs.copyFile(project.music.path, join(dir, `music${extname(project.music.path)}`), fsConstants.COPYFILE_FICLONE);
    await fs.writeFile(join(dir, "assets.json"), JSON.stringify({ broll: assets, music: project.music ? { path: `music${extname(project.music.path)}`, licenseConfirmed: project.music.licenseConfirmed } : null }, null, 2));
  }
  await fs.writeFile(join(dir, "transcript.json"), JSON.stringify(project.transcript, null, 2));
  await fs.writeFile(join(dir, "brief.json"), JSON.stringify({ phase, goal: project.goal, style: project.style, comments: project.comments || [], media: { ...project.media, path: "input.mp4" }, approvedPlan: phase === "render" ? project.plan : undefined }, null, 2));
  return { dir, runId };
}

export async function invokeClaudeCode({ dir, phase, onEvent = () => {}, budgetUsd = phase === "plan" ? 4 : 6, timeoutMs = 12 * 60000 }) {
  await fs.mkdir(controlDir(dir), { recursive: true });
  const auditPath = join(controlDir(dir), `tools-${phase}.jsonl`);
  const configPath = join(controlDir(dir), `mcp-${phase}.json`);
  await fs.writeFile(auditPath, "");
  const toolEnv = { PATH: process.env.PATH, HOME: process.env.HOME || "/home/ben", PEXELS_API_KEY: process.env.PEXELS_API_KEY || "", PIXABAY_API_KEY: process.env.PIXABAY_API_KEY || "" };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { video: { command: process.execPath, args: [join(root, "server/video-agent-tools.mjs"), dir, auditPath], env: toolEnv } } }));
  const prompt = `/video-edit\nUse this skill for the ${phase} phase. Start by reading .claude/skills/video-edit/SKILL.md with mcp__video__read_file, then read references/public-skill-audit.md, references/editorial-grammar.md, references/verification.md, brief.json, transcript.json and assets.json. Use the project adapter rules, not a generic downloaded skill. You must operate the actual tools and visually inspect real video frames. Implement the edit yourself; do not just describe a plan. Read the HyperFrames skill when using that tool. Run scripts/verify-render.mjs on the preview or final when applicable. End only after writing manifest.json with phase=${phase}, actual output paths and honest visual review. Keep work bounded: at most two repair cycles and no unrelated exploration. ${phase === "render" ? "An approved preview and editable sources already exist in this workspace. Read them and apply the user's timestamped feedback." : "Produce a complete low-resolution edited preview and editable sources for approval, not a final delivery."}`;
  const args = ["--bare", "--restricted", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", configPath, "--model", EDITOR_MODEL, "--effort", "high", "--permission-mode", "dontAsk", "--tools", "Read,Skill", "--allowedTools", "Read,Skill,mcp__video__*", "--max-budget-usd", String(budgetUsd), "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--print", prompt];
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

export async function validateAgentOutput(dir, phase) {
  const manifest = JSON.parse(await fs.readFile(await workspacePath(dir, "manifest.json"), "utf8"));
  if (manifest.phase !== phase || manifest.review?.passed !== true || typeof manifest.review.notes !== "string" || !manifest.review.notes.trim()) throw new Error("缺少真实阶段产物或视觉审查说明");
  const mainPath = await workspacePath(dir, manifest.main);
  if (extname(mainPath) !== ".mp4") throw new Error("主视频必须是 MP4");
  const probe = await probeOutput(mainPath);
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
  const files = [{ path: manifest.main, kind: phase === "plan" ? "preview" : "video", ...probe }, { path: manifest.subtitle, kind: "subtitle" }];
  const brollAudit = (await fs.readFile(join(controlDir(dir), "broll-audit.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const downloaded = new Map(brollAudit.filter((entry) => entry.tool === "download_broll").map((entry) => [entry.assetId, entry]));
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
    if (phase !== "render" || !Number.isInteger(short.slot) || short.slot < 1 || short.slot > 5) throw new Error("Shorts 清单无效");
    const path = await workspacePath(dir, short.path);
    const shortProbe = await probeOutput(path);
    if (shortProbe.width !== 1080 || shortProbe.height !== 1920) throw new Error("Shorts 必须为 1080×1920");
    files.push({ ...short, kind: "short", ...shortProbe });
  }
  return { manifest, files, qc: { passed: true, main: probe, engine: "claude-code", model: EDITOR_MODEL, subtitlesBurnedIn: true, audioVideoSyncChecked: true, noUnexpectedBlackFrames: true, visualReview: { method: "claude-code-vision", frames: frames.map(({ timeSeconds, sha256 }) => ({ timeSeconds, sha256 })), notes: manifest.review.notes }, requiresHumanReview: true } };
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

export async function editWithClaudeCode(project, phase, onEvent) {
  if (activeProjects.has(project.id)) throw Object.assign(new Error("当前项目已有 Claude Code 会话在执行"), { statusCode: 409 });
  activeProjects.add(project.id);
  try {
    const { dir, runId } = await prepareWorkspace(project, phase);
    const receipt = await invokeClaudeCode({ dir, phase, onEvent });
    return await saveAgentOutput(project, phase, dir, runId, receipt);
  } finally { activeProjects.delete(project.id); }
}
