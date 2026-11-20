const USER_AGENT = "Mozilla/5.0 (compatible; WayneBrollSources/1.0)";
const MIXKIT_LICENSE = "https://mixkit.co/license/";
const COVERR_LICENSE = "https://coverr.co/license";
const YSJF_LICENSE = "https://www.ysjf.com/material";
const YSJF_ORDER = ["enterprise_commercial", "personal_commercial", "personal_learning"];
const YSJF_LICENSE_NAMES = {
  enterprise_commercial: "企业商用",
  personal_commercial: "个人商用",
  personal_learning: "个人学习",
};

function cleanText(value, max = 500) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
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

function isoDurationSeconds(value) {
  const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function rankCandidate(candidate, query, orientation) {
  const terms = tokenize(query);
  const description = tokenize(`${candidate.title || ""} ${candidate.tags || ""} ${candidate.description || ""}`);
  const overlap = terms.length ? terms.filter((term) => description.some((word) => word.includes(term) || term.includes(word))).length / terms.length : 0;
  const orientationScore = candidate.width && candidate.height ? (matchesOrientation(candidate.width, candidate.height, orientation) ? 1 : 0) : .5;
  const pixels = Number(candidate.width || 0) * Number(candidate.height || 0);
  const technicalScore = pixels ? Math.min(1, pixels / (1920 * 1080)) : .5;
  const duration = Number(candidate.durationSeconds || 0);
  const durationScore = duration >= 2 && duration <= 30 ? 1 : duration ? .45 : .5;
  return {
    ...candidate,
    score: Math.round((overlap * .6 + orientationScore * .2 + technicalScore * .1 + durationScore * .1) * 100),
    match: {
      keyword: Math.round(overlap * 100),
      orientation: Math.round(orientationScore * 100),
      resolution: Math.round(technicalScore * 100),
      duration: Math.round(durationScore * 100),
    },
  };
}

export function rankBrollSourceCandidates(candidates, query, orientation = "landscape") {
  return candidates.map((candidate) => rankCandidate(candidate, query, orientation)).sort((a, b) => b.score - a.score);
}

function jsonLdNodes(html) {
  const nodes = [];
  for (const match of String(html || "").matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        if (Array.isArray(value?.["@graph"])) nodes.push(...value["@graph"]);
        else nodes.push(value);
      }
    } catch { /* Ignore malformed analytics or third-party JSON-LD. */ }
  }
  return nodes;
}

function mixkitLicense(notice, licenseUrl) {
  const restricted = /restricted/i.test(String(notice || ""));
  const free = !restricted && (/free/i.test(String(notice || "")) || /#videoFree/i.test(String(licenseUrl || "")));
  if (restricted) return {
    commercialUse: false,
    licenseName: "Mixkit Restricted License",
    licenseUrl: `${MIXKIT_LICENSE}#videoRestricted`,
    licenseNote: "免费 720p 仅限个人使用；商用需要 Envato 订阅的 1080p 版本。",
  };
  if (free) return { commercialUse: true, licenseName: "Mixkit Free License", licenseUrl: `${MIXKIT_LICENSE}#videoFree` };
  return { commercialUse: false, licenseName: "Mixkit License（需核验）", licenseUrl: MIXKIT_LICENSE, licenseNote: "未能确认该单条素材的许可类型。" };
}

export function parseMixkitHtml(html) {
  return jsonLdNodes(html)
    .filter((node) => node?.["@type"] === "VideoObject")
    .map((node) => {
      const sourceUrl = cleanText(node["@id"], 1000).replace(/#video$/i, "");
      const downloadUrl = cleanText(node.contentUrl || node.embedUrl, 1000);
      const providerId = downloadUrl.match(/\/videos\/(\d+)\//i)?.[1] || sourceUrl.match(/-(\d+)\/?$/)?.[1];
      if (!providerId || !downloadUrl) return null;
      const license = mixkitLicense(node.copyrightNotice, node.license);
      const tags = (node.about || []).map((item) => cleanText(String(item?.["@id"] || "").replace(/^#stock_video_/, ""), 80)).filter(Boolean);
      return {
        provider: "mixkit",
        providerId,
        title: cleanText(node.name) || `Mixkit video ${providerId}`,
        tags: tags.join(", "),
        previewUrl: cleanText(node.thumbnailUrl || node.embedUrl, 1000),
        thumbnailUrl: cleanText(node.thumbnailUrl, 1000),
        downloadUrl,
        sourceUrl: sourceUrl || `https://mixkit.co/free-stock-video/${providerId}/`,
        width: 0,
        height: 0,
        durationSeconds: isoDurationSeconds(node.duration),
        ...license,
      };
    })
    .filter(Boolean);
}

export function parseCoverrResponse(payload) {
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  return hits.filter((hit) => hit?.isPremium !== true && hit?.state !== "unpublished").map((hit) => {
    const rendition = hit.defaultVariant?.renditions?.find((item) => item?.type === "fhd" && item?.url);
    const downloadUrl = cleanText(hit.urls?.mp4Download || hit.urls?.mp4 || rendition?.url, 1000);
    if (!hit.id || !downloadUrl) return null;
    return {
      provider: "coverr",
      providerId: String(hit.id),
      title: cleanText(hit.title) || `Coverr video ${hit.id}`,
      description: cleanText(hit.description),
      tags: cleanText((hit.searchKeywords || []).join(", ")),
      previewUrl: cleanText(hit.thumbnail || hit.poster, 1000),
      thumbnailUrl: cleanText(hit.thumbnail || hit.poster, 1000),
      downloadUrl,
      sourceUrl: `https://coverr.co/videos/${encodeURIComponent(hit.slug || hit.id)}`,
      width: Number(rendition?.width || hit.maxWidth || 0),
      height: Number(rendition?.height || hit.maxHeight || 0),
      durationSeconds: Number(hit.duration || 0),
      fps: Number(hit.fps || 0),
      isAiGenerated: hit.isAiGenerated === true,
      commercialUse: true,
      licenseName: "Coverr License",
      licenseUrl: COVERR_LICENSE,
    };
  }).filter(Boolean);
}

function ysjfSpecification(specs) {
  return YSJF_ORDER.map((license) => specs.find((spec) => spec?.license === license)).find(Boolean) || null;
}

export function normalizeYsjfMaterial(detail, listItem = {}) {
  const specs = Array.isArray(detail?.specifications) ? detail.specifications : [];
  const spec = ysjfSpecification(specs);
  if (!spec) return null;
  const tags = Array.isArray(detail?.tags) ? detail.tags : Array.isArray(listItem?.tags) ? listItem.tags : [];
  const tagName = (type) => cleanText(tags.find((tag) => tag?.type === type)?.name, 80);
  const format = cleanText((spec.tags || []).find((tag) => String(tag?.name || "").startsWith("."))?.name, 40);
  const size = cleanText((spec.tags || []).find((tag) => /\b(?:MB|GB)\b/i.test(String(tag?.name || "")))?.name, 40);
  const previewUrl = cleanText(detail?.previews?.find((item) => item?.type === "video")?.url || detail?.previews?.[0]?.url, 1000);
  return {
    provider: "ysjf",
    providerId: String(detail.id),
    title: cleanText(detail.name) || `影视飓风素材 ${detail.id}`,
    description: "",
    tags: tags.map((tag) => cleanText(tag?.name, 80)).filter(Boolean).join(", "),
    previewUrl,
    thumbnailUrl: cleanText(detail.cover || previewUrl, 1000),
    downloadUrl: null,
    sourceUrl: `https://www.ysjf.com/material/${encodeURIComponent(detail.id)}`,
    width: 0,
    height: 0,
    durationSeconds: 0,
    commercialUse: spec.license !== "personal_learning",
    licenseName: YSJF_LICENSE_NAMES[spec.license] || spec.license,
    licenseUrl: YSJF_LICENSE,
    requiresOrder: true,
    downloadMode: "baidu-pan",
    specificationId: String(spec.id),
    skuId: String(spec.skuId || ""),
    specificationName: cleanText(spec.name, 80),
    price: Number(spec.price || 0),
    format,
    size,
    logProfile: tagName("log"),
    camera: tagName("camera"),
    frameRate: tagName("frame_rate"),
    licenseOptions: specs.map((item) => ({
      specificationId: String(item.id),
      license: item.license,
      licenseName: YSJF_LICENSE_NAMES[item.license] || item.license,
      name: cleanText(item.name, 80),
      price: Number(item.price || 0),
    })),
    note: "需要登录影视飓风并提交 0 元授权订单，再把百度网盘分享链接交给下载工具；不要自动化登录、实名或下单。",
  };
}

async function fetchJson(url, fetchImpl, label) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}`);
  return response.json();
}

export async function searchMixkit(query, { limit = 6, orientation = "landscape", fetchImpl = fetch } = {}) {
  const slug = cleanText(query, 200).toLowerCase().replace(/\s+/g, "-");
  if (!slug) throw new Error("Mixkit 搜索词不能为空");
  const url = `https://mixkit.co/free-stock-video/discover/${encodeURIComponent(slug)}/${orientation === "portrait" ? "?orientation=vertical" : ""}`;
  const response = await fetchImpl(url, { headers: { Accept: "text/html", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Mixkit 返回 HTTP ${response.status}`);
  return parseMixkitHtml(await response.text()).slice(0, limit);
}

export async function searchCoverr(query, { limit = 6, orientation = "landscape", fetchImpl = fetch } = {}) {
  const url = new URL("https://coverr.co/papi/videos");
  url.searchParams.set("lang", "en");
  url.searchParams.set("page", "0");
  url.searchParams.set("pageSize", String(Math.min(36, Math.max(1, limit))));
  url.searchParams.set("camelCase", "true");
  url.searchParams.set("sort", "relevance");
  url.searchParams.set("query", cleanText(query, 200));
  url.searchParams.set("filter", orientation === "portrait" ? "isVertical:true" : "");
  url.searchParams.set("extends", "translatedSlugs,variant,keywords,facets");
  url.searchParams.set("searchMode", "ai");
  url.searchParams.set("userId", "guest");
  return parseCoverrResponse(await fetchJson(url, fetchImpl, "Coverr")).slice(0, limit);
}

export async function searchYsjf(query, { limit = 6, fetchImpl = fetch } = {}) {
  const url = new URL("https://api.ysjf.com/mediastorm/resource/v2/items");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("pageSize", String(Math.min(50, Math.max(6, limit * 3))));
  url.searchParams.set("type", "video");
  url.searchParams.set("sort", "time");
  url.searchParams.set("keyword", cleanText(query, 200));
  const payload = await fetchJson(url, fetchImpl, "影视飓风列表");
  const items = Array.isArray(payload?.data?.entities) ? payload.data.entities : [];
  const settled = await Promise.allSettled(items.slice(0, Math.min(12, Math.max(limit * 3, 6))).map(async (item) => {
    const detail = await fetchJson(`https://api.ysjf.com/mediastorm/resource/v2/materials/${encodeURIComponent(item.id)}`, fetchImpl, "影视飓风详情");
    return normalizeYsjfMaterial(detail?.data, item);
  }));
  return {
    candidates: settled.filter((item) => item.status === "fulfilled").map((item) => item.value).filter(Boolean),
    errors: settled.filter((item) => item.status === "rejected").map((item) => item.reason?.message || "影视飓风详情失败"),
  };
}

export async function searchBrollSources({
  query,
  providers = ["mixkit", "coverr", "ysjf"],
  orientation = "landscape",
  limit = 6,
  commercialOnly = false,
  fetchImpl = fetch,
} = {}) {
  const text = cleanText(query, 200);
  if (text.length < 2) throw new Error("请提供至少 2 个字符的搜索词");
  const requested = [...new Set((Array.isArray(providers) ? providers : []).filter((provider) => ["mixkit", "coverr", "ysjf"].includes(provider)))];
  if (!requested.length) throw new Error("至少选择一个素材来源");
  const resultLimit = Math.min(12, Math.max(1, Number(limit) || 6));
  const settled = await Promise.allSettled(requested.map(async (provider) => {
    if (provider === "mixkit") return { candidates: await searchMixkit(text, { limit: resultLimit, orientation, fetchImpl }), errors: [] };
    if (provider === "coverr") return { candidates: await searchCoverr(text, { limit: resultLimit, orientation, fetchImpl }), errors: [] };
    return searchYsjf(text, { limit: resultLimit, fetchImpl });
  }));
  const providerStatus = {};
  const candidates = [];
  settled.forEach((entry, index) => {
    const provider = requested[index];
    if (entry.status === "rejected") {
      providerStatus[provider] = { status: "error", error: entry.reason?.message || "搜索失败" };
      return;
    }
    const filtered = entry.value.candidates.filter((candidate) => !commercialOnly || candidate.commercialUse === true);
    const ranked = rankBrollSourceCandidates(filtered, text, orientation).slice(0, resultLimit);
    candidates.push(...ranked);
    providerStatus[provider] = { status: "ok", count: ranked.length, errors: entry.value.errors || [] };
  });
  return {
    query: text,
    orientation,
    commercialOnly: commercialOnly === true,
    candidates: candidates.sort((a, b) => b.score - a.score),
    providerStatus,
    disclaimer: "候选排序只基于标题、标签、画幅、分辨率和片长；下载前必须查看画面和具体授权。影视飓风需要人工完成 0 元订单和网盘获取。",
  };
}
