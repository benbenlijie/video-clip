import assert from "node:assert/strict";
import { createRenderManifest, getEngineAvailability, toTimelineV1 } from "./timeline-contract.mjs";

const project = {
  id: "project-1",
  workflowId: "wayne-video-editing",
  goal: "Make a short explainer",
  style: "clean creator",
  media: { filename: "input.mp4", durationMs: 10000, width: 1920, height: 1080, hasAudio: true, hasVideo: true, path: "/private/input.mp4" },
  transcript: { provider: "local", language: "en", text: "Hello world", segments: [{ startMs: 0, endMs: 1000, text: "Hello" }] },
  plan: {
    summary: "Keep the explanation concise",
    segments: [{ id: "segment-1", startMs: 0, endMs: 10000, action: "keep", title: "Main", note: "Keep" }],
    shorts: [{ id: "short-1", startMs: 0, endMs: 5000, title: "Hook" }],
    visualEvents: [{ id: "hook", type: "title_card", startMs: 0, endMs: 1000, text: "Hello", subtext: "" }],
    brollEvents: [],
  },
  brollAssets: [],
  editor: { version: 2 },
};

const timeline = toTimelineV1(project);
assert.equal(timeline.contract, "timeline.v1");
assert.equal(timeline.project.sourceVersion, 2);
assert.equal(timeline.segments[0].id, "segment-1");
assert.equal(timeline.transcript.segments[0].text, "Hello");
assert.equal(JSON.stringify(timeline).includes("/private/input.mp4"), false, "local media paths must not cross the engine boundary");

const manifest = createRenderManifest({ timeline, engine: "remotion", engineVersion: "4.0.539", status: "completed", inputs: { timelineSha256: "a".repeat(64), sourceMediaSha256: "b".repeat(64) }, artifacts: [{ name: "preview.mp4", kind: "preview", width: 1920, height: 1080, durationMs: 10000 }], qc: { passed: true, checks: ["probe", "black-frames"] } });
assert.equal(manifest.contract, "render-manifest.v1");
assert.equal(manifest.engine, "remotion");
assert.equal(manifest.engineVersion, "4.0.539");
assert.equal(manifest.artifacts[0].version, 2);
assert.equal(manifest.qc.passed, true);
assert.match(manifest.inputs.timelineSha256, /^[a-f0-9]{64}$/);
assert.equal(getEngineAvailability().openchatcut.mode, "disabled");
assert.equal(getEngineAvailability({ remotion: true }).remotion.enabled, true);
assert.throws(() => createRenderManifest({ timeline, engine: "unknown" }), /不支持的渲染引擎/);
assert.throws(() => toTimelineV1({ id: "missing" }), /需要项目、媒体信息和已确认的剪辑计划/);

console.log("timeline-contract.verify: schema conversion, path privacy, render manifest, and engine availability passed");
