import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sandboxCommand, workspacePath } from "./video-agent-tools.mjs";

const root = await fs.mkdtemp(join(os.tmpdir(), "wayne-video-agent-"));
const audit = join(root, "audit.jsonl");
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("./video-agent-tools.mjs", import.meta.url).pathname, root, audit], env: { ...process.env, WAYNE_DEEPSEEK_DELEGATION: "off" } });
const client = new Client({ name: "video-agent-tools-verify", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((item) => item.name).sort(), ["analyze_fluency", "compose_remotion_video", "download_broll", "download_broll_candidate", "execute", "inspect_broll_candidate", "read_file", "render_remotion_preview", "search_broll", "search_broll_sources", "verify_fluency", "view_broll_candidate", "view_frame", "write_file"]);
  assert.deepEqual(tools.tools.find((item) => item.name === "render_remotion_preview")?.inputSchema.properties, {}, "Remotion must use the current workspace plan and fixed paths");
  await assert.rejects(workspacePath(root, "../escape"), /inside the edit workspace/);
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify({
    text: "你好呃世界",
    segments: [{ id: "fluency", startMs: 0, endMs: 2000, text: "你好呃世界", words: [
      { startMs: 0, endMs: 400, text: "你好" },
      { startMs: 900, endMs: 1100, text: "呃" },
      { startMs: 1300, endMs: 1900, text: "世界" },
    ] }],
  }));
  const fluencyWithoutTimeline = await client.callTool({ name: "analyze_fluency", arguments: { transcript: "transcript.json" } });
  assert.equal(fluencyWithoutTimeline.isError, undefined, JSON.stringify(fluencyWithoutTimeline));
  assert.deepEqual(JSON.parse(fluencyWithoutTimeline.content[0].text).sourceRanges, [{ startMs: 0, endMs: 2000 }], "a new project must be analyzable before timeline.json exists");
  await fs.writeFile(join(root, "timeline.json"), JSON.stringify({ pieces: [{ src: [0, 2000], out: [0, 2000] }] }));
  const fluency = await client.callTool({ name: "analyze_fluency", arguments: { transcript: "transcript.json", timeline: "timeline.json" } });
  assert.equal(fluency.isError, undefined, JSON.stringify(fluency));
  assert.match(fluency.content[0].text, /hard-filler/);
  const fluencyVerify = await client.callTool({ name: "verify_fluency", arguments: { transcript: "transcript.json", timeline: "timeline.json" } });
  assert.match(fluencyVerify.content[0].text, /"passed":false/);
  const protectedTranscript = { segments: [{ id: "corrected-line", startMs: 250, endMs: 750, text: "校对后的句子", wordTimingStatus: "protected" }] };
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify(protectedTranscript));
  const partialPlan = { segments: [
    { id: "keep-before", startMs: 0, endMs: 300, action: "keep", title: "Before", note: "" },
    { id: "trim-middle", startMs: 300, endMs: 700, action: "remove", title: "Trim", note: "" },
    { id: "keep-after", startMs: 700, endMs: 1000, action: "keep", title: "After", note: "" },
  ] };
  const writePlan = await client.callTool({ name: "write_file", arguments: { path: "edit-plan.json", content: JSON.stringify(partialPlan) } });
  assert.match(writePlan.content[0].text, /corrected-line/);
  assert.deepEqual(JSON.parse(await fs.readFile(join(root, "edit-plan.json"), "utf8")).segments.map(({ startMs, endMs, action }) => ({ startMs, endMs, action })), [
    { startMs: 0, endMs: 250, action: "keep" },
    { startMs: 250, endMs: 750, action: "keep" },
    { startMs: 750, endMs: 1000, action: "keep" },
  ], "edit-plan writes automatically keep a corrected utterance whole before rendering");
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify({ segments: [{ id: "execute-line", startMs: 200, endMs: 800, text: "另一句修订字幕", wordTimingStatus: "protected" }] }));
  const executePlan = { segments: [{ id: "cut", startMs: 300, endMs: 700, action: "keep", title: "Partial", note: "" }] };
  const executeResult = await client.callTool({ name: "execute", arguments: { command: `cat > /work/edit-plan.json <<'PLAN'\n${JSON.stringify(executePlan)}\nPLAN\n# ffmpeg rendering follows in a later command` } });
  assert.match(executeResult.content[0].text, /重新渲染/);
  assert.deepEqual(JSON.parse(await fs.readFile(join(root, "edit-plan.json"), "utf8")).segments.map(({ startMs, endMs, action }) => ({ startMs, endMs, action })), [{ startMs: 200, endMs: 800, action: "keep" }], "edit-plan changes made by execute are normalized before the next render tool call");
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify({ segments: [{ id: "wrapped-line", startMs: 100, endMs: 300, text: "脚本修改计划并经由FFmpeg输出", wordTimingStatus: "protected" }] }));
  await fs.writeFile(join(root, "edit-plan.json"), JSON.stringify({ segments: [{ id: "partial", startMs: 150, endMs: 250, action: "keep" }] }));
  const renderScript = `import { writeFileSync } from "node:fs"; import { spawnSync } from "node:child_process"; writeFileSync("edit-plan.json", ${JSON.stringify(JSON.stringify({ segments: [{ id: "script-partial", startMs: 150, endMs: 250, action: "keep" }] }))}); const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=2", "-t", "0.5", "-pix_fmt", "yuv420p", "-y", "wrapped.mp4"], { encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr);`;
  await fs.writeFile(join(root, "render-edit.mjs"), renderScript);
  const wrappedRender = await client.callTool({ name: "execute", arguments: { command: "node render-edit.mjs" } });
  assert.match(wrappedRender.content[0].text, /先重新读取 edit-plan\.json 并重新生成 timeline\.json\/媒体输出/, "commands must stop before rendering when plan protection changes the current plan");
  await assert.rejects(fs.stat(join(root, "wrapped.mp4")), "a render command must not create stale output after plan protection");
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify({ segments: [{ id: "remotion-line", startMs: 100, endMs: 900, text: "Remotion protected caption", wordTimingStatus: "protected" }] }));
  await fs.writeFile(join(root, "edit-plan.json"), JSON.stringify({ segments: [{ id: "partial", startMs: 400, endMs: 500, action: "keep" }] }));
  const compose = await client.callTool({ name: "compose_remotion_video", arguments: { baseVideo: "stale-base.mp4", phase: "plan" } });
  assert.equal(compose.isError, undefined, "Remotion must report a corrected plan before trying to compose from a stale base");
  assert.match(compose.content[0].text, /remotion-line/);
  assert.match(compose.content[0].text, /Regenerate the base video and timeline\.json/);
  await client.callTool({ name: "write_file", arguments: { path: "sample.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nTest\n" } });
  const render = await client.callTool({ name: "execute", arguments: { command: "ffmpeg -v error -f lavfi -i testsrc=size=320x480:rate=2 -t 2 -pix_fmt yuv420p -y input.mp4 && test -z \"$ANTHROPIC_API_KEY\" && test -z \"$CLAUDE_CODE_OAUTH_TOKEN\" && test \"$PWD\" = \"$(pwd)\" && ffprobe -v error -show_entries format=duration -of csv=p=0 input.mp4" } });
  assert.equal(render.isError, false, JSON.stringify(render));
  const devNull = await client.callTool({ name: "execute", arguments: { command: "test -c /dev/null && test -d /dev/shm && printf sandbox-dev-ok" } });
  assert.equal(devNull.isError, false, JSON.stringify(devNull));
  const frame = await client.callTool({ name: "view_frame", arguments: { video: "input.mp4", timeSeconds: 0.5 } });
  assert.ok(frame.content.some((item) => item.type === "image" && item.data.length > 100));
  assert.match(await fs.readFile(audit, "utf8"), /"tool":"view_frame"/);
  assert.match(await fs.readFile(audit, "utf8"), /"tool":"protect_transcript_corrections"/);
  console.log("video-agent-tools.verify: restricted MCP, workspace path checks, scrubbed environment, FFmpeg and real visual-frame return passed");
} finally {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
