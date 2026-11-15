import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { runReferenceStyleAgent } from "./reference-style-editor.mjs";

const execFile = promisify(execFileCallback);
const root = await fs.mkdtemp(join(tmpdir(), "wayne-reference-style-agent-"));
const referencePath = join(root, "reference.mp4");
await execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", referencePath]);

try {
  await assert.rejects(
    runReferenceStyleAgent({
      referenceId: "style-agent-no-consent",
      videoPath: referencePath,
      workDir: join(root, "no-consent"),
      mode: "single-video-v1",
      sourceFilename: "reference.mp4",
      styleRoot: join(root, "style-library"),
      claudeRunner: async () => { throw new Error("must not run without consent"); },
    }),
    /authorization|许可/i,
  );

  const run = await runReferenceStyleAgent({
    referenceId: "style-agent-fixture",
    videoPath: referencePath,
    workDir: join(root, "reference"),
    mode: "single-video-v1",
    sourceFilename: "reference.mp4",
    referenceUsageConfirmedAt: new Date().toISOString(),
    styleRoot: join(root, "style-library"),
    claudeRunner: async ({ dir, configPath, styleRoot }) => {
      assert.ok((await fs.stat(join(dir, "reference.mp4"))).isFile());
      assert.ok((await fs.stat(join(dir, ".claude/skills/reference-style/SKILL.md"))).isFile());
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.ok(config.mcpServers.style.args[0].endsWith("style-agent-tools.mjs"));
      assert.equal(config.mcpServers.style.env.WAYNE_STYLE_DIR, styleRoot);
      await fs.writeFile(join(dir, "analysis.json"), JSON.stringify({ analysisId: "analysis-fixture", source: { sha256: "a".repeat(64) }, shots: [], rhythm: {}, captions: {}, overlays: [], audio: {}, capabilities: {}, unsupported: [], confidence: {} }, null, 2));
      await fs.writeFile(join(dir, "style-pack.json"), JSON.stringify({ id: "style-fixture", version: 1, status: "pending_approval" }, null, 2));
      await fs.writeFile(join(dir, "style-proof.mov"), "proof");
      await fs.writeFile(join(dir, "validation.json"), JSON.stringify({ passed: true }));
      return { models: ["claude-opus-5-5"], result: { subtype: "success" } };
    },
  });
  assert.equal(run.analysis.analysisId, "analysis-fixture");
  assert.equal(run.stylePack.status, "pending_approval");
  assert.equal(run.stylePack.id, "style-fixture");
  console.log("reference-style-editor.verify: consent gate, skill/MCP workspace preparation, injected Claude Code runner, and pending pack handoff passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
