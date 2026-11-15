import { promises as fs } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { scanStyleProject } from "./style-policy.mjs";

function assertInside(root, target) {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("style project path escapes its sandbox root");
  }
}

export async function assertStyleProjectSandboxed(projectDir) {
  const root = resolve(projectDir);
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("style project directory does not exist");
  const entry = resolve(root, "src", "index.tsx");
  assertInside(root, entry);
  if (!(await fs.stat(entry).catch(() => null))?.isFile()) throw new Error("style project entry point is missing");
  const policy = await scanStyleProject(root);
  if (!policy.ok) {
    throw new Error(`style policy rejected generated project: ${policy.errors.map((item) => `${item.code}@${item.file}:${item.line}`).join(", ")}`);
  }
  return true;
}
