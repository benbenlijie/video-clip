import assert from "node:assert/strict";
import { createOutputProfiles, toTimelineV2, validateTimelineV2 } from "./timeline-v2.mjs";

const project = {
  id: "p1",
  workflowMode: "multi-asset-v1",
  goal: "product intro",
  style: "clean",
  brief: { rawText: "先讲问题，再展示产品", aspectRatio: "both", targetDurationMs: 6000 },
  assets: [
    { id: "a1", filename: "one.mp4", durationMs: 4000, width: 1920, height: 1080, hasAudio: true, hasVideo: true, licenseConfirmed: true, path: "/private/a1.mp4", role: "main", status: "ready", analysisStatus: "ready" },
    { id: "a2", filename: "two.mp4", durationMs: 5000, width: 1080, height: 1920, hasAudio: false, hasVideo: true, licenseConfirmed: true, path: "/private/a2.mp4", role: "supporting", status: "ready", analysisStatus: "ready" },
  ],
  multiAssetPlan: {
    summary: "问题到方案",
    clips: [
      { id: "c1", sourceAssetId: "a1", sourceInMs: 500, sourceOutMs: 3000, timelineStartMs: 0, timelineEndMs: 2500, track: "video-main", purpose: "hook", reason: "开场问题" },
      { id: "c2", sourceAssetId: "a2", sourceInMs: 1000, sourceOutMs: 4500, timelineStartMs: 2500, timelineEndMs: 6000, track: "video-main", purpose: "solution", reason: "展示方案" },
    ],
    overlays: [],
  },
  music: { filename: "licensed.wav", licenseConfirmed: true, sha256: "c".repeat(64), path: "/private/music.wav" },
};

const profiles = createOutputProfiles(project.brief);
assert.deepEqual(profiles.map(({ id, width, height }) => [id, width, height]), [["landscape", 1920, 1080], ["portrait", 1080, 1920]]);
assert.deepEqual(createOutputProfiles({ ...project.brief, aspectRatio: "portrait" }).map((item) => item.id), ["portrait"]);
const timeline = toTimelineV2(project);
assert.equal(timeline.contract, "timeline.v2");
assert.equal(timeline.clips.length, 2);
assert.equal(timeline.clips[1].timelineStartMs, timeline.clips[0].timelineEndMs);
assert.equal(timeline.assets[0].transcriptRef, "assets/a1/transcript.json");
assert.deepEqual(timeline.audio, { sourcePolicy: "retain-source-audio-or-silence", music: { filename: "licensed.wav", licenseConfirmed: true, sha256: "c".repeat(64) } });
assert.equal(JSON.stringify(timeline).includes("/private/a1.mp4"), false);
assert.deepEqual(validateTimelineV2(timeline, project), timeline);

assert.throws(() => validateTimelineV2({ ...timeline, clips: [{ ...timeline.clips[0], sourceAssetId: "missing" }, timeline.clips[1]] }, project), /素材引用/);
assert.throws(() => validateTimelineV2({ ...timeline, durationMs: 8000, clips: [{ ...timeline.clips[0], sourceOutMs: 5000, timelineEndMs: 4500 }, { ...timeline.clips[1], timelineStartMs: 4500, timelineEndMs: 8000 }] }, project), /源时间范围/);
assert.throws(() => validateTimelineV2({ ...timeline, clips: [{ ...timeline.clips[0], timelineEndMs: 2400 }, timeline.clips[1]] }, project), /时间轴区间/);
assert.throws(() => validateTimelineV2({ ...timeline, durationMs: 6100, clips: [timeline.clips[0], { ...timeline.clips[1], timelineStartMs: 2600, timelineEndMs: 6100 }] }, project), /不能有空洞/);
assert.throws(() => validateTimelineV2({ ...timeline, profiles: [{ id: "landscape", width: 1, height: 1, fps: 30, codec: "h264", audioCodec: "aac" }] }, project), /输出规格/);
assert.throws(() => validateTimelineV2({ ...timeline, clips: [{ ...timeline.clips[0], track: "audio-main" }, timeline.clips[1]] }, project), /不支持的时间轴轨道/);
assert.throws(() => validateTimelineV2(timeline, { ...project, assets: project.assets.map((asset) => ({ ...asset, licenseConfirmed: false })) }), /使用许可/);

console.log("timeline-v2.verify: multi-source ranges, profiles, gap checks, license, and path privacy passed");
