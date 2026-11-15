import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const fixturePath = new URL("test-fixtures/style/synthetic-reference.json", root);
const packagePath = new URL("package.json", root);

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

assert.equal(fixture.contract, "style-fixtures.v1");
assert.ok(Array.isArray(fixture.references) && fixture.references.length >= 6);
assert.ok(Array.isArray(fixture.userMedia) && fixture.userMedia.length >= 4);

const references = fixture.references;
for (const aspectRatio of ["9:16", "16:9"]) {
  assert.ok(references.some((item) => item.aspectRatio === aspectRatio), `missing ${aspectRatio} reference`);
}
assert.ok(references.some((item) => item.hasCaptions && item.hasBroll));
assert.ok(references.some((item) => item.hasCaptions && !item.hasBroll));
assert.ok(references.some((item) => !item.hasCaptions && item.hasBroll));
assert.ok(references.some((item) => !item.hasCaptions && !item.hasBroll));

for (const aspectRatio of ["9:16", "16:9"]) {
  assert.ok(fixture.userMedia.some((item) => item.aspectRatio === aspectRatio && item.mode === "single-video-v1"));
  assert.ok(fixture.userMedia.some((item) => item.aspectRatio === aspectRatio && item.mode === "multi-asset-v1"));
}

assert.equal(typeof packageJson.scripts?.["verify:style"], "string");
assert.match(packageJson.scripts["verify:style"], /style-baseline\.verify\.mjs/);

console.log("style-baseline.verify: fixture matrix and verify:style command passed");
