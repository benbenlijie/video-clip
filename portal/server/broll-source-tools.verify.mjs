import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeYsjfMaterial, parseCoverrResponse, parseMixkitHtml, searchBrollSources } from "./broll-sources.mjs";
import { registerBrollSourceTools } from "./broll-source-tools.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-broll-sources-"));
const fixture = path.join(root, "sample.mp4");
const generated = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=10:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
const videoBytes = await fs.readFile(fixture);
const imageBytes = new Uint8Array([255, 216, 255, 217]);

const mixkitHtml = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "VideoObject",
      "@id": "https://mixkit.co/free-stock-video/ocean-free-1001/#video",
      name: "Ocean free",
      copyrightNotice: "Mixkit Free License",
      license: "https://mixkit.co/license/#videoFree",
      contentUrl: "https://assets.mixkit.co/videos/1001/1001-720.mp4",
      thumbnailUrl: "https://assets.mixkit.co/videos/1001/1001-thumb-720-0.jpg",
      duration: "PT0M5S",
      about: [{ "@id": "#stock_video_ocean" }],
    },
    {
      "@type": "VideoObject",
      "@id": "https://mixkit.co/free-stock-video/ocean-restricted-1002/#video",
      name: "Ocean restricted",
      copyrightNotice: "Mixkit Restricted License",
      license: "https://mixkit.co/license/#videoFree",
      contentUrl: "https://assets.mixkit.co/videos/1002/1002-720.mp4",
      thumbnailUrl: "https://assets.mixkit.co/videos/1002/1002-thumb-720-0.jpg",
      about: [{ "@id": "#stock_video_ocean" }],
    },
  ],
})}</script>`;

const coverrPayload = {
  hits: [{
    id: "coverr-1",
    title: "Ocean coverr",
    description: "A calm ocean shot.",
    searchKeywords: ["ocean", "water"],
    thumbnail: "https://cdn.coverr.co/videos/coverr-ocean/thumbnail?width=640",
    poster: "https://cdn.coverr.co/videos/coverr-ocean/poster.jpg",
    duration: "8.0",
    maxWidth: 3840,
    maxHeight: 2160,
    fps: 30,
    isPremium: false,
    state: "published",
    slug: "ocean-coverr",
    urls: {
      mp4: "https://cdn.coverr.co/videos/coverr-ocean/1080p.mp4",
      mp4Download: "https://cdn.coverr.co/videos/coverr-ocean/1080p.mp4?download=true",
    },
    defaultVariant: { renditions: [{ type: "fhd", width: 1920, height: 1080, url: "https://cdn.coverr.co/videos/coverr-ocean/1080p.mp4" }] },
  }],
};

const ysjfList = {
  data: {
    entities: [{
      id: "m_city_1",
      name: "城市夜景",
      tags: [{ name: "城市", type: "content" }, { name: "S-Log3", type: "log" }],
    }],
  },
};
const ysjfDetail = {
  data: {
    id: "m_city_1",
    name: "城市夜景",
    cover: "https://public.ysjf.com/mediastorm/material/city.jpg",
    previews: [{ url: "https://public.ysjf.com/mediastorm/material_preview/city.mp4", type: "video" }],
    tags: [
      { name: "城市", type: "content" },
      { name: "Sony", type: "camera" },
      { name: "S-Log3", type: "log" },
    ],
    specifications: [
      { id: "s-learning", skuId: "sku-learning", license: "personal_learning", name: "4K", price: 0, tags: [{ name: "灰片" }, { name: ".MOV" }, { name: "500MB" }] },
      { id: "s-enterprise", skuId: "sku-enterprise", license: "enterprise_commercial", name: "4K", price: 0, tags: [{ name: "灰片" }, { name: ".MOV" }, { name: "500MB" }] },
    ],
  },
};

let sawPortraitFilter = false;
const fakeFetch = async (input) => {
  const url = new URL(input);
  if (url.hostname === "mixkit.co") return new Response(mixkitHtml, { status: 200, headers: { "content-type": "text/html" } });
  if (url.hostname === "coverr.co" && url.pathname === "/papi/videos") {
    if (url.searchParams.get("filter") === "isVertical:true") sawPortraitFilter = true;
    return new Response(JSON.stringify(coverrPayload), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "api.ysjf.com" && url.pathname.endsWith("/items")) return new Response(JSON.stringify(ysjfList), { status: 200, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.ysjf.com" && url.pathname.includes("/materials/")) return new Response(JSON.stringify(ysjfDetail), { status: 200, headers: { "content-type": "application/json" } });
  if ((url.hostname === "assets.mixkit.co" || url.hostname === "cdn.coverr.co") && /thumb|thumbnail/i.test(url.pathname)) return new Response(imageBytes, { status: 200, headers: { "content-length": String(imageBytes.length), "content-type": "image/jpeg" } });
  if (url.hostname === "assets.mixkit.co" || url.hostname === "cdn.coverr.co") return new Response(videoBytes, { status: 200, headers: { "content-length": String(videoBytes.length), "content-type": "video/mp4" } });
  if (url.hostname === "public.ysjf.com") return new Response(imageBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("not found", { status: 404 });
};

const mixkit = parseMixkitHtml(mixkitHtml);
assert.equal(mixkit.length, 2);
assert.equal(mixkit[0].commercialUse, true);
assert.equal(mixkit[1].commercialUse, false);
assert.match(mixkit[1].licenseName, /Restricted/);
assert.equal(mixkit[0].durationSeconds, 5);

const coverr = parseCoverrResponse(coverrPayload);
assert.equal(coverr.length, 1);
assert.equal(coverr[0].commercialUse, true);
assert.equal(coverr[0].width, 1920);
assert.equal(coverr[0].height, 1080);

const ysjf = normalizeYsjfMaterial(ysjfDetail.data, ysjfList.data.entities[0]);
assert.equal(ysjf.licenseName, "企业商用");
assert.equal(ysjf.requiresOrder, true);
assert.equal(ysjf.logProfile, "S-Log3");

const search = await searchBrollSources({ query: "ocean", limit: 2, fetchImpl: fakeFetch });
assert.equal(search.providerStatus.mixkit.status, "ok");
assert.equal(search.providerStatus.coverr.status, "ok");
assert.equal(search.providerStatus.ysjf.status, "ok");
assert.ok(search.candidates.some((candidate) => candidate.provider === "mixkit"));
assert.ok(search.candidates.some((candidate) => candidate.provider === "coverr"));
assert.ok(search.candidates.some((candidate) => candidate.provider === "ysjf"));
const commercialOnly = await searchBrollSources({ query: "ocean", limit: 2, commercialOnly: true, fetchImpl: fakeFetch });
assert.equal(commercialOnly.candidates.some((candidate) => candidate.provider === "mixkit" && candidate.providerId === "1002"), false);
await searchBrollSources({ query: "ocean", providers: ["coverr"], orientation: "portrait", limit: 2, fetchImpl: fakeFetch });
assert.equal(sawPortraitFilter, true, "portrait Coverr search must request isVertical:true");

const audit = path.join(root, "audit.jsonl");
const server = new McpServer({ name: "broll-source-verify", version: "1.0.0" });
registerBrollSourceTools(server, {
  workspaceDir: root,
  auditPath: audit,
  fetchImpl: fakeFetch,
  panDownloadImpl: async ({ target }) => {
    assert.match(target, /pwd=secret/);
    return { downloaded: [{ name: "ysjf-city.mp4", path: fixture, bytes: videoBytes.length }] };
  },
});
const tools = server._registeredTools;
assert.ok(tools.search_broll_sources && tools.inspect_broll_candidate && tools.download_broll_candidate);

const found = await tools.search_broll_sources.handler({ query: "ocean", providers: ["mixkit", "coverr", "ysjf"], orientation: "landscape", limit: 2, commercialOnly: false });
const candidates = JSON.parse(found.content[0].text).candidates;
const mixkitFree = candidates.find((item) => item.provider === "mixkit" && item.providerId === "1001");
const mixkitRestricted = candidates.find((item) => item.provider === "mixkit" && item.providerId === "1002");
const coverrCandidate = candidates.find((item) => item.provider === "coverr");
const ysjfCandidate = candidates.find((item) => item.provider === "ysjf");
assert.ok(mixkitFree && mixkitRestricted && coverrCandidate && ysjfCandidate);

const preview = await tools.inspect_broll_candidate.handler({ candidateHandle: coverrCandidate.candidateHandle });
assert.ok(preview.content.some((item) => item.type === "image"), "candidate thumbnail must be returned as image content");

const downloaded = JSON.parse((await tools.download_broll_candidate.handler({ candidateHandle: coverrCandidate.candidateHandle, licenseAcknowledged: true })).content[0].text);
assert.equal(downloaded.provider, "coverr");
assert.equal(downloaded.width, 320);
assert.equal(downloaded.height, 180);
assert.ok(downloaded.sha256);
assert.ok((await fs.stat(path.join(root, downloaded.path))).size > 0);

await assert.rejects(() => tools.download_broll_candidate.handler({ candidateHandle: mixkitRestricted.candidateHandle, licenseAcknowledged: true }), /不是可商用/);
await assert.rejects(() => tools.download_broll_candidate.handler({ candidateHandle: ysjfCandidate.candidateHandle, licenseAcknowledged: true }), /shareUrl/);
await assert.rejects(() => tools.download_broll_candidate.handler({ candidateHandle: ysjfCandidate.candidateHandle, licenseAcknowledged: true, shareUrl: "https://pan.baidu.com/s/share?pwd=secret" }), /match 或 index/);
const ysjfDownloaded = JSON.parse((await tools.download_broll_candidate.handler({
  candidateHandle: ysjfCandidate.candidateHandle,
  licenseAcknowledged: true,
  shareUrl: "https://pan.baidu.com/s/share?pwd=secret",
  match: "city",
})).content[0].text);
assert.equal(ysjfDownloaded.provider, "ysjf");
assert.equal(ysjfDownloaded.licenseName, "企业商用");
assert.equal(ysjfDownloaded.logProfile, "S-Log3");

const auditText = await fs.readFile(audit, "utf8");
assert.match(auditText, /"tool":"search_broll_sources"/);
assert.match(auditText, /"tool":"download_broll_candidate"/);
assert.match(auditText, /shareUrlRedacted/);
assert.equal(auditText.includes("pwd=secret"), false, "share links must never enter audit logs");

await fs.rm(root, { recursive: true, force: true });
console.log("broll-source-tools.verify: provider parsing, license gates, thumbnail inspection, direct download, Pan download and provenance audit passed");
