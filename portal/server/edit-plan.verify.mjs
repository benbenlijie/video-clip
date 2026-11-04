import assert from "node:assert/strict";
import { normalizeEditPlan, validateEditPlan } from "./edit-plan.mjs";

const base = {
  summary: "论文 Hook 后解释核心观点，再收尾引导互动。",
  segments: [{ startMs: 0, endMs: 10000, action: "keep", title: "完整表达", note: "保留语义" }],
  shorts: Array.from({ length: 5 }, (_, index) => ({ startMs: index * 1000, endMs: (index + 1) * 1000 + 1000, title: `Short ${index + 1}` })),
};
const validVisualEvents = [
  { id: "hook", type: "title_card", startMs: 0, endMs: 1500, text: "Hook" },
  { id: "point", type: "emphasis", startMs: 3500, endMs: 5000, text: "Key point" },
  { id: "cta", type: "cta", startMs: 8000, endMs: 10000, text: "CTA" },
];

const plan = validateEditPlan({
  ...base,
  visualEvents: [
    { id: "hook", type: "title_card", startMs: 0, endMs: 1800, text: "The Bitter Lesson", subtext: "为什么它改变了机器人" },
    { id: "key-point", type: "emphasis", startMs: 3800, endMs: 5200, text: "数据规模胜过手工规则" },
    { id: "cta", type: "cta", startMs: 8200, endMs: 10000, text: "你怎么看？", subtext: "评论区聊聊" },
  ],
}, 10000, { requireVisualEvents: true });
assert.equal(plan.visualEvents.length, 3);
assert.equal(plan.visualEvents[0].type, "title_card");
assert.equal(plan.visualEvents[2].subtext, "评论区聊聊");
const captionStyled = validateEditPlan({ ...base, captionStyle: { fontSize: 28, marginV: 18, outline: 2, color: "#c6f475" } }, 10000);
assert.deepEqual(captionStyled.captionStyle, { fontSize: 28, marginV: 18, outline: 2, color: "#c6f475" }, "subtitle presentation requests must survive plan validation");
assert.throws(() => validateEditPlan({ ...base, captionStyle: { fontSize: 9999 } }, 10000), /字幕样式/);
assert.throws(() => validateEditPlan({ ...base, captionStyle: { color: "white,FontSize=100" } }, 10000), /字幕样式/);

const withCaptionCoverage = validateEditPlan({
  ...base,
  visualEvents: [{ id: "point", type: "emphasis", startMs: 3500, endMs: 5000, text: "Key point" }],
  captionCoverage: [{ eventId: "point", startMs: 3800, endMs: 4200, text: "spoken words" }],
}, 10000, { requireFiveShorts: false });
assert.deepEqual(withCaptionCoverage.captionCoverage, [{ eventId: "point", startMs: 3800, endMs: 4200, text: "spoken words" }]);
assert.throws(() => validateEditPlan({ ...base, visualEvents: validVisualEvents, captionCoverage: [{ eventId: "missing", startMs: 3800, endMs: 4200, text: "hidden words" }] }, 10000, { requireVisualEvents: true }), /字幕视觉覆盖区间无效/);

const customBroll = validateEditPlan({ ...base, shorts: [], visualEvents: [{ id: "title", type: "emphasis-caption", startMs: 2000, endMs: 3000, text: "B-roll" }], brollEvents: [{ id: "broll-1", assetId: "asset-1", startMs: 2000, endMs: 3000, sourceStartMs: 0 }] }, 10000, { allowCustomVisualEvents: true, requireFiveShorts: false, brollAssets: [{ id: "asset-1", filename: "cutaway.mp4", durationMs: 2000, licenseConfirmed: true }] });
assert.equal(customBroll.brollEvents.length, 1, "custom Claude Code plans must preserve downloaded B-roll events");

const brollAssets = [{ id: "cutaway-1", filename: "screen-demo.mp4", durationMs: 4000 }];
const withBroll = validateEditPlan({ ...base, visualEvents: validVisualEvents, brollEvents: [{ id: "cutaway", assetId: "cutaway-1", startMs: 4000, endMs: 6000, sourceStartMs: 1000 }] }, 10000, { requireVisualEvents: true, brollAssets });
assert.deepEqual(withBroll.brollEvents[0], { id: "cutaway", assetId: "cutaway-1", startMs: 4000, endMs: 6000, sourceStartMs: 1000 });
assert.throws(() => validateEditPlan({ ...base, visualEvents: validVisualEvents, brollEvents: [{ assetId: "missing", startMs: 4000, endMs: 6000, sourceStartMs: 0 }] }, 10000, { requireVisualEvents: true, brollAssets }), /B-roll 素材不存在/);
assert.throws(() => validateEditPlan({ ...base, visualEvents: validVisualEvents, brollEvents: [{ assetId: "cutaway-1", startMs: 4000, endMs: 7000, sourceStartMs: 2000 }] }, 10000, { requireVisualEvents: true, brollAssets }), /B-roll 裁切超出素材时长/);
const retainedOnlyEvents = [{ id: "hook", type: "title_card", startMs: 0, endMs: 1000, text: "Hook" }, { id: "point", type: "emphasis", startMs: 1500, endMs: 2500, text: "Point" }, { id: "cta", type: "cta", startMs: 8000, endMs: 9000, text: "CTA" }];
assert.throws(() => validateEditPlan({ ...base, segments: [{ startMs: 0, endMs: 3500, action: "keep" }, { startMs: 3500, endMs: 7000, action: "remove" }, { startMs: 7000, endMs: 10000, action: "keep" }], visualEvents: retainedOnlyEvents, brollEvents: [{ assetId: "cutaway-1", startMs: 4000, endMs: 6000, sourceStartMs: 0 }] }, 10000, { requireVisualEvents: true, brollAssets }), /B-roll 时间未落在保留片段/);

assert.throws(() => validateEditPlan({ ...base, visualEvents: [...validVisualEvents.slice(0, 2), { type: "magic", startMs: 6000, endMs: 7000, text: "不支持" }] }, 10000, { requireVisualEvents: true }), /视觉事件类型无效/);
assert.throws(() => validateEditPlan({ ...base, visualEvents: [...validVisualEvents.slice(0, 2), { type: "cta", startMs: 9000, endMs: 11000, text: "越界" }] }, 10000, { requireVisualEvents: true }), /视觉事件时间超出素材范围/);
assert.throws(() => validateEditPlan({ ...base, segments: [{ startMs: 0, endMs: 10000, action: "remove", title: "删掉全部" }], visualEvents: validVisualEvents }, 10000, { requireVisualEvents: true }), /视觉事件时间未落在保留片段/);
assert.throws(() => validateEditPlan(base, 10000, { requireVisualEvents: true }), /剪辑计划必须包含可执行视觉事件/);
assert.deepEqual(validateEditPlan(base, 10000).visualEvents, [], "legacy plans remain readable and are identified as having no visual events");

const legacy = normalizeEditPlan({
  keep: [{ startMs: 100, endMs: 1100 }, { startMs: 2000, endMs: 3000 }],
  titleCard: { startMs: 500, endMs: 1500, text: "主题" },
  captions: [{ startMs: 0, endMs: 500, text: "开场" }],
  shorts: [],
}, 3000);
assert.equal(legacy.segments.length, 2);
assert.equal(legacy.visualEvents[0].type, "title_card");
assert.deepEqual(validateEditPlan(legacy, 3000, { requireFiveShorts: false, allowCustomVisualEvents: true }).shorts, []);
assert.equal(validateEditPlan({ keep: [{ startMs: 0, endMs: 1000 }], titleCard: { startMs: 0, endMs: 500, text: "主题" }, shorts: [] }, 1000, { requireFiveShorts: false, allowCustomVisualEvents: true }).segments.length, 1);

console.log("edit-plan.verify: visual-event contract passed");
