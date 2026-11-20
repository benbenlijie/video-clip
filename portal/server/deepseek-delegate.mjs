import { promises as fs, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { workspacePath } from "./workspace-path.mjs";

const DELEGATION_MODES = new Set(["off", "auto", "force"]);
const ROLES = new Set(["analysis", "script", "media", "captions", "broll", "qc"]);
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 200 * 1024;

export function deepSeekDelegationMode(value = process.env.WAYNE_DEEPSEEK_DELEGATION) {
  const mode = String(value || "").trim().toLowerCase();
  return DELEGATION_MODES.has(mode) ? mode : "off";
}

function stringList(value, name, { maxItems = 50, maxLength = 500 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array with at most ${maxItems} items`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.length > maxLength) throw new Error(`${name}[${index}] is invalid`);
    return item.trim();
  });
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("delegate_task request is invalid");
  const role = String(request.role || "script");
  if (!ROLES.has(role)) throw new Error(`delegate_task role is invalid: ${role}`);
  const objective = String(request.objective || "").trim();
  if (!objective) throw new Error("delegate_task objective is required");
  return {
    role,
    objective,
    inputs: stringList(request.inputs || [], "inputs"),
    outputs: stringList(request.outputs || [], "outputs", { maxItems: 50 }),
    constraints: stringList(request.constraints || [], "constraints", { maxItems: 20, maxLength: 1000 }),
    sessionId: request.sessionId == null ? null : String(request.sessionId).trim(),
  };
}

export function buildDelegationPrompt(request) {
  const task = normalizeRequest(request);
  const networkRule = task.role === "broll"
    ? "Network access is allowed only for the configured Pexels/Pixabay provider APIs."
    : "Do not use network access.";
  return `You are the execution worker for the Wayne video-editing portal. You are not the final director.

Role: ${task.role}
Objective: ${task.objective}

Inputs:
${task.inputs.length ? task.inputs.map((item) => `- ${item}`).join("\n") : "- none"}

Required outputs:
${task.outputs.map((item) => `- ${item}`).join("\n")}

Extra constraints:
${task.constraints.length ? task.constraints.map((item) => `- ${item}`).join("\n") : "- none"}

Execution contract:
- Work only inside the current working directory.
- ${networkRule}
- Never modify input.mp4, transcript.original.json, transcript.whisper.json, brief.json, or assets.json.
- Do not create or overwrite edit-plan.json, content-copy.json, or manifest.json. The director owns those files.
- Use real shell, FFmpeg, FFprobe, Node, or Python commands when needed and inspect the actual outputs.
- Keep work bounded to at most two repair cycles. Do not explore unrelated files.
- If a required output cannot be produced, stop and report failure instead of claiming success.
- Finish by writing delegate-result.json with this shape:
  {"contract":"delegate-result.v1","status":"completed"|"failed","summary":"...","changedFiles":["..."],"checks":{"name":true}}
- Only mark status completed after every required output exists and has been checked.
`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectOutput(root, relative) {
  const target = await workspacePath(root, relative);
  const stat = await fs.stat(target);
  if (!stat.isFile()) return { path: relative, kind: "directory", bytes: null, sha256: null };
  return { path: relative, kind: "file", bytes: stat.size, sha256: await sha256File(target) };
}

async function readDelegateResult(root) {
  try {
    const value = JSON.parse(await fs.readFile(await workspacePath(root, "delegate-result.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("delegate-result.json must be an object");
    if (!["completed", "failed"].includes(value.status)) throw new Error("delegate-result.json status is invalid");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`delegate-result.json is invalid: ${error.message}`);
  }
}

function appendBounded(current, chunk, limit) {
  const next = current + String(chunk);
  return next.length > limit ? next.slice(-limit) : next;
}

function parseEvent(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function killProcessTree(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* process already exited */ } }
}

export async function runDeepSeekDelegate({
  root,
  auditPath,
  request,
  env = process.env,
  dshBin = env.WAYNE_DSH_BIN || "dsh",
  profile = env.WAYNE_DSH_PROFILE || "headless",
  timeoutMs = Number(env.WAYNE_DEEPSEEK_DELEGATE_TIMEOUT_MS) || 180000,
} = {}) {
  const task = normalizeRequest(request);
  for (const input of task.inputs) await workspacePath(root, input);
  for (const output of task.outputs) await workspacePath(root, output, { existing: false });

  const controlDir = dirname(auditPath);
  await fs.mkdir(controlDir, { recursive: true });
  const logFile = `delegate-${Date.now()}-${randomUUID()}.jsonl`;
  const stderrFile = logFile.replace(/\.jsonl$/, ".stderr.log");
  const logPath = join(controlDir, logFile);
  const stderrPath = join(controlDir, stderrFile);
  const prompt = buildDelegationPrompt(task);
  const args = ["--profile", profile, "--json"];
  if (task.sessionId) args.push("--session-id", task.sessionId);
  const childEnv = {
    PATH: env.PATH || process.env.PATH,
    HOME: env.HOME || process.env.HOME,
    LANG: env.LANG || "C.UTF-8",
    TMPDIR: env.TMPDIR || "/tmp",
    DSH_PERMISSION_MODE: "workspace-write",
  };
  if (task.role === "broll") {
    if (env.PEXELS_API_KEY) childEnv.PEXELS_API_KEY = env.PEXELS_API_KEY;
    if (env.PIXABAY_API_KEY) childEnv.PIXABAY_API_KEY = env.PIXABAY_API_KEY;
  }

  const startedAt = Date.now();
  const events = [];
  let stdout = "";
  let stdoutPending = "";
  let stderr = "";
  let finalText = "";
  let sessionId = task.sessionId || null;
  let turnEndReason = null;
  let eventError = null;
  let timedOut = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const recordEvent = (event) => {
    events.push(event);
    if (event.type === "session" && event.sessionId) sessionId = String(event.sessionId);
    if (event.type === "final" && typeof event.text === "string") finalText = event.text;
    if (event.type === "status" && event.phase === "turn_end") turnEndReason = event.reason?.kind ?? event.reason ?? null;
    if (event.type === "status" && event.usage && typeof event.usage === "object") {
      for (const key of Object.keys(usage)) usage[key] += Number(event.usage[key]) || 0;
    }
    if (event.type === "error" && event.message) eventError = String(event.message);
  };

  const child = spawn(dshBin, args, { cwd: root, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(prompt);
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout = appendBounded(stdout, text, MAX_STDOUT_BYTES);
    stdoutPending += text;
    const lines = stdoutPending.split(/\r?\n/);
    stdoutPending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (!event) continue;
      recordEvent(event);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, String(chunk), MAX_STDERR_BYTES); });

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, "SIGTERM");
    setTimeout(() => killProcessTree(child, "SIGKILL"), 5000).unref();
  }, Math.max(10000, Math.min(Number(timeoutMs) || 180000, 300000)));

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (stdoutPending.trim()) {
    const event = parseEvent(stdoutPending);
    if (event) recordEvent(event);
  }
  await fs.writeFile(logPath, stdout, { flag: "wx" });
  await fs.writeFile(stderrPath, stderr, { flag: "wx" });

  let delegateResult = null;
  let resultError = null;
  try { delegateResult = await readDelegateResult(root); } catch (error) { resultError = error.message; }
  const outputs = [];
  const missingOutputs = [];
  for (const output of task.outputs) {
    try { outputs.push(await inspectOutput(root, output)); } catch (error) {
      if (error.code === "ENOENT") missingOutputs.push(output);
      else resultError = `${output}: ${error.message}`;
    }
  }
  const workerResultMissing = !delegateResult;
  if (!delegateResult && !timedOut && code === 0 && !eventError && !resultError && missingOutputs.length === 0) {
    delegateResult = {
      contract: "delegate-result.v1",
      status: "completed",
      summary: String(finalText || "Worker completed without delegate-result.json").slice(0, 4000),
      changedFiles: outputs.map((item) => item.path),
      checks: { workerResultMissing: true },
    };
    await fs.writeFile(await workspacePath(root, "delegate-result.json", { existing: false }), JSON.stringify(delegateResult, null, 2));
  }
  const workerReportedComplete = delegateResult?.status === "completed";
  const failed = Boolean(eventError) || Boolean(resultError) || missingOutputs.length > 0
    || delegateResult?.status === "failed" || ((timedOut || code !== 0) && !workerReportedComplete);
  const result = {
    contract: "deepseek-delegation.v1",
    status: failed ? "failed" : "completed",
    role: task.role,
    sessionId,
    durationMs: Date.now() - startedAt,
    summary: String(delegateResult?.summary || finalText || "").slice(0, 4000),
    changedFiles: Array.isArray(delegateResult?.changedFiles) ? delegateResult.changedFiles.slice(0, 50).map(String) : outputs.map((item) => item.path),
    checks: delegateResult?.checks && typeof delegateResult.checks === "object" && !Array.isArray(delegateResult.checks) ? delegateResult.checks : {},
    outputs,
    missingOutputs,
    toolCalls: events.filter((event) => event.type === "tool_call").map((event) => String(event.tool || "tool")).slice(0, 100),
    logFile,
    stderrFile,
    exitCode: code,
    timedOut,
    turnEndReason,
    usage,
    ...(workerResultMissing ? { workerResultMissing: true } : {}),
    ...(eventError ? { error: eventError } : {}),
    ...(resultError ? { resultError } : {}),
  };
  return result;
}
