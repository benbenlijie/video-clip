import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const root = new URL("../test-fixtures/style/golden/", import.meta.url);
const labels = JSON.parse(await fs.readFile(new URL("labels.example.json", root), "utf8"));
assert.equal(labels.contract, "style-golden-labels.v1");
assert.equal(labels.datasetStatus, "template-not-reviewed");
assert.equal(labels.pairs.length, 10);
assert.equal(labels.pairs.filter((pair) => pair.mode === "single-video-v1").length, 5);
assert.equal(labels.pairs.filter((pair) => pair.mode === "multi-asset-v1").length, 5);
assert.ok(labels.pairs.filter((pair) => pair.aspectRatio === "9:16").length >= 4);
assert.ok(labels.pairs.filter((pair) => pair.aspectRatio === "16:9").length >= 4);
assert.deepEqual(new Set(labels.pairs.map((pair) => pair.reference.hasCaptions)), new Set([true, false]));
assert.deepEqual(new Set(labels.pairs.map((pair) => pair.reference.hasBroll)), new Set([true, false]));
assert.equal(new Set(labels.pairs.map((pair) => pair.id)).size, 10);
for (const pair of labels.pairs) {
  assert.equal(pair.reference.path, null);
  assert.equal(pair.user.path, null);
  assert.equal(pair.styleQc.passed, null);
  assert.equal(pair.humanReview.styleSimilarity, null);
  assert.equal(pair.consent.referenceClearedForEvaluation, false);
  assert.equal(pair.consent.userMediaClearedForEvaluation, false);
}
const files = await fs.readdir(new URL(root));
assert.deepEqual(files.sort(), ["README.md", "labels.example.json"]);
assert.equal(await fs.access(join(new URL(root).pathname, "labels.local.json")).then(() => true, () => false), false, "private completed labels must not be committed");

console.log("style-golden.verify: 10-pair matrix, privacy template, score placeholders, and thresholds passed");
