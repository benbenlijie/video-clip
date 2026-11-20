import { assertStylePackCompatible } from "./style-pack-store.mjs";
import { classifyOverlayType, validateStyleManifest } from "./style-project.mjs";

const MODES = new Set(["single-video-v1", "multi-asset-v1"]);
const LAYOUTS = new Set(["full", "punch_in", "split", "broll_cover", "unknown"]);
const STYLE_COPY_KEYS = new Set(["copyCaptions", "copyRhythm", "copyLayout", "copyBroll", "copyAudio"]);
const VISUAL_OVERLAY_TYPES = {
  title: "title_card",
  title_card: "title_card",
  cta: "cta",
  emphasis: "emphasis",
  callout: "emphasis",
  caption: "emphasis",
  sticker: "emphasis",
};
const CAMERA_LAYOUT_CAPABILITIES = ["punch_in", "split", "broll_cover"];
const VISUAL_OVERLAY_CAPABILITIES = ["title_card", "emphasis", "cta"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function normalizeStyleCopy(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries([...STYLE_COPY_KEYS].flatMap((key) => typeof value[key] === "boolean" ? [[key, value[key]]] : []));
}

function manifestOf(stylePack) {
  return validateStyleManifest(stylePack?.manifest || stylePack);
}

function referenceOf(stylePack, referenceAnalysis) {
  const source = referenceAnalysis || stylePack?.referenceAnalysis || null;
  if (!source) return null;
  return {
    ...source,
    styleSpec: stylePack?.manifest?.styleSpec || source.styleSpec || null,
  };
}

function hasBroll(assets = []) {
  return assets.some((asset) => asset?.licenseConfirmed === true && (asset?.role === "broll" || asset?.track === "video-overlay"));
}

function hasSupporting(assets = []) {
  return assets.some((asset) => asset?.licenseConfirmed === true && ["supporting", "broll"].includes(asset?.role));
}

export function styleAssetsForProject(project = {}) {
  return [
    ...(Array.isArray(project.assets) ? project.assets : []),
    ...(Array.isArray(project.brollAssets) ? project.brollAssets.map((asset) => ({ ...asset, role: "broll" })) : []),
  ];
}

function splitCaptionTokens(text) {
  const value = String(text || "").trim();
  if (!value) return { tokens: [], spaced: false };
  if (/\s/.test(value)) return { tokens: value.split(/\s+/).filter(Boolean), spaced: true };
  return { tokens: Array.from(value.replace(/\s+/g, "")), spaced: false };
}

const CJK_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const LEADING_BAD_PARTICLE = /^(?:的|地|得|了|着|过|和|与|及|或|而|但|却|并|且)/;
const TRAILING_BAD_PARTICLE = /(?:的|地|得|了|着|过|和|与|及|或|而|但|却|并|且)$/;
const PUNCTUATION_EDGE = /^[，。！？；：、,.!?;:]|[，。！？；：、,.!?;:]$/;

function cjkTokens(text) {
  try {
    return [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
      .map((item) => item.segment)
      .filter((item) => item.trim());
  } catch {
    return Array.from(text);
  }
}

function tokenWeight(token) {
  return Array.from(String(token || "")).filter((char) => !/\s/.test(char)).length;
}

function boundaryPenalty(left, right) {
  if (PUNCTUATION_EDGE.test(left) || PUNCTUATION_EDGE.test(right)) return -5;
  if (LEADING_BAD_PARTICLE.test(right)) return 1000;
  if (TRAILING_BAD_PARTICLE.test(left)) return 800;
  return 0;
}

function semanticCjkGroups(text, limit) {
  const tokens = cjkTokens(text);
  if (!tokens.length) return [];
  if (tokens.length === 1) return [{ text: text.trim(), weight: tokenWeight(text) }];
  const maxOverflow = limit >= 8 ? 2 : 1;
  const dp = Array(tokens.length + 1).fill(Infinity);
  const previous = Array(tokens.length + 1).fill(-1);
  dp[0] = 0;
  for (let start = 0; start < tokens.length; start += 1) {
    if (!Number.isFinite(dp[start])) continue;
    let units = 0;
    for (let end = start + 1; end <= tokens.length; end += 1) {
      units += tokenWeight(tokens[end - 1]);
      const overflow = Math.max(0, units - limit);
      if (overflow > maxOverflow && end > start + 1) break;
      const underfill = Math.max(0, limit - units);
      let cost = dp[start] + 5 + overflow * overflow * 100 + underfill * 0.1;
      if (end < tokens.length) cost += boundaryPenalty(tokens[end - 1], tokens[end]);
      if (cost <= dp[end]) {
        dp[end] = cost;
        previous[end] = start;
      }
    }
  }
  const groups = [];
  for (let end = tokens.length; end > 0; end = previous[end]) {
    const start = previous[end];
    if (start < 0) break;
    const groupTokens = tokens.slice(start, end);
    groups.unshift({
      text: groupTokens.join("").trim(),
      weight: groupTokens.reduce((sum, token) => sum + tokenWeight(token), 0),
    });
  }
  return groups;
}

function keywordsForGroup(cue, text) {
  const raw = [cue?.keywords, cue?.highlights].flatMap((value) => Array.isArray(value) ? value : []);
  const normalized = String(text || "").replace(/\s+/g, "");
  return [...new Set(raw.map(String).map((value) => value.trim()).filter((value) => value && normalized.includes(value.replace(/\s+/g, ""))))];
}

export function regroupCaptionCues(cues, maxWordsPerCue) {
  const limit = Math.max(0, Math.min(12, Math.round(Number(maxWordsPerCue) || 0)));
  if (!Array.isArray(cues) || limit < 1) return (cues || []).map((cue) => ({ ...cue }));
  return cues.flatMap((cue) => {
    const startMs = Number(cue.startMs);
    const endMs = Number(cue.endMs);
    const text = String(cue.text || "").trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !text) return [];
    // The style QC allows three characters of overflow; keep a semantic cue
    // intact within that tolerance instead of splitting a word or phrase.
    if (!/\s/.test(text) && Array.from(text).length <= limit + 3) return [{ ...cue, text }];
    const { tokens, spaced } = splitCaptionTokens(text);
    const groups = CJK_PATTERN.test(text) && !spaced
      ? semanticCjkGroups(text, limit)
      : tokens.reduce((result, token, index) => {
          if (index % limit === 0) result.push([]);
          result.at(-1).push(token);
          return result;
        }, []).map((group) => ({ text: group.join(" "), weight: group.length }));
    const visibleGroups = groups.filter((group) => /[^\s，。！？；：、,.!?;:]/.test(group.text));
    const totalWeight = visibleGroups.reduce((sum, group) => sum + group.weight, 0);
    if (!totalWeight) return [];
    const durationMs = endMs - startMs;
    let consumed = 0;
    return visibleGroups.filter((group) => group.text.trim()).map((group, index) => {
      const groupStart = startMs + durationMs * consumed / totalWeight;
      consumed += group.weight;
      const groupEnd = startMs + durationMs * consumed / totalWeight;
      const keywords = keywordsForGroup(cue, group.text);
      return {
        id: `${String(cue.id || "cue")}-${index + 1}`,
        startMs: Math.round(groupStart),
        endMs: Math.max(Math.round(groupStart) + 1, Math.round(groupEnd)),
        text: group.text.trim(),
        ...(keywords.length ? { keywords } : {}),
      };
    });
  });
}

function captionPolicy(reference, media) {
  const caption = reference?.captions || {};
  const styledCaption = reference?.styleSpec?.captions || null;
  const height = Number(media?.height) || 1920;
  const fontSize = Math.round(clamp(height * (Number(styledCaption?.typography?.fontSizeRatio || caption.fontSizeRatio) || 0.05), 8, 64));
  const anchor = styledCaption?.anchor || caption.position || "bottom";
  const position = String(anchor).startsWith("top") ? "top" : String(anchor).startsWith("middle") ? "middle" : "bottom";
  return {
    wordsPerCue: Math.round(clamp(styledCaption?.maxCharsPerCue || caption.maxWordsPerCue || 4, 1, 24)),
    position,
    style: {
      fontSize,
      marginV: position === "top" ? 150 : position === "middle" ? 80 : 24,
      outline: Math.round(clamp((Number(styledCaption?.typography?.strokeWidthRatio) || 0) * height || caption.strokeWidth || 1, 0, 5)),
      color: /^#[0-9a-f]{6}$/i.test(String(styledCaption?.typography?.color || caption.primaryColor || ""))
        ? String(styledCaption?.typography?.color || caption.primaryColor).toLowerCase()
        : "#ffffff",
    },
  };
}

function shortUserText(segments, startMs, endMs) {
  const text = (segments || [])
    .filter((segment) => Number(segment.endMs) > startMs && Number(segment.startMs) < endMs)
    .map((segment) => String(segment.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const graphemes = Array.from(text);
  return graphemes.length > 28 ? graphemes.slice(0, 28).join("").trim() : text;
}

function visualEventsFor(reference, durationMs, transcript, existingEvents, capabilities) {
  const overlays = Array.isArray(reference?.overlays) ? reference.overlays : [];
  if (!overlays.length || !durationMs) return existingEvents || [];
  const referenceDuration = Math.max(1, Number(reference.source?.durationMs) || Number(durationMs));
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const remainingSlots = Math.max(0, 8 - (existingEvents || []).length);
  const mapped = overlays.flatMap((overlay, index) => {
    const type = VISUAL_OVERLAY_TYPES[String(overlay.type || "").toLowerCase()] || classifyOverlayType(overlay.type);
    if (!type || !capabilities.includes(type)) return [];
    const startMs = Math.round(Number(overlay.startMs) / referenceDuration * durationMs);
    const endMs = Math.round(Number(overlay.endMs) / referenceDuration * durationMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    const overlapsExisting = (existingEvents || []).some((event) => Number(event.endMs) > startMs && Number(event.startMs) < endMs);
    if (overlapsExisting) return [];
    const text = shortUserText(segments, startMs, endMs);
    if (!text) return [];
    const stylePosition = type === "title_card"
      ? reference?.styleSpec?.title?.anchor
      : type === "emphasis"
        ? reference?.styleSpec?.identity?.anchor
        : null;
    return [{
      id: `style-overlay-${index + 1}`,
      type,
      startMs,
      endMs,
      text,
      subtext: "",
      position: String(stylePosition || overlay.position || "center"),
      sizeRatio: Math.max(0.08, Math.min(0.6, Number(overlay.sizeRatio) || 0.2)),
      coverage: Math.max(0, Math.min(1, Number(overlay.coverage) || 0)),
    }];
  }).slice(0, Math.min(6, remainingSlots));
  return [...(existingEvents || []), ...mapped];
}

function layoutFallback(capabilities) {
  return capabilities.includes("punch_in") ? "punch_in" : "full";
}

function layoutEventsFor(reference, durationMs, copyBroll, copyLayout, hasSupportingAsset, brollEvents = [], capabilities = []) {
  if (!copyLayout || !reference?.shots?.length || !durationMs) return [];
  const referenceDuration = Math.max(1, Number(reference.source?.durationMs) || Number(durationMs));
  const brollWindows = (brollEvents || []).flatMap((event) => {
    const startMs = Math.max(0, Number(event.startMs));
    const endMs = Math.min(Number(durationMs), Number(event.endMs));
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? [{ startMs, endMs }] : [];
  });
  return reference.shots.flatMap((shot, index) => {
    let type = LAYOUTS.has(shot.layout) ? shot.layout : "full";
    const startMs = Math.round(Number(shot.startMs) / referenceDuration * durationMs);
    const endMs = Math.round(Number(shot.endMs) / referenceDuration * durationMs);
    if (type === "broll_cover" && copyBroll) {
      const overlaps = brollWindows
        .map((event) => ({ startMs: Math.max(startMs, event.startMs), endMs: Math.min(endMs, event.endMs) }))
        .filter((event) => event.endMs > event.startMs);
      if (overlaps.length) {
        return overlaps.map((event, overlapIndex) => ({
          id: `style-layout-${index + 1}-broll-${overlapIndex + 1}`,
          type: "broll_cover",
          ...event,
          params: {},
        }));
      }
      type = layoutFallback(capabilities);
    } else if (type === "broll_cover") {
      type = layoutFallback(capabilities);
    }
    if (type === "punch_in" && !capabilities.includes("punch_in")) type = "full";
    if (type === "split" && (!hasSupportingAsset || !capabilities.includes("split"))) type = layoutFallback(capabilities);
    if (type === "unknown") type = "full";
    return [{
      id: `style-layout-${index + 1}`,
      type,
      startMs,
      endMs,
      params: {},
    }];
  }).filter((event) => event.endMs > event.startMs);
}

export function buildStyleApplication({
  stylePack,
  referenceAnalysis = null,
  workflowMode,
  transcript = null,
  media = null,
  assets = [],
  brief = {},
} = {}) {
  if (!MODES.has(workflowMode)) throw new Error("workflowMode must be single-video-v1 or multi-asset-v1");
  const manifest = manifestOf(stylePack);
  const reference = referenceOf(stylePack, referenceAnalysis);
  if (!reference) throw new Error("referenceAnalysis is required");
  const compatible = manifest.supportedModes.includes(workflowMode)
    && (workflowMode !== "multi-asset-v1" || (manifest.requirements.needsMainFootage === true && manifest.requirements.minAssets >= 2));
  const brollAvailable = hasBroll(assets) || Boolean(brief.hasBroll);
  const supportAvailable = hasSupporting(assets);
  const styleCopy = normalizeStyleCopy(brief.styleCopy);
  const supportsCaptions = manifest.capabilities.includes("captions");
  const supportsLayout = manifest.capabilities.some((capability) => [
    ...CAMERA_LAYOUT_CAPABILITIES,
    ...VISUAL_OVERLAY_CAPABILITIES,
  ].includes(capability));
  const supportsBroll = manifest.capabilities.includes("broll_cover");
  const requestedBroll = styleCopy.copyBroll === true ? brollAvailable : styleCopy.copyBroll === false ? false : brief.copyBroll === true ? brollAvailable : brief.copyBroll === false ? false : brollAvailable;
  const copyBroll = supportsBroll && requestedBroll;
  const warnings = [];
  if (!compatible) warnings.push({ code: "incompatible-mode", message: `StylePack is not compatible with ${workflowMode}` });
  if (reference.capabilities?.needsBroll && !brollAvailable) warnings.push({ code: "broll-fallback", message: "Reference uses B-roll but this project has no B-roll assets; broll_cover will fall back to punch_in" });
  if (reference.capabilities?.needsSplitScreen && !supportAvailable) warnings.push({ code: "split-fallback", message: "Reference uses split screen but this project has no supporting footage; split will fall back to punch_in" });
  return {
    contract: "style-application.v1",
    stylePackId: manifest.id,
    styleVersion: manifest.version,
    workflowMode,
    compatible,
    manifest,
    reference,
    referenceShots: reference.shots || [],
    referenceDurationMs: reference.source?.durationMs || media?.durationMs || 1,
    transcript,
    media,
    assets,
    parameters: {
      copyRhythm: styleCopy.copyRhythm ?? brief.copyRhythm !== false,
      copyCaptions: supportsCaptions && (styleCopy.copyCaptions ?? brief.copyCaptions !== false),
      copyLayout: supportsLayout && (styleCopy.copyLayout ?? brief.copyLayout !== false),
      copyBroll,
      copyAudio: styleCopy.copyAudio ?? brief.copyAudio !== false,
    },
    captionPolicy: captionPolicy(reference, media),
    styleParameters: { ...manifest.parameters, ...(brief.styleParameters || {}) },
    warnings,
    unsupported: [...(manifest.unsupported || [])],
  };
}

function assertApplicationMode(application, mode) {
  if (application.workflowMode !== mode) throw new Error(`style application was built for ${application.workflowMode}, not ${mode}`);
  if (!application.compatible) throw new Error(`StylePack is not compatible with ${mode}`);
  // Keep this assertion tied to the same compatibility predicate as storage.
  assertStylePackCompatible({ manifest: application.manifest }, mode);
}

export function applyStyleToEditPlan({ plan, application, transcript = null } = {}) {
  if (!plan || !application) throw new Error("plan and application are required");
  assertApplicationMode(application, "single-video-v1");
  const durationMs = Math.max(1, ...((plan.segments || []).filter((segment) => segment.action !== "remove").map((segment) => Number(segment.endMs) || 0)));
  const hasSupportingAsset = hasSupporting(application.assets);
  const layoutEvents = layoutEventsFor(
    application.reference,
    durationMs,
    application.parameters.copyBroll,
    application.parameters.copyLayout,
    hasSupportingAsset,
    plan.brollEvents || [],
    application.manifest.capabilities || [],
  );
  const next = {
    ...plan,
    stylePackId: application.stylePackId,
    styleVersion: application.styleVersion,
    styleParameters: { ...application.styleParameters },
    ...(application.parameters.copyLayout ? { layoutEvents } : {}),
  };
  if (application.parameters.copyCaptions) next.captionStyle = application.captionPolicy.style;
  if (application.parameters.copyLayout) {
    next.visualEvents = visualEventsFor(
      application.reference,
      durationMs,
      application.transcript,
      plan.visualEvents || [],
      application.manifest.capabilities || [],
    );
  }
  if (transcript && !Array.isArray(transcript.segments)) throw new Error("transcript segments are invalid");
  return next;
}

export function applyStyleToMultiAssetPlan({ plan, application, assets = [] } = {}) {
  if (!plan || !application) throw new Error("plan and application are required");
  assertApplicationMode(application, "multi-asset-v1");
  const durationMs = Number(plan.durationMs) || 1;
  const hasSupportingAsset = hasSupporting(assets);
  const clips = (plan.clips || []).map((clip) => {
    const center = (Number(clip.timelineStartMs) + Number(clip.timelineEndMs)) / 2;
    const referenceTime = center / durationMs * (Number(application.referenceDurationMs) || durationMs);
    const referenceShot = (application.referenceShots || []).find((shot) => referenceTime >= shot.startMs && referenceTime < shot.endMs);
    let type = application.parameters.copyLayout ? referenceShot?.layout || "full" : clip.layout?.type || "full";
    if (type === "unknown") type = "full";
    if (type === "broll_cover" && !application.parameters.copyBroll) type = "punch_in";
    if (type === "split" && !hasSupportingAsset) type = "punch_in";
    return { ...clip, shotRole: type, layout: { type, params: {} } };
  });
  const next = {
    ...plan,
    stylePackId: application.stylePackId,
    styleVersion: application.styleVersion,
    styleParameters: { ...application.styleParameters },
    clips,
  };
  if (application.parameters.copyCaptions) next.captionStyle = application.captionPolicy.style;
  return next;
}

export function applyStyleToWorkflow({
  stylePack,
  referenceAnalysis = null,
  workflowMode,
  transcript = null,
  media = null,
  assets = [],
  brief = {},
  plan = null,
  multiAssetPlan = null,
} = {}) {
  const application = buildStyleApplication({
    stylePack,
    referenceAnalysis,
    workflowMode,
    transcript,
    media,
    assets,
    brief,
  });
  return {
    application,
    plan: workflowMode === "single-video-v1" && plan
      ? applyStyleToEditPlan({ plan, application, transcript })
      : plan,
    multiAssetPlan: workflowMode === "multi-asset-v1" && multiAssetPlan
      ? applyStyleToMultiAssetPlan({ plan: multiAssetPlan, application, assets })
      : multiAssetPlan,
  };
}
