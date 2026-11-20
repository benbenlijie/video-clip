import { promises as fs, constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeOutput, detectBlackFrames } from "./render.mjs";
import { transcriptToSrt, validateEditPlan } from "./edit-plan.mjs";
import { findUnverifiablePartialTranscriptSegments, subtitlesMatchTranscript, transcriptFingerprint, validateProofreadResult } from "./transcript-proofreading.mjs";
import { workspacePath } from "./video-agent-tools.mjs";
import { REMOTION_MAIN_MODE, validateRemotionComposition } from "./remotion-main.mjs";
import { mainArtifactVersion } from "./edit-chat.mjs";
import { hashStyleProject } from "./style-project.mjs";
import { deepSeekDelegationMode } from "./deepseek-delegate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITABLE_SOURCE_EXTENSIONS = new Set([".py", ".mjs", ".js", ".css", ".html", ".json", ".ass", ".srt", ".md", ".txt", ".filter", ".log"]);
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
    for (const skill of project.compositionMode === REMOTION_MAIN_MODE ? ["remotion"] : ["hyperframes", "hyperframes-cli"]) {
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
  let styleBrief = {};
  if (project.styleProjectPath || project.stylePackId) {
    const stylePack = project.stylePack;
    if (!stylePack || stylePack.status !== "approved" || !project.styleProjectPath) throw new Error("当前风格缺少已审批的 StylePack 或 StyleProject");
    if (stylePack.id !== project.stylePackId || Number(stylePack.version) !== Number(project.styleVersion)) throw new Error("项目风格版本与已审批 StylePack 不一致");
    const styleProjectHash = await hashStyleProject(project.styleProjectPath);
    if (stylePack.codeSha256 && styleProjectHash !== stylePack.codeSha256) throw new Error("StyleProject 内容哈希已变化，请重新审批风格包");
    const styleProjectDir = join(dir, "style-project");
    await fs.rm(styleProjectDir, { recursive: true, force: true });
    await fs.cp(project.styleProjectPath, styleProjectDir, { recursive: true, errorOnExist: true, force: false });
    if (project.referenceAnalysis) await fs.writeFile(join(dir, "reference-analysis.json"), JSON.stringify(project.referenceAnalysis, null, 2));
    styleBrief = {
      stylePackId: stylePack.id,
      styleVersion: Number(stylePack.version),
      styleProjectDir: "style-project",
      styleProjectHash,
      styleManifestSha256: stylePack.manifestSha256,
      styleCompositionId: "ReferenceStyle",
      styleParameters: project.styleParameters || stylePack.manifest?.parameters || {},
      styleCopy: project.styleCopy || undefined,
      styleApplication: project.styleApplication || undefined,
      referenceAnalysisPath: project.referenceAnalysis ? "reference-analysis.json" : undefined,
      styleSpec: stylePack.manifest?.styleSpec || project.referenceAnalysis?.styleSpec || null,
    };
    const styleTransfer = {
      contract: "style-transfer-brief.v1",
      stylePackId: stylePack.id,
      styleVersion: Number(stylePack.version),
      styleManifestSha256: stylePack.manifestSha256,
      styleProjectHash,
      sourceAnalysisId: stylePack.manifest?.sourceAnalysisId || null,
      styleSpec: stylePack.manifest?.styleSpec || project.referenceAnalysis?.styleSpec || null,
      styleParameters: project.styleParameters || stylePack.manifest?.parameters || {},
      styleCopy: project.styleCopy || null,
      application: project.styleApplication || null,
      rules: {
        preserveUserTranscript: true,
        preserveUserMedia: true,
        doNotReuseReferenceMedia: true,
        doNotReuseReferenceTranscript: true,
      },
    };
    await fs.writeFile(join(dir, "style-transfer.json"), JSON.stringify(styleTransfer, null, 2));
    styleBrief.styleTransferPath = "style-transfer.json";
  }
  const originalCache = await fs.readFile(join(projectDir, "transcript.original.json"), "utf8").catch(() => "");
  let originalTranscript = project.primaryTranscript || project.transcript;
  if (originalCache) {
    try { originalTranscript = JSON.parse(originalCache).transcript || JSON.parse(originalCache); } catch { /* Old project cache: fall back to the active transcript. */ }
  }
  const existingTranscript = await fs.readFile(join(dir, "transcript.json"), "utf8").then(JSON.parse).catch(() => null);
  const userChangedTranscript = project.primaryTranscript
    && transcriptFingerprint(project.transcript) !== transcriptFingerprint(project.primaryTranscript);
  const approvedProofreading = project.proofreading && project.proofreading.status !== "pending";
  if (phase !== "plan" || !existingTranscript || approvedProofreading || userChangedTranscript) {
    await fs.writeFile(join(dir, "transcript.json"), JSON.stringify(project.transcript, null, 2));
  }
  await fs.writeFile(join(dir, "transcript.original.json"), JSON.stringify(originalTranscript, null, 2));
  if (project.secondaryTranscript) await fs.writeFile(join(dir, "transcript.whisper.json"), JSON.stringify(project.secondaryTranscript, null, 2));
  const existingProofread = await fs.readFile(join(dir, "transcript-proofread.json"), "utf8").then(JSON.parse).catch(() => null);
  if (project.proofreading && (project.proofreading.status !== "pending" || !existingProofread)) {
    await fs.writeFile(join(dir, "transcript-proofread.json"), JSON.stringify(project.proofreading, null, 2));
  }
  const resumeArtifacts = [];
  for (const name of ["transcript-proofread.json", "fluency-report.json", "content-copy.json", "edit.py", "timeline.json", "base.mp4", "captions.srt", "edit-plan.json", "manifest.json"]) {
    try { await fs.stat(join(dir, name)); resumeArtifacts.push(name); } catch { /* Artifact not produced yet. */ }
  }
  await fs.writeFile(join(dir, "brief.json"), JSON.stringify({ phase, compositionMode: project.compositionMode, approvedCompositionDesignSha256: project.editor?.compositionDesignSha256, projectId: project.id, goal: project.goal, style: project.style, comments: project.comments || [], media: { ...project.media, path: "input.mp4" }, resumeArtifacts, approvedPlan: ["render", "chat-edit"].includes(phase) ? project.plan : undefined, chatTurn: options.chatTurn ? { ...options.chatTurn, timeline: "edited-preview", instruction: "The requested time range belongs to this baseVersion preview, not the uncut input.mp4. Use the saved timeline map to locate source footage." } : undefined, chatContext: options.chatContext || undefined, latestVersion: project.editSession?.latestVersion || project.editor?.version || 1, ...styleBrief }, null, 2));
  return { dir, runId };
}

export async function invokeClaudeCode({ dir, phase, onEvent = () => {}, budgetUsd = phase === "plan" ? Number(process.env.WAYNE_EDIT_PLAN_BUDGET_USD) || 8 : Number(process.env.WAYNE_EDIT_RENDER_BUDGET_USD) || 6, timeoutMs = EDITOR_SESSION_TIMEOUT_MS, sessionId = null, resume = false }) {
  await fs.mkdir(controlDir(dir), { recursive: true });
  const auditPath = join(controlDir(dir), `tools-${phase}.jsonl`);
  const configPath = join(controlDir(dir), `mcp-${phase}.json`);
  await fs.writeFile(auditPath, "");
  const toolEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || "/home/ben",
    PEXELS_API_KEY: process.env.PEXELS_API_KEY || "",
    PIXABAY_API_KEY: process.env.PIXABAY_API_KEY || "",
    WAYNE_DEEPSEEK_DELEGATION: process.env.WAYNE_DEEPSEEK_DELEGATION || "off",
    WAYNE_DSH_BIN: process.env.WAYNE_DSH_BIN || "",
    WAYNE_DSH_PROFILE: process.env.WAYNE_DSH_PROFILE || "headless",
    WAYNE_DEEPSEEK_DELEGATE_TIMEOUT_MS: process.env.WAYNE_DEEPSEEK_DELEGATE_TIMEOUT_MS || "180000",
  };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { video: { command: process.execPath, args: [join(root, "server/video-agent-tools.mjs"), dir, auditPath], env: toolEnv } } }));
  const brief = JSON.parse(await fs.readFile(join(dir, "brief.json"), "utf8"));
  const prompt = buildEditorPrompt(phase, brief.compositionMode, { hasStylePack: Boolean(brief.stylePackId) });
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

export function buildEditorPrompt(phase, compositionMode = null, { hasStylePack = false } = {}) {
  const mainWorkflow = compositionMode === REMOTION_MAIN_MODE;
  const delegationMode = deepSeekDelegationMode();
  const delegationInstruction = delegationMode === "off"
    ? ""
    : delegationMode === "force"
      ? "DeepSeek delegation is FORCED. Send every concrete shell, file-media, caption-timing, and QC execution task through mcp__video__delegate_task. You may use read_file and view_frame for inspection, write only edit-plan.json, content-copy.json, and manifest.json directly, and call the deterministic compose/verify tools. Do not call execute or write other artifact files. Batch related work into a few bounded tasks rather than one micro-command per call. You remain responsible for the creative plan and final visual acceptance."
      : "Prefer mcp__video__delegate_task for concrete execution: transcript statistics or compaction, cut EDL and FFmpeg/Python scripts, caption timing, file hashes, QC commands, and B-roll preparation. Keep Hook/title/CTA, visual hierarchy, final B-roll selection, and final frame acceptance yourself. Batch related work into a few bounded tasks with explicit inputs, outputs, constraints, and acceptance checks; avoid one micro-command per call and inspect the returned files before continuing.";
  const animationInstruction = mainWorkflow
    ? "Use the installed Remotion skill for standard title_card, emphasis, and cta events. Make a clean base video with the actual cuts, B-roll and audio, but without burned captions or duplicate title overlays. Write timeline.json with frame-aligned pieces, each containing src:[sourceStartMs,sourceEndMs] and out:[editedStartMs,editedEndMs], in milliseconds, matching the executed edit-plan.json and the actual base video fps. Adjust subtitle presentation through edit-plan.json.captionStyle (fontSize 8-64, marginV 0-160, outline 0-5, color #RRGGBB), including when the user asks for larger captions. Call mcp__video__compose_remotion_video with baseVideo and this phase. It renders Remotion on the edited timeline, burns captions.srt, and retains reproducible alpha/source/hash evidence. Inspect the returned outputPath at all visual events and B-roll points, then use that exact path as manifest.main and set manifest.compositionMode to remotion-main.v1. Render full source dimensions during the final render phase, with the same approved edit-plan.json, captions.srt and timeline.json as the preview. Do not call render_remotion_preview or require HyperFrames. If the main composition fails, report failure and keep the existing version; never silently omit the planned animation."
    : "Read the HyperFrames skill when using that tool. Use HyperFrames for at least one executable animated overlay or transition in every plan when the runtime is available.";
  const remotionInstruction = mainWorkflow ? "" : ["plan", "chat-edit"].includes(phase)
    ? "After edit-plan.json is stable, use mcp__video__render_remotion_preview for one comparison render when the Remotion runtime is available. Inspect at least two moments in its returned preview with mcp__video__view_frame. Use a second comparison render only after changing visualEvents. This is a separate design comparison; do not claim it is the normal Wayne preview or final export. If the tool fails, record the reason and continue with the standard Wayne preview."
    : "Do not create an additional Remotion comparison during the final export phase.";
  const proofreadingInstruction = phase === "plan"
    ? "Before finalizing the plan, read transcript.original.json and transcript.whisper.json if present. Claude Code cannot directly hear the audio, so compare the two ASR texts only; do not claim to have listened. Correct a segment only when the replacement is supported by one or both transcript sources. Write transcript-proofread.json with status ready, needs_review, or manual_review_required; include corrected transcript segments, every text change with evidence (primary, whisper, or both) and reason, and every unresolved disagreement with the exact primary/Whisper text. Keep ids and source timestamps unchanged. Never invent words from context. Update transcript.json to the corrected transcript. If Whisper is missing, keep the primary text unchanged and set manual_review_required. Continue with the edit plan in this same Claude session; do not start another Claude session for proofreading."
    : "Use the current transcript.json as the authoritative approved text. Do not alter spoken words unless the user requests a transcript correction.";
  const timingInstruction = "When the user has manually corrected a transcript segment, the server has already compared the old and new text and remapped unchanged/replaced/inserted grapheme timing where possible; wordTimingStatus=estimated denotes ASR-anchored estimates, not fresh audio evidence. If wordTimingStatus=protected, write edit-plan.json as a separate step before rendering: the MCP server automatically expands any partial cut to retain that complete utterance, while a complete-sentence deletion remains allowed. After any execute call that reports automatic plan protection, reread edit-plan.json and rerender every output made by that same command before reviewing or publishing it. The user does not need to provide extra instructions for this. Caption cue boundaries must follow semantic phrases and punctuation; never split a word, complete noun, proper noun or fixed phrase, and never start a Chinese cue with a binding particle such as 的/地/得/了/着/过/和/与/及/或/而/但/却/并/且.";
  const fluencyInstruction = "Before edit-plan.json, call mcp__video__analyze_fluency with transcript.json and the current timeline.json when one exists. It writes fluency-report.json with proposedPieces. Use those pieces (or explicitly justify an override) to remove hard fillers, false starts and excessive pauses; soft particles such as 啊/呢/吧/嘛 must be marked for semantic review, not blindly deleted. Recompute timeline.json and captions.srt after the cuts, include fluency-report.json in manifest.sources, and call mcp__video__verify_fluency before composing. Do not claim a fluent result if residual hard fillers or long pauses remain.";
  const styleInstruction = hasStylePack
    ? "A reusable approved StylePack is attached. Read style-transfer.json and the copied style-project/style-manifest.json before planning. Treat it as the visual grammar contract for title, identity, captions, panels, keyword emphasis, enter/exit motion and layout. Preserve the user's transcript and media; never copy reference transcript, text, footage, audio, people or brand. Before edit-plan.json, write content-copy.json with content-specific title, subtitle, identity, identitySubtext, cta and keywords plus evidence from the current user's transcript, real frames, filename or brief; include content-copy.json in manifest.sources. Keywords must be actual words in the user's transcript, not topic guesses. Omit identity when evidence is absent and never use technical placeholders such as style proof, user title, user identity or six-second preview as production copy. The server will reapply the StylePack to the final plan for provenance, so do not invent a competing visual style."
    : "No reusable StylePack is attached. Use the project's normal video-edit design rules.";
  return `/video-edit\nUse this skill for the ${phase} phase. Start by reading .claude/skills/video-edit/SKILL.md with mcp__video__read_file. The project references are inside that skill directory: read .claude/skills/video-edit/references/public-skill-audit.md, .claude/skills/video-edit/references/editorial-grammar.md, and .claude/skills/video-edit/references/verification.md. Then read brief.json, style-transfer.json if present, transcript.json, transcript.original.json, transcript.whisper.json if present, and assets.json. If brief.json.resumeArtifacts is non-empty, inspect and validate those existing artifacts before redoing work; reuse them when their inputs still match and regenerate only affected downstream steps. ${styleInstruction} ${proofreadingInstruction} ${fluencyInstruction} Use the project adapter rules, not a generic downloaded skill. ${delegationInstruction} You must operate the actual tools and visually inspect real video frames. Keep subtitle wording complete: if the same spoken words are visibly presented by a timed visual overlay and therefore omitted from captions.srt, declare each exact source interval and verbatim text in edit-plan.json.captionCoverage with its visualEvent id; do not mark paraphrases or merely implied text as covered. The covered words must exist in the actually rendered event input or declared HTML/JS visual source, and be verified in the main preview. ${timingInstruction} Implement the edit through actual tools, directly or through delegate_task as configured; do not just describe a plan. ${animationInstruction} Run .claude/skills/video-edit/scripts/verify-render.mjs on the preview or final when applicable. For portrait 9:16 talking-head footage, do not default to a talking-head-only edit: evaluate at least one licensed B-roll search for each concrete visual intent, and use 1–3 B-roll inserts when the visual adds information; absence of product UI is not a reason to skip generic but relevant scene-setting footage. Keep title/emphasis cards short, compact and inside the portrait safe area; prefer split-screen, B-roll cover, punch-in, kinetic phrase captions and motion accents over large persistent text panels. When style-transfer.json is present, its StyleSpec v2 geometry and motion contract take precedence over these generic style examples. ${remotionInstruction} End only after writing manifest.json with phase=${phase}, actual output paths and honest visual review. Keep work bounded: at most two repair cycles and no unrelated exploration. ${phase === "render" ? "An approved preview and editable sources already exist in this workspace. Read them and apply the user's timestamped feedback." : phase === "chat-edit" ? "This is a continuation turn. Read the latest approved version and the chat turn in brief.json. Apply only the user's latest request, preserve unrelated decisions, generate a new low-resolution preview, and leave the prior version intact." : "Produce a complete low-resolution edited preview and editable sources for approval, not a final delivery."}`;
}

export async function validateAgentOutput(dir, phase, { compositionMode, approvedDesignSha256 = null, targetMedia = null } = {}) {
  const manifest = JSON.parse(await fs.readFile(await workspacePath(dir, "manifest.json"), "utf8"));
  if (manifest.phase !== phase || manifest.review?.passed !== true || typeof manifest.review.notes !== "string" || !manifest.review.notes.trim()) throw new Error("缺少真实阶段产物或视觉审查说明");
  const mainPath = await workspacePath(dir, manifest.main);
  if (extname(mainPath) !== ".mp4") throw new Error("主视频必须是 MP4");
  const probe = await probeOutput(mainPath);
  const brief = JSON.parse(await fs.readFile(await workspacePath(dir, "brief.json"), "utf8"));
  if (compositionMode !== undefined && (brief.compositionMode || null) !== compositionMode) throw new Error("工作区主合成模式与项目记录不一致");
  const mainMode = (compositionMode === undefined ? brief.compositionMode : compositionMode) === REMOTION_MAIN_MODE;
  const finalTarget = targetMedia || brief.media;
  if (mainMode && phase === "render" && (probe.width !== finalTarget.width || probe.height !== finalTarget.height)) throw new Error("正式成片尺寸与目标工程不一致");
  const transcript = JSON.parse(await fs.readFile(await workspacePath(dir, "transcript.json"), "utf8"));
  let proofreading = null;
  if (phase === "plan") {
    const original = JSON.parse(await fs.readFile(await workspacePath(dir, "transcript.original.json"), "utf8"));
    let secondary = null;
    try { secondary = JSON.parse(await fs.readFile(await workspacePath(dir, "transcript.whisper.json"), "utf8")); } catch { /* The local second pass is optional. */ }
    const proofreadFile = await workspacePath(dir, "transcript-proofread.json");
    const proofread = JSON.parse(await fs.readFile(proofreadFile, "utf8"));
    proofreading = validateProofreadResult(proofread, original, secondary);
    const activeMatches = transcript.segments?.length === proofreading.transcript.segments.length
      && transcript.segments.every((segment, index) => segment.id === proofreading.transcript.segments[index].id && segment.startMs === proofreading.transcript.segments[index].startMs && segment.endMs === proofreading.transcript.segments[index].endMs && segment.text === proofreading.transcript.segments[index].text)
      && transcript.text === proofreading.transcript.text;
    if (!activeMatches) throw new Error("工作区 transcript.json 与校对稿不一致");
  }
  const hash = createHash("sha256").update(await fs.readFile(mainPath)).digest("hex");
  const audit = (await fs.readFile(join(controlDir(dir), `tools-${phase}.jsonl`), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const composition = mainMode ? await validateRemotionComposition({ dir, phase, manifest, audit, approvedDesignSha256 }) : null;
  const frames = audit.filter((event) => event.tool === "view_frame" && event.video === manifest.main && event.sha256 === hash && !event.error);
  if (new Set(frames.map((frame) => frame.timeSeconds)).size < 3) throw new Error("最终版本缺少至少三张实际送入 Claude 视觉的审片帧");
  if (Math.max(...frames.map((frame) => frame.timeSeconds)) - Math.min(...frames.map((frame) => frame.timeSeconds)) < probe.durationMs / 2000) throw new Error("审片帧必须覆盖至少一半成片时长");
  if (composition && composition.record.events.some((event) => !frames.some((frame) => frame.timeSeconds * 1000 >= event.startMs && frame.timeSeconds * 1000 <= event.endMs))) throw new Error("Remotion 主视频缺少动效出现区间的实际审片帧");
  if (phase === "plan" && new Set(audit.filter((event) => event.tool === "view_frame" && event.video === "input.mp4" && !event.error).map((event) => event.timeSeconds)).size < 3) throw new Error("缺少原片视觉检查");
  if (probe.avSyncDeltaMs === null || probe.avDurationDeltaMs === null || probe.avSyncDeltaMs > 250 || probe.avDurationDeltaMs > 250) throw new Error("音视频同步检查未通过");
  const blackFrames = await detectBlackFrames(mainPath);
  if (blackFrames.length) throw new Error("成片存在持续黑帧，需要 Claude Code 修正");
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) throw new Error("缺少可编辑工程源码");
  const subtitle = manifest.subtitle ? await workspacePath(dir, manifest.subtitle) : null;
  if (subtitle && (extname(subtitle) !== ".srt" || !(await fs.readFile(subtitle, "utf8")).includes("-->"))) throw new Error("缺少最终时间线字幕");
  if (!subtitle && !(manifest.subtitleNote && transcript.text === "")) throw new Error("缺少最终时间线字幕");
  if (subtitle) {
    const subtitleText = await fs.readFile(subtitle, "utf8");
    const editPlan = JSON.parse(await fs.readFile(await workspacePath(dir, "edit-plan.json"), "utf8"));
    const visualSourceTexts = [];
    if (composition) visualSourceTexts.push(...composition.record.events.map((event) => `${event.text || ""} ${event.subtext || ""}`));
    for (const source of manifest.sources.filter((item) => [".html", ".js"].includes(extname(item).toLowerCase()))) {
      visualSourceTexts.push(await fs.readFile(await workspacePath(dir, source), "utf8"));
    }
    const unalignedSegments = findUnverifiablePartialTranscriptSegments(transcript, editPlan, composition?.record.pieces);
    if (unalignedSegments.length) throw new Error(`字幕无法校验：剪辑切入了逐词时间码与校对文字不一致的片段（${unalignedSegments.join(", ")}）。请保留完整片段，或先重新对齐逐词时间码再重试。`);
    if (!subtitlesMatchTranscript(subtitleText, transcript, editPlan, visualSourceTexts, composition?.record.pieces, composition?.record.events)) throw new Error("字幕文字与当前校对转录不一致，或字幕时间码与当前剪辑时间轴不一致");
  }
  const files = [{ path: manifest.main, kind: ["plan", "chat-edit"].includes(phase) ? "preview" : "video", ...probe }, ...(subtitle ? [{ path: manifest.subtitle, kind: "subtitle" }] : [])];
  if (composition) files.push(...composition.files);
  const currentPlanSha256 = await sha256File(await workspacePath(dir, "edit-plan.json"));
  const currentSourceSha256 = await sha256File(await workspacePath(dir, "input.mp4"));
  const remotionComparisons = [];
  for (const entry of mainMode ? [] : audit.filter((event) => event.tool === "render_remotion_preview" && !event.error)) {
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
  if (!mainMode && ["plan", "render", "chat-edit"].includes(phase) && probe.height > probe.width && (!manifest.hyperframes?.rendered || !hyperframesSource || !hyperframesExecuted)) {
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
    if (!EDITABLE_SOURCE_EXTENSIONS.has(extname(source).toLowerCase())) throw new Error("不支持的工程源码类型");
    await workspacePath(dir, source); files.push({ path: source, kind: "source" });
  }
  for (const short of manifest.shorts || []) {
    if (!["render", "chat-edit"].includes(phase) || !Number.isInteger(short.slot) || short.slot < 1 || short.slot > 5) throw new Error("Shorts 清单无效");
    const path = await workspacePath(dir, short.path);
    const shortProbe = await probeOutput(path);
    if (shortProbe.width !== 1080 || shortProbe.height !== 1920) throw new Error("Shorts 必须为 1080×1920");
    files.push({ ...short, kind: "short", ...shortProbe });
  }
  return { manifest, files, proofreading, qc: { passed: true, main: probe, engine: "claude-code", model: EDITOR_MODEL, subtitlesBurnedIn: true, audioVideoSyncChecked: true, noUnexpectedBlackFrames: true, subtitleTextChecked: Boolean(subtitle), remotionComposition: composition?.record || null, visualReview: { method: "claude-code-vision", frames: frames.map(({ timeSeconds, sha256 }) => ({ timeSeconds, sha256 })), notes: manifest.review.notes }, remotionComparisons: remotionComparisons.length ? remotionComparisons : null, requiresHumanReview: true } };
}

export async function saveAgentOutput(project, phase, dir, runId, receipt, { version: assignedVersion = null } = {}) {
  const output = await validateAgentOutput(dir, phase, { compositionMode: project.compositionMode || null, approvedDesignSha256: project.editor?.compositionDesignSha256 || null, targetMedia: project.media });
  if (phase === "plan" && output.proofreading) {
    project.transcript = { ...project.transcript, ...output.proofreading.transcript };
    project.proofreading = { status: output.proofreading.status, model: project.transcription?.model || null, changes: output.proofreading.changes, unresolved: output.proofreading.unresolved, previewTranscriptSha256: transcriptFingerprint(project.transcript), previewStale: false };
    await fs.writeFile(join(project.dir, "transcript.corrections.json"), JSON.stringify(project.proofreading, null, 2));
    await fs.writeFile(join(project.dir, "transcript.json"), JSON.stringify(project.transcript, null, 2));
    await fs.writeFile(join(project.dir, "transcript.srt"), transcriptToSrt(project.transcript));
  }
  const planData = JSON.parse(await fs.readFile(await workspacePath(dir, "edit-plan.json"), "utf8"));
  const brollAudit = (await fs.readFile(join(controlDir(dir), "broll-audit.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const brollAssets = brollAudit.filter((entry) => entry.tool === "download_broll").map((entry) => ({ id: entry.assetId, filename: entry.filename, path: join(dir, entry.path), durationMs: entry.durationMs, width: entry.width, height: entry.height, licenseConfirmed: true, sourceUrl: entry.sourceUrl, licenseName: entry.licenseName, licenseUrl: entry.licenseUrl, sha256: entry.sha256, provider: entry.provider, providerId: entry.providerId }));
  const plan = validateEditPlan(planData, project.media.durationMs, { requireFiveShorts: false, allowCustomVisualEvents: true, brollAssets: [...(project.brollAssets || []), ...brollAssets] });
  const version = phase === "render" ? project.editor.version : assignedVersion ?? mainArtifactVersion(project) + 1;
  if (!Number.isInteger(version) || version < 1) throw new Error("主视频版本无效");
  const artifactsDir = join(resolve(project.dir), "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifacts = [];
  const files = [...output.files, ...brollAssets.map((asset) => ({ path: asset.path.replace(`${dir}/`, ""), kind: "broll", assetId: asset.id, sourceUrl: asset.sourceUrl, licenseName: asset.licenseName, licenseUrl: asset.licenseUrl, provider: asset.provider, providerId: asset.providerId, sha256: asset.sha256 })), { path: "edit-plan.json", kind: "plan" }, ...(phase === "plan" ? [{ path: "transcript-proofread.json", kind: "transcript-proofreading" }] : []), { path: `session-${phase}.json`, kind: "agent-log", control: true }, { path: `tools-${phase}.jsonl`, kind: "agent-log", control: true }];
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
  if (phase === "chat-edit" && project.proofreading) {
    project.proofreading = { ...project.proofreading, previewTranscriptSha256: transcriptFingerprint(project.transcript), previewStale: false };
  }
  return { plan, artifacts, brollAssets: persistedBrollAssets, proofreading: output.proofreading, qc, editor: { engine: "claude-code", model: EDITOR_MODEL, runId, version, phase, compositionDesignSha256: output.qc.remotionComposition?.designSha256 || null, sessionId: receipt.sessionId, costUsd: receipt.costUsd } };
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
    return await saveAgentOutput(project, phase, dir, runId, receipt, { version: options.chatTurn?.resultVersion ?? null });
  } finally { activeProjects.delete(project.id); }
}
