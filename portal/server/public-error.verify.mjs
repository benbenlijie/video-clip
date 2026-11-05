import assert from "node:assert/strict";
import { publicErrorText, sanitizePublicResponse } from "./public-error.mjs";

const source = "ffmpeg failed: /home/ben/portal/storage/id/assets/a1/source.mp4; details at /tmp/run-123/output.log";
const safe = publicErrorText(source);
assert.equal(safe.includes("/home/ben"), false);
assert.equal(safe.includes("/tmp/run-123"), false);
assert.match(safe, /服务器本地路径/);
const response = sanitizePublicResponse({ error: source, project: { error: source, assets: [{ analysisError: source, path: "/home/ben/private.mp4", visualEvidence: { path: "/home/ben/contact-sheet.jpg" } }] } });
assert.equal(JSON.stringify(response).includes("/home/ben"), false);
assert.equal(response.project.assets[0].path, undefined);
const event = sanitizePublicResponse({ message: "ffmpeg failed: /srv/wayne/storage/job/render.mp4", project: { status: "failed", error: source } });
assert.equal(JSON.stringify(event).includes("/srv/wayne"), false, "SSE progress text must redact custom storage paths");
assert.equal(JSON.stringify(event).includes("/tmp/run-123"), false, "SSE progress text must not expose local paths");

console.log("public-error.verify: public errors redact local paths and filesystem fields");
