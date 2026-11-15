import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runWxVideoCli } from "./wx-video-tools.mjs";

const root = await fs.mkdtemp(join(os.tmpdir(), "wayne-wx-video-"));
const fixture = join(root, "fixture.mp4");
const workspace = join(root, "workspace");
const audit = join(root, "audit", "wx-video.jsonl");
await fs.mkdir(workspace, { recursive: true });

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

await ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture]);
const fixtureBytes = await fs.readFile(fixture);
const fixtureSha = createHash("sha256").update(fixtureBytes).digest("hex");

let mediaHits = 0;
const mediaServer = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/api/parse") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const link = String(parsed.text || parsed.url || "");
      if (!/sph\//.test(link)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 400, succ: false, msg: "链接无效" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: 200,
        succ: true,
        data: {
          title: "验证用 视频/标题  #标签 #测试",
          url: `http://127.0.0.1:${mediaServer.address().port}/media.mp4`,
          video_id: "fixture01",
          author: { nickname: "验证作者" },
        },
      }));
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/parse-bad") {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 500, succ: false, msg: "解析服务繁忙" }));
    });
    return;
  }
  if (url.pathname === "/media.mp4") {
    mediaHits += 1;
    const range = request.headers.range;
    if (range) {
      const [, startText] = range.match(/bytes=(\d+)-/) || [];
      const start = Number(startText || 0);
      response.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${fixtureBytes.length - 1}/${fixtureBytes.length}`, "content-length": fixtureBytes.length - start });
      response.end(fixtureBytes.subarray(start));
      return;
    }
    response.writeHead(200, { "content-type": "video/mp4", "content-length": fixtureBytes.length });
    response.end(fixtureBytes);
    return;
  }
  if (url.pathname === "/not-a-video") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>二维码页面，不是视频</body></html>");
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mediaServer.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./wx-video-tools.mjs", import.meta.url).pathname, workspace, audit],
  env: { ...process.env, WX_VIDEO_RESOLVER: `${base}/api/parse` },
});
const client = new Client({ name: "wx-video-tools-verify", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((item) => item.name).sort(), ["download_video", "list_videos", "probe_video", "resolve_video"]);

  const resolved = await client.callTool({ name: "resolve_video", arguments: { link: "3.21 复制打开微信 https://weixin.qq.com/sph/fixture01" } });
  const resolvedPayload = JSON.parse(resolved.content[0].text);
  assert.equal(resolvedPayload.ok, true);
  assert.match(resolvedPayload.videoUrl, /\/media\.mp4$/);
  assert.equal(resolvedPayload.videoId, "fixture01");
  assert.equal(mediaHits, 0, "resolve must not download media");

  const download1 = JSON.parse((await client.callTool({ name: "download_video", arguments: { link: "https://weixin.qq.com/sph/fixture01", writeMeta: true } })).content[0].text);
  assert.equal(download1.ok, true);
  assert.ok(download1.path.startsWith(`${workspace}/downloads/`), "downloads land inside the workspace");
  assert.equal(download1.bytes, fixtureBytes.length);
  assert.equal(download1.sha256, fixtureSha, "sha256 must match the served fixture");
  assert.equal(download1.verified, true);
  assert.equal(download1.width, 320);
  assert.equal(download1.height, 240);
  assert.ok(Math.abs(download1.durationSeconds - 2) < 0.3, "duration comes from ffprobe");
  assert.ok(!/[/\\:*?"<>|]/.test(download1.path.split("/").pop()), "file name is sanitized");
  assert.ok(!/#标签/.test(download1.path), "trailing hashtags are stripped from the file name");
  assert.ok(download1.metaPath && download1.metaPath.endsWith(".json"));
  const meta = JSON.parse(await fs.readFile(download1.metaPath, "utf8"));
  assert.equal(meta.sha256, fixtureSha);

  const download2 = JSON.parse((await client.callTool({ name: "download_video", arguments: { link: "https://weixin.qq.com/sph/fixture01" } })).content[0].text);
  assert.notEqual(download2.path, download1.path, "a second download must not overwrite the first");
  assert.match(download2.path, /\(2\)\.mp4$/);

  const listed = JSON.parse((await client.callTool({ name: "list_videos", arguments: {} })).content[0].text);
  assert.equal(listed.files.length, 2);
  assert.ok(listed.files[0].modifiedAt >= listed.files[1].modifiedAt);

  await fs.writeFile(join(workspace, "notes.txt"), "not a video");
  const probeBad = await client.callTool({ name: "probe_video", arguments: { path: "notes.txt" } });
  assert.equal(probeBad.isError, true, "probing a text file must fail");
  assert.match(probeBad.content[0].text, /没有视频流|no-video-stream|不是可识别的视频容器/);

  const escape = await client.callTool({ name: "download_video", arguments: { link: "https://weixin.qq.com/sph/fixture01", subdir: "../escape" } });
  assert.equal(escape.isError, true, "subdir escapes are rejected");
  assert.match(escape.content[0].text, /Edit workspace|工作区|Path must remain/);

  const badResolve = await runWxVideoCli(["resolve", "https://weixin.qq.com/sph/fixture01", "--resolver", `${base}/api/parse-bad`]);
  assert.equal(badResolve.json?.ok, false, "a resolver error must surface as ok:false");
  assert.match(badResolve.json?.error || "", /解析服务繁忙/);

  const badLink = await runWxVideoCli(["resolve", "这不是链接"]);
  assert.equal(badLink.json?.ok, false);
  assert.equal(badLink.code, 5, "invalid input exits 5");

  const auditLines = (await fs.readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(auditLines.some((entry) => entry.tool === "download_video" && entry.ok === true));
  assert.ok(auditLines.some((entry) => entry.tool === "download_video" && entry.ok === false), "failures are audited too");
  console.log("wx-video-tools.verify: ok");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => mediaServer.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
