import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const PIXABAY_LICENSE = "https://pixabay.com/service/license-summary/";
const PEXELS_LICENSE = "https://www.pexels.com/license/";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS_PER_QUERY = 8;
let cacheWriteQueue = Promise.resolve();

function cleanText(value, max = 180) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function validateBrollScenes(payload) {
  if (!payload || !Array.isArray(payload.scenes)) throw new Error("Claude 返回的分镜格式无效");
  const scenes = payload.scenes.slice(0, 3).map((scene, index) => {
    const visualIntent = cleanText(scene.visualIntent, 180);
    const queries = Array.isArray(scene.queries) ? [...new Set(scene.queries.map((query) => cleanText(query, 100).toLowerCase()).filter(Boolean))].slice(0, 2) : [];
    if (visualIntent.length < 4 || !queries.length) throw new Error(`第 ${index + 1} 个分镜缺少视觉意图或搜索词`);
    return { id: cleanText(scene.id, 48) || `scene-${index + 1}`, visualIntent, queries };
  });
  if (!scenes.length) throw new Error("没有可用于搜索的分镜");
  return scenes;
}

function tokenize(value) {
  const english = String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const cjk = (String(value || "").toLowerCase().match(/[\u3400-\u9fff]{2,}/g) || []).flatMap((run) => {
    const chars = Array.from(run);
    return chars.length < 3 ? [run] : chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
  });
  return [...new Set([...english, ...cjk].filter((word) => word.length > 1))];
}

function matchesOrientation(width, height, orientation) {
  const ratio = Number(width || 0) / Math.max(1, Number(height || 0));
  if (orientation === "square") return ratio >= .9 && ratio <= 1.1;
  return orientation === "portrait" ? ratio < 1 : ratio >= 1;
}

export function rankBrollCandidates(candidates, query, orientation = "landscape") {
  const terms = tokenize(query);
  return candidates.map((candidate) => {
    const description = tokenize(`${candidate.title || ""} ${candidate.tags || ""}`);
    const overlap = terms.length ? terms.filter((term) => description.some((word) => word.includes(term) || term.includes(word))).length / terms.length : 0;
    const orientationScore = matchesOrientation(candidate.width, candidate.height, orientation) ? 1 : 0;
    const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
    const technicalScore = Math.min(1, pixels / (1280 * 720));
    const duration = Number(candidate.durationSeconds || 0);
    const durationScore = duration >= 2 && duration <= 30 ? 1 : duration > 0 ? .45 : 0;
    const score = Math.round((overlap * .55 + orientationScore * .2 + technicalScore * .15 + durationScore * .1) * 100);
    return { ...candidate, score, match: { keyword: Math.round(overlap * 100), orientation: Math.round(orientationScore * 100), resolution: Math.round(technicalScore * 100), duration: Math.round(durationScore * 100) } };
  }).sort((a, b) => b.score - a.score || Number(b.popularity || 0) - Number(a.popularity || 0));
}

function bestPexelsFile(files = [], orientation = "landscape") {
  return [...files].filter((file) => file.link && file.file_type?.includes("mp4")).sort((a, b) => {
    const match = (file) => (matchesOrientation(file.width, file.height, orientation) ? 1 : 0);
    return match(b) - match(a) || Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height);
  })[0];
}

export function normalizePexelsVideo(video, orientation) {
  const file = bestPexelsFile(video.video_files, orientation);
  if (!file) return null;
  const slug = String(video.url || "").split("/").filter(Boolean).at(-1) || "";
  const title = cleanText(slug.replace(/-\d+$/, "").replaceAll("-", " ")) || cleanText(video.user?.name || "Pexels video");
  return { provider: "pexels", providerId: String(video.id), title, tags: cleanText(slug), previewUrl: video.image, downloadUrl: file.link, sourceUrl: video.url, creator: cleanText(video.user?.name), creatorUrl: video.user?.url, width: Number(file.width || video.width || 0), height: Number(file.height || video.height || 0), durationSeconds: Number(video.duration || 0), licenseName: "Pexels License", licenseUrl: PEXELS_LICENSE };
}

export function normalizePixabayVideo(video, orientation) {
  const variants = Object.entries(video.videos || {}).map(([quality, value]) => ({ quality, ...value })).filter((value) => value.url);
  const matching = variants.filter((value) => matchesOrientation(value.width, value.height, orientation));
  const file = [...(matching.length ? matching : variants)].sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))[0];
  if (!file) return null;
  return { provider: "pixabay", providerId: String(video.id), title: cleanText(video.tags || "Pixabay video"), tags: cleanText(video.tags), previewUrl: file.thumbnail, downloadUrl: file.url, sourceUrl: video.pageURL, creator: cleanText(video.user), creatorUrl: `https://pixabay.com/users/${encodeURIComponent(video.user || "")}-${video.user_id || ""}/`, width: Number(file.width || 0), height: Number(file.height || 0), durationSeconds: Number(video.duration || 0), popularity: Number(video.downloads || 0), licenseName: "Pixabay Content License", licenseUrl: PIXABAY_LICENSE };
}

async function expandScenes(text, fetchImpl) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_API_KEY;
  if (!key) throw new Error("未配置 Claude 服务，无法从文案提取 B-roll 分镜");
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const response = await fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1200, system: "你把视频文案转成真实可搜索的 B-roll 镜头意图。只返回合法 JSON。", messages: [{ role: "user", content: `根据下方文案，选出最多 3 个最值得用真实画面补充的分镜。不要按句子机械拆分；画面应具体可拍、可搜索，不可用抽象概念代替画面。为每个分镜提供视觉意图和最多 2 条简短英文搜索词。只返回 {"scenes":[{"id":"...","visualIntent":"...","queries":["..."]}]}。\n文案：\n${cleanText(text, 12000)}` }] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Claude 分镜分析失败 (${response.status})`);
  const output = (body.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const jsonText = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  try { return validateBrollScenes(JSON.parse(jsonText)); } catch (error) { throw new Error(`Claude 返回的 B-roll 分镜无法解析：${error.message}`); }
}

async function readCache(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return {}; }
}

async function saveCacheEntry(cachePath, entryKey, entry) {
  cacheWriteQueue = cacheWriteQueue.then(async () => {
    const cache = await readCache(cachePath);
    const now = Date.now();
    cache[entryKey] = entry;
    for (const [key, value] of Object.entries(cache)) if (!value?.cachedAt || now - value.cachedAt >= CACHE_TTL_MS) delete cache[key];
    const keys = Object.keys(cache);
    for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete cache[key];
    await fs.mkdir(dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(cache));
    await fs.rename(temporary, cachePath);
  });
  return cacheWriteQueue;
}

async function fetchProvider(provider, query, orientation, { fetchImpl, cachePath }) {
  const apiKey = provider === "pexels" ? process.env.PEXELS_API_KEY : process.env.PIXABAY_API_KEY;
  if (!apiKey) return { provider, query, candidates: [], skipped: "未配置 API key" };
  const cache = await readCache(cachePath);
  const cacheKey = `${provider}:${orientation}:${query.toLowerCase()}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return { provider, query, candidates: cached.candidates, cached: true };
  const url = provider === "pexels" ? new URL("https://api.pexels.com/v1/videos/search") : new URL("https://pixabay.com/api/videos/");
  if (provider === "pexels") {
    url.searchParams.set("query", query);
    url.searchParams.set("orientation", orientation);
    url.searchParams.set("per_page", String(MAX_RESULTS_PER_QUERY));
  } else {
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", query);
    url.searchParams.set("video_type", "film");
    url.searchParams.set("safesearch", "true");
    url.searchParams.set("per_page", String(MAX_RESULTS_PER_QUERY));
    url.searchParams.set("min_width", "720");
  }
  const response = await fetchImpl(url, { headers: provider === "pexels" ? { Authorization: apiKey } : {}, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`${provider} API 返回 HTTP ${response.status}`);
  const payload = await response.json();
  const candidates = provider === "pexels" ? (payload.videos || []).map((video) => normalizePexelsVideo(video, orientation)).filter(Boolean) : (payload.hits || []).map((video) => normalizePixabayVideo(video, orientation)).filter(Boolean);
  await saveCacheEntry(cachePath, cacheKey, { cachedAt: Date.now(), candidates });
  return { provider, query, candidates, cached: false, rateLimit: { limit: response.headers.get("x-ratelimit-limit"), remaining: response.headers.get("x-ratelimit-remaining"), reset: response.headers.get("x-ratelimit-reset") } };
}

export async function searchOnlineBroll({ text, orientation = "landscape", cachePath, fetchImpl = fetch }) {
  const normalizedText = cleanText(text, 12000);
  if (normalizedText.length < 8) throw new Error("请提供至少 8 个字符的文案或字幕");
  if (!cachePath) throw new Error("B-roll 缓存路径未配置");
  const targetOrientation = ["landscape", "portrait", "square"].includes(orientation) ? orientation : "landscape";
  const scenes = await expandScenes(normalizedText, fetchImpl);
  const result = await searchBrollScenes({ scenes, orientation: targetOrientation, cachePath, fetchImpl });
  return { ...result, disclaimer: "分数仅为关键词、画幅、分辨率和片长的启发式预排序，不代表视频动作已由视觉模型验证。使用前请查看来源页和具体授权。搜索结果不会自动下载。" };
}

export async function searchBrollScenes({ scenes: rawScenes, orientation = "landscape", cachePath, fetchImpl = fetch }) {
  const scenes = validateBrollScenes({ scenes: rawScenes });
  if (!cachePath) throw new Error("B-roll 缓存路径未配置");
  const targetOrientation = ["landscape", "portrait", "square"].includes(orientation) ? orientation : "landscape";
  const uniqueQueries = [...new Set(scenes.flatMap((scene) => scene.queries))];
  const searches = await Promise.all(uniqueQueries.map(async (query) => {
    const providers = await Promise.allSettled(["pexels", "pixabay"].map((provider) => fetchProvider(provider, query, targetOrientation, { fetchImpl, cachePath })));
    return { query, providers: providers.map((item, index) => item.status === "fulfilled" ? item.value : { provider: ["pexels", "pixabay"][index], query, candidates: [], error: item.reason?.message || "素材搜索失败" }) };
  }));
  const results = scenes.map((scene) => {
    const providerResults = searches.filter((search) => scene.queries.includes(search.query)).flatMap((search) => search.providers);
    const deduped = new Map();
    for (const providerResult of providerResults) for (const candidate of providerResult.candidates) {
      const key = `${candidate.provider}:${candidate.providerId}`;
      const ranked = rankBrollCandidates([{ ...candidate, query: providerResult.query }], `${scene.visualIntent} ${providerResult.query}`, targetOrientation)[0];
      const previous = deduped.get(key);
      if (!previous || ranked.score > previous.score) deduped.set(key, ranked);
    }
    return { ...scene, candidates: [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, 8), providerStatus: { pexels: process.env.PEXELS_API_KEY ? "configured" : "missing_key", pixabay: process.env.PIXABAY_API_KEY ? "configured" : "missing_key" }, errors: providerResults.filter((result) => result.error).map((result) => result.error) };
  });
  return { orientation: targetOrientation, scenes: results };
}

export function brollProviderState() {
  return { pexels: Boolean(process.env.PEXELS_API_KEY), pixabay: Boolean(process.env.PIXABAY_API_KEY) };
}
