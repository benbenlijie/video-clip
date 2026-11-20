import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeReferenceAudio,
  detectReferenceShots,
  extractReferenceFrames,
  normalizeReferenceAnalysis,
  probeReferenceMedia,
} from "./reference-analysis.mjs";
import { extractReferenceMotionSheets } from "./reference-motion.mjs";
import { normalizeStyleSpec } from "./style-spec.mjs";
import { classifyOverlayType, createDraftStyleProject, defaultManifest, hashStyleProject, validateStyleManifest } from "./style-project.mjs";
import { scanStyleProject } from "./style-policy.mjs";
import { assertStyleProjectSandboxed } from "./style-sandbox.mjs";
import { renderStyleProject } from "./style-renderer.mjs";
import { saveStylePack } from "./style-pack-store.mjs";
import { workspacePath } from "./workspace-path.mjs";

const execFile = promisify(execFileCallback);
const portalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultStyleRoot = resolve(portalRoot, "style-library");
const shotVisualSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  role: z.enum(["hook", "teaser", "context", "proof", "payoff", "brand", "cta", "unknown"]),
  layout: z.enum(["full", "punch_in", "split", "broll_cover", "unknown"]),
  broll: z.boolean(),
}).strict();
const captionVisualSchema = z.object({
  grouping: z.enum(["phrase", "sentence", "word", "unknown"]).optional(),
  maxWordsPerCue: z.number().int().min(0).max(12).optional(),
  position: z.enum(["bottom", "middle", "top", "unknown"]).optional(),
  fontSizeRatio: z.number().min(0).max(0.2).optional(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  strokeColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  strokeWidth: z.number().min(0).max(12).optional(),
  keywordColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  animation: z.string().min(1).max(80).optional(),
}).strict();
const overlayVisualSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  type: z.string().min(1).max(80),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  position: z.string().min(1).max(80).optional(),
  sizeRatio: z.number().min(0).max(1).optional(),
  coverage: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();
const capabilityVisualSchema = z.object({
  needsBroll: z.boolean().optional(),
  needsScreenshots: z.boolean().optional(),
  needsSplitScreen: z.boolean().optional(),
}).strict();
const confidenceVisualSchema = z.object({
  overall: z.number().min(0).max(1).optional(),
  rhythm: z.number().min(0).max(1).optional(),
  captions: z.number().min(0).max(1).optional(),
  layout: z.number().min(0).max(1).optional(),
}).strict();
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
const panelSpecSchema = z.object({
  enabled: z.boolean(),
  color: colorSchema,
  opacity: z.number().min(0).max(1),
  radiusRatio: z.number().min(0).max(0.5),
  paddingXRatio: z.number().min(0).max(0.25),
  paddingYRatio: z.number().min(0).max(0.25),
  blurPx: z.number().min(0).max(40),
}).strict();
const typographySpecSchema = z.object({
  fontFamily: z.string().regex(/^[A-Za-z0-9 ,'"_\-]{1,120}$/),
  fontId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/).optional(),
  fontWidthScale: z.number().min(0.7).max(1.3).optional(),
  fontWeight: z.number().int().min(300).max(900),
  fontSizeRatio: z.number().min(0.01).max(0.2),
  lineHeight: z.number().min(0.8).max(2),
  letterSpacingRatio: z.number().min(-0.02).max(0.1),
  color: colorSchema,
  strokeColor: colorSchema,
  strokeWidthRatio: z.number().min(0).max(0.02),
  shadowOpacity: z.number().min(0).max(1),
  shadowBlurRatio: z.number().min(0).max(0.05),
  shadowOffsetYRatio: z.number().min(-0.05).max(0.05),
}).strict();
const animationSpecSchema = z.object({
  type: z.enum(["none", "fade", "scale", "fade-scale", "slide-up", "wipe"]),
  durationMs: z.number().int().min(0).max(1200),
  delayMs: z.number().int().min(0).max(1200),
  easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "spring"]),
  scaleFrom: z.number().min(0.5).max(1.5),
  translateYRatio: z.number().min(-0.2).max(0.2),
  stagger: z.enum(["none", "word", "char"]),
  staggerMs: z.number().int().min(0).max(300),
}).strict();
const motionSpecSchema = z.object({
  enter: animationSpecSchema,
  exit: animationSpecSchema,
}).strict();
const styleSpecSchema = z.object({
  contract: z.enum(["style-spec.v2", "style-spec.v3"]),
  canvas: z.object({
    aspectRatio: z.enum(["9:16", "16:9"]),
    safeArea: z.object({
      topRatio: z.number().min(0).max(0.3),
      rightRatio: z.number().min(0).max(0.3),
      bottomRatio: z.number().min(0).max(0.3),
      leftRatio: z.number().min(0).max(0.3),
    }).strict(),
  }).strict(),
  title: z.object({
    anchor: z.enum(["top_left", "top_center", "top_right"]),
    widthRatio: z.number().min(0.2).max(1),
    maxLines: z.number().int().min(1).max(3),
    panel: panelSpecSchema,
    primary: typographySpecSchema,
    secondary: typographySpecSchema,
    motion: motionSpecSchema,
  }).strict(),
  identity: z.object({
    anchor: z.enum([
      "top_left", "top_center", "top_right",
      "middle_left", "middle_center", "middle_right",
      "bottom_left", "bottom_center", "bottom_right",
    ]),
    maxWidthRatio: z.number().min(0.2).max(0.8),
    offsetYRatio: z.number().min(-0.3).max(0.3).optional(),
    maxLines: z.number().int().min(1).max(6).optional(),
    panel: panelSpecSchema,
    primary: typographySpecSchema,
    secondary: typographySpecSchema,
    motion: motionSpecSchema,
  }).strict(),
  captions: z.object({
    grouping: z.enum(["word", "phrase", "sentence"]),
    maxCharsPerCue: z.number().int().min(1).max(24),
    anchor: z.enum(["top_center", "middle_center", "bottom_center"]),
    maxWidthRatio: z.number().min(0.3).max(1),
    panel: panelSpecSchema,
    typography: typographySpecSchema,
    highlight: z.object({
      strategy: z.enum(["none", "keyword"]),
      color: colorSchema,
      strokeColor: colorSchema,
      scalePeak: z.number().min(1).max(1.3),
      durationMs: z.number().int().min(0).max(500),
    }).strict(),
    motion: motionSpecSchema,
  }).strict(),
  effects: z.array(z.object({
    id: z.string().min(1).max(80),
    target: z.enum(["title", "identity", "captions", "overlay"]),
    trigger: z.enum(["enter", "cue_enter", "keyword", "exit"]),
    type: z.enum(["fade", "scale", "slide", "highlight", "color"]),
    durationMs: z.number().int().min(0).max(1200),
    delayMs: z.number().int().min(0).max(1200),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "spring"]),
    intensity: z.number().min(0).max(1),
  }).strict()).max(50).default([]),
}).strict();

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function imageContent(frame, label) {
  return [
    { type: "text", text: `${label}; shotIndex=${frame.shotIndex}; timeMs=${frame.timeMs}` },
    { type: "image", mimeType: frame.mimeType, data: frame.data },
  ];
}

export function buildStyleProofProps({ manifest, analysis, width, height }) {
  const legacyCaptions = analysis?.captions || {};
  const titlePosition = analysis?.styleSpec?.title?.anchor
    || analysis?.overlays?.find((overlay) => classifyOverlayType(overlay.type) === "title_card")?.position
    || "top_center";
  const identityPosition = analysis?.styleSpec?.identity?.anchor
    || analysis?.overlays?.find((overlay) => classifyOverlayType(overlay.type) === "emphasis")?.position
    || "middle_right";
  const captions = [
    { id: "proof-caption-1", startMs: 300, endMs: 1200, text: "用户自己的字幕样本", keywords: ["字幕"] },
    { id: "proof-caption-2", startMs: 1500, endMs: 2600, text: "风格预览", keywords: ["风格"] },
  ];
  const visualEvents = [...new Set(manifest.capabilities.filter((item) => ["title_card", "emphasis", "cta"].includes(item)))].map((type) => ({
    id: `proof-${type}`,
    type,
    startMs: type === "cta" ? 1200 : 0,
    endMs: 3000,
    text: type === "title_card" ? "用户自己的标题" : type === "emphasis" ? "用户自己的身份信息" : "用户自己的行动提示",
    subtext: type === "title_card" ? "用户自己的副标题" : type === "emphasis" ? "用户自己的身份说明" : "",
    position: type === "title_card" ? titlePosition : type === "emphasis" ? identityPosition : "bottom_center",
  }));
  const layoutEvents = manifest.capabilities.some((item) => ["punch_in", "split", "broll_cover"].includes(item))
    ? [{ id: "proof-layout", type: manifest.capabilities.includes("punch_in") ? "punch_in" : "full", startMs: 0, endMs: 3000, params: {} }]
    : [];
  const captionStyle = {
    fontSize: Math.max(16, Math.round(height * (Number(legacyCaptions.fontSizeRatio) || 0.05))),
    marginV: Math.max(24, Math.round(height * 0.08)),
    outline: Math.max(0, Math.round(Number(legacyCaptions.strokeWidth) || 1)),
    color: legacyCaptions.primaryColor || "#ffffff",
    position: legacyCaptions.position === "unknown" || !legacyCaptions.position ? "bottom" : legacyCaptions.position,
  };
  return {
    width,
    height,
    fps: 30,
    durationMs: 3000,
    captions,
    visualEvents,
    layoutEvents,
    styleParams: manifest.parameters,
    captionStyle,
    styleSpec: analysis.styleSpec || null,
  };
}

export async function startStyleTools(workDir, auditPath, { styleRoot = process.env.WAYNE_STYLE_DIR || defaultStyleRoot } = {}) {
  const root = await fs.realpath(workDir);
  const storageRoot = resolve(styleRoot);
  const audit = async (entry) => fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const server = new McpServer({ name: "reference-style", version: "1.0.0" });

  const register = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      await audit({ tool: name, error: error.message });
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });

  const referencePath = async () => workspacePath(root, "reference.mp4");
  const projectPath = async () => workspacePath(root, "style-project", { existing: false });
  const readBrief = async () => readJson(await workspacePath(root, "brief.json"));
  const readAnalysis = async () => normalizeReferenceAnalysis(await readJson(await workspacePath(root, "analysis.json")));

  register("probe_reference", "Read reference.mp4 with ffprobe and persist its factual media metadata and source SHA-256.", {}, async () => {
    const probe = await probeReferenceMedia(await referencePath());
    await fs.writeFile(await workspacePath(root, "probe.json", { existing: false }), JSON.stringify(probe, null, 2));
    await audit({ tool: "probe_reference", sha256: probe.sha256 });
    return { content: [{ type: "text", text: JSON.stringify(probe) }] };
  });

  register("detect_reference_shots", "Detect reference-video scene boundaries with the approved FFmpeg detector and persist shots.json. A one-shot result is valid for a continuous talking head.", {}, async () => {
    const probe = await readJson(await workspacePath(root, "probe.json"));
    const shots = await detectReferenceShots({ videoPath: await referencePath(), durationMs: probe.durationMs, workDir: root });
    await fs.writeFile(await workspacePath(root, "shots.json", { existing: false }), JSON.stringify(shots, null, 2));
    await audit({ tool: "detect_reference_shots", count: shots.length });
    return { content: [{ type: "text", text: JSON.stringify(shots) }] };
  });

  register("extract_reference_frames", "Extract representative reference frames and return them as images for Claude vision. The tool never returns reference OCR or transcript text.", { maxFrames: z.number().int().min(1).max(8).default(6) }, async ({ maxFrames }) => {
    const probe = await readJson(await workspacePath(root, "probe.json"));
    const shots = await readJson(await workspacePath(root, "shots.json")).catch(() => [{ id: "shot-01", startMs: 0, endMs: probe.durationMs }]);
    const frames = await extractReferenceFrames({ videoPath: await referencePath(), workDir: root, shots, maxFrames });
    const content = [];
    for (const frame of frames) {
      content.push(...imageContent({ ...frame, data: (await fs.readFile(frame.path)).toString("base64") }, frame.path.split("/").at(-1)));
    }
    await audit({ tool: "extract_reference_frames", count: frames.length });
    return { content };
  });

  register("extract_reference_motion_windows", "Extract chronological contact sheets across the reference video so motion, subtitle transitions, emphasis, and panel behavior can be compared. Each sheet covers one short time window.", {
    maxWindows: z.number().int().min(1).max(6).default(5),
    secondsPerWindow: z.number().min(1).max(4).default(2.5),
  }, async ({ maxWindows, secondsPerWindow }) => {
    const probe = await readJson(await workspacePath(root, "probe.json"));
    const outDir = await workspacePath(root, "reference-motion", { existing: false });
    const sheets = await extractReferenceMotionSheets({
      videoPath: await referencePath(),
      outDir,
      durationMs: probe.durationMs,
      maxWindows,
      secondsPerWindow,
    });
    await audit({ tool: "extract_reference_motion_windows", count: sheets.length, secondsPerWindow });
    const content = [];
    for (const sheet of sheets) {
      content.push(
        { type: "text", text: `motion window ${sheet.index + 1}; startMs=${sheet.startMs}; endMs=${sheet.endMs}; fps=${sheet.sampleFps}` },
        { type: "image", mimeType: sheet.mimeType, data: (await fs.readFile(sheet.path)).toString("base64") },
      );
    }
    return { content };
  });

  register("read_file", "Read a UTF-8 file from the reference-style workspace. Paths are workspace-relative and cannot escape the workspace.", { path: z.string().min(1).max(300) }, async ({ path }) => {
    const target = await workspacePath(root, path);
    if ((await fs.stat(target)).size > 350000) throw new Error("file exceeds 350KB");
    await audit({ tool: "read_file", path });
    return { content: [{ type: "text", text: await fs.readFile(target, "utf8") }] };
  });

  register("write_style_file", "Write or replace a source file under style-project/src. Manifest, package, tsconfig and files outside src are protected.", { path: z.string().min(1).max(300), content: z.string().max(300000) }, async ({ path, content }) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!/^style-project\/src\/[A-Za-z0-9._/-]+\.(tsx?|jsx?|css|svg)$/.test(normalized) || normalized.includes("..")) {
      throw new Error("only style-project/src source files may be written");
    }
    const target = await workspacePath(root, normalized, { existing: false });
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    await audit({ tool: "write_style_file", path: normalized, bytes: Buffer.byteLength(content) });
    return { content: [{ type: "text", text: `Written ${normalized}` }] };
  });

  register("analyze_reference_audio", "Extract local BPM and onset-density features from the reference audio. Returns unknown/null when the analyzer is unavailable.", {}, async () => {
    const probe = await readJson(await workspacePath(root, "probe.json"));
    let audio;
    try {
      audio = await analyzeReferenceAudio({ videoPath: await referencePath(), workDir: root, hasAudio: probe.hasAudio });
    } catch {
      audio = { bpm: null, voice: "unknown", sfxDensity: "unknown" };
    }
    await fs.writeFile(await workspacePath(root, "audio.json", { existing: false }), JSON.stringify(audio, null, 2));
    await audit({ tool: "analyze_reference_audio", audio });
    return { content: [{ type: "text", text: JSON.stringify(audio) }] };
  });

  register("write_reference_analysis", "Persist Claude's visual facts and the detailed StyleSpec v2/v3. MCP injects source, audio, rhythm, analysisId and contract from probe/audio/shots files; Claude supplies shots, captions, overlays, capabilities, unsupported, confidence, and styleSpec.", {
    shots: z.array(shotVisualSchema).optional(),
    captions: captionVisualSchema.optional(),
    overlays: z.array(overlayVisualSchema).optional(),
    capabilities: capabilityVisualSchema.optional(),
    unsupported: z.array(z.string()).optional(),
    confidence: confidenceVisualSchema.optional(),
    styleSpec: styleSpecSchema,
  }, async ({ shots, captions = {}, overlays = [], capabilities = {}, unsupported = [], confidence = {}, styleSpec }) => {
    const probe = await readJson(await workspacePath(root, "probe.json"));
    const analyzedAudio = await readJson(await workspacePath(root, "audio.json"));
    const detectedShots = await readJson(await workspacePath(root, "shots.json"));
    const visualShots = shots?.length ? shots : detectedShots;
    const derivedCapabilities = {
      needsBroll: visualShots.some((shot) => shot.broll === true || shot.layout === "broll_cover"),
      needsScreenshots: false,
      needsSplitScreen: visualShots.some((shot) => shot.layout === "split"),
    };
    const normalized = normalizeReferenceAnalysis({
      contract: "reference-analysis.v2",
      source: {
        filename: probe.filename,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        aspectRatio: probe.width < probe.height ? "9:16" : "16:9",
        fps: probe.fps,
        hasAudio: probe.hasAudio,
        sha256: probe.sha256,
      },
      shots: visualShots,
      captions,
      overlays,
      audio: analyzedAudio,
      capabilities: { ...derivedCapabilities, ...capabilities },
      unsupported,
      confidence,
      styleSpec,
    });
    if (normalized.shots.some((shot) => shot.layout === "unknown")) throw new Error("ReferenceAnalysis shot layout is incomplete; use full when no stronger visual layout is supported");
    const captionEvidence = normalized.captions.position !== "unknown"
      && (normalized.captions.maxWordsPerCue > 0 || normalized.captions.fontSizeRatio > 0);
    if (!captionEvidence && !normalized.unsupported.includes("captions-not-visible")) {
      throw new Error(
        `ReferenceAnalysis caption evidence is incomplete: position=${normalized.captions.position}, `
        + `maxWordsPerCue=${normalized.captions.maxWordsPerCue}, fontSizeRatio=${normalized.captions.fontSizeRatio}. `
        + "When captions are visible, set position to bottom/top/middle and set at least one of maxWordsPerCue (1-12) "
        + "or fontSizeRatio (>0). For Chinese cues, count visible characters as words for this heuristic. "
        + "Otherwise add captions-not-visible to unsupported.",
      );
    }
    const hasHeader = normalized.overlays.some((overlay) => (
      classifyOverlayType(overlay.type) === "title_card"
      || String(overlay.position).startsWith("top")
    ));
    if (!hasHeader && !normalized.unsupported.includes("no-header-text")) {
      throw new Error(
        "ReferenceAnalysis header evidence is incomplete: record the persistent top/header text band as a title_card overlay "
        + "with its time range, position, sizeRatio, and coverage. If the reference has no persistent header text, "
        + "explicitly add no-header-text to unsupported.",
      );
    }
    const brief = await readBrief();
    if (!brief.referenceUsageConfirmedAt) throw new Error("reference authorization timestamp is missing");
    await fs.writeFile(await workspacePath(root, "analysis.json", { existing: false }), JSON.stringify(normalized, null, 2));
    await audit({ tool: "write_reference_analysis", analysisId: normalized.analysisId, confidence: normalized.confidence });
    return { content: [{ type: "text", text: JSON.stringify({ contract: normalized.contract, analysisId: normalized.analysisId, source: normalized.source, rhythm: normalized.rhythm, audio: normalized.audio, captions: normalized.captions, overlays: normalized.overlays, capabilities: normalized.capabilities, unsupported: normalized.unsupported, styleSpec: normalized.styleSpec }) }] };
  });

  register("create_style_project", "Create the fixed StyleProject scaffold from analysis.json. The agent may edit only files under style-project/src and relative allowed assets.", { name: z.string().max(120).optional() }, async ({ name }) => {
    const analysis = await readAnalysis();
    const manifest = name ? { ...defaultManifest(analysis), name } : null;
    const projectDir = await projectPath();
    await fs.access(projectDir).then(() => { throw new Error("style-project already exists"); }, () => undefined);
    const project = await createDraftStyleProject({ analysis, outDir: projectDir, manifest });
    await audit({ tool: "create_style_project", id: project.id, version: project.version, codeSha256: project.codeSha256 });
    return { content: [{ type: "text", text: JSON.stringify({ id: project.id, version: project.version, dir: "style-project", entryPoint: project.entryPoint, compositionId: project.compositionId, manifest: project.manifest, manifestSha256: project.manifestSha256, codeSha256: project.codeSha256 }) }] };
  });

  register("validate_style_project", "Run the static policy scan, sandbox check, and transparent alpha proof render. Returns a proof path and hash for visual inspection.", {}, async () => {
    const projectDir = await projectPath();
    const analysis = await readAnalysis();
    const manifest = validateStyleManifest(await readJson(join(projectDir, "style-manifest.json")));
    const policy = await scanStyleProject(projectDir);
    if (!policy.ok) throw new Error(`style policy rejected project: ${policy.errors.map((item) => `${item.code}@${item.file}:${item.line}`).join(", ")}`);
    await assertStyleProjectSandboxed(projectDir);
    const proofPath = await workspacePath(root, "style-proof.mov", { existing: false });
    await fs.rm(proofPath, { force: true });
    const width = analysis.source.aspectRatio === "16:9" ? 640 : 360;
    const height = analysis.source.aspectRatio === "16:9" ? 360 : 640;
    const proofProps = buildStyleProofProps({ manifest, analysis, width, height });
    const result = await renderStyleProject({ projectDir, compositionId: "ReferenceStyle", outputPath: proofPath, props: proofProps });
    const codeSha256 = await hashStyleProject(projectDir);
    await fs.writeFile(await workspacePath(root, "validation.json", { existing: false }), JSON.stringify({ passed: true, validatedAt: new Date().toISOString(), proof: "style-proof.mov", proofSha256: result.sha256, codeSha256, manifestSha256: createHash("sha256").update(await fs.readFile(join(projectDir, "style-manifest.json"))).digest("hex"), alpha: result.alpha, isolation: result.isolation, networkIsolated: result.networkIsolated }, null, 2));
    await audit({ tool: "validate_style_project", proofSha256: result.sha256, codeSha256 });
    return { content: [{ type: "text", text: JSON.stringify({ proofPath: "style-proof.mov", ...result }) }] };
  });

  if (process.env.WAYNE_STYLE_NATIVE_VISION !== "1") {
    register("view_frame", "View a frame from reference.mp4 or the generated style-proof.mov. Use at least three proof times after validation.", { video: z.enum(["reference.mp4", "style-proof.mov"]), timeSeconds: z.number().min(0) }, async ({ video, timeSeconds }) => {
      const source = await workspacePath(root, video);
      const frameName = `inspection-${Date.now()}.jpg`;
      const framePath = await workspacePath(root, frameName, { existing: false });
      await execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(timeSeconds), "-i", source, "-frames:v", "1", "-vf", "scale=720:1280:force_original_aspect_ratio=decrease", "-q:v", "3", framePath], { cwd: root, timeout: 30000 });
      const data = await fs.readFile(framePath);
      await audit({ tool: "view_frame", video, timeSeconds, sha256: await sha256File(source) });
      return { content: [{ type: "text", text: `${video} at ${timeSeconds}s` }, { type: "image", mimeType: "image/jpeg", data: data.toString("base64") }] };
    });
  }

  if (process.env.WAYNE_STYLE_PHASE !== "authoring") register("begin_style_revision", "Create the next immutable StyleManifest version before changing an already-saved StyleProject. This updates only the manifest version; revalidate before saving.", {}, async () => {
    const projectDir = await projectPath();
    const manifestPath = join(projectDir, "style-manifest.json");
    const manifest = validateStyleManifest(await readJson(manifestPath));
    const styleVersionsDir = join(storageRoot, "styles", manifest.id);
    const storedVersions = await fs.readdir(styleVersionsDir).catch(() => []);
    const highestStored = Math.max(0, ...storedVersions
      .map((name) => /^v(\d+)$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1])));
    const nextVersion = Math.max(Number(manifest.version), highestStored + 1);
    const nextManifest = validateStyleManifest({ ...manifest, version: nextVersion, status: "draft", preview: null });
    await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2));
    const manifestSha256 = createHash("sha256").update(await fs.readFile(manifestPath)).digest("hex");
    await audit({ tool: "begin_style_revision", previousVersion: manifest.version, version: nextVersion, manifestSha256 });
    return { content: [{ type: "text", text: JSON.stringify({ version: nextVersion, manifestSha256, revalidateRequired: true }) }] };
  });

  if (process.env.WAYNE_STYLE_PHASE !== "authoring") register("update_style_spec", "Replace the detailed StyleSpec v2 in both analysis.json and the current StyleProject manifest during review. Keeps analysisId and manifest version; revalidation is required before saving.", {
    styleSpec: styleSpecSchema,
  }, async ({ styleSpec }) => {
    const projectDir = await projectPath();
    const analysisPath = await workspacePath(root, "analysis.json");
    const manifestPath = join(projectDir, "style-manifest.json");
    const analysisRaw = await readJson(analysisPath);
    const normalizedSpec = normalizeStyleSpec(styleSpec, {
      aspectRatio: analysisRaw.source?.aspectRatio || undefined,
    });
    const nextAnalysis = normalizeReferenceAnalysis({
      ...analysisRaw,
      contract: "reference-analysis.v2",
      styleSpec: normalizedSpec,
    });
    const manifest = validateStyleManifest(await readJson(manifestPath));
    if (manifest.sourceAnalysisId !== nextAnalysis.analysisId) throw new Error("StyleManifest sourceAnalysisId does not match analysis");
    const derivedManifest = defaultManifest(nextAnalysis);
    const nextManifest = validateStyleManifest({
      ...manifest,
      styleSpec: normalizedSpec,
      capabilities: derivedManifest.capabilities,
      requirements: derivedManifest.requirements,
    });
    await fs.writeFile(analysisPath, JSON.stringify(nextAnalysis, null, 2));
    await fs.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2));
    const manifestSha256 = createHash("sha256").update(await fs.readFile(manifestPath)).digest("hex");
    await audit({ tool: "update_style_spec", analysisId: nextAnalysis.analysisId, version: nextManifest.version, manifestSha256 });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          analysisId: nextAnalysis.analysisId,
          version: nextManifest.version,
          styleSpec: nextManifest.styleSpec,
          manifestSha256,
          revalidateRequired: true,
        }),
      }],
    };
  });

  if (process.env.WAYNE_STYLE_PHASE !== "authoring") register("save_style_pack", "Persist a visually reviewed StyleProject as a pending-approval StylePack. The current proof and code hashes must match the orchestrator's one-time review gate. Human or local admin approval is still required before use.", {}, async () => {
    const brief = await readBrief();
    if (!brief.referenceUsageConfirmedAt) throw new Error("reference authorization timestamp is missing");
    const projectDir = await projectPath();
    const manifest = validateStyleManifest(await readJson(join(projectDir, "style-manifest.json")));
    if (!manifest.capabilities.length) throw new Error("StyleManifest has no transferable capabilities; do not save an empty style pack");
    const validation = await readJson(await workspacePath(root, "validation.json"));
    const codeSha256 = await hashStyleProject(projectDir);
    const manifestSha256 = createHash("sha256").update(await fs.readFile(join(projectDir, "style-manifest.json"))).digest("hex");
    if (validation.passed !== true || validation.alpha !== true || validation.networkIsolated !== true) {
      throw new Error("StyleProject validation evidence is incomplete");
    }
    if (validation.codeSha256 !== codeSha256) throw new Error("StyleProject changed after validation");
    if (validation.manifestSha256 !== manifestSha256) throw new Error("StyleManifest changed after validation");
    const reviewGatePath = await workspacePath(root, ".control/style-review-gate.json", { existing: false });
    const reviewGate = await readJson(reviewGatePath).catch(() => null);
    if (!reviewGate) {
      await audit({ tool: "save_style_pack", deferredForReview: true });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "deferred_for_review",
            message: "Authoring phase complete. End this turn without saving; the orchestrator will attach the current proof for review.",
          }),
        }],
      };
    }
    if (
      reviewGate.contract !== "style-review-gate.v1"
      || reviewGate.proofSha256 !== validation.proofSha256
      || reviewGate.codeSha256 !== codeSha256
    ) {
      await audit({ tool: "save_style_pack", deferredForReview: true, staleGate: true });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "deferred_for_review",
            message: "The proof changed after the last review gate. End this turn without saving; the orchestrator will attach the new proof for another review.",
          }),
        }],
      };
    }
    await fs.mkdir(storageRoot, { recursive: true });
    const pack = await saveStylePack({ root: storageRoot, manifest, projectDir, status: "pending_approval" });
    await fs.writeFile(await workspacePath(root, "style-pack.json", { existing: false }), JSON.stringify(pack, null, 2));
    await audit({ tool: "save_style_pack", id: pack.id, version: pack.version, status: pack.status });
    return { content: [{ type: "text", text: JSON.stringify({ id: pack.id, version: pack.version, status: pack.status, manifestSha256: pack.manifestSha256, codeSha256: pack.codeSha256 }) }] };
  });

  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startStyleTools(process.argv[2], process.argv[3]);
}
