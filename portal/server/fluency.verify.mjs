import assert from "node:assert/strict";
import { analyzeFluency, verifyFluency } from "./fluency.mjs";

const transcript = {
  text: "你好呃今天我们说重点",
  segments: [{
    id: "segment-1",
    startMs: 0,
    endMs: 2000,
    text: "你好呃今天我们说重点",
    words: [
      { startMs: 0, endMs: 300, text: "你好" },
      { startMs: 500, endMs: 700, text: "呃" },
      { startMs: 900, endMs: 1400, text: "今天我们说重点" },
    ],
  }],
};

const report = analyzeFluency({ transcript });
assert.equal(report.findings.some((item) => item.type === "filler" && item.text === "呃" && item.action === "remove"), true);
assert.deepEqual(report.edits.map((edit) => [edit.startMs, edit.endMs, edit.reason]), [[480, 720, "hard-filler"]]);

const pauseTranscript = {
  text: "你好世界",
  segments: [{
    id: "segment-1",
    startMs: 0,
    endMs: 1700,
    text: "你好世界",
    words: [
      { startMs: 0, endMs: 300, text: "你好" },
      { startMs: 1300, endMs: 1700, text: "世界" },
    ],
  }],
};
const pauseReport = analyzeFluency({ transcript: pauseTranscript });
const pause = pauseReport.findings.find((item) => item.type === "pause");
assert.equal(pause.action, "clamp");
assert.equal(pause.targetGapMs, 160);
assert.deepEqual(pauseReport.edits.map((edit) => [edit.startMs, edit.endMs, edit.reason]), [[380, 1220, "pause-clamp"]]);

const softTranscript = {
  text: "你好啊今天",
  segments: [{
    id: "segment-1",
    startMs: 0,
    endMs: 1200,
    text: "你好啊今天",
    words: [
      { startMs: 0, endMs: 300, text: "你好" },
      { startMs: 500, endMs: 650, text: "啊" },
      { startMs: 800, endMs: 1200, text: "今天" },
    ],
  }],
};
const softReport = analyzeFluency({ transcript: softTranscript });
assert.equal(softReport.findings.some((item) => item.type === "filler" && item.text === "啊" && item.action === "review"), true);
assert.deepEqual(softReport.edits, []);

const edlReport = analyzeFluency({
  transcript,
  timeline: { pieces: [{ src: [0, 2000], out: [0, 2000] }] },
});
assert.deepEqual(edlReport.proposedPieces.map((piece) => piece.src), [[0, 480], [720, 2000]]);

const cleanTranscript = {
  text: "你好今天说重点",
  segments: [{
    id: "segment-1",
    startMs: 0,
    endMs: 1600,
    text: "你好今天说重点",
    words: [
      { startMs: 0, endMs: 300, text: "你好" },
      { startMs: 450, endMs: 1000, text: "今天" },
      { startMs: 1150, endMs: 1600, text: "说重点" },
    ],
  }],
};
assert.equal(verifyFluency({ transcript: cleanTranscript }).passed, true);
assert.equal(verifyFluency({ transcript }).passed, false);

console.log("fluency.verify: hard filler, pause clamping, soft-particle review, EDL subtraction, and residual gate passed");
