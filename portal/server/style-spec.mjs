const V2_CONTRACT = "style-spec.v2";
const V3_CONTRACT = "style-spec.v3";
const CONTRACTS = new Set([V2_CONTRACT, V3_CONTRACT]);
const ANCHORS = new Set([
  "top_left", "top_center", "top_right",
  "middle_left", "middle_center", "middle_right",
  "bottom_left", "bottom_center", "bottom_right",
]);
const FONT_FAMILIES = new Set(["sans", "serif", "display", "rounded"]);
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9 ,'"_\-]{1,120}$/;
const FONT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;
const ANIMATION_TYPES = new Set(["none", "fade", "scale", "fade-scale", "slide-up", "wipe"]);
const EASINGS = new Set(["linear", "ease-in", "ease-out", "ease-in-out", "spring"]);
const STAGGERS = new Set(["none", "word", "char"]);
const HIGHLIGHT_STRATEGIES = new Set(["none", "keyword"]);
const EFFECT_TARGETS = new Set(["title", "identity", "captions", "overlay"]);
const EFFECT_TRIGGERS = new Set(["enter", "cue_enter", "keyword", "exit"]);
const EFFECT_TYPES = new Set(["fade", "scale", "slide", "highlight", "color"]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function keys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unsupported ${name} field: ${key}`);
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, selected));
}

function color(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;
}

function choice(value, allowed, fallback, name) {
  const selected = String(value || "");
  if (allowed.has(selected)) return selected;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is invalid`);
}

function normalizePanel(raw = {}) {
  const value = object(raw, "StyleSpec panel");
  keys(value, new Set(["enabled", "color", "opacity", "radiusRatio", "paddingXRatio", "paddingYRatio", "blurPx"]), "StyleSpec panel");
  return {
    enabled: Boolean(value.enabled),
    color: color(value.color, "#000000"),
    opacity: number(value.opacity, 0, 0, 1),
    radiusRatio: number(value.radiusRatio, 0, 0, 0.5),
    paddingXRatio: number(value.paddingXRatio, 0, 0, 0.25),
    paddingYRatio: number(value.paddingYRatio, 0, 0, 0.25),
    blurPx: number(value.blurPx, 0, 0, 40),
  };
}

function normalizeTypography(raw = {}, contract = V2_CONTRACT) {
  const value = object(raw, "StyleSpec typography");
  const v3 = contract === V3_CONTRACT;
  keys(value, new Set([
    "fontFamily", "fontWeight", "fontSizeRatio", "lineHeight", "letterSpacingRatio",
    "color", "strokeColor", "strokeWidthRatio", "shadowOpacity", "shadowBlurRatio", "shadowOffsetYRatio",
    ...(v3 ? ["fontId", "fontWidthScale"] : []),
  ]), "StyleSpec typography");
  const fontFamily = v3
    ? (FONT_FAMILY_PATTERN.test(String(value.fontFamily || "")) ? String(value.fontFamily) : "sans")
    : choice(value.fontFamily, FONT_FAMILIES, "sans", "fontFamily");
  return {
    fontFamily,
    ...(v3 ? {
      fontId: FONT_ID_PATTERN.test(String(value.fontId || "")) ? String(value.fontId) : "system-sans",
      fontWidthScale: number(value.fontWidthScale, 1, 0.7, 1.3),
    } : {}),
    fontWeight: Math.round(number(value.fontWeight, 700, 300, 900)),
    fontSizeRatio: number(value.fontSizeRatio, 0.05, 0.01, 0.2),
    lineHeight: number(value.lineHeight, 1.15, 0.8, 2),
    letterSpacingRatio: number(value.letterSpacingRatio, 0, -0.02, 0.1),
    color: color(value.color, "#ffffff"),
    strokeColor: color(value.strokeColor, "#000000"),
    strokeWidthRatio: number(value.strokeWidthRatio, 0.003, 0, 0.02),
    shadowOpacity: number(value.shadowOpacity, 0.4, 0, 1),
    shadowBlurRatio: number(value.shadowBlurRatio, 0.008, 0, 0.05),
    shadowOffsetYRatio: number(value.shadowOffsetYRatio, 0.002, -0.05, 0.05),
  };
}

function normalizeAnimation(raw = {}, name) {
  const value = object(raw, name);
  keys(value, new Set(["type", "durationMs", "delayMs", "easing", "scaleFrom", "translateYRatio", "stagger", "staggerMs"]), name);
  return {
    type: choice(value.type, ANIMATION_TYPES, "none", `${name}.type`),
    durationMs: Math.round(number(value.durationMs, 0, 0, 1200)),
    delayMs: Math.round(number(value.delayMs, 0, 0, 1200)),
    easing: choice(value.easing, EASINGS, "ease-out", `${name}.easing`),
    scaleFrom: number(value.scaleFrom, 1, 0.5, 1.5),
    translateYRatio: number(value.translateYRatio, 0, -0.2, 0.2),
    stagger: choice(value.stagger, STAGGERS, "none", `${name}.stagger`),
    staggerMs: Math.round(number(value.staggerMs, 0, 0, 300)),
  };
}

function normalizeMotion(raw = {}, name) {
  const value = object(raw, name);
  keys(value, new Set(["enter", "exit"]), name);
  return {
    enter: normalizeAnimation(value.enter, `${name}.enter`),
    exit: normalizeAnimation(value.exit, `${name}.exit`),
  };
}

function normalizeHighlight(raw = {}) {
  const value = object(raw, "StyleSpec captions.highlight");
  keys(value, new Set(["strategy", "color", "strokeColor", "scalePeak", "durationMs"]), "StyleSpec captions.highlight");
  return {
    strategy: choice(value.strategy, HIGHLIGHT_STRATEGIES, "none", "highlight.strategy"),
    color: color(value.color, "#ffe45c"),
    strokeColor: color(value.strokeColor, "#000000"),
    scalePeak: number(value.scalePeak, 1, 1, 1.3),
    durationMs: Math.round(number(value.durationMs, 120, 0, 500)),
  };
}

function normalizeTitle(raw = {}, contract = V2_CONTRACT) {
  const value = object(raw, "StyleSpec title");
  keys(value, new Set(["anchor", "widthRatio", "maxLines", "panel", "primary", "secondary", "motion"]), "StyleSpec title");
  return {
    anchor: choice(value.anchor, new Set(["top_left", "top_center", "top_right"]), "top_center", "title.anchor"),
    widthRatio: number(value.widthRatio, 1, 0.2, 1),
    maxLines: Math.round(number(value.maxLines, 2, 1, 3)),
    panel: normalizePanel(value.panel),
    primary: normalizeTypography(value.primary, contract),
    secondary: normalizeTypography(value.secondary, contract),
    motion: normalizeMotion(value.motion, "StyleSpec title.motion"),
  };
}

function normalizeIdentity(raw = {}, contract = V2_CONTRACT) {
  const value = object(raw, "StyleSpec identity");
  const v3 = contract === V3_CONTRACT;
  keys(value, new Set(["anchor", "maxWidthRatio", "panel", "primary", "secondary", "motion", ...(v3 ? ["offsetYRatio", "maxLines"] : [])]), "StyleSpec identity");
  return {
    anchor: choice(value.anchor, ANCHORS, "middle_right", "identity.anchor"),
    maxWidthRatio: number(value.maxWidthRatio, 0.42, 0.2, 0.8),
    ...(v3 ? {
      offsetYRatio: number(value.offsetYRatio, 0, -0.3, 0.3),
      maxLines: Math.round(number(value.maxLines, 4, 1, 6)),
    } : {}),
    panel: normalizePanel(value.panel),
    primary: normalizeTypography(value.primary, contract),
    secondary: normalizeTypography(value.secondary, contract),
    motion: normalizeMotion(value.motion, "StyleSpec identity.motion"),
  };
}

function normalizeCaptions(raw = {}, contract = V2_CONTRACT) {
  const value = object(raw, "StyleSpec captions");
  keys(value, new Set(["grouping", "maxCharsPerCue", "anchor", "maxWidthRatio", "panel", "typography", "highlight", "motion"]), "StyleSpec captions");
  return {
    grouping: choice(value.grouping, new Set(["word", "phrase", "sentence"]), "phrase", "captions.grouping"),
    maxCharsPerCue: Math.round(number(value.maxCharsPerCue, 10, 1, 24)),
    anchor: choice(value.anchor, new Set(["top_center", "middle_center", "bottom_center"]), "bottom_center", "captions.anchor"),
    maxWidthRatio: number(value.maxWidthRatio, 0.86, 0.3, 1),
    panel: normalizePanel(value.panel),
    typography: normalizeTypography(value.typography, contract),
    highlight: normalizeHighlight(value.highlight),
    motion: normalizeMotion(value.motion, "StyleSpec captions.motion"),
  };
}

function normalizeEffects(raw = []) {
  if (!Array.isArray(raw) || raw.length > 50) throw new Error("StyleSpec effects is invalid");
  return raw.map((item, index) => {
    const value = object(item, `StyleSpec effect ${index + 1}`);
    keys(value, new Set(["id", "target", "trigger", "type", "durationMs", "delayMs", "easing", "intensity"]), "StyleSpec effect");
    return {
      id: String(value.id || `effect-${String(index + 1).padStart(2, "0")}`),
      target: choice(value.target, EFFECT_TARGETS, undefined, "effect.target"),
      trigger: choice(value.trigger, EFFECT_TRIGGERS, undefined, "effect.trigger"),
      type: choice(value.type, EFFECT_TYPES, undefined, "effect.type"),
      durationMs: Math.round(number(value.durationMs, 160, 0, 1200)),
      delayMs: Math.round(number(value.delayMs, 0, 0, 1200)),
      easing: choice(value.easing, EASINGS, "ease-out", "effect.easing"),
      intensity: number(value.intensity, 0.1, 0, 1),
    };
  });
}

export function normalizeStyleSpec(raw, { aspectRatio = null } = {}) {
  const value = object(raw, "StyleSpec");
  keys(value, new Set(["contract", "canvas", "title", "identity", "captions", "effects"]), "StyleSpec");
  if (!CONTRACTS.has(value.contract)) throw new Error(`StyleSpec contract must be ${[...CONTRACTS].join(" or ")}`);
  const contract = value.contract;
  const canvas = object(value.canvas, "StyleSpec canvas");
  keys(canvas, new Set(["aspectRatio", "safeArea"]), "StyleSpec canvas");
  const safeArea = object(canvas.safeArea, "StyleSpec canvas.safeArea");
  keys(safeArea, new Set(["topRatio", "rightRatio", "bottomRatio", "leftRatio"]), "StyleSpec canvas.safeArea");
  const resolvedAspectRatio = choice(canvas.aspectRatio, new Set(["9:16", "16:9"]), "9:16", "canvas.aspectRatio");
  if (aspectRatio && resolvedAspectRatio !== aspectRatio) {
    throw new Error(`StyleSpec aspectRatio ${resolvedAspectRatio} does not match source ${aspectRatio}`);
  }
  return {
    contract,
    canvas: {
      aspectRatio: resolvedAspectRatio,
      safeArea: {
        topRatio: number(safeArea.topRatio, 0.06, 0, 0.3),
        rightRatio: number(safeArea.rightRatio, 0.06, 0, 0.3),
        bottomRatio: number(safeArea.bottomRatio, 0.1, 0, 0.3),
        leftRatio: number(safeArea.leftRatio, 0.06, 0, 0.3),
      },
    },
    title: normalizeTitle(value.title, contract),
    identity: normalizeIdentity(value.identity, contract),
    captions: normalizeCaptions(value.captions, contract),
    effects: normalizeEffects(value.effects || []),
  };
}

