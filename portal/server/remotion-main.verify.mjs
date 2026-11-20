import assert from "node:assert/strict";

const module = await import("./remotion-main.mjs").catch(() => ({}));
assert.equal(typeof module.validateEditMap, "function", "the main compositor must validate the actual edit map");
const { validateEditMap, mapRemotionEvents } = module;
const plan = { segments: [{ startMs: 0, endMs: 1000, action: "keep" }, { startMs: 1000, endMs: 3000, action: "remove" }, { startMs: 3000, endMs: 4000, action: "keep" }] };
const map = { pieces: [{ src: [0, 1000], out: [0, 1000] }, { src: [3000, 4000], out: [1000, 2000] }] };
const options = { map, plan, sourceDurationMs: 4000, durationMs: 2000, fps: 30 };
const pieces = validateEditMap(options);
assert.deepEqual(pieces, map.pieces);
assert.deepEqual(mapRemotionEvents([{ id: "late", type: "emphasis", startMs: 3200, endMs: 3800, text: "正确时间" }], pieces).map(({ startMs, endMs }) => [startMs, endMs]), [[1200, 1800]]);
assert.deepEqual(mapRemotionEvents([{ id: "cut", type: "emphasis", startMs: 1200, endMs: 2500, text: "已删除" }], pieces), []);
assert.deepEqual(mapRemotionEvents([{ id: "span", type: "title_card", startMs: 500, endMs: 3500, text: "分段" }], pieces).map(({ startMs, endMs }) => [startMs, endMs]), [[500, 1500]], "one persistent event must stay continuous across editorial pieces");
assert.deepEqual(mapRemotionEvents([
  { id: "first", type: "title_card", startMs: 500, endMs: 1000, text: "第一段" },
  { id: "second", type: "title_card", startMs: 3000, endMs: 3500, text: "第二段" },
], pieces).map(({ startMs, endMs }) => [startMs, endMs]), [[500, 1000], [1000, 1500]], "different events must not merge even when their output times touch");
assert.deepEqual(mapRemotionEvents([
  { id: "repeat", type: "emphasis", startMs: 100, endMs: 300, text: "重复" },
  { id: "repeat", type: "emphasis", startMs: 3100, endMs: 3300, text: "重复" },
], pieces).map(({ startMs, endMs }) => [startMs, endMs]), [[100, 300], [1100, 1300]], "non-adjacent occurrences must remain separate");
assert.throws(() => mapRemotionEvents([{ id: "unknown", type: "magic", startMs: 0, endMs: 500, text: "未知" }], pieces), /不支持.*magic/);
assert.throws(() => validateEditMap({ ...options, durationMs: 2100 }), /时长/);
assert.throws(() => validateEditMap({ ...options, map: { pieces: [...map.pieces].reverse() } }), /映射/);
assert.throws(() => validateEditMap({ ...options, map: { pieces: [{ src: [0, 1000], out: [0, 1000] }, { src: [500, 1500], out: [1000, 2000] }] } }), /映射/);
assert.throws(() => validateEditMap({ ...options, map: { pieces: [{ src: [0, 4000], out: [0, 2000] }] } }), /映射/);
assert.throws(() => validateEditMap({ ...options, map: { pieces: [{ src: [0, 2000], out: [0, 2000] }] } }), /计划|映射/);
assert.throws(() => validateEditMap({ ...options, map: { pieces: [] } }), /映射/);
const roundedPlan = { segments: [{ startMs: 110, endMs: 970, action: "keep" }] };
assert.deepEqual(validateEditMap({ map: { pieces: [{ src: [100, 966.667], out: [0, 866.667] }] }, plan: roundedPlan, sourceDurationMs: 1000, durationMs: 867, fps: 30 }), [{ src: [100, 966.667], out: [0, 866.667] }]);
const integerMsPlan = { segments: [{ startMs: 0, endMs: 18033, action: "keep" }, { startMs: 18033, endMs: 24900, action: "keep" }] };
const integerMsMap = { pieces: [{ src: [0, 18033], out: [0, 18033] }, { src: [18033, 24900], out: [18033, 24900] }] };
assert.deepEqual(validateEditMap({ map: integerMsMap, plan: integerMsPlan, sourceDurationMs: 24900, durationMs: 24900, fps: 30 }), integerMsMap.pieces, "integer milliseconds render safely within the one-millisecond frame tolerance");
console.log("remotion-main.verify: frame-aligned edit map, deleted footage and output event timing passed");
