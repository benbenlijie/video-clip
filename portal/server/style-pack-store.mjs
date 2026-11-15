import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashStyleProject, validateStyleManifest } from "./style-project.mjs";

const portalRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultRoot = resolve(portalRoot, "style-library");
const STATUSES = new Set(["draft", "pending_approval", "approved", "rejected"]);

function styleRoot({ root, project } = {}) {
  if (root) return resolve(root);
  if (project?.styleRoot) return resolve(project.styleRoot);
  if (project?.dir) return join(resolve(project.dir), "styles");
  return defaultRoot;
}

function safeVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new Error("StylePack version is invalid");
  return version;
}

function safeStyleId(value) {
  const id = String(value || "");
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new Error("StylePack id is invalid");
  return id;
}

function versionDir(root, id, version) {
  return join(root, "styles", safeStyleId(id), `v${safeVersion(version)}`);
}

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packFrom({ root, manifest, dir, status, manifestSha256, codeSha256 }) {
  return {
    contract: "style-pack.v1",
    id: manifest.id,
    version: manifest.version,
    status,
    manifest,
    dir,
    styleProjectDir: join(dir, "style-project"),
    manifestSha256,
    codeSha256,
  };
}

export async function saveStylePack({ project = null, manifest, projectDir, status = "draft", root = null } = {}) {
  const normalized = validateStyleManifest(manifest);
  if (!STATUSES.has(status)) throw new Error("StylePack approval status is invalid");
  if (!projectDir) throw new Error("StylePack projectDir is required");
  const sourceDir = resolve(projectDir);
  if (!(await exists(sourceDir))) throw new Error("StyleProject directory does not exist");
  const storageRoot = styleRoot({ root, project });
  const target = versionDir(storageRoot, normalized.id, normalized.version);
  if (await exists(target)) throw new Error(`StylePack ${normalized.id} v${normalized.version} already exists and is immutable`);
  await fs.mkdir(target, { recursive: true });
  try {
    await fs.cp(sourceDir, join(target, "style-project"), { recursive: true, errorOnExist: true, force: false });
    const manifestPath = join(target, "style-manifest.json");
    const manifestText = JSON.stringify(normalized, null, 2);
    await fs.writeFile(manifestPath, manifestText, { flag: "wx" });
    const manifestSha256 = hashBytes(Buffer.from(manifestText));
    const codeSha256 = await hashStyleProject(join(target, "style-project"));
    const approval = {
      contract: "style-approval.v1",
      styleId: normalized.id,
      version: normalized.version,
      status,
      manifestSha256,
      codeSha256,
      savedAt: new Date().toISOString(),
    };
    await fs.writeFile(join(target, "approval.json"), JSON.stringify(approval, null, 2), { flag: "wx" });
    return packFrom({ root: storageRoot, manifest: normalized, dir: target, status, manifestSha256, codeSha256 });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function loadStylePack(id, version, { root = defaultRoot } = {}) {
  const storageRoot = styleRoot({ root });
  const dir = versionDir(storageRoot, id, version);
  const manifestPath = join(dir, "style-manifest.json");
  const approvalPath = join(dir, "approval.json");
  const [manifestText, approvalText] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(approvalPath, "utf8"),
  ]);
  const manifest = validateStyleManifest(JSON.parse(manifestText));
  const approval = JSON.parse(approvalText);
  if (approval.contract !== "style-approval.v1" || approval.styleId !== manifest.id || Number(approval.version) !== manifest.version) {
    throw new Error("StylePack approval metadata does not match manifest");
  }
  if (!STATUSES.has(approval.status)) throw new Error("StylePack approval status is invalid");
  const manifestSha256 = hashBytes(Buffer.from(manifestText));
  if (manifestSha256 !== approval.manifestSha256) throw new Error("StylePack manifest hash mismatch");
  const codeSha256 = await hashStyleProject(join(dir, "style-project"));
  if (codeSha256 !== approval.codeSha256) throw new Error("StylePack code hash mismatch");
  return packFrom({ root: storageRoot, manifest, dir, status: approval.status, manifestSha256, codeSha256 });
}

export async function approveStylePack(id, version, { root = defaultRoot } = {}) {
  const pack = await loadStylePack(id, version, { root });
  if (pack.status === "approved") return pack;
  if (!["draft", "pending_approval"].includes(pack.status)) throw new Error(`StylePack cannot be approved from status ${pack.status}`);
  const approvalPath = join(pack.dir, "approval.json");
  const approval = JSON.parse(await fs.readFile(approvalPath, "utf8"));
  const next = { ...approval, status: "approved", approvedAt: new Date().toISOString() };
  await fs.writeFile(approvalPath, JSON.stringify(next, null, 2));
  return loadStylePack(id, version, { root });
}

export async function rejectStylePack(id, version, { root = defaultRoot, reason = "" } = {}) {
  const pack = await loadStylePack(id, version, { root });
  if (pack.status === "rejected") return pack;
  if (pack.status === "approved") throw new Error("approved StylePack cannot be rejected");
  const approvalPath = join(pack.dir, "approval.json");
  const approval = JSON.parse(await fs.readFile(approvalPath, "utf8"));
  const next = {
    ...approval,
    status: "rejected",
    rejectedAt: new Date().toISOString(),
    rejectionReason: String(reason || "").slice(0, 500),
  };
  await fs.writeFile(approvalPath, JSON.stringify(next, null, 2));
  return loadStylePack(id, version, { root });
}

export function assertStylePackCompatible(stylePack, mode) {
  if (!["single-video-v1", "multi-asset-v1"].includes(mode)) throw new Error("unsupported project mode");
  if (!stylePack?.manifest?.supportedModes?.includes(mode)) throw new Error(`StylePack is not compatible with ${mode}`);
  if (mode === "multi-asset-v1") {
    if (stylePack.manifest.requirements?.needsMainFootage !== true || Number(stylePack.manifest.requirements?.minAssets) < 2) {
      throw new Error("multi-asset StylePack requires main footage and at least two assets");
    }
  }
  return true;
}

export { defaultRoot as stylePackRoot };
