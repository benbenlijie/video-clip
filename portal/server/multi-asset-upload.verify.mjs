import assert from "node:assert/strict";
import { findMatchingMultiAsset, hashFileChunks } from "../src/multi-asset-upload.mjs";

const file = Object.assign(new Blob(["abcdefgh"]), { name: "same.mp4" });
const differentFile = Object.assign(new Blob(["wxyzefgh"]), { name: "same.mp4" });
const chunks = await hashFileChunks(file, 4);
const sameNameAndSizeButDifferentContent = await hashFileChunks(differentFile, 4);
const ready = { id: "ready", filename: file.name, bytes: file.size, status: "ready", chunkHashes: chunks };
assert.equal(findMatchingMultiAsset([ready], file, chunks).asset, ready);
assert.equal(findMatchingMultiAsset([ready], differentFile, sameNameAndSizeButDifferentContent).asset, undefined, "name and size cannot identify completed content");

const uploading = { id: "uploading", filename: file.name, status: "uploading", upload: { totalBytes: file.size, receivedBytes: 4, chunkHashes: [chunks[0]] } };
assert.equal(findMatchingMultiAsset([uploading], file, chunks).asset, uploading, "an identical acknowledged prefix can resume");
const conflict = findMatchingMultiAsset([uploading], differentFile, sameNameAndSizeButDifferentContent);
assert.equal(conflict.asset, undefined);
assert.equal(conflict.incompleteConflict, true, "a different file cannot reuse a same-name, same-size partial upload");

console.log("multi-asset-upload.verify: exact content matching and acknowledged-prefix resume passed");
