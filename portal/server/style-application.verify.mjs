import assert from "node:assert/strict";
import { validateStyleManifest } from "./style-project.mjs";
import { normalizeReferenceAnalysis } from "./reference-analysis.mjs";
import { applyStyleToEditPlan, applyStyleToMultiAssetPlan, applyStyleToWorkflow, buildStyleApplication, regroupCaptionCues, styleAssetsForProject } from "./style-application.mjs";
import { validateEditPlan } from "./edit-plan.mjs";
import { validateMultiAssetPlan } from "./multi-asset-plan.mjs";
import { referenceStyleSpec } from "../test-fixtures/style-spec-v2.mjs";

const referenceAnalysis = normalizeReferenceAnalysis({
  contract: "reference-analysis.v1",
  source: {
    filename: "reference.mp4",
    durationMs: 42000,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    sha256: "a".repeat(64),
  },
  shots: [
    { id: "hook", startMs: 0, endMs: 3000, role: "hook", layout: "full", broll: false },
    { id: "context", startMs: 3000, endMs: 9000, role: "context", layout: "punch_in", broll: false },
    { id: "proof", startMs: 9000, endMs: 18000, role: "proof", layout: "broll_cover", broll: true },
    { id: "payoff", startMs: 18000, endMs: 42000, role: "payoff", layout: "full", broll: false },
  ],
  overlays: [
    { id: "reference-emphasis", type: "callout", startMs: 3000, endMs: 6000, position: "top_right", sizeRatio: 0.2, coverage: 0.1 },
    { id: "reference-identity", type: "identity", startMs: 5000, endMs: 6000, position: "middle_right", sizeRatio: 0.42, coverage: 0.12 },
  ],
  captions: { grouping: "phrase", maxWordsPerCue: 4, position: "bottom", fontSizeRatio: 0.05, primaryColor: "#ffffff", strokeColor: "#111111", strokeWidth: 2, keywordColor: "#c6f475", animation: "scale_pop" },
  audio: { bpm: 112, voice: "human", sfxDensity: "medium" },
  capabilities: { needsBroll: true, needsScreenshots: false, needsSplitScreen: false },
  unsupported: [],
  confidence: { overall: 0.8, rhythm: 0.9, captions: 0.8, layout: 0.7 },
});

const manifest = validateStyleManifest({
  contract: "style-manifest.v1",
  id: "style-reference-punch",
  name: "Reference punch",
  version: 1,
  status: "approved",
  sourceAnalysisId: referenceAnalysis.analysisId,
  supportedModes: ["single-video-v1", "multi-asset-v1"],
  parameters: { captionScale: 1, motionIntensity: 0.8, brollDensity: 0.5, colorAccent: "#c6f475" },
  capabilities: ["captions", "title_card", "emphasis", "punch_in", "broll_cover"],
  requirements: { minAssets: 2, needsMainFootage: true, needsBroll: false },
  unsupported: [],
  preview: null,
});
const stylePack = { contract: "style-pack.v1", id: manifest.id, version: 1, status: "approved", manifest };
const transcript = {
  durationMs: 75000,
  segments: [
    { id: "s1", startMs: 0, endMs: 2500, text: "用户自己的开场", words: [{ text: "用户自己的开场", startMs: 0, endMs: 2500 }] },
    { id: "s2", startMs: 5000, endMs: 11000, text: "用户自己的重点", words: [{ text: "用户自己的重点", startMs: 5000, endMs: 11000 }] },
  ],
};
const media = { durationMs: 75000, width: 1080, height: 1920 };
const singleAssets = [{ id: "main", role: "main", durationMs: 75000, hasVideo: true }];
const application = buildStyleApplication({
  stylePack,
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssets,
  brief: { styleCopy: { copyCaptions: true, copyLayout: true, copyBroll: true } },
});
assert.equal(application.contract, "style-application.v1");
assert.equal(application.stylePackId, manifest.id);
assert.equal(application.parameters.copyRhythm, true);
assert.equal(application.parameters.copyBroll, false);
assert.ok(application.warnings.some((item) => /broll|B-roll/i.test(item.message || item)));
assert.equal(application.captionPolicy.wordsPerCue, 4);

const licensedBroll = {
  id: "broll-1",
  filename: "licensed-broll.mp4",
  durationMs: 4000,
  licenseConfirmed: true,
};
const singleAssetsWithBroll = styleAssetsForProject({
  assets: singleAssets,
  brollAssets: [licensedBroll],
});
assert.deepEqual(singleAssetsWithBroll.at(-1), { ...licensedBroll, role: "broll" });
const withBrollApplication = buildStyleApplication({
  stylePack,
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssetsWithBroll,
  brief: { styleCopy: { copyCaptions: true, copyLayout: true, copyBroll: true } },
});
assert.equal(withBrollApplication.parameters.copyBroll, true);
assert.equal(withBrollApplication.warnings.some((item) => item.code === "broll-fallback"), false);
const withBrollPlan = applyStyleToEditPlan({
  plan: {
    ...validateEditPlan({
      summary: "user plan",
      segments: [{ id: "keep", startMs: 0, endMs: 75000, action: "keep", title: "用户内容", note: "" }],
      shorts: [],
      visualEvents: [{ id: "title", type: "title_card", startMs: 0, endMs: 1500, text: "用户自己的标题" }],
      brollEvents: [],
    }, 75000, { requireFiveShorts: false }),
  },
  application: withBrollApplication,
  transcript,
});
assert.equal(withBrollPlan.layoutEvents.some((event) => event.type === "broll_cover"), false);
assert.ok(withBrollPlan.layoutEvents.some((event) => event.type === "punch_in"));
const withActualBrollPlan = applyStyleToEditPlan({
  plan: validateEditPlan({
    summary: "user plan with actual B-roll",
    segments: [{ id: "keep", startMs: 0, endMs: 75000, action: "keep", title: "用户内容", note: "" }],
    shorts: [],
    visualEvents: [{ id: "title", type: "title_card", startMs: 0, endMs: 1500, text: "用户自己的标题" }],
    brollEvents: [{ id: "broll-event", assetId: licensedBroll.id, startMs: 16000, endMs: 20000, sourceStartMs: 0 }],
  }, 75000, { requireFiveShorts: false, brollAssets: [licensedBroll] }),
  application: withBrollApplication,
  transcript,
});
const actualBrollLayouts = withActualBrollPlan.layoutEvents.filter((event) => event.type === "broll_cover");
assert.equal(actualBrollLayouts.length, 1);
assert.ok(Math.abs(actualBrollLayouts[0].startMs - 16000) <= 100);
assert.equal(actualBrollLayouts[0].endMs, 20000);
const unlicensedBrollApplication = buildStyleApplication({
  stylePack,
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: styleAssetsForProject({ assets: singleAssets, brollAssets: [{ ...licensedBroll, licenseConfirmed: false }] }),
  brief: { styleCopy: { copyBroll: true } },
});
assert.equal(unlicensedBrollApplication.parameters.copyBroll, false);
assert.ok(unlicensedBrollApplication.warnings.some((item) => item.code === "broll-fallback"));

const singlePlan = validateEditPlan({
  summary: "user plan",
  segments: [{ id: "keep", startMs: 0, endMs: 75000, action: "keep", title: "用户内容", note: "" }],
  shorts: [],
  visualEvents: [{ id: "title", type: "title_card", startMs: 0, endMs: 1500, text: "用户自己的标题" }],
  brollEvents: [],
}, 75000, { requireFiveShorts: false });
const styledSingle = applyStyleToEditPlan({ plan: singlePlan, application, transcript });
assert.equal(styledSingle.stylePackId, manifest.id);
assert.equal(styledSingle.styleVersion, 1);
assert.ok(styledSingle.layoutEvents.length > 0);
assert.ok(styledSingle.layoutEvents.every((event) => event.endMs <= 75000 && event.endMs > event.startMs));
assert.ok(styledSingle.visualEvents.some((event) => event.type === "emphasis" && event.position === "middle_right"));

const v2StyleSpec = JSON.parse(JSON.stringify(referenceStyleSpec));
v2StyleSpec.identity.anchor = "middle_left";
v2StyleSpec.captions.maxCharsPerCue = 10;
const v2Reference = normalizeReferenceAnalysis({
  ...referenceAnalysis,
  contract: "reference-analysis.v2",
  styleSpec: v2StyleSpec,
});
const v2Application = buildStyleApplication({
  stylePack: {
    ...stylePack,
    manifest: validateStyleManifest({
      ...manifest,
      contract: "style-manifest.v2",
      capabilities: ["captions", "title_card", "emphasis"],
      styleSpec: v2StyleSpec,
    }),
  },
  referenceAnalysis: v2Reference,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssets,
  brief: { styleCopy: { copyCaptions: true, copyLayout: true } },
});
assert.equal(v2Application.captionPolicy.wordsPerCue, 10);
const styledV2 = applyStyleToEditPlan({ plan: singlePlan, application: v2Application, transcript });
assert.ok(styledV2.visualEvents.some((event) => event.type === "emphasis" && event.position === "middle_left"));
assert.ok(styledSingle.layoutEvents.every((event) => event.type !== "broll_cover"), "missing B-roll must degrade to punch-in/full");
assert.equal(styledSingle.visualEvents[0].text, "用户自己的标题");
const mappedEmphasis = styledSingle.visualEvents.find((event) => event.type === "emphasis" && event.text === "用户自己的重点");
assert.ok(mappedEmphasis);
assert.equal(mappedEmphasis.position, "top_right");
assert.equal(mappedEmphasis.sizeRatio, 0.2);

const reusePack = {
  ...stylePack,
  manifest: validateStyleManifest({
    ...manifest,
    contract: "style-manifest.v2",
    capabilities: ["captions", "title_card", "emphasis"],
    styleSpec: v2StyleSpec,
  }),
};
const reuseTranscript = {
  durationMs: 75000,
  segments: [
    { id: "reuse-1", startMs: 0, endMs: 4000, text: "第二条素材的真实口播" },
    { id: "reuse-2", startMs: 4000, endMs: 9000, text: "应该得到同一套视觉语法" },
  ],
};
const reuseMedia = { durationMs: 75000, width: 720, height: 1280 };
const attachedBeforePlan = applyStyleToWorkflow({
  stylePack: reusePack,
  referenceAnalysis: v2Reference,
  workflowMode: "single-video-v1",
  transcript: reuseTranscript,
  media: reuseMedia,
  assets: singleAssets,
  brief: { styleCopy: { copyCaptions: true, copyLayout: true } },
});
assert.equal(attachedBeforePlan.plan, null, "a StylePack can be attached before a project has a plan");
assert.equal(attachedBeforePlan.application.stylePackId, reusePack.id);
assert.equal(attachedBeforePlan.application.captionPolicy.wordsPerCue, 10);
const reusedPlan = applyStyleToWorkflow({
  stylePack: reusePack,
  referenceAnalysis: v2Reference,
  workflowMode: "single-video-v1",
  transcript: reuseTranscript,
  media: reuseMedia,
  assets: singleAssets,
  brief: { styleCopy: { copyCaptions: true, copyLayout: true } },
  plan: {
    ...singlePlan,
    summary: "第二条素材",
    visualEvents: [{ id: "reuse-title", type: "title_card", startMs: 0, endMs: 4000, text: "第二条素材的真实口播" }],
  },
});
assert.equal(reusedPlan.application.stylePackId, reusePack.id);
assert.ok(reusedPlan.plan.visualEvents.some((event) => event.text === "第二条素材的真实口播"));
assert.ok(reusedPlan.plan.visualEvents.some((event) => event.type === "emphasis" && event.text === "应该得到同一套视觉语法"));
assert.equal(JSON.stringify(reusedPlan.plan).includes("用户自己的开场"), false);
const overlayOnlyApplication = buildStyleApplication({
  stylePack: { ...stylePack, manifest: { ...manifest, capabilities: ["emphasis"] } },
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssets,
  brief: { styleCopy: { copyLayout: true } },
});
assert.equal(overlayOnlyApplication.parameters.copyLayout, true);
const overlayOnlyPlan = applyStyleToEditPlan({ plan: singlePlan, application: overlayOnlyApplication, transcript });
assert.ok(overlayOnlyPlan.visualEvents.some((event) => event.type === "emphasis" && event.text === "用户自己的重点"));
assert.ok(overlayOnlyPlan.layoutEvents.every((event) => event.type === "full"));
const punchOnlyApplication = buildStyleApplication({
  stylePack: { ...stylePack, manifest: { ...manifest, capabilities: ["punch_in"] } },
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssetsWithBroll,
  brief: { styleCopy: { copyLayout: true, copyBroll: true } },
});
const punchOnlyPlan = applyStyleToEditPlan({ plan: singlePlan, application: punchOnlyApplication, transcript });
assert.ok(punchOnlyPlan.layoutEvents.every((event) => ["full", "punch_in"].includes(event.type)));
assert.equal(styledSingle.captionStyle.fontSize, 64);
assert.equal(application.transcript.segments[0].text, "用户自己的开场");
assert.equal(JSON.stringify(styledSingle).includes("用户自己的开场"), false);
const validatedSingle = validateEditPlan(styledSingle, 75000, { requireFiveShorts: false });
assert.equal(validatedSingle.stylePackId, manifest.id);
assert.equal(validatedSingle.layoutEvents.length, styledSingle.layoutEvents.length);
const regroupedZh = regroupCaptionCues([{ id: "zh", startMs: 0, endMs: 1100, text: "用户自己的开场今天学习" }], 4);
assert.deepEqual(regroupedZh.map((cue) => cue.text), ["用户", "自己的开场", "今天学习"]);
assert.equal(regroupedZh[0].startMs, 0);
assert.equal(regroupedZh.at(-1).endMs, 1100);
const semanticNounZh = regroupCaptionCues([{ id: "noun", startMs: 0, endMs: 2000, text: "就能直接分割保單的現金價值" }], 10);
assert.deepEqual(semanticNounZh.map((cue) => cue.text), ["就能直接", "分割保單的現金價值"]);
const semanticPhraseZh = regroupCaptionCues([{ id: "phrase", startMs: 0, endMs: 2000, text: "最近找我咨询的朋友越来越多" }], 10);
assert.deepEqual(semanticPhraseZh.map((cue) => cue.text), ["最近找我咨询的朋友", "越来越多"]);
const regroupedEn = regroupCaptionCues([{ id: "en", startMs: 0, endMs: 1000, text: "one two three four five" }], 2);
assert.deepEqual(regroupedEn.map((cue) => cue.text), ["one two", "three four", "five"]);
assert.equal(regroupedEn.map((cue) => cue.text).join(" "), "one two three four five");

const assets = [
  { id: "a1", filename: "a1.mp4", durationMs: 6000, width: 1080, height: 1920, hasAudio: true, hasVideo: true, role: "main", label: "A1", licenseConfirmed: true, sha256: "1".repeat(64), transcriptRef: "assets/a1/transcript.json", visualEvidence: null, status: "ready", analysisStatus: "ready", transcript },
  { id: "a2", filename: "a2.mp4", durationMs: 6000, width: 1080, height: 1920, hasAudio: true, hasVideo: true, role: "supporting", label: "A2", licenseConfirmed: true, sha256: "2".repeat(64), transcriptRef: "assets/a2/transcript.json", visualEvidence: null, status: "ready", analysisStatus: "ready", transcript },
];
const project = { id: "multi-style", workflowMode: "multi-asset-v1", brief: { rawText: "用户方案", targetDurationMs: 12000 }, assets, multiAssetInputRevision: 0 };
const rawMulti = {
  summary: "multi plan",
  storyBeats: [],
  clips: [
    { id: "c1", sourceAssetId: "a1", sourceInMs: 0, sourceOutMs: 6000, timelineStartMs: 0, timelineEndMs: 6000, track: "video-main", purpose: "hook", reason: "user footage" },
    { id: "c2", sourceAssetId: "a2", sourceInMs: 0, sourceOutMs: 6000, timelineStartMs: 6000, timelineEndMs: 12000, track: "video-main", purpose: "proof", reason: "user footage" },
  ],
};
const multi = validateMultiAssetPlan(rawMulti, project);
const multiApplication = buildStyleApplication({
  stylePack,
  referenceAnalysis,
  workflowMode: "multi-asset-v1",
  transcript,
  media,
  assets,
  brief: project.brief,
});
const noCaptionApplication = buildStyleApplication({
  stylePack: { ...stylePack, manifest: { ...manifest, capabilities: ["punch_in"] } },
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssets,
  brief: {},
});
assert.equal(noCaptionApplication.parameters.copyCaptions, false);
assert.equal(noCaptionApplication.parameters.copyLayout, true);
const noSingleCapabilitiesApplication = buildStyleApplication({
  stylePack: { ...stylePack, manifest: { ...manifest, capabilities: [] } },
  referenceAnalysis,
  workflowMode: "single-video-v1",
  transcript,
  media,
  assets: singleAssets,
  brief: { styleCopy: { copyCaptions: true, copyLayout: true, copyBroll: true } },
});
const noCaptionSingle = applyStyleToEditPlan({
  plan: {
    ...singlePlan,
    captionStyle: { fontSize: 44, marginV: 30, outline: 2, color: "#ffffff" },
    layoutEvents: [{ id: "user-layout", type: "full", startMs: 0, endMs: 75000, params: {} }],
  },
  application: noSingleCapabilitiesApplication,
  transcript,
});
assert.deepEqual(noCaptionSingle.captionStyle, { fontSize: 44, marginV: 30, outline: 2, color: "#ffffff" });
assert.deepEqual(noCaptionSingle.layoutEvents, [{ id: "user-layout", type: "full", startMs: 0, endMs: 75000, params: {} }]);
const noCapabilitiesApplication = buildStyleApplication({
  stylePack: { ...stylePack, manifest: { ...manifest, capabilities: [] } },
  referenceAnalysis,
  workflowMode: "multi-asset-v1",
  transcript,
  media,
  assets,
  brief: { ...project.brief, styleCopy: { copyLayout: true } },
});
assert.equal(noCapabilitiesApplication.parameters.copyLayout, false);
const noCapabilitiesMulti = applyStyleToMultiAssetPlan({ plan: multi, application: noCapabilitiesApplication, assets });
assert.ok(noCapabilitiesMulti.clips.every((clip) => ["full", "punch_in", "split", "broll_cover"].includes(clip.layout?.type)));
assert.ok(noCapabilitiesMulti.clips.every((clip) => clip.layout.type === (multi.clips.find((item) => item.id === clip.id)?.layout?.type || "full")));
const noCapabilitiesMultiWithCaption = applyStyleToMultiAssetPlan({
  plan: { ...multi, captionStyle: { fontSize: 44, marginV: 30, outline: 2, color: "#ffffff" } },
  application: noCapabilitiesApplication,
  assets,
});
assert.deepEqual(noCapabilitiesMultiWithCaption.captionStyle, { fontSize: 44, marginV: 30, outline: 2, color: "#ffffff" });
const styledMulti = applyStyleToMultiAssetPlan({ plan: multi, application: multiApplication, assets });
assert.equal(styledMulti.stylePackId, manifest.id);
assert.ok(styledMulti.clips.every((clip) => ["full", "punch_in", "split", "broll_cover"].includes(clip.layout?.type)));
assert.ok(styledMulti.clips.every((clip) => clip.shotRole === clip.layout.type));
assert.equal(styledMulti.clips.reduce((sum, clip) => sum + clip.timelineEndMs - clip.timelineStartMs, 0), 12000);
assert.equal(styledMulti.captionStyle.fontSize, 64);
assert.doesNotThrow(() => validateMultiAssetPlan(styledMulti, project));
assert.equal(validateMultiAssetPlan(styledMulti, project).captionStyle.fontSize, 64);

const singleOnly = buildStyleApplication({
  stylePack: { ...stylePack, manifest: { ...manifest, supportedModes: ["single-video-v1"] } },
  referenceAnalysis,
  workflowMode: "multi-asset-v1",
  transcript,
  media,
  assets,
  brief: project.brief,
});
assert.throws(() => applyStyleToMultiAssetPlan({ plan: multi, application: singleOnly, assets }), /supportedModes|multi-asset|compatible/i);

console.log("style-application.verify: scaled rhythm, caption policy, B-roll fallback, and both workflow contracts passed");
