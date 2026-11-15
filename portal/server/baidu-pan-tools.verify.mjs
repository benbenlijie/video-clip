import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runBaiduPanCli } from "./baidu-pan-tools.mjs";

// 全离线验证：用一个假的 pan.baidu.com 服务把「列举 -> 取直链 -> 分片下载 -> ffprobe」整条链路跑一遍。
// 假服务会强制检查下载 UA 必须是 pan.baidu.com —— 用浏览器 UA 会被 403，这正是真实接口的行为。

const root = await fs.mkdtemp(join(os.tmpdir(), "wayne-baidu-pan-"));
const workspace = join(root, "workspace");
const audit = join(root, "audit", "baidu-pan.jsonl");
const cache = join(root, "cache");
await fs.mkdir(workspace, { recursive: true });

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const fixture = join(root, "fixture.mp4");
await ffmpeg([
  "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture,
]);
const fixtureBytes = await fs.readFile(fixture);
const MOCK_UK = "111";
const SHARE_ID = 987654;

function sendJson(response, payload, code = 200) {
  response.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendRange(request, response, body) {
  const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range || "");
  if (!match) {
    response.writeHead(200, { "content-type": "video/mp4", "content-length": body.length });
    response.end(body);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : body.length - 1;
  const slice = body.subarray(start, end + 1);
  response.writeHead(206, {
    "content-type": "video/mp4",
    "content-length": slice.length,
    "content-range": `bytes ${start}-${end}/${body.length}`,
  });
  response.end(slice);
}

const files = [{ server_filename: "mock-clip.mp4", path: "/我的/集合/mock-clip.mp4", size: String(fixtureBytes.length) }];

const mock = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/rest/2.0/xpan/nas") return sendJson(response, { errno: 0, uk: MOCK_UK, baidu_name: "verify-user", vip_type: 2 });
  if (path === "/api/gettemplatevariable") return sendJson(response, { errno: 0, result: { bdstoken: "mocktoken" } });
  if (path === "/rest/2.0/membership/user") {
    return sendJson(response, { error_code: 0, current_product: { detail_cluster: "svip" }, level_info: { current_level: 4 } });
  }
  if (path === "/api/quota") return sendJson(response, { errno: 0, total: 1000, used: 100, free: 900 });

  if (path.startsWith("/s/")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(`<html><script>var raw={"shareid":${SHARE_ID},"share_uk":"${MOCK_UK}","share_page_type":"multi"};</script></html>`);
  }

  if (path === "/share/list") {
    if (url.searchParams.get("root") === "1") {
      return sendJson(response, { errno: 0, list: [{ server_filename: "集合", path: "/我的/集合", isdir: "1", size: "0", fs_id: "1" }] });
    }
    if (url.searchParams.get("dir") === "/我的/集合") {
      return sendJson(response, {
        errno: 0,
        list: files.map((file, index) => ({ ...file, isdir: "0", fs_id: String(10 + index), category: "6" })),
      });
    }
    return sendJson(response, { errno: 2, list: [] });
  }

  if (path === "/api/list") {
    const dir = url.searchParams.get("dir") || "/";
    if (dir === "/我的" || dir === "/我的/集合") {
      return sendJson(response, {
        errno: 0,
        list: dir === "/我的"
          ? [{ server_filename: "集合", path: "/我的/集合", isdir: "1", size: "0", fs_id: "1" }]
          : files.map((file, index) => ({ ...file, isdir: "0", fs_id: String(10 + index), category: "6" })),
      });
    }
    return sendJson(response, { errno: 0, list: [] });
  }

  if (path === "/api/filemetas") {
    const target = JSON.parse(url.searchParams.get("target") || "[]");
    return sendJson(response, {
      errno: 0,
      info: target.map((entry) => ({
        server_filename: basename(entry),
        size: String(fixtureBytes.length),
        dlink: `http://127.0.0.1:${mock.address().port}/file/${encodeURIComponent(basename(entry))}`,
      })),
    });
  }

  if (path.startsWith("/file/")) {
    // 真实 pcs 就是这么卡 UA 的；用浏览器 UA 会拿到 403 hitcode:119
    if (String(request.headers["user-agent"] || "") !== "pan.baidu.com") {
      response.writeHead(403, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error_code: 31326, error_msg: "user is not authorized, hitcode:119" }));
    }
    return sendRange(request, response, fixtureBytes);
  }

  if (path === "/api/filemanager") return sendJson(response, { errno: 0, info: [] });
  return sendJson(response, { errno: 404 }, 404);
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mock.address().port}`;
const env = {
  ...process.env,
  BAIDU_API_BASE: base,
  BAIDU_BDUSS: "mock-bduss-for-verify",
  BAIDU_STOKEN: "mock-stoken-for-verify",
  BAIDU_DL_CACHE: cache,
};

// ---- CLI 直测 -------------------------------------------------------
const whoami = await runBaiduPanCli(["whoami"], { env });
assert.equal(whoami.code, 0, whoami.stderr);
assert.equal(whoami.json.ok, true);
assert.equal(whoami.json.uk, MOCK_UK);
assert.equal(whoami.json.is_svip, true);

const listed = await runBaiduPanCli(["list", `https://pan.baidu.com/s/mockshare?pwd=abcd`, "--videos"], { env });
assert.equal(listed.code, 0, listed.stderr);
assert.equal(listed.json.isMine, true);
assert.equal(listed.json.videoCount, 1, "目录不能被当成视频");
assert.equal(listed.json.items.filter((item) => item.is_video).length, 1);

const download = await runBaiduPanCli(["download", "https://pan.baidu.com/s/mockshare?pwd=abcd", "--out", workspace, "--videos"], { env });
assert.equal(download.code, 0, download.stderr);
const saved = download.json.downloaded[0];
assert.equal(saved.bytes, fixtureBytes.length);
assert.equal(saved.verified, true);
assert.equal(saved.width, 320);
const savedBytes = await fs.readFile(saved.path);
assert.equal(savedBytes.equals(fixtureBytes), true, "下载内容必须和源文件逐字节一致");

// 再跑一次应当跳过（幂等），而不是重复下载
const again = await runBaiduPanCli(["download", "https://pan.baidu.com/s/mockshare?pwd=abcd", "--out", workspace, "--videos"], { env });
assert.equal(again.json.downloaded[0].skipped, true);

// 浏览器 UA 必须被拒：这条断言防止有人把 UA 改回去
const denied = await fetch(`${base}/file/mock-clip.mp4`, { headers: { "user-agent": "Mozilla/5.0" } });
assert.equal(denied.status, 403);

// ---- MCP 包装 -------------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./baidu-pan-tools.mjs", import.meta.url).pathname, workspace, audit],
  env,
});
const client = new Client({ name: "baidu-pan-verify", version: "1.0.0" });
await client.connect(transport);
try {
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["baidu_pan_download", "baidu_pan_list", "baidu_pan_probe", "baidu_pan_whoami"]);

  const mcpWhoami = JSON.parse((await client.callTool({ name: "baidu_pan_whoami", arguments: {} })).content[0].text);
  assert.equal(mcpWhoami.uk, MOCK_UK);
  assert.equal(mcpWhoami.is_svip, true);

  const mcpList = JSON.parse(
    (await client.callTool({ name: "baidu_pan_list", arguments: { target: "https://pan.baidu.com/s/mockshare?pwd=abcd", videosOnly: true } })).content[0].text,
  );
  assert.equal(mcpList.videoCount, 1);

  const dry = JSON.parse(
    (await client.callTool({ name: "baidu_pan_download", arguments: { target: "https://pan.baidu.com/s/mockshare?pwd=abcd", dryRun: true } })).content[0].text,
  );
  assert.equal(dry.dryRun, true);
  assert.equal(dry.files.length, 1);

  const mcpDownload = JSON.parse(
    (await client.callTool({ name: "baidu_pan_download", arguments: { target: "https://pan.baidu.com/s/mockshare?pwd=abcd", subdir: "videos" } })).content[0].text,
  );
  assert.equal(mcpDownload.downloaded[0].verified, true);
  assert.ok(mcpDownload.downloaded[0].path.startsWith(workspace), "落盘路径必须在工作区内");

  const escape = await client.callTool({ name: "baidu_pan_download", arguments: { target: "/我的/集合", subdir: "../escape" } });
  assert.equal(escape.isError, true, "不允许写出工作区");

  const probe = JSON.parse((await client.callTool({ name: "baidu_pan_probe", arguments: { path: "videos/mock-clip.mp4" } })).content[0].text);
  assert.equal(probe.ok, true);
  assert.equal(probe.width, 320);

  const auditLines = (await fs.readFile(audit, "utf8")).trim().split("\n");
  assert.ok(auditLines.length >= 4);
} finally {
  await client.close();
  mock.close();
}

console.log("baidu-pan-tools.verify: ok");
