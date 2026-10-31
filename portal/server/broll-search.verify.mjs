import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePexelsVideo, normalizePixabayVideo, rankBrollCandidates, searchBrollScenes, validateBrollScenes } from "./broll-search.mjs";

const scenes = validateBrollScenes({ scenes: [
  { id: "night-work", visualIntent: "A young person working alone at night", queries: ["person working late night laptop", "tired worker dark office"] },
  { id: "software", visualIntent: "A close-up of hands using a laptop", queries: ["hands typing laptop"] },
  { id: "unused", visualIntent: "An office meeting", queries: ["office meeting"] },
  { id: "fourth", visualIntent: "A sunny office", queries: ["sunny office"] },
] });
assert.equal(scenes.length, 3, "scene planner output is capped to control external API requests");
assert.equal(scenes[0].queries.length, 2);
assert.throws(() => validateBrollScenes({ scenes: [{ id: "bad", visualIntent: "x", queries: [""] }] }), /搜索词/);
assert.throws(() => validateBrollScenes({ scenes: "invalid" }), /分镜格式/);

const pexels = normalizePexelsVideo({ id: 71, url: "https://www.pexels.com/video/person-working-late-night-71/", image: "https://images.pexels.com/preview.jpg", duration: 9, user: { name: "Sample Creator", url: "https://www.pexels.com/@sample" }, video_files: [{ link: "https://videos.pexels.com/sd.mp4", file_type: "video/mp4", quality: "sd", width: 854, height: 480 }, { link: "https://videos.pexels.com/hd.mp4", file_type: "video/mp4", quality: "hd", width: 1920, height: 1080 }] }, "landscape");
assert.equal(pexels.downloadUrl, "https://videos.pexels.com/hd.mp4");
assert.equal(pexels.licenseUrl, "https://www.pexels.com/license/");
const pixabay = normalizePixabayVideo({ id: 82, pageURL: "https://pixabay.com/videos/id-82/", tags: "working laptop", duration: 7, downloads: 50, user: "author", user_id: 14, videos: { small: { url: "https://cdn.pixabay.com/small.mp4", thumbnail: "https://cdn.pixabay.com/small.jpg", width: 960, height: 540 }, medium: { url: "https://cdn.pixabay.com/medium.mp4", thumbnail: "https://cdn.pixabay.com/medium.jpg", width: 1920, height: 1080 } } }, "landscape");
assert.equal(pixabay.downloadUrl, "https://cdn.pixabay.com/medium.mp4");
assert.equal(pixabay.sourceUrl, "https://pixabay.com/videos/id-82/");

const candidates = [
  { provider: "pexels", providerId: "landscape", title: "A person working late at night on a laptop", width: 1920, height: 1080, durationSeconds: 12, sourceUrl: "https://www.pexels.com/video/1/" },
  { provider: "pixabay", providerId: "portrait", title: "A person working on a laptop", width: 720, height: 1280, durationSeconds: 8, sourceUrl: "https://pixabay.com/videos/id-2/" },
  { provider: "pexels", providerId: "meeting", title: "An office meeting in a bright room", width: 1920, height: 1080, durationSeconds: 15, sourceUrl: "https://www.pexels.com/video/3/" },
];
const ranked = rankBrollCandidates(candidates, "person working late night laptop", "landscape");
assert.equal(ranked[0].providerId, "landscape", "matching scene words and requested orientation rank higher");
assert.ok(ranked[0].score >= ranked.at(-1).score);
assert.ok(ranked.every((candidate) => candidate.score >= 0 && candidate.score <= 100));

const previousKeys = { PEXELS_API_KEY: process.env.PEXELS_API_KEY, PIXABAY_API_KEY: process.env.PIXABAY_API_KEY };
process.env.PEXELS_API_KEY = "test-pexels";
process.env.PIXABAY_API_KEY = "test-pixabay";
const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-broll-search-"));
try {
  const searched = await searchBrollScenes({
    scenes: [
      { id: "typing", visualIntent: "Hands typing on a laptop", queries: ["hands typing laptop", "close up typing"] },
      { id: "subway", visualIntent: "Person waiting in a subway", queries: ["person waiting subway"] },
      { id: "extra", visualIntent: "Night city traffic", queries: ["night city traffic"] },
      { id: "ignored", visualIntent: "Extra shot beyond search limit", queries: ["extra shot"] },
    ],
    orientation: "portrait",
    cachePath: path.join(cacheDir, "cache.json"),
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      const query = url.searchParams.get("query") || url.searchParams.get("q");
      const pexels = url.hostname === "api.pexels.com";
      const videos = Array.from({ length: 10 }, (_, index) => pexels
        ? { id: `${query}-${index}`, url: `https://www.pexels.com/video/${query}-${index}/`, image: "https://images.pexels.com/preview.jpg", duration: 8, user: { name: "Creator" }, video_files: [{ link: `https://videos.pexels.com/${query}-${index}.mp4`, file_type: "video/mp4", width: 720, height: 1280 }] }
        : { id: `${query}-${index}`, pageURL: `https://pixabay.com/videos/${query}-${index}/`, tags: `${query} ${index}`, duration: 8, videos: { medium: { url: `https://cdn.pixabay.com/${query}-${index}.mp4`, width: 720, height: 1280 } } });
      return new Response(JSON.stringify(pexels ? { videos } : { hits: videos }), { status: 200, headers: { "x-ratelimit-limit": "100" } });
    },
  });
  assert.deepEqual(searched.scenes.map((scene) => scene.id), ["typing", "subway", "extra"]);
  assert.ok(searched.scenes.every((scene) => scene.candidates.length <= 8), "each visual intent returns at most eight distinct candidates");
  assert.ok(searched.scenes.find((scene) => scene.id === "typing").candidates.every((candidate) => candidate.title.toLowerCase().includes("typing")), "candidate results remain scoped to their own search intent");
  assert.equal(searched.scenes[0].providerStatus.pexels, "configured");
} finally {
  await fs.rm(cacheDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousKeys)) value === undefined ? delete process.env[key] : process.env[key] = value;
}
console.log("broll-search.verify: scene bounds and deterministic relevance/orientation ranking passed");
