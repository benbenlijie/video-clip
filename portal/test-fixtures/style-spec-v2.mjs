export const referenceStyleSpec = {
  contract: "style-spec.v2",
  canvas: {
    aspectRatio: "9:16",
    safeArea: { topRatio: 0.06, rightRatio: 0.07, bottomRatio: 0.12, leftRatio: 0.07 },
  },
  title: {
    anchor: "top_center",
    widthRatio: 1,
    maxLines: 2,
    panel: { enabled: true, color: "#f2efe4", opacity: 0.82, radiusRatio: 0, paddingXRatio: 0.04, paddingYRatio: 0.015, blurPx: 0 },
    primary: { fontFamily: "sans", fontWeight: 900, fontSizeRatio: 0.064, lineHeight: 1.14, letterSpacingRatio: 0.004, color: "#e3cc6b", strokeColor: "#29271f", strokeWidthRatio: 0.004, shadowOpacity: 0.45, shadowBlurRatio: 0.012, shadowOffsetYRatio: 0.003 },
    secondary: { fontFamily: "sans", fontWeight: 800, fontSizeRatio: 0.055, lineHeight: 1.14, letterSpacingRatio: 0.002, color: "#ffffff", strokeColor: "#29271f", strokeWidthRatio: 0.004, shadowOpacity: 0.45, shadowBlurRatio: 0.012, shadowOffsetYRatio: 0.003 },
    motion: {
      enter: { type: "fade", durationMs: 180, delayMs: 0, easing: "ease-out", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
      exit: { type: "none", durationMs: 0, delayMs: 0, easing: "linear", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
    },
  },
  identity: {
    anchor: "middle_right",
    maxWidthRatio: 0.42,
    panel: { enabled: false, color: "#000000", opacity: 0, radiusRatio: 0, paddingXRatio: 0, paddingYRatio: 0, blurPx: 0 },
    primary: { fontFamily: "sans", fontWeight: 900, fontSizeRatio: 0.035, lineHeight: 1.2, letterSpacingRatio: 0, color: "#ffe45c", strokeColor: "#000000", strokeWidthRatio: 0.004, shadowOpacity: 0.6, shadowBlurRatio: 0.01, shadowOffsetYRatio: 0.002 },
    secondary: { fontFamily: "sans", fontWeight: 700, fontSizeRatio: 0.026, lineHeight: 1.25, letterSpacingRatio: 0, color: "#ffffff", strokeColor: "#000000", strokeWidthRatio: 0.003, shadowOpacity: 0.5, shadowBlurRatio: 0.008, shadowOffsetYRatio: 0.002 },
    motion: {
      enter: { type: "fade", durationMs: 140, delayMs: 0, easing: "ease-out", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
      exit: { type: "none", durationMs: 0, delayMs: 0, easing: "linear", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
    },
  },
  captions: {
    grouping: "phrase",
    maxCharsPerCue: 10,
    anchor: "bottom_center",
    maxWidthRatio: 0.86,
    panel: { enabled: true, color: "#f3f0e7", opacity: 0.72, radiusRatio: 0.04, paddingXRatio: 0.03, paddingYRatio: 0.01, blurPx: 0 },
    typography: { fontFamily: "sans", fontWeight: 800, fontSizeRatio: 0.06, lineHeight: 1.08, letterSpacingRatio: 0, color: "#ffffff", strokeColor: "#000000", strokeWidthRatio: 0.0045, shadowOpacity: 0.5, shadowBlurRatio: 0.008, shadowOffsetYRatio: 0 },
    highlight: { strategy: "keyword", color: "#ffe45c", strokeColor: "#000000", scalePeak: 1.08, durationMs: 140 },
    motion: {
      enter: { type: "fade-scale", durationMs: 160, delayMs: 0, easing: "ease-out", scaleFrom: 0.92, translateYRatio: 0.008, stagger: "none", staggerMs: 0 },
      exit: { type: "fade", durationMs: 80, delayMs: 0, easing: "ease-in", scaleFrom: 1, translateYRatio: 0, stagger: "none", staggerMs: 0 },
    },
  },
  effects: [
    { id: "caption-pop", target: "captions", trigger: "cue_enter", type: "scale", durationMs: 160, delayMs: 0, easing: "ease-out", intensity: 0.12 },
  ],
};
