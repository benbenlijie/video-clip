import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowserExecutable, browserExecutableCandidates } from "./style-browser.mjs";

const root = await fs.mkdtemp(join(tmpdir(), "wayne-style-browser-"));
try {
  const home = join(root, "home");
  const cache = join(home, ".cache", "ms-playwright");
  const shell = join(cache, "chromium_headless_shell-9999", "chrome-headless-shell-linux64", "chrome-headless-shell");
  await fs.mkdir(join(shell, ".."), { recursive: true });
  await fs.writeFile(shell, "#!/bin/sh\n");
  const candidates = await browserExecutableCandidates({ env: { PATH: "" }, home });
  assert.equal(candidates[0], shell);
  assert.equal(await findBrowserExecutable({ env: { PATH: "" }, home }), shell);

  const explicit = join(root, "custom-chrome");
  await fs.writeFile(explicit, "#!/bin/sh\n");
  assert.equal(await findBrowserExecutable({ env: { REMOTION_BROWSER_EXECUTABLE: explicit, PATH: "" }, home }), explicit);

  const systemDir = join(root, "bin");
  const system = join(systemDir, "google-chrome");
  await fs.mkdir(systemDir, { recursive: true });
  await fs.writeFile(system, "#!/bin/sh\n");
  assert.equal(await findBrowserExecutable({ env: { PATH: systemDir }, home: join(root, "empty-home") }), system);
  assert.equal(await findBrowserExecutable({ env: { PATH: "" }, home: join(root, "empty-home") }), null);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("style-browser.verify: explicit, Playwright cache, system PATH, and missing-browser discovery passed");
