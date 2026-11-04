import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { whisperRuntimeFingerprint } from "./local-whisper.mjs";
import { readRecognitionPassCache, runPrimaryAttempts, runRecognitionPasses, transcribeVideo, writeRecognitionPassCache } from "./transcription.mjs";

let finishCloud;
let finishLocal;
const started = [];
const cloudResult = { provider: "volcengine", transcript: { text: "云端稿", segments: [] } };
const localResult = { provider: "whisper.cpp", model: "small_q5_1", text: "本地稿", segments: [] };
const passes = runRecognitionPasses({
  cloud: () => { started.push("cloud"); return new Promise((resolve) => { finishCloud = resolve; }); },
  local: () => { started.push("local"); return new Promise((resolve) => { finishLocal = resolve; }); },
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(started.sort(), ["cloud", "local"], "both passes must start before either result is awaited");
finishCloud(cloudResult);
finishLocal(localResult);
const both = await passes;
assert.equal(both.primaryStatus, "complete");
assert.equal(both.secondaryStatus, "complete");
assert.equal(both.primary, cloudResult);
assert.equal(both.secondary, localResult);

const partial = await runRecognitionPasses({ cloud: async () => cloudResult, local: async () => { throw new Error("CLI unavailable"); } });
assert.equal(partial.primaryStatus, "complete");
assert.equal(partial.secondaryStatus, "failed");
assert.equal(partial.primary, cloudResult, "local failure must not discard the cloud transcript");
assert.match(partial.secondaryError, /CLI unavailable/);

const order = [];
const primary = await runPrimaryAttempts([
  async () => { order.push("volc-standard"); throw new Error("standard unavailable"); },
  async () => { order.push("volc-fast"); return "volc-fast-result"; },
  async () => { order.push("tencent"); return "tencent-result"; },
]);
assert.equal(primary, "volc-fast-result");
assert.deepEqual(order, ["volc-standard", "volc-fast"], "cloud fallback order must stay sequential and stop on success");
await assert.rejects(runPrimaryAttempts([async () => { throw new Error("volc failed"); }, async () => { throw new Error("tencent failed"); }]), /volc failed.*tencent failed/);

const root = await mkdtemp(join(tmpdir(), "wayne-transcript-cache-"));
try {
  const cachePath = join(root, "transcript.whisper.json");
  const cliPath = join(root, "whisper-cli");
  const modelPath = join(root, "ggml-small-q5_1.bin");
  await Promise.all([import("node:fs/promises").then(({ writeFile }) => writeFile(cliPath, "cli bytes v1")), import("node:fs/promises").then(({ writeFile }) => writeFile(modelPath, "model bytes v1"))]);
  const runtimeConfig = { cliPath, modelPath, threads: 8, model: "small_q5_1" };
  const runtimeFingerprint = await whisperRuntimeFingerprint(runtimeConfig);
  await writeRecognitionPassCache(cachePath, { audioSha256: "abc123", model: "small_q5_1", runtimeFingerprint, transcript: localResult });
  assert.deepEqual(await readRecognitionPassCache(cachePath, { audioSha256: "abc123", model: "small_q5_1", runtimeFingerprint }), { audioSha256: "abc123", model: "small_q5_1", runtimeFingerprint, transcript: localResult });
  assert.equal(await readRecognitionPassCache(cachePath, { audioSha256: "new-audio", model: "small_q5_1", runtimeFingerprint }), null, "a cache for another audio file must not be reused");
  assert.equal(await readRecognitionPassCache(cachePath, { audioSha256: "abc123", model: "base_q5_1", runtimeFingerprint }), null, "a cache from another model must not be reused");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(modelPath, "replacement model bytes"));
  const replacedRuntimeFingerprint = await whisperRuntimeFingerprint(runtimeConfig);
  assert.notEqual(replacedRuntimeFingerprint, runtimeFingerprint, "replacement model bytes must get a new runtime identity");
  assert.equal(await readRecognitionPassCache(cachePath, { audioSha256: "abc123", model: "small_q5_1", runtimeFingerprint: replacedRuntimeFingerprint }), null, "a replaced model file must not reuse an old result");
  assert.equal(await readFile(cachePath, "utf8").then((value) => JSON.parse(value).model), "small_q5_1");
} finally {
  await rm(root, { recursive: true, force: true });
}

const integrationRoot = await mkdtemp(join(tmpdir(), "wayne-transcription-passes-"));
const envKeys = ["TRANSCRIPTION_PROVIDER", "VOLCENGINE_ASR_MODE", "VOLCENGINE_ASR_API_KEY", "VOLCENGINE_ASR_RESOURCE_ID", "VOLCENGINE_ASR_BASE_URL", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "WAYNE_WHISPER_CLI_PATH", "WAYNE_WHISPER_MODEL_PATH", "WAYNE_WHISPER_THREADS", "WAYNE_WHISPER_TIMEOUT_MS"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
try {
  const projectDir = join(integrationRoot, "project");
  const model = join(integrationRoot, "small-q5_1.bin");
  const cli = join(integrationRoot, "fake-whisper.mjs");
  const cliCount = join(integrationRoot, "cli-count.txt");
  const videoPath = join(integrationRoot, "source.mp4");
  await Promise.all([
    (await import("node:fs/promises")).mkdir(projectDir, { recursive: true }),
    (await import("node:fs/promises")).writeFile(model, "model fixture"),
    (await import("node:fs/promises")).writeFile(cli, `#!/usr/bin/env node\nimport { readFile, writeFile } from 'node:fs/promises';\nconst a=process.argv.slice(2); const wav=a[a.indexOf('-f')+1]; const prefix=a[a.indexOf('-of')+1];\nlet n=Number(await readFile(${JSON.stringify(cliCount)},'utf8').catch(()=> '0')); await writeFile(${JSON.stringify(cliCount)},String(n+1));\nif(!wav.endsWith('transcript-audio.wav')) process.exit(8);\nawait writeFile(prefix+'.srt','1\\n00:00:00,100 --> 00:00:01,000\\n本地识别稿\\n');\n`),
  ]);
  await (await import("node:fs/promises")).chmod(cli, 0o755);
  const ffmpeg = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x334433:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", videoPath]);
  let ffmpegError = "";
  ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk; });
  const [ffmpegCode] = await once(ffmpeg, "close");
  assert.equal(ffmpegCode, 0, ffmpegError);

  Object.assign(process.env, {
    TRANSCRIPTION_PROVIDER: "volcengine",
    VOLCENGINE_ASR_MODE: "fast",
    VOLCENGINE_ASR_API_KEY: "test-key",
    VOLCENGINE_ASR_RESOURCE_ID: "fixture-resource",
    VOLCENGINE_ASR_BASE_URL: "https://asr.invalid/recognize",
    TENCENTCLOUD_SECRET_ID: "",
    TENCENTCLOUD_SECRET_KEY: "",
    WAYNE_WHISPER_CLI_PATH: cli,
    WAYNE_WHISPER_MODEL_PATH: model,
    WAYNE_WHISPER_THREADS: "8",
    WAYNE_WHISPER_TIMEOUT_MS: "5000",
  });
  let cloudCalls = 0;
  const progress = [];
  globalThis.fetch = async () => {
    cloudCalls += 1;
    return { ok: true, status: 200, json: async () => ({ code: 1000, result: { text: "云端识别稿", utterances: [{ start_time: 0, end_time: 900, text: "云端识别稿" }] } }) };
  };

  const firstRun = await transcribeVideo({ videoPath, projectDir, projectId: "fixture-project", onPass: (event) => progress.push(event) });
  assert.deepEqual(progress.filter((event) => event.status === "running").map((event) => event.pass).sort(), ["primary", "secondary"]);
  assert.deepEqual(progress.filter((event) => event.status === "complete").map((event) => event.pass).sort(), ["primary", "secondary"]);
  assert.equal(firstRun.primaryStatus, "complete");
  assert.equal(firstRun.secondaryStatus, "complete");
  assert.equal(firstRun.primary.transcript.text, "云端识别稿");
  assert.equal(firstRun.secondary.text, "本地识别稿");
  assert.match(JSON.parse(await readFile(join(projectDir, "transcript.original.json"), "utf8")).model, /^cloud-[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(join(projectDir, "transcript.whisper.json"), "utf8")).model, "small_q5_1");

  const retried = await transcribeVideo({ videoPath, projectDir, projectId: "fixture-project" });
  assert.equal(retried.primaryStatus, "complete");
  assert.equal(retried.secondaryStatus, "complete");
  assert.equal(cloudCalls, 1, "matching persisted cloud result must not incur another ASR request");
  assert.equal(await readFile(cliCount, "utf8"), "1", "matching local result must not be re-run");
  await (await import("node:fs/promises")).writeFile(model, "replacement model fixture");
  const replacedModelRun = await transcribeVideo({ videoPath, projectDir, projectId: "fixture-project" });
  assert.equal(replacedModelRun.primaryStatus, "complete");
  assert.equal(replacedModelRun.secondaryStatus, "complete");
  assert.equal(cloudCalls, 1, "the unchanged cloud cache should remain reusable");
  assert.equal(await readFile(cliCount, "utf8"), "2", "same-path model replacement must invalidate the local result cache");
  await (await import("node:fs/promises")).writeFile(cli, `${await readFile(cli, "utf8")}\n// replacement CLI bytes\n`);
  await transcribeVideo({ videoPath, projectDir, projectId: "fixture-project" });
  assert.equal(await readFile(cliCount, "utf8"), "3", "same-path CLI replacement must invalidate the local result cache");
  process.env.WAYNE_WHISPER_THREADS = "4";
  await transcribeVideo({ videoPath, projectDir, projectId: "fixture-project" });
  assert.equal(await readFile(cliCount, "utf8"), "4", "thread configuration changes must invalidate the local result cache");
} finally {
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(integrationRoot, { recursive: true, force: true });
}

console.log("transcription.verify: parallel start, isolated pass failures, cloud fallback order and audio/model cache passed");
