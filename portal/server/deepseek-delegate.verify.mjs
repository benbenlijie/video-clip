import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildDelegationPrompt, deepSeekDelegationMode, runDeepSeekDelegate } from "./deepseek-delegate.mjs";

const root = await fs.mkdtemp(join(os.tmpdir(), "wayne-deepseek-delegate-"));
const fakeDir = await fs.mkdtemp(join(os.tmpdir(), "wayne-deepseek-fixture-"));
const fakeDsh = join(fakeDir, "fake-dsh.mjs");
const fixture = `#!/usr/bin/env node
import { promises as fs } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "session", sessionId: "session-fixture", cwd: process.cwd() });
  emit({ type: "tool_call", callId: "1", tool: "bash", input: { command: "fixture" } });
  if (prompt.includes("FIXTURE_FAIL")) {
    await fs.writeFile("delegate-result.json", JSON.stringify({ contract: "delegate-result.v1", status: "failed", summary: "fixture failure", changedFiles: [], checks: {} }));
    emit({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
    emit({ type: "status", phase: "turn_end", reason: "error" });
    emit({ type: "final", text: "fixture failed" });
    process.exit(1);
  }
  await fs.writeFile("edit.py", "print('ok')\\n");
  await fs.writeFile("timeline.json", JSON.stringify({ fps: 30, pieces: [{ src: [0, 1000], out: [0, 1000] }] }));
  await fs.writeFile("delegate-result.json", JSON.stringify({ contract: "delegate-result.v1", status: "completed", summary: "fixture completed", changedFiles: ["edit.py", "timeline.json"], checks: { fixture: true } }));
  emit({ type: "tool_result", callId: "1", status: "completed", result: "ok" });
  emit({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
  emit({ type: "status", phase: "turn_end", reason: "completed" });
  emit({ type: "final", text: "fixture completed" });
  if (prompt.includes("FIXTURE_NONZERO_COMPLETE")) process.exit(1);
});
`;

try {
  await fs.writeFile(fakeDsh, fixture, { mode: 0o755 });
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify({ text: "test", segments: [] }));
  assert.equal(deepSeekDelegationMode("AUTO"), "auto");
  assert.equal(deepSeekDelegationMode("invalid"), "off");
  const prompt = buildDelegationPrompt({
    role: "media",
    objective: "Cut the base video",
    inputs: ["transcript.json"],
    outputs: ["edit.py", "timeline.json"],
    constraints: ["Keep word timing exact"],
  });
  assert.match(prompt, /Role: media/);
  assert.match(prompt, /delegate-result\.json/);
  assert.match(prompt, /Never modify input\.mp4/);

  const success = await runDeepSeekDelegate({
    root,
    auditPath: join(fakeDir, "audit.jsonl"),
    request: {
      role: "media",
      objective: "Create the base edit",
      inputs: ["transcript.json"],
      outputs: ["edit.py", "timeline.json"],
      constraints: ["Do not modify transcript.json"],
    },
    env: { ...process.env, PATH: process.env.PATH },
    dshBin: fakeDsh,
  });
  assert.equal(success.status, "completed", JSON.stringify(success));
  assert.equal(success.sessionId, "session-fixture");
  assert.equal(success.outputs.length, 2);
  assert.match(success.outputs[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(success.toolCalls, ["bash"]);
  assert.equal(success.checks.fixture, true);
  assert.equal(success.usage.totalTokens, 10);
  await fs.stat(join(fakeDir, success.logFile));

  const failed = await runDeepSeekDelegate({
    root,
    auditPath: join(fakeDir, "audit.jsonl"),
    request: {
      role: "media",
      objective: "FIXTURE_FAIL",
      inputs: ["transcript.json"],
      outputs: ["edit.py"],
      constraints: [],
    },
    env: { ...process.env, PATH: process.env.PATH },
    dshBin: fakeDsh,
  });
  assert.equal(failed.status, "failed");

  const nonzeroButComplete = await runDeepSeekDelegate({
    root,
    auditPath: join(fakeDir, "audit.jsonl"),
    request: {
      role: "script",
      objective: "FIXTURE_NONZERO_COMPLETE",
      inputs: ["transcript.json"],
      outputs: ["edit.py", "timeline.json"],
      constraints: [],
    },
    env: { ...process.env, PATH: process.env.PATH },
    dshBin: fakeDsh,
  });
  assert.equal(nonzeroButComplete.status, "completed", JSON.stringify(nonzeroButComplete));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./video-agent-tools.mjs", import.meta.url).pathname, root, join(fakeDir, "mcp-audit.jsonl")],
    env: {
      ...process.env,
      WAYNE_DEEPSEEK_DELEGATION: "force",
      WAYNE_DSH_BIN: fakeDsh,
      WAYNE_DSH_PROFILE: "headless",
    },
  });
  const client = new Client({ name: "deepseek-delegate-verify", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "delegate_task"));
    const blockedWrite = await client.callTool({ name: "write_file", arguments: { path: "notes.md", content: "blocked" } });
    assert.equal(blockedWrite.isError, true);
    const allowedWrite = await client.callTool({ name: "write_file", arguments: { path: "edit-plan.json", content: JSON.stringify({ segments: [] }) } });
    assert.equal(allowedWrite.isError, undefined, JSON.stringify(allowedWrite));
    const blockedExecute = await client.callTool({ name: "execute", arguments: { command: "echo should-be-delegated" } });
    assert.equal(blockedExecute.isError, true);
    const delegated = await client.callTool({
      name: "delegate_task",
      arguments: {
        role: "script",
        objective: "Create fixture outputs",
        inputs: ["transcript.json"],
        outputs: ["edit.py", "timeline.json"],
        constraints: [],
      },
    });
    assert.equal(delegated.isError, undefined, JSON.stringify(delegated));
    assert.equal(JSON.parse(delegated.content[0].text).status, "completed");
  } finally {
    await client.close();
  }
  console.log("deepseek-delegate.verify: prompt, event parsing, output hashes, failure handling and force-mode routing passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(fakeDir, { recursive: true, force: true });
}
