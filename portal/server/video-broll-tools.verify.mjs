import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-broll-tools-"));
const asset = path.join(root, "sample.mp4");
await new Promise((resolveRun, reject) => { const child = spawn("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x480:r=10:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", asset]); child.on("error", reject); child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`ffmpeg ${code}`))); });
const bytes = await fs.readFile(asset); const audit = path.join(root, "audit.jsonl"); const cache = path.join(root, "cache.json");
process.env.PEXELS_API_KEY = "test-pexels"; process.env.PIXABAY_API_KEY = "test-pixabay";
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("server/video-broll-tools.mjs"), root, audit, cache] });
const client = new Client({ name: "video-broll-tools-verify", version: "1.0.0" });
const fakeFetch = async (input) => {
  const url = new URL(input);
  if (url.hostname === "api.pexels.com" || url.hostname === "pixabay.com") return new Response(JSON.stringify(url.hostname === "api.pexels.com" ? { videos: [{ id: 1, url: "https://www.pexels.com/video/1/", image: "https://images.pexels.com/preview.jpg", duration: 1, user: { name: "Creator" }, video_files: [{ link: "https://videos.pexels.com/sample.mp4", file_type: "video/mp4", width: 320, height: 480 }] }] } : { hits: [] }), { status: 200 });
  if (url.hostname === "videos.pexels.com" && url.pathname === "/redirect.mp4") return new Response(null, { status: 302, headers: { location: "https://example.com/not-allowed.mp4" } });
  if (url.hostname === "videos.pexels.com") return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length), "content-type": "video/mp4" } });
  if (url.hostname === "images.pexels.com") return new Response(new Uint8Array([255, 216, 255, 217]), { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("no", { status: 404 });
};
// The CLI uses real fetch, so exercise the pure MCP registration through a temporary inline harness below.
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { downloadBrollCandidate, registerBrollTools } = await import("./video-broll-tools.mjs");
const server = new McpServer({ name: "verify", version: "1" }); registerBrollTools(server, { workspaceDir: root, auditPath: audit, cachePath: cache, fetchImpl: fakeFetch });
const registered = server._registeredTools;
assert.ok(registered.search_broll && registered.view_broll_candidate && registered.download_broll, "MCP tools should be registered");
const search = await registered.search_broll.handler({ scenes: [{ id: "portrait", visualIntent: "person in portrait frame", queries: ["person portrait"] }], orientation: "portrait" });
const parsed = JSON.parse(search.content[0].text); const handle = parsed.scenes[0].candidates[0].candidateHandle; assert.ok(handle);
const candidateFrame = await registered.view_broll_candidate.handler({ candidateHandle: handle }); assert.ok(candidateFrame.content.some((item) => item.type === "image"), "Claude must be able to see candidate thumbnails");
const downloaded = await registered.download_broll.handler({ candidateHandle: handle });
const metadata = JSON.parse(downloaded.content[0].text); assert.equal(metadata.bytes, bytes.length); assert.equal(metadata.width, 320); assert.equal(metadata.height, 480); assert.ok(metadata.sha256); assert.equal(await fs.stat(path.join(root, metadata.path)).then((s) => s.size), bytes.length);
await assert.rejects(() => registered.download_broll.handler({ candidateHandle: handle }), /无效/);
const directDir = path.join(root, "direct");
await fs.mkdir(directDir);
const direct = await downloadBrollCandidate({
  candidate: {
    provider: "pexels", providerId: "direct-1", title: "Direct candidate",
    downloadUrl: "https://videos.pexels.com/direct.mp4",
    sourceUrl: "https://www.pexels.com/video/direct-1/",
    licenseName: "Pexels License", licenseUrl: "https://www.pexels.com/license/",
  },
  workspaceDir: directDir,
  fetchImpl: fakeFetch,
});
assert.equal(direct.providerId, "direct-1");
assert.equal(direct.bytes, bytes.length);
assert.equal(await fs.stat(path.join(directDir, direct.path)).then((item) => item.size), bytes.length);
await assert.rejects(() => downloadBrollCandidate({
  candidate: { provider: "pexels", providerId: "bad", title: "Bad", downloadUrl: "https://example.com/bad.mp4", sourceUrl: "https://www.pexels.com/video/bad/", licenseName: "Pexels License", licenseUrl: "https://www.pexels.com/license/" },
  workspaceDir: directDir,
  fetchImpl: fakeFetch,
}), /官方 CDN/);
await assert.rejects(() => downloadBrollCandidate({
  candidate: { provider: "pexels", providerId: "redirect", title: "Redirect", downloadUrl: "https://videos.pexels.com/redirect.mp4", sourceUrl: "https://www.pexels.com/video/redirect/", licenseName: "Pexels License", licenseUrl: "https://www.pexels.com/license/" },
  workspaceDir: directDir,
  fetchImpl: fakeFetch,
}), /官方 CDN/, "a redirect must not escape the official CDN allowlist");
const auditText = await fs.readFile(audit, "utf8"); assert.match(auditText, /"tool":"search_broll"/); assert.match(auditText, /"tool":"download_broll"/); assert.match(auditText, /Pexels License/);
await client.close().catch(() => undefined); await fs.rm(root, { recursive: true, force: true });
console.log("video-broll-tools.verify: bounded MCP search, candidate binding, download validation, provenance audit and asset probe passed");
