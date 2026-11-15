import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStyleSpec } from "./style-spec.mjs";

const portalRoot = fileURLToPath(new URL("../", import.meta.url));
const scaffoldDir = resolve(portalRoot, "style-project-template");
const MANIFEST_KEYS = new Set(["contract", "id", "name", "version", "status", "sourceAnalysisId", "supportedModes", "parameters", "capabilities", "requirements", "unsupported", "preview", "styleSpec"]);
const PROJECT_KEYS = new Set(["contract", "id", "version", "dir", "entryPoint", "compositionId", "manifest", "manifestSha256", "codeSha256", "status"]);
const MODES = new Set(["single-video-v1", "multi-asset-v1"]);
const STATUSES = new Set(["draft", "pending_approval", "approved", "rejected"]);
const CAPABILITIES = new Set(["captions", "title_card", "emphasis", "cta", "callout", "punch_in", "split", "broll_cover"]);

export function classifyOverlayType(rawType) {
  const type = String(rawType || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["title", "titlecard", "header", "headertitle", "headline", "headlinetitle"].includes(type)) return "title_card";
  if (type === "cta") return "cta";
  if (["emphasis", "callout", "caption", "sticker", "lowerthird", "identity", "identitycard", "badge"].includes(type)) return "emphasis";
  return null;
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function assertKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unsupported ${name} field: ${key}`);
}

function safeId(value) {
  const id = String(value || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new Error("style id must be a lowercase slug");
  return id;
}

export function validateStyleManifest(raw) {
  assertObject(raw, "StyleManifest");
  assertKeys(raw, MANIFEST_KEYS, "StyleManifest");
  if (!["style-manifest.v1", "style-manifest.v2"].includes(raw.contract)) {
    throw new Error("StyleManifest contract must be style-manifest.v1 or style-manifest.v2");
  }
  const styleSpec = raw.styleSpec ? normalizeStyleSpec(raw.styleSpec) : null;
  if (raw.contract === "style-manifest.v2" && !styleSpec) throw new Error("StyleManifest v2 requires styleSpec");
  safeId(raw.id);
  const name = String(raw.name || "").trim();
  if (!name || name.length > 120) throw new Error("StyleManifest name is invalid");
  if (!Number.isInteger(Number(raw.version)) || Number(raw.version) < 1) throw new Error("StyleManifest version is invalid");
  if (!STATUSES.has(raw.status)) throw new Error("StyleManifest status is invalid");
  if (!String(raw.sourceAnalysisId || "").trim()) throw new Error("StyleManifest sourceAnalysisId is required");
  if (!Array.isArray(raw.supportedModes) || !raw.supportedModes.length || raw.supportedModes.some((mode) => !MODES.has(mode))) {
    throw new Error("StyleManifest supportedModes is invalid");
  }
  if (new Set(raw.supportedModes).size !== raw.supportedModes.length) throw new Error("StyleManifest supportedModes is duplicated");
  assertObject(raw.parameters, "StyleManifest parameters");
  for (const [key, value] of Object.entries(raw.parameters)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key)) throw new Error(`invalid style parameter name: ${key}`);
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`invalid style parameter value: ${key}`);
  }
  if (!Array.isArray(raw.capabilities) || raw.capabilities.some((item) => !CAPABILITIES.has(item))) throw new Error("StyleManifest capabilities is invalid");
  assertObject(raw.requirements, "StyleManifest requirements");
  assertKeys(raw.requirements, new Set(["minAssets", "needsMainFootage", "needsBroll"]), "StyleManifest requirements");
  const minAssets = Number(raw.requirements.minAssets);
  if (!Number.isInteger(minAssets) || minAssets < 1) throw new Error("StyleManifest requirements.minAssets is invalid");
  if (typeof raw.requirements.needsMainFootage !== "boolean" || typeof raw.requirements.needsBroll !== "boolean") {
    throw new Error("StyleManifest requirements flags are invalid");
  }
  if (raw.supportedModes.includes("multi-asset-v1") && (minAssets < 2 || raw.requirements.needsMainFootage !== true)) {
    throw new Error("multi-asset StyleManifest requires at least two assets and needsMainFootage");
  }
  if (!Array.isArray(raw.unsupported) || raw.unsupported.some((item) => typeof item !== "string")) throw new Error("StyleManifest unsupported is invalid");
  if (raw.preview !== null) {
    assertObject(raw.preview, "StyleManifest preview");
    assertKeys(raw.preview, new Set(["video", "poster"]), "StyleManifest preview");
    if (!String(raw.preview.video || "").trim() || !String(raw.preview.poster || "").trim()) throw new Error("StyleManifest preview paths are invalid");
  }
  return {
    ...raw,
    id: raw.id,
    name,
    version: Number(raw.version),
    supportedModes: [...raw.supportedModes],
    parameters: { ...raw.parameters },
    capabilities: [...raw.capabilities],
    requirements: { ...raw.requirements },
    unsupported: [...raw.unsupported],
    preview: raw.preview ? { ...raw.preview } : null,
    ...(styleSpec ? { styleSpec } : {}),
  };
}

function validateStyleProjectShape(raw) {
  assertObject(raw, "StyleProject");
  assertKeys(raw, PROJECT_KEYS, "StyleProject");
  if (raw.contract !== "style-project.v1") throw new Error("StyleProject contract must be style-project.v1");
  safeId(raw.id);
  if (!Number.isInteger(Number(raw.version)) || Number(raw.version) < 1) throw new Error("StyleProject version is invalid");
  if (!String(raw.dir || "").trim()) throw new Error("StyleProject dir is required");
  if (!/^src\/[A-Za-z0-9_./-]+\.(tsx|ts|jsx|js)$/.test(String(raw.entryPoint || ""))) throw new Error("StyleProject entryPoint is invalid");
  if (String(raw.entryPoint).includes("..")) throw new Error("StyleProject entryPoint must stay inside src");
  if (!String(raw.compositionId || "").trim()) throw new Error("StyleProject compositionId is required");
  const manifest = validateStyleManifest(raw.manifest);
  if (!/^[a-f0-9]{64}$/.test(String(raw.manifestSha256 || "")) || !/^[a-f0-9]{64}$/.test(String(raw.codeSha256 || ""))) throw new Error("StyleProject hashes are invalid");
  if (!STATUSES.has(raw.status)) throw new Error("StyleProject status is invalid");
  return { ...raw, id: raw.id, version: Number(raw.version), manifest };
}

export function validateStyleProject(project) {
  return validateStyleProjectShape(project);
}

async function listFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    const rel = relative(root, absolute);
    if (rel === "style-manifest.json" || rel.startsWith(`previews${process.platform === "win32" ? "\\" : "/"}`)) continue;
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export async function hashStyleProject(dir) {
  const root = resolve(dir);
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update(await fs.readFile(file));
  }
  return hash.digest("hex");
}

export function defaultManifest(analysis, overrides = {}) {
  const analysisId = String(analysis?.analysisId || "").trim();
  if (!analysisId) throw new Error("analysis.analysisId is required");
  const id = String(overrides.id || `style-${analysisId.slice(0, 16)}`).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const shots = Array.isArray(analysis?.shots) ? analysis.shots : [];
  const brollRatio = Math.max(0, Math.min(1, Number(analysis?.rhythm?.brollRatio) || 0));
  const punchInRatio = Math.max(0, Math.min(1, Number(analysis?.rhythm?.punchInRatio) || 0));
  const captionEvidence = Number(analysis?.confidence?.captions) >= 0.5
    || Number(analysis?.captions?.maxWordsPerCue) > 0
    || Number(analysis?.captions?.fontSizeRatio) > 0;
  const overlayCapabilities = [...new Set((Array.isArray(analysis?.overlays) ? analysis.overlays : []).flatMap((overlay) => {
    const capability = classifyOverlayType(overlay?.type);
    return capability ? [capability] : [];
  }))];
  const capabilities = [
    ...(captionEvidence ? ["captions"] : []),
    ...overlayCapabilities,
    ...(shots.some((shot) => shot.layout === "punch_in") || punchInRatio > 0 ? ["punch_in"] : []),
    ...(shots.some((shot) => shot.layout === "split") ? ["split"] : []),
    ...(shots.some((shot) => shot.layout === "broll_cover" || shot.broll) || brollRatio > 0 ? ["broll_cover"] : []),
  ];
  const colorAccent = /^#[0-9a-f]{6}$/i.test(String(analysis?.captions?.keywordColor || ""))
    ? String(analysis.captions.keywordColor).toLowerCase()
    : "#c6f475";
  const styleSpec = analysis?.styleSpec ? normalizeStyleSpec(analysis.styleSpec, {
    aspectRatio: analysis?.source?.aspectRatio || undefined,
  }) : null;
  if (analysis?.contract === "reference-analysis.v2" && !styleSpec) {
    throw new Error("ReferenceAnalysis v2 must include styleSpec");
  }
  return validateStyleManifest({
    contract: styleSpec ? "style-manifest.v2" : "style-manifest.v1",
    id,
    name: String(overrides.name || `Draft style ${analysisId.slice(0, 8)}`),
    version: 1,
    status: "draft",
    sourceAnalysisId: analysisId,
    supportedModes: ["single-video-v1", "multi-asset-v1"],
    parameters: {
      captionScale: Math.round(Math.max(0.5, Math.min(2, (Number(analysis?.captions?.fontSizeRatio) || 0.05) / 0.05)) * 100) / 100,
      motionIntensity: Math.round(Math.max(0.3, Math.min(1, 0.5 + punchInRatio)) * 100) / 100,
      brollDensity: Math.round(brollRatio * 100) / 100,
      colorAccent,
    },
    capabilities,
    requirements: { minAssets: 2, needsMainFootage: true, needsBroll: capabilities.includes("broll_cover") },
    unsupported: Array.isArray(analysis?.unsupported) ? [...analysis.unsupported] : [],
    preview: null,
    ...(styleSpec ? { styleSpec } : {}),
    ...overrides,
  });
}

export async function createDraftStyleProject({ analysis, outDir, manifest = null } = {}) {
  if (!outDir) throw new Error("outDir is required");
  const target = resolve(outDir);
  await fs.access(target).then(() => { throw new Error("style project outDir already exists"); }, () => undefined);
  const resolvedManifest = manifest ? validateStyleManifest(manifest) : defaultManifest(analysis);
  if (resolvedManifest.sourceAnalysisId !== String(analysis?.analysisId || "").trim()) throw new Error("StyleManifest sourceAnalysisId does not match analysis");
  await fs.cp(scaffoldDir, target, { recursive: true, errorOnExist: true, force: false });
  const manifestPath = resolve(target, "style-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(resolvedManifest, null, 2), { flag: "wx" });
  const manifestSha256 = createHash("sha256").update(await fs.readFile(manifestPath)).digest("hex");
  const codeSha256 = await hashStyleProject(target);
  return validateStyleProject({
    contract: "style-project.v1",
    id: resolvedManifest.id,
    version: resolvedManifest.version,
    dir: target,
    entryPoint: "src/index.tsx",
    compositionId: "ReferenceStyle",
    manifest: resolvedManifest,
    manifestSha256,
    codeSha256,
    status: "draft",
  });
}
