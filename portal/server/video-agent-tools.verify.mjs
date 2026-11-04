import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sandboxCommand, workspacePath } from "./video-agent-tools.mjs";

const root = await fs.mkdtemp(join(os.tmpdir(), "wayne-video-agent-"));
const audit = join(root, "audit.jsonl");
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("./video-agent-tools.mjs", import.meta.url).pathname, root, audit] });
const client = new Client({ name: "video-agent-tools-verify", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((item) => item.name).sort(), ["compose_remotion_video", "download_broll", "execute", "read_file", "render_remotion_preview", "search_broll", "view_broll_candidate", "view_frame", "write_file"]);
  assert.deepEqual(tools.tools.find((item) => item.name === "render_remotion_preview")?.inputSchema.properties, {}, "Remotion must use the current workspace plan and fixed paths");
  await assert.rejects(workspacePath(root, "../escape"), /inside the edit workspace/);
  await client.callTool({ name: "write_file", arguments: { path: "sample.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nTest\n" } });
  const render = await client.callTool({ name: "execute", arguments: { command: "ffmpeg -v error -f lavfi -i testsrc=size=320x480:rate=2 -t 2 -pix_fmt yuv420p -y input.mp4 && test -z \"$ANTHROPIC_API_KEY\" && test -z \"$CLAUDE_CODE_OAUTH_TOKEN\" && test \"$PWD\" = \"$(pwd)\" && ffprobe -v error -show_entries format=duration -of csv=p=0 input.mp4" } });
  assert.equal(render.isError, false, JSON.stringify(render));
  const devNull = await client.callTool({ name: "execute", arguments: { command: "test -c /dev/null && test -d /dev/shm && printf sandbox-dev-ok" } });
  assert.equal(devNull.isError, false, JSON.stringify(devNull));
  const frame = await client.callTool({ name: "view_frame", arguments: { video: "input.mp4", timeSeconds: 0.5 } });
  assert.ok(frame.content.some((item) => item.type === "image" && item.data.length > 100));
  assert.match(await fs.readFile(audit, "utf8"), /"tool":"view_frame"/);
  console.log("video-agent-tools.verify: restricted MCP, workspace path checks, scrubbed environment, FFmpeg and real visual-frame return passed");
} finally {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
