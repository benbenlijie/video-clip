import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { trimReferenceClip } from "./wechat-ingest.mjs";


function ffprobeDuration(file) {
  return new Promise((done, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? done(Number(out.trim())) : reject(new Error(`ffprobe exited ${code}`))));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function ffmpeg(args, cwd) {
  return new Promise((done, reject) => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { cwd });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? done() : reject(new Error(stderr))));
  });
}

const storageRoot = await fs.mkdtemp(join(tmpdir(), "wayne-wechat-route-"));
const styleRoot = join(storageRoot, "style-library");
const fixtureDir = join(storageRoot, "fixture");
await fs.mkdir(fixtureDir, { recursive: true });
await ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=30",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "reference.mp4",
], fixtureDir);
const fixture = await fs.readFile(join(fixtureDir, "reference.mp4"));
const fixtureSha = createHash("sha256").update(fixture).digest("hex");

// 本地假解析器：把分享链接换成同机媒体地址，验证路由时完全不联网。
const resolver = createHttpServer((request, response) => {
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
          title: "验证用参考视频 #测试",
          url: `http://127.0.0.1:${resolver.address().port}/media.mp4`,
          video_id: "fixture-ref",
          author: { nickname: "验证作者" },
        },
      }));
    });
    return;
  }
  if (url.pathname === "/media.mp4") {
    const range = request.headers.range || "";
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), fixture.length - 1) : fixture.length - 1;
      response.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${fixture.length}`, "content-length": end - start + 1 });
      response.end(fixture.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, { "content-type": "video/mp4", "content-length": fixture.length });
    response.end(fixture);
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((done) => resolver.listen(0, "127.0.0.1", done));
const resolverUrl = `http://127.0.0.1:${resolver.address().port}/api/parse`;

// 长视频裁剪：风格分析只接受 30–180 秒，链接导入需要自动截取并报告范围。
const longPath = join(fixtureDir, "long.mp4");
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5:duration=200", "-c:v", "libx264", "-pix_fmt", "yuv420p", longPath]);
const noTrim = await trimReferenceClip({ filePath: longPath, durationSeconds: 120 });
assert.equal(noTrim, null, "短片不裁剪");
const source200 = join(fixtureDir, "source-200.mp4");
await fs.copyFile(longPath, source200);
const trim = await trimReferenceClip({ filePath: source200, durationSeconds: 200, startSeconds: 10 });
assert.ok(trim, "长片必须裁剪");
assert.equal(trim.analysisDurationMs, 180000);
assert.equal(trim.startMs, 10000);
assert.equal(trim.originalDurationMs, 200000);
assert.ok(Math.abs((await ffprobeDuration(source200)) - 180) < 1.5, "裁剪后应约为 180 秒");

const port = await freePort();
const child = spawn(process.execPath, [resolve("server/index.mjs")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    WAYNE_STORAGE_DIR: storageRoot,
    WAYNE_STYLE_DIR: styleRoot,
    WAYNE_STYLE_GENERATOR: "fixture",
    WAYNE_STYLE_AGENT: "direct",
    WAYNE_IGNORE_DOTENV: "1",
    REFERENCE_STYLE_ENABLED: "1",
    REFERENCE_STYLE_STAGE: "preview",
    REFERENCE_STYLE_VISUAL_ANALYSIS: "0",
    REFERENCE_STYLE_AUDIO_ANALYSIS: "0",
    WX_VIDEO_RESOLVER: resolverUrl,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;
const jsonRequest = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

try {
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { health = response; break; }
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(health?.status, 200, `API did not start: ${stderr}`);

  const rejected = await jsonRequest("/api/wechat-video/resolve", { link: "https://example.com/video" });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.match(rejected.body.error, /视频号分享链接/);

  const resolved = await jsonRequest("/api/wechat-video/resolve", { link: "https://weixin.qq.com/sph/AbCd1234" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.title, "验证用参考视频 #测试");
  assert.equal(resolved.body.author, "验证作者");
  assert.equal(JSON.stringify(resolved.body).includes("stodownload"), false, "签名直链不能下发给浏览器");

  const ingested = await jsonRequest("/api/wechat-video/ingest", { link: "https://weixin.qq.com/sph/AbCd1234", mode: "single-video-v1" });
  assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
  const source = ingested.body;
  assert.match(source.id, /^[a-f0-9-]{36}$/);
  assert.equal(source.sha256, fixtureSha);
  assert.equal(source.width, 160);
  assert.equal(source.height, 90);
  assert.ok(Math.abs(source.durationSeconds - 30) < 1);
  assert.equal(JSON.stringify(ingested.body).includes(storageRoot), false, "暂存路径不能暴露给前端");
  await fs.access(join(storageRoot, "wechat-sources", source.id, "source.mp4"));

  const media = await fetch(`${base}/api/wechat-video/sources/${source.id}/media`, { headers: { Range: "bytes=0-99" } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get("content-type"), "video/mp4");
  assert.equal((await media.arrayBuffer()).byteLength, 100);

  const unconfirmed = await jsonRequest("/api/reference-styles", { sourceId: source.id, mode: "single-video-v1" });
  assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.body));
  assert.match(unconfirmed.body.error, /确认.*许可/);

  const created = await jsonRequest("/api/reference-styles", { sourceId: source.id, mode: "single-video-v1", referenceUsageConfirmed: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.id, /^[a-f0-9-]{36}$/);
  assert.equal(created.body.analysis.contract, "reference-analysis.v1");
  assert.equal(created.body.analysis.source.filename, "source.mp4");
  assert.ok(created.body.analysis.shots.length >= 1);
  assert.equal(JSON.stringify(created.body).includes(storageRoot), false);

  const stored = await fetch(`${base}/api/reference-styles/${created.body.id}`).then((response) => response.json());
  assert.equal(stored.analysis.contract, "reference-analysis.v1");
  assert.match(stored.referenceUsageConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);

  const referenceMedia = await fetch(`${base}/api/reference-styles/${created.body.id}/media`, { headers: { Range: "bytes=0-99" } });
  assert.equal(referenceMedia.status, 206);

  const pruned = await fetch(`${base}/api/wechat-video/sources/${source.id}/media`);
  assert.equal(pruned.status, 404, "分析成功后应清理暂存视频");

  const missing = await jsonRequest("/api/reference-styles", { sourceId: "00000000-0000-0000-0000-000000000000", mode: "single-video-v1", referenceUsageConfirmed: true });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));

  const badMode = await jsonRequest("/api/reference-styles", { sourceId: source.id, mode: "nope", referenceUsageConfirmed: true });
  assert.equal(badMode.status, 400);

  console.log("wechat-route.verify: ok");
} finally {
  child.kill("SIGTERM");
  await new Promise((done) => resolver.close(done));
  await fs.rm(storageRoot, { recursive: true, force: true });
}
