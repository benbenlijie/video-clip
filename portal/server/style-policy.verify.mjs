import assert from "node:assert/strict";
import { scanStyleSource } from "./style-policy.mjs";

const allowed = `
import React from "react";
import { AbsoluteFill } from "remotion";
import { Html5Audio } from "@remotion/media";
import { createTikTokStyleCaptions } from "@remotion/captions";
import { CaptionLayer } from "./CaptionLayer";
export const component = <AbsoluteFill />;
`;
assert.deepEqual(scanStyleSource(allowed, "src/StyleOverlay.tsx").errors, []);

const cases = [
  ["fetch", 'fetch("https://example.com");'],
  ["child_process", 'import { spawn } from "child_process";'],
  ["process env", "const key = process.env.API_KEY;"],
  ["file write", "await fs.writeFile('/tmp/x', 'x');"],
  ["eval", "eval('1 + 1');"],
  ["dynamic import", "await import('./outside.js');"],
  ["absolute path", "const path = '/home/ben/private/video.mp4';"],
  ["http url", "const url = 'http://127.0.0.1:8080/data';"],
  ["network module", 'import axios from "axios";'],
  ["renderer import", 'import { renderMedia } from "@remotion/renderer";'],
  ["embedded media", 'const image = "data:image/png;base64,AAAA";'],
  ["protocol relative url", 'const style = { backgroundImage: "url(//evil.example/a.png)" };'],
];
for (const [name, source] of cases) {
  const result = scanStyleSource(source, `src/${name}.tsx`);
  assert.ok(result.errors.length, `expected ${name} to be rejected`);
  assert.equal(result.ok, false);
}

const project = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const root = await project.mkdtemp(path.join(os.tmpdir(), "wayne-style-policy-"));
try {
  await project.mkdir(path.join(root, "src"), { recursive: true });
  await project.writeFile(path.join(root, "src", "index.tsx"), allowed);
  await project.writeFile(path.join(root, "package.json"), JSON.stringify({
    dependencies: { react: "19.3.1", remotion: "4.0.539", "@remotion/captions": "4.0.539", "@remotion/media": "4.0.539" },
  }));
  const policy = await import("./style-policy.mjs");
  assert.equal((await policy.scanStyleProject(root)).ok, true);
  await project.writeFile(path.join(root, "reference.mp4"), Buffer.from("reference media"));
  const withMedia = await policy.scanStyleProject(root);
  assert.equal(withMedia.ok, false);
  assert.ok(withMedia.errors.some((item) => item.code === "media_asset" && item.file === "reference.mp4"));
  await project.rm(path.join(root, "reference.mp4"));
  await project.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19.3.1", axios: "1.0.0" } }));
  assert.equal((await policy.scanStyleProject(root)).ok, false);
} finally {
  await project.rm(root, { recursive: true, force: true });
}

console.log("style-policy.verify: source, package, network, filesystem, and dependency policy passed");
