import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectStore } from "./project-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-store-race-"));
try {
  const store = createProjectStore(root);
  const project = { id: "same-project", dir: store.projectDir("same-project"), sequence: 0 };
  const results = await Promise.all(Array.from({ length: 40 }, (_, sequence) => store.saveProject({ ...project, sequence })));
  assert.equal(results.length, 40);
  const persisted = JSON.parse(await fs.readFile(path.join(root, project.id, "project.json"), "utf8"));
  assert.ok(persisted.sequence >= 0 && persisted.sequence < 40);
  assert.equal(store.get(project.id).id, project.id);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("project-store.verify: concurrent atomic project saves passed");
