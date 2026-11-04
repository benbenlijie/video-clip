import { randomUUID } from "node:crypto";

const MAX_CONTEXT_MESSAGES = 6;

function numericVersion(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

export function mainArtifactVersion(project) {
  return (project.artifacts || []).filter((artifact) => ["video", "preview"].includes(artifact.kind)).reduce((highest, artifact) => Math.max(highest, numericVersion(artifact.version) || 1), 0);
}

export function nextEditVersion(project = {}) {
  const artifactVersion = mainArtifactVersion(project);
  return (artifactVersion || Math.max(numericVersion(project.editSession?.latestVersion), numericVersion(project.editor?.version))) + 1;
}

export function createEditSession(project = {}) {
  const latestVersion = mainArtifactVersion(project) || Math.max(numericVersion(project.editSession?.latestVersion), numericVersion(project.editor?.version), 1);
  return {
    sessionId: project.editSession?.sessionId || null,
    latestVersion,
    turnCount: Number(project.editSession?.turnCount || 0),
    status: project.editSession?.status || "idle",
    messages: Array.isArray(project.editSession?.messages) ? project.editSession.messages : [],
    turns: Array.isArray(project.editSession?.turns) ? project.editSession.turns : [],
    summary: String(project.editSession?.summary || ""),
  };
}

export function appendEditTurn(session, { text, timeMs = null, rangeEndMs = null, baseVersion } = {}) {
  const request = String(text || "").trim();
  if (!request) throw new Error("对话修改内容不能为空");
  const current = createEditSession({ editSession: session });
  if (current.status === "running") throw new Error("当前已有对话修改正在执行，请等待本轮完成");
  const resolvedBaseVersion = numericVersion(baseVersion) || current.latestVersion;
  if (resolvedBaseVersion !== current.latestVersion) throw Object.assign(new Error("修改所基于的版本已过期，请回到最新版本后重试"), { statusCode: 409 });
  const turn = {
    id: `turn-${String(current.turnCount + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`,
    baseVersion: resolvedBaseVersion,
    resultVersion: Math.max(resolvedBaseVersion + 1, nextEditVersion({ editSession: current })),
    request,
    timeMs: Number.isFinite(Number(timeMs)) ? Math.max(0, Math.round(Number(timeMs))) : null,
    rangeEndMs: Number.isFinite(Number(rangeEndMs)) ? Math.max(0, Math.round(Number(rangeEndMs))) : null,
    status: "running",
    createdAt: new Date().toISOString(),
  };
  return {
    session: { ...current, status: "running", turnCount: current.turnCount + 1, turns: [...current.turns, turn], messages: [...current.messages, { id: randomUUID(), role: "user", text: request, timeMs: turn.timeMs, rangeEndMs: turn.rangeEndMs, turnId: turn.id, createdAt: turn.createdAt }] },
    turn,
  };
}

export function completeEditTurn(session, turnId, { resultVersion, assistantText = "已生成新的编辑版本", sessionId = null } = {}) {
  const current = createEditSession({ editSession: session });
  const version = numericVersion(resultVersion);
  const turns = current.turns.map((turn) => turn.id === turnId ? { ...turn, resultVersion: version || turn.resultVersion, status: "completed", completedAt: new Date().toISOString() } : turn);
  const turn = turns.find((item) => item.id === turnId);
  if (!turn) throw new Error("对话轮次不存在");
  return {
    ...current,
    sessionId: sessionId || current.sessionId,
    latestVersion: version || turn.resultVersion,
    status: "idle",
    turns,
    messages: [...current.messages, { id: randomUUID(), role: "assistant", text: String(assistantText || "已生成新的编辑版本"), version: version || turn.resultVersion, turnId, createdAt: new Date().toISOString() }],
  };
}

export function failEditTurn(session, turnId, error) {
  const current = createEditSession({ editSession: session });
  const turns = current.turns.map((turn) => turn.id === turnId ? { ...turn, status: "failed", error: String(error || "对话修改失败"), failedAt: new Date().toISOString() } : turn);
  if (!turns.some((turn) => turn.id === turnId)) throw new Error("对话轮次不存在");
  return { ...current, status: "idle", turns, messages: [...current.messages, { id: randomUUID(), role: "assistant", text: `本轮修改失败：${String(error || "未知错误")}`, turnId, error: true, createdAt: new Date().toISOString() }] };
}

export function buildChatContext(session, limit = MAX_CONTEXT_MESSAGES) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const recent = messages.slice(-Math.max(1, limit));
  const summary = String(session?.summary || "").trim();
  return [
    summary ? `更早对话摘要：${summary}` : "",
    "最近对话：",
    ...recent.map((message) => `${message.role === "assistant" ? "Claude" : "用户"}：${message.text}`),
  ].filter(Boolean).join("\n");
}

export function updateChatSummary(session, summary) {
  return { ...createEditSession({ editSession: session }), summary: String(summary || "").trim().slice(0, 2000) };
}
