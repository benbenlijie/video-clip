import { promises as fs } from "node:fs";
import { dirname, resolve, sep } from "node:path";

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
