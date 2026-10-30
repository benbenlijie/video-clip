import assert from "node:assert/strict";
import { validateEditPlan } from "./edit-plan.mjs";

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

assert.throws(() => validateEditPlan({ ...base, visualEvents: [...validVisualEvents.slice(0, 2), { type: "magic", startMs: 6000, endMs: 7000, text: "不支持" }] }, 10000, { requireVisualEvents: true }), /视觉事件类型无效/);
assert.throws(() => validateEditPlan({ ...base, visualEvents: [...validVisualEvents.slice(0, 2), { type: "cta", startMs: 9000, endMs: 11000, text: "越界" }] }, 10000, { requireVisualEvents: true }), /视觉事件时间超出素材范围/);
assert.throws(() => validateEditPlan({ ...base, segments: [{ startMs: 0, endMs: 10000, action: "remove", title: "删掉全部" }], visualEvents: validVisualEvents }, 10000, { requireVisualEvents: true }), /视觉事件时间未落在保留片段/);
assert.throws(() => validateEditPlan(base, 10000, { requireVisualEvents: true }), /剪辑计划必须包含可执行视觉事件/);
assert.deepEqual(validateEditPlan(base, 10000).visualEvents, [], "legacy plans remain readable and are identified as having no visual events");

console.log("edit-plan.verify: visual-event contract passed");
