import { promises as fs } from "node:fs";
import { constants as fsConstants, existsSync } from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { probeReferenceMedia } from "./reference-analysis.mjs";
import { extractReferenceMotionSheets } from "./reference-motion.mjs";

const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
export const STYLE_AGENT_MODEL = "claude-opus-5-5";
export const STYLE_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

function agentEnvironment(styleRoot) {
  const env = { ...process.env };
  // Prefer Claude Code's local OAuth login. The portal .env key is a
  // router credential for other services and must not override the user's
  // authenticated Claude Code session.
  delete env.ANTHROPIC_API_KEY;
  delete env.LLM_ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_MODEL;
  if (process.env.WAYNE_STYLE_CLAUDE_AUTH === "api-key") {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY;
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.WAYNE_STYLE_DIR = styleRoot;
  return env;
}

async function copyIfPresent(source, target) {
  if (existsSync(source)) await fs.cp(source, target, { recursive: true, dereference: true });
}

async function writeStyleMcpConfig({ controlDir, phase, styleRoot, auditPath }) {
  const configPath = join(controlDir, `mcp-style-${phase}.json`);
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: {
      style: {
        command: process.execPath,
        args: [join(portalRoot, "server/style-agent-tools.mjs"), resolve(controlDir, ".."), auditPath],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME || "/home/ben",
          WAYNE_STYLE_DIR: styleRoot || join(portalRoot, "style-library"),
          WAYNE_STYLE_NATIVE_VISION: "1",
          WAYNE_STYLE_PHASE: phase,
        },
      },
    },
  }, null, 2));
  return configPath;
}

export async function prepareReferenceStyleWorkspace({
  workDir,
  videoPath,
  referenceId,
  mode,
  sourceFilename,
  referenceUsageConfirmedAt,
  styleRoot,
} = {}) {
  if (!workDir || !videoPath || !mode || !sourceFilename) throw new Error("style workspace inputs are required");
  if (!referenceUsageConfirmedAt) throw new Error("reference authorization timestamp is required");
  const dir = resolve(workDir);
  await fs.mkdir(dir, { recursive: true });
  const referencePath = join(dir, "reference.mp4");
  if (!existsSync(referencePath)) await fs.copyFile(videoPath, referencePath, fsConstants.COPYFILE_FICLONE).catch(async () => fs.copyFile(videoPath, referencePath));
  await fs.writeFile(join(dir, "brief.json"), JSON.stringify({
    referenceId: String(referenceId || workDir.split(/[\\/]/).filter(Boolean).at(-1) || ""),
    mode,
    sourceFilename,
    referenceUsageConfirmedAt,
    engine: "claude-code",
  }, null, 2));
  const skillsRoot = join(dir, ".claude", "skills");
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.rm(join(skillsRoot, "reference-style"), { recursive: true, force: true });
  await fs.cp(join(portalRoot, "agent-skills/reference-style"), join(skillsRoot, "reference-style"), { recursive: true });
  await copyIfPresent(join(process.env.HOME || "/home/ben", ".agents", "skills", "remotion"), join(skillsRoot, "remotion"));
  const controlDir = join(dir, ".control");
  const auditPath = join(controlDir, "style-audit.jsonl");
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(auditPath, "");
  const configPath = await writeStyleMcpConfig({ controlDir, phase: "authoring", styleRoot, auditPath });
  const reviewConfigPath = await writeStyleMcpConfig({ controlDir, phase: "review", styleRoot, auditPath });
  return { dir, auditPath, configPath, reviewConfigPath, controlDir, referencePath };
}

async function extractVisionFrames({ videoPath, outputDir, times, prefix }) {
  await fs.mkdir(outputDir, { recursive: true });
  const frames = [];
  for (const [index, timeSeconds] of times.entries()) {
    const label = timeSeconds.toFixed(2).replace(".", "p");
    const framePath = join(outputDir, `${prefix}-${String(index + 1).padStart(2, "0")}-${label}s.jpg`);
    await execFile("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(timeSeconds),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=720:-2",
      "-q:v", "3",
      framePath,
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    frames.push({
      path: framePath,
      timeSeconds,
      mimeType: "image/jpeg",
      data: (await fs.readFile(framePath)).toString("base64"),
    });
  }
  return frames;
}

function frameBlocks(label, frames) {
  return frames.flatMap((frame, index) => [
    { type: "text", text: frame.label || `${label} ${index + 1}: ${frame.timeSeconds.toFixed(2)}s` },
    { type: "image", source: { type: "base64", media_type: frame.mimeType, data: frame.data } },
  ]);
}

function authoringPrompt(referenceFrames, referenceMotionSheets) {
  return [
    "/reference-style",
    "Use the reference-style skill for the authoring phase.",
    "The attached images are representative reference frames in chronological order. Inspect the pixels directly; MCP image results are diagnostic fallback only and may not be rendered by every Claude Code client.",
    "Call the MCP tools for probe, shots, audio, visual-fact persistence, StyleProject creation, and sandbox validation. Submit only visual facts to write_reference_analysis; MCP injects source, audio, rhythm, contract, and analysis id.",
    "Visual inventory is mandatory: check persistent header text, its panel background and opacity, mid-frame badges or identity cards, bottom/middle captions, caption panel, and progress indicators. A persistent header must be a title_card overlay; if absent, declare no-header-text explicitly.",
    "The motion sheets are chronological contact sheets. Use them to measure cue transitions, pop/scale/fade behavior, emphasis and motion timing. Do not infer animation from a single still.",
    "Fill StyleSpec v2 with explicit panel, typography, highlight, enter/exit, and effect tokens. Do not reduce the style to one free-text animation label.",
    "Panel color is the intended overlay base color, not the RGB sampled after the overlay is composited over the person/background. A light reference band must use a light neutral base (roughly #e8e6dd to #f7f5ef) with medium-to-high opacity; a dark result on a black alpha proof is not evidence for a dark panel. Captions with a visible background band must set panel.enabled=true. Preserve black caption strokes and gold keyword accents when the reference shows them.",
    "Author the StyleProject so it consumes the optional styleSpec prop: render panel backgrounds, primary/secondary typography, caption highlight, enter/exit motion, and effects from StyleSpec v2 when present. Keep v1 captionStyle fallback behavior. Validate it; if save_style_pack or view_frame returns deferred_for_review, end the authoring turn immediately. Proof inspection happens in the follow-up turn with native proof images. Do not claim success without analysis.json, style-proof.mov, and validation.json.",
    ...frameBlocks("Reference image", referenceFrames).map((block) => block.type === "text" ? block.text : block),
    ...frameBlocks("Motion sheet", referenceMotionSheets).map((block) => block.type === "text" ? block.text : block),
  ].filter((item) => typeof item === "string").join("\n");
}

function reviewPrompt({ round, maxRounds, referenceFrames, referenceMotionSheets, proofFrames, proofMotionSheet }) {
  const labels = [
    `Proof review round ${round}/${maxRounds}.`,
    "Use the existing analysis.json, style-manifest.json, StyleProject, and validation. Do not call probe_reference, detect_reference_shots, write_reference_analysis, or create_style_project in review.",
    "The attached images are ordered as reference keyframes followed by frames from the current rendered style-proof.mov. Inspect only the attached pixels.",
    "Compare the observable visual grammar: title/caption geometry and hierarchy, text placement and safe areas, typography treatment, motion cues, composition, alpha edges, and whether the proof reads as a reusable style rather than a copy of reference content.",
    "Compare the reference motion sheets with the proof motion sheet, including panel backgrounds, cue entry/exit transitions, keyword emphasis, and timing.",
    "The persistent header and identity layers must remain in their intended regions at all three proof times. Respect each event.position exactly; title_card and emphasis must not overlap. Render event.subtext when present instead of dropping the reference's second line.",
    "Captions must remain legible inside the safe area. The caption primary color must dominate; keywordColor may accent only explicit keywords and must never color the entire cue. For Chinese text without whitespace, do not treat the whole cue as one long word or highlight all of it by length.",
    "Panel color is an overlay base color, not a sampled post-composite color. If the reference shows a light gray title/caption band, the proof must show a light neutral panel with enabled=true and appropriate opacity over transparency. Do not turn a light band into a dark panel because the alpha proof is viewed on black. Keep visible black outlines and gold keyword accents distinct.",
    "If panel, typography, anchor, highlight, or motion tokens in StyleSpec v2 disagree with the attached reference, call update_style_spec with the complete corrected spec, then update style-project/src and revalidate. Do not compensate for wrong manifest tokens only with hardcoded component values.",
    "If and only if the proof is visibly acceptable, call save_style_pack, which will persist a pending-approval StylePack.",
    "If it needs work, edit only style-project/src, rerun validate_style_project, and stop without saving so the orchestrator can attach the new proof for another review round.",
    "If this StyleProject already has an immutable stored version, call begin_style_revision before editing, then revalidate the new version.",
    "Never branch rendering behavior on Chinese copy, keywords, or whether text contains 标题/身份. Use event.type, event.position, geometry, and style parameters so the style remains reusable with any user copy.",
    "Never transcribe or reuse the reference transcript, title copy, identity copy, brand, face, footage, or music.",
    ...frameBlocks("Reference image", referenceFrames).map((block) => block.type === "text" ? block.text : block),
    ...frameBlocks("Reference motion sheet", referenceMotionSheets).map((block) => block.type === "text" ? block.text : block),
    ...frameBlocks("Proof image", proofFrames).map((block) => block.type === "text" ? block.text : block),
    proofMotionSheet.label,
  ];
  return labels.filter((item) => typeof item === "string").join("\n");
}

function userMessage(text, frames) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...frames.flatMap((frame, index) => [
          { type: "text", text: frame.label || `Attached frame ${index + 1}: ${frame.timeSeconds.toFixed(2)}s` },
          { type: "image", source: { type: "base64", media_type: frame.mimeType, data: frame.data } },
        ]),
      ],
    },
  };
}

async function writeReviewGate(dir) {
  const validation = JSON.parse(await fs.readFile(join(dir, "validation.json"), "utf8"));
  if (!validation.proofSha256 || !validation.codeSha256) throw new Error("StyleProject validation hashes are missing");
  const gate = {
    contract: "style-review-gate.v1",
    proofSha256: validation.proofSha256,
    codeSha256: validation.codeSha256,
    reviewedAt: new Date().toISOString(),
  };
  await fs.mkdir(join(dir, ".control"), { recursive: true });
  await fs.writeFile(join(dir, ".control", "style-review-gate.json"), JSON.stringify(gate, null, 2));
  return gate;
}

async function stylePackMatchesCurrent(dir) {
  try {
    const [pack, manifest, validation] = await Promise.all([
      fs.readFile(join(dir, "style-pack.json"), "utf8").then(JSON.parse),
      fs.readFile(join(dir, "style-project", "style-manifest.json"), "utf8").then(JSON.parse),
      fs.readFile(join(dir, "validation.json"), "utf8").then(JSON.parse),
    ]);
    return pack.id === manifest.id
      && Number(pack.version) === Number(manifest.version)
      && pack.codeSha256 === validation.codeSha256;
  } catch {
    return false;
  }
}

async function runClaudeVisionTurn({
  dir,
  configPath,
  styleRoot,
  payload,
  timeoutMs,
  budgetUsd,
  onEvent,
}) {
  const args = [
    "--bare",
    "--strict-mcp-config",
    "--mcp-config", configPath,
    "--model", STYLE_AGENT_MODEL,
    "--effort", "high",
    "--permission-mode", "dontAsk",
    "--tools", "Skill",
    "--allowedTools", "Skill,mcp__style__*",
    "--max-budget-usd", String(budgetUsd),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--print",
  ];
  return new Promise((resolveTurn, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd: dir, env: agentEnvironment(styleRoot), detached: true });
    let pending = "";
    let stderr = "";
    let settled = false;
    let result = null;
    const models = new Set();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      reject(error);
    };
    const record = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "assistant") {
        if (event.message?.model) models.add(event.message.model);
        for (const item of event.message?.content || []) {
          if (item.type === "tool_use") onEvent({ tool: item.name, at: new Date().toISOString() });
        }
      }
      if (event.type === "result") result = event;
    };
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      lines.forEach(record);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", fail);
    child.on("close", (code) => {
      if (pending) record(pending);
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) return reject(new Error("Claude Code reference-style session timed out"));
      if (code !== 0 || !result) return reject(new Error(`Claude Code reference-style session failed: ${stderr || code}`));
      if (result.is_error || result.subtype !== "success") return reject(new Error(`Claude Code reference-style turn failed: ${result.result || result.subtype || stderr}`));
      if (!models.size || [...models].some((model) => !model.startsWith(STYLE_AGENT_MODEL))) {
        return reject(new Error(`Claude Code did not confirm ${STYLE_AGENT_MODEL}: ${[...models].join(", ") || "no model evidence"}`));
      }
      resolveTurn({ result, models: [...models], stderr });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

async function prepareStyleVision(dir) {
  const referenceProbe = await probeReferenceMedia(join(dir, "reference.mp4"));
  const durationSeconds = referenceProbe.durationMs / 1000;
  const referenceTimes = [0.08, 0.24, 0.4, 0.56, 0.72, 0.88]
    .map((ratio) => Math.max(0, Math.min(durationSeconds - 0.05, durationSeconds * ratio)))
    .map((value) => Math.round(value * 100) / 100);
  const visionDir = join(dir, ".control", "vision");
  const referenceFrames = await extractVisionFrames({
    videoPath: join(dir, "reference.mp4"),
    outputDir: visionDir,
    times: referenceTimes,
    prefix: "reference",
  });
  const motionSheets = await extractReferenceMotionSheets({
    videoPath: join(dir, "reference.mp4"),
    outDir: join(visionDir, "reference-motion"),
    durationMs: referenceProbe.durationMs,
    maxWindows: 5,
    secondsPerWindow: 2.5,
    fps: 4,
    columns: 5,
    frameWidth: 360,
  });
  const referenceMotionSheets = await Promise.all(motionSheets.map(async (sheet, index) => ({
    ...sheet,
    timeSeconds: sheet.startMs / 1000,
    label: `Reference motion sheet ${index + 1}: ${(sheet.startMs / 1000).toFixed(2)}-${(sheet.endMs / 1000).toFixed(2)}s at ${sheet.sampleFps}fps`,
    data: (await fs.readFile(sheet.path)).toString("base64"),
  })));
  return { referenceTimes, referenceFrames, referenceMotionSheets, visionDir };
}

export async function reviewReferenceStyleProject({
  dir,
  reviewConfigPath,
  styleRoot,
  timeoutMs = STYLE_AGENT_TIMEOUT_MS,
  budgetUsd = 4,
  maxReviewRounds = 3,
  onEvent = () => {},
  vision = null,
} = {}) {
  if (!dir || !reviewConfigPath) throw new Error("style review workspace inputs are required");
  const preparedVision = vision || await prepareStyleVision(dir);
  await fs.access(join(dir, "style-proof.mov"));
  const results = [];
  const models = new Set();
  const stderr = [];
  for (let round = 1; round <= maxReviewRounds; round += 1) {
    const proofFrames = await extractVisionFrames({
      videoPath: join(dir, "style-proof.mov"),
      outputDir: preparedVision.visionDir,
      times: [0.5, 1.5, 2.5],
      prefix: `proof-round-${round}`,
    });
    const [proofSheet] = await extractReferenceMotionSheets({
      videoPath: join(dir, "style-proof.mov"),
      outDir: join(preparedVision.visionDir, `proof-motion-round-${round}`),
      durationMs: 3000,
      maxWindows: 1,
      secondsPerWindow: 2.8,
      fps: 4,
      columns: 5,
      frameWidth: 360,
    });
    const proofMotionSheet = {
      ...proofSheet,
      timeSeconds: 0,
      label: "Proof motion sheet: 0.00-2.80s at 4fps",
      data: (await fs.readFile(proofSheet.path)).toString("base64"),
    };
    await writeReviewGate(dir);
    const review = await runClaudeVisionTurn({
      dir,
      configPath: reviewConfigPath,
      styleRoot,
      payload: userMessage(reviewPrompt({
        round,
        maxRounds: maxReviewRounds,
        referenceFrames: preparedVision.referenceFrames,
        referenceMotionSheets: preparedVision.referenceMotionSheets,
        proofFrames,
        proofMotionSheet,
      }), [
        ...preparedVision.referenceFrames.slice(1, 5),
        ...preparedVision.referenceMotionSheets,
        ...proofFrames,
        proofMotionSheet,
      ]),
      timeoutMs,
      budgetUsd,
      onEvent,
    });
    results.push(review.result);
    review.models.forEach((model) => models.add(model));
    stderr.push(review.stderr);
    if (await stylePackMatchesCurrent(dir)) {
      return {
        result: review.result,
        results,
        models: [...models],
        stderr: stderr.join("\n").slice(-8000),
        referenceFrames: preparedVision.referenceTimes,
      };
    }
    if (round === maxReviewRounds) {
      const reviewEvidence = String(review.result.result || "no review explanation").slice(0, 1600);
      throw new Error(`Claude Code did not approve a visually valid StylePack after ${maxReviewRounds} proof review rounds. Last review: ${reviewEvidence}`);
    }
  }
  throw new Error("Claude Code proof review did not produce a StylePack");
}

export async function invokeReferenceStyleAgent({
  dir,
  configPath,
  reviewConfigPath,
  styleRoot,
  timeoutMs = STYLE_AGENT_TIMEOUT_MS,
  budgetUsd = 4,
  maxReviewRounds = 3,
  onEvent = () => {},
} = {}) {
  const vision = await prepareStyleVision(dir);
  const author = await runClaudeVisionTurn({
    dir,
    configPath,
    styleRoot,
    payload: userMessage(
      authoringPrompt(vision.referenceFrames, vision.referenceMotionSheets),
      [...vision.referenceFrames, ...vision.referenceMotionSheets],
    ),
    timeoutMs,
    budgetUsd,
    onEvent,
  });
  await fs.access(join(dir, "analysis.json"));
  await fs.access(join(dir, "validation.json"));
  const review = await reviewReferenceStyleProject({
    dir,
    reviewConfigPath,
    styleRoot,
    timeoutMs,
    budgetUsd,
    maxReviewRounds,
    onEvent,
    vision,
  });
  return {
    ...review,
    results: [author.result, ...review.results],
    models: [...new Set([...author.models, ...review.models])],
    stderr: [author.stderr, review.stderr].filter(Boolean).join("\n").slice(-8000),
  };
}

export async function runReferenceStyleAgent({
  referenceId = randomUUID(),
  videoPath,
  workDir,
  mode,
  sourceFilename,
  referenceUsageConfirmedAt,
  styleRoot,
  claudeRunner = invokeReferenceStyleAgent,
  budgetUsd = 4,
  timeoutMs = STYLE_AGENT_TIMEOUT_MS,
  maxReviewRounds = 3,
  onEvent = () => {},
} = {}) {
  const prepared = await prepareReferenceStyleWorkspace({ workDir, videoPath, referenceId, mode, sourceFilename, referenceUsageConfirmedAt, styleRoot });
  const run = await claudeRunner({
    dir: prepared.dir,
    configPath: prepared.configPath,
    reviewConfigPath: prepared.reviewConfigPath,
    styleRoot,
    budgetUsd,
    timeoutMs,
    maxReviewRounds,
    referenceId,
    onEvent,
  });
  const analysis = JSON.parse(await fs.readFile(join(prepared.dir, "analysis.json"), "utf8"));
  const stylePack = JSON.parse(await fs.readFile(join(prepared.dir, "style-pack.json"), "utf8"));
  if (!analysis?.analysisId || !stylePack?.id || stylePack.status !== "pending_approval") {
    throw new Error("Claude Code did not produce a pending StylePack and analysis");
  }
  return { analysis, stylePack, workspaceDir: prepared.dir, claudeRun: run };
}
