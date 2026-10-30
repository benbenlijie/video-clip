import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";

function serializableProject(project) {
  const { config: _config, dir: _dir, ...rest } = project;
  return rest;
}

export function createProjectStore(storageRoot) {
  const root = resolve(storageRoot);
  const projects = new Map();

  async function ensureRoot() {
    await fs.mkdir(root, { recursive: true });
  }

  function projectDir(id) {
    return join(root, id);
  }

  async function saveProject(project) {
    await ensureRoot();
    const dir = project.dir ?? projectDir(project.id);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = join(dir, ".project.json.tmp");
    await fs.writeFile(tempPath, JSON.stringify(serializableProject(project), null, 2), "utf8");
    await fs.rename(tempPath, join(dir, "project.json"));
    project.dir = dir;
    projects.set(project.id, project);
    return project;
  }

  async function loadProjects() {
    await ensureRoot();
    projects.clear();
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await fs.readFile(join(root, entry.name, "project.json"), "utf8");
        const project = JSON.parse(raw);
        if (!project.id || project.id !== entry.name) continue;
        project.dir = projectDir(project.id);
        projects.set(project.id, project);
      } catch {
        // Ignore incomplete directories; a failed upload can leave one behind.
      }
    }
    return projects;
  }

  function get(id) {
    return projects.get(id);
  }

  function artifactPath(project, name) {
    if (!project || typeof name !== "string" || !name || name.includes("\\") || name.includes("..") || name.includes("/")) return null;
    const artifactsDir = join(project.dir, "artifacts");
    const target = resolve(artifactsDir, name);
    if (!target.startsWith(`${resolve(artifactsDir)}${sep}`)) return null;
    return target;
  }

  return { root, projects, ensureRoot, saveProject, loadProjects, get, artifactPath, projectDir };
}

