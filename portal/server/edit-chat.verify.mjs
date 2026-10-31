import assert from "node:assert/strict";
import { appendEditTurn, buildChatContext, completeEditTurn, createEditSession, failEditTurn, nextEditVersion } from "./edit-chat.mjs";

const project = {
  id: "project-1",
  editor: { version: 4 },
  artifacts: [
    { name: "wayne-case-01-final.mp4", kind: "video", version: 1 },
    { name: "wayne-case-01-final-v2.mp4", kind: "video", version: 2 },
    { name: "cc-v4-render-1.mp4", kind: "video", version: 4 },
  ],
};

assert.equal(nextEditVersion(project), 5, "a chat edit must increment from the latest successful artifact");
const session = createEditSession(project);
assert.equal(session.latestVersion, 4);
assert.equal(session.turnCount, 0);

const first = appendEditTurn(session, { text: "00:18 到 00:24 节奏太慢，删掉停顿", timeMs: 18000 });
assert.equal(first.turn.baseVersion, 4);
assert.equal(first.turn.resultVersion, 5);
assert.equal(first.session.latestVersion, 4, "a pending turn must not become the latest version before QC passes");
assert.equal(first.session.turnCount, 1);
assert.equal(first.session.messages.at(-1).text, "00:18 到 00:24 节奏太慢，删掉停顿");
assert.throws(() => appendEditTurn(first.session, { text: "再改一次" }), /已有对话修改正在执行/);

const completed = { ...first.session, latestVersion: 5, status: "idle", turns: first.session.turns.map((turn) => ({ ...turn, status: "completed" })) };
const second = appendEditTurn(completed, { text: "字幕再大一点，其他地方保持不变", timeMs: null });
assert.equal(second.turn.baseVersion, 5, "the next turn must target the newest successful version");
assert.equal(second.turn.resultVersion, 6);
assert.match(buildChatContext(second.session), /00:18 到 00:24/);

const longSession = { ...second.session, messages: Array.from({ length: 20 }, (_, index) => ({ role: "user", text: `message-${index}` })) };
const context = buildChatContext(longSession, 6);
assert.ok(!context.includes("message-0"), "old raw messages should be compacted out of the prompt context");
assert.match(context, /message-19/);
const done = completeEditTurn({ ...second.session, status: "running" }, second.turn.id, { resultVersion: 6, sessionId: "claude-session-1" });
assert.equal(done.latestVersion, 6);
assert.equal(done.sessionId, "claude-session-1");
assert.equal(done.status, "idle");
const failed = failEditTurn({ ...done, status: "running" }, first.turn.id, "nope");
assert.equal(failed.status, "idle");

console.log("edit-chat.verify: latest-version binding, turn history, and context compaction passed");
