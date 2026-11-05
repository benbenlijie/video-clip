import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-multi-route-"));
const storage = path.join(root, "storage");
const apiPort = await freePort();
const providerPort = await freePort();
const anthropicPort = await freePort();
const videoPath = path.join(root, "fixture.mp4");
const musicPath = path.join(root, "licensed-music.wav");
const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", videoPath]);
let fixtureError = "";
child.stderr.on("data", (chunk) => { fixtureError += chunk; });
const [fixtureCode] = await once(child, "close");
assert.equal(fixtureCode, 0, fixtureError);
const musicFixture = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "pcm_s16le", musicPath]);
let musicError = "";
musicFixture.stderr.on("data", (chunk) => { musicError += chunk; });
const [musicCode] = await once(musicFixture, "close");
assert.equal(musicCode, 0, musicError);
const video = await fs.readFile(videoPath);
const musicBytes = await fs.readFile(musicPath);
let releaseAnalysis;
let holdAnalysis = false;
const analysisGate = new Promise((resolve) => { releaseAnalysis = resolve; });
const provider = createServer(async (req, res) => {
  for await (const _chunk of req) { /* Consume the ASR request body before replying. */ }
  if (holdAnalysis) await analysisGate;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 1000, result: { text: "真实素材转录", audio_info: { duration: 2000 }, utterances: [{ start_time: 0, end_time: 1800, text: "真实素材转录" }] } }));
});
const anthropic = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const content = body.messages?.[0]?.content || [];
  const prompt = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.equal(content.filter((item) => item.type === "image").length, 2, "Claude must receive one real contact sheet for each source asset");
  assert.ok(content.filter((item) => item.type === "image").every((item) => item.source?.type === "base64" && item.source.media_type === "image/jpeg"));
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const ids = [...new Set(prompt.match(uuidPattern) || [])].slice(-2);
  assert.equal(ids.length, 2, `Claude prompt should contain both uploaded asset ids: ${prompt.slice(-1000)}`);
  const plan = {
    summary: "先交代问题，再展示解决方式",
    storyBeats: [{ title: "问题", purpose: "建立情境" }, { title: "方案", purpose: "展示解决方式" }],
    clips: [
      { id: "c1", sourceAssetId: ids[0], sourceInMs: 0, sourceOutMs: 2000, timelineStartMs: 0, timelineEndMs: 2000, track: "video-main", purpose: "problem", reason: "开场" },
      { id: "c2", sourceAssetId: ids[1], sourceInMs: 0, sourceOutMs: 2000, timelineStartMs: 2000, timelineEndMs: 4000, track: "video-main", purpose: "solution", reason: "主体" },
    ],
    overlays: [],
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan) }] }));
});
provider.listen(providerPort, "127.0.0.1");
anthropic.listen(anthropicPort, "127.0.0.1");
await Promise.all([once(provider, "listening"), once(anthropic, "listening")]);
const api = spawn(process.execPath, [path.resolve("server/index.mjs")], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    PORT: String(apiPort), HOST: "127.0.0.1", WAYNE_STORAGE_DIR: storage, WAYNE_IGNORE_DOTENV: "1",
    TRANSCRIPTION_PROVIDER: "volcengine", VOLCENGINE_ASR_MODE: "fast", VOLCENGINE_ASR_API_KEY: "fixture-key", VOLCENGINE_ASR_BASE_URL: `http://127.0.0.1:${providerPort}/recognize`,
    TENCENTCLOUD_SECRET_ID: "", TENCENTCLOUD_SECRET_KEY: "", WAYNE_WHISPER_CLI_PATH: path.join(root, "missing-whisper-cli"), WAYNE_WHISPER_MODEL_PATH: path.join(root, "missing-whisper-model.bin"),
    ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`, ANTHROPIC_MODEL: "claude-opus-5-5",
    OPENCHATCUT_MCP_URL: "http://127.0.0.1:1/api/external-mcp/mcp",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErrors = "";
api.stderr.on("data", (chunk) => { serverErrors = (serverErrors + chunk).slice(-5000); });
api.on("exit", (code, signal) => console.error(`multi-asset-route.verify: api exited code=${code} signal=${signal}\n${serverErrors}`));
const base = `http://127.0.0.1:${apiPort}`;
try {
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(health?.status, 200, `API failed to start: ${serverErrors}`);
  console.log("multi-asset-route.verify: api ready");
  const createdResponse = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowMode: "multi-asset-v1", goal: "产品介绍", brief: { rawText: "先交代问题，再展示解决方式", targetDurationMs: 4000, aspectRatio: "both" } }) });
  assert.equal(createdResponse.status, 201);
  let project = await createdResponse.json();
  assert.equal(project.workflowMode, "multi-asset-v1");
  console.log("multi-asset-route.verify: project created");
  const legacyAdvance = await fetch(`${base}/api/projects/${project.id}/advance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(legacyAdvance.status, 409, "legacy advance must not mutate multi-asset project status");
  const invalidLegacyUpload = await fetch(`${base}/api/projects/${project.id}/input`, { method: "POST" });
  assert.equal(invalidLegacyUpload.status, 409, "multi-asset projects must not use the legacy single-input route");

  const quotaProject = await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowMode: "multi-asset-v1", brief: { rawText: "素材配额验证" } }) })).json();
  const quotaResponses = await Promise.all(Array.from({ length: 22 }, (_, index) => fetch(`${base}/api/projects/${quotaProject.id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: `quota-${index}.mp4`, totalBytes: 1, licenseConfirmed: true }) })));
  assert.equal(quotaResponses.filter((response) => response.status === 201).length, 20, "concurrent asset creation must respect the 20-file cap");
  assert.equal(quotaResponses.filter((response) => response.status === 400).length, 2);
  const tooLargeAsset = await fetch(`${base}/api/projects/${quotaProject.id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "too-large.mp4", totalBytes: 501 * 1024 * 1024, licenseConfirmed: true }) });
  assert.equal(tooLargeAsset.status, 400, "an individual asset must respect the 500MB limit");
  const projectByteLimit = await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowMode: "multi-asset-v1", brief: { rawText: "项目总容量验证" } }) })).json();
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${base}/api/projects/${projectByteLimit.id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: `large-${index}.mp4`, totalBytes: 500 * 1024 * 1024, licenseConfirmed: true }) });
    assert.equal(response.status, 201);
  }
  const overProjectLimit = await fetch(`${base}/api/projects/${projectByteLimit.id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "over-project-limit.mp4", totalBytes: 500 * 1024 * 1024, licenseConfirmed: true }) });
  assert.equal(overProjectLimit.status, 400, "the total asset bytes must not exceed 5GB");

  const assets = [];
  for (let index = 0; index < 2; index += 1) {
    const assetResponse = await fetch(`${base}/api/projects/${project.id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: `source-${index + 1}.mp4`, totalBytes: video.length, role: index === 0 ? "main" : "supporting", label: `素材 ${index + 1}`, licenseConfirmed: true }) });
    assert.equal(assetResponse.status, 201, await assetResponse.clone().text());
    project = await assetResponse.json();
    const asset = project.assets.at(-1);
    const split = Math.floor(video.length / 2);
    const uploadChunk = async (offset, content) => fetch(`${base}/api/projects/${project.id}/assets/${asset.id}/chunk`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Upload-Length": String(content.length), "X-Upload-Offset": String(offset), "X-Upload-Total": String(video.length) }, body: content });
    const [first, duplicate] = await Promise.all([uploadChunk(0, video.subarray(0, split)), uploadChunk(0, video.subarray(0, split))]);
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(duplicate.status, 200, "concurrent identical replays must be idempotent");
    const changedReplay = await uploadChunk(0, Buffer.alloc(split, 7));
    assert.equal(changedReplay.status, 409, "a different file with a matching name and size must not reuse an acknowledged prefix");
    const second = await uploadChunk(split, video.subarray(split));
    assert.equal(second.status, 200, await second.clone().text());
    const complete = await fetch(`${base}/api/projects/${project.id}/assets/${asset.id}/complete`, { method: "POST" });
    assert.equal(complete.status, 201, await complete.clone().text());
    project = await complete.json();
    assets.push(project.assets.find((item) => item.id === asset.id));
  }
  assert.equal(project.assets.length, 2);
  console.log("multi-asset-route.verify: assets uploaded");
  assert.equal(JSON.stringify(project.assets).includes(root), false, "project API must hide local asset paths");
  console.log(`multi-asset-route.verify: analyze request to ${apiPort}`);
  holdAnalysis = true;
  const analysisPromise = fetch(`${base}/api/projects/${project.id}/analyze`, { method: "POST" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await (await fetch(`${base}/api/projects/${project.id}`)).json();
    if (current.status === "analyzing_assets") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const concurrentAnalysis = await fetch(`${base}/api/projects/${project.id}/analyze`, { method: "POST" });
  assert.equal(concurrentAnalysis.status, 409, "only one analysis run can mutate a project's assets at a time");
  const briefDuringAnalysis = await fetch(`${base}/api/projects/${project.id}/brief`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rawText: "racing update" }) });
  assert.equal(briefDuringAnalysis.status, 409, "brief edits cannot race with analysis");
  holdAnalysis = false;
  releaseAnalysis();
  const analyzedResponse = await analysisPromise;
  assert.equal(analyzedResponse.status, 200, await analyzedResponse.clone().text());
  project = await analyzedResponse.json();
  assert.equal(project.assetAnalysis.status, "ready");
  console.log("multi-asset-route.verify: assets analyzed");
  assert.ok(project.assets.every((asset) => asset.analysisStatus === "ready" && asset.sha256));
  const contactSheet = await fetch(`${base}/api/projects/${project.id}/assets/${project.assets[0].id}/contact-sheet`);
  assert.equal(contactSheet.status, 200);
  assert.match(contactSheet.headers.get("content-type") || "", /image\/jpeg/);
  assert.ok((await contactSheet.arrayBuffer()).byteLength > 100);
  assert.equal((await fs.readFile(path.join(storage, project.id, "asset-inventory.json"), "utf8")).includes('"transcript"'), true);

  const plannedResponse = await fetch(`${base}/api/projects/${project.id}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(plannedResponse.status, 200, await plannedResponse.clone().text());
  project = await plannedResponse.json();
  assert.equal(project.status, "plan_ready");
  assert.equal(new Set(project.multiAssetPlan.clips.map((clip) => clip.sourceAssetId)).size, 2);
  const versionOne = project.multiAssetPlan.version;
  const timelineResponse = await fetch(`${base}/api/projects/${project.id}/timeline`);
  const timeline = await timelineResponse.json();
  assert.equal(timelineResponse.status, 200);
  assert.equal(timeline.contract, "timeline.v2");
  assert.equal(timeline.profiles.length, 2);
  assert.equal(JSON.stringify(timeline).includes(root), false, "timeline.v2 must not expose local source paths");
  console.log("multi-asset-route.verify: plan generated");
  const confirmedResponse = await fetch(`${base}/api/projects/${project.id}/plan/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: project.multiAssetPlan.version }) });
  assert.equal(confirmedResponse.status, 200, await confirmedResponse.clone().text());
  project = await confirmedResponse.json();
  assert.equal(project.multiAssetPlan.confirmed, true);
  const finalBeforePreview = await fetch(`${base}/api/projects/${project.id}/render`, { method: "POST" });
  assert.equal(finalBeforePreview.status, 409, "formal export must require a passed preview for the current plan version");
  const previewResponse = await fetch(`${base}/api/projects/${project.id}/preview`, { method: "POST" });
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  project = await previewResponse.json();
  assert.equal(project.multiAssetPreview.qc.passed, true);
  assert.equal(project.multiAssetPreview.planVersion, project.multiAssetPlan.version);
  assert.equal(project.multiAssetPreview.inputRevision, project.multiAssetRevision);
  assert.deepEqual(project.artifacts.filter((item) => item.kind === "preview").map((item) => [item.profile, item.width, item.height]).sort(), [["landscape", 960, 540], ["portrait", 540, 960]]);
  const staleReview = await fetch(`${base}/api/projects/${project.id}/preview/reviewed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planVersion: project.multiAssetPlan.version - 1, profiles: ["landscape", "portrait"] }) });
  assert.equal(staleReview.status, 409, "review attestations must bind to the exact plan version");
  const oneProfileReview = await fetch(`${base}/api/projects/${project.id}/preview/reviewed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planVersion: project.multiAssetPlan.version, profiles: ["landscape"] }) });
  assert.equal(oneProfileReview.status, 200, await oneProfileReview.clone().text());
  project = await oneProfileReview.json();
  const missingProfileReview = await fetch(`${base}/api/projects/${project.id}/render`, { method: "POST" });
  assert.equal(missingProfileReview.status, 409, "all requested profiles must be explicitly checked before final export");
  assert.match((await missingProfileReview.json()).error, /播放检查.*预览/);
  const bothProfileReview = await fetch(`${base}/api/projects/${project.id}/preview/reviewed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planVersion: project.multiAssetPlan.version, profiles: ["landscape", "portrait"] }) });
  assert.equal(bothProfileReview.status, 200);
  project = await bothProfileReview.json();
  const musicForm = new FormData();
  musicForm.append("file", new Blob([musicBytes], { type: "audio/wav" }), "licensed-music.wav");
  musicForm.append("licenseConfirmed", "true");
  const musicUpload = await fetch(`${base}/api/projects/${project.id}/music`, { method: "POST", headers: { "X-Music-Filename": encodeURIComponent("licensed-music.wav") }, body: musicForm });
  assert.equal(musicUpload.status, 200, await musicUpload.clone().text());
  project = await musicUpload.json();
  assert.equal(project.multiAssetPreview, null, "changing the music bed invalidates the existing preview");
  assert.equal(project.multiAssetPreviewReview, null, "changing the music bed invalidates previous human review");
  const postMusicRevision = project.multiAssetRevision;
  const finalAfterMusicChange = await fetch(`${base}/api/projects/${project.id}/render`, { method: "POST" });
  assert.equal(finalAfterMusicChange.status, 409, "final export must not use a preview made before the music changed");
  const refreshedPreviewResponse = await fetch(`${base}/api/projects/${project.id}/preview`, { method: "POST" });
  assert.equal(refreshedPreviewResponse.status, 200, await refreshedPreviewResponse.clone().text());
  project = await refreshedPreviewResponse.json();
  assert.equal(project.multiAssetPreview.inputRevision, postMusicRevision);
  const refreshedReview = await fetch(`${base}/api/projects/${project.id}/preview/reviewed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planVersion: project.multiAssetPlan.version, profiles: ["landscape", "portrait"] }) });
  assert.equal(refreshedReview.status, 200);
  project = await refreshedReview.json();
  assert.deepEqual(project.multiAssetPreviewReview.profiles.sort(), ["landscape", "portrait"]);
  const renderedResponse = await fetch(`${base}/api/projects/${project.id}/render`, { method: "POST" });
  assert.equal(renderedResponse.status, 200, await renderedResponse.clone().text());
  project = await renderedResponse.json();
  assert.equal(project.status, "completed");
  console.log("multi-asset-route.verify: exports rendered");
  assert.equal(project.qc.passed, true);
  assert.equal(project.qc.musicMixed, true);
  assert.deepEqual(project.artifacts.filter((item) => item.kind === "video").map((item) => item.profile).sort(), ["landscape", "portrait"]);
  const streamedVideo = project.artifacts.find((item) => item.kind === "video");
  const streamResponse = await fetch(`${base}${streamedVideo.streamUrl}`, { headers: { Range: "bytes=0-3" } });
  assert.equal(streamResponse.status, 206);
  assert.match(streamResponse.headers.get("content-disposition") || "", /inline/);
  const revisedResponse = await fetch(`${base}/api/projects/${project.id}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: "缩短开头" }) });
  assert.equal(revisedResponse.status, 200, await revisedResponse.clone().text());
  project = await revisedResponse.json();
  assert.equal(project.multiAssetPlan.version, versionOne + 1);
  assert.equal(project.multiAssetPreview, null, "a new plan invalidates the previous plan's preview gate");
  assert.equal(project.multiAssetPlanHistory[0].version, versionOne);
  const restoreResponse = await fetch(`${base}/api/projects/${project.id}/plan/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: versionOne }) });
  assert.equal(restoreResponse.status, 200, await restoreResponse.clone().text());
  project = await restoreResponse.json();
  assert.equal(project.multiAssetPlan.summary, "先交代问题，再展示解决方式");
  assert.equal(project.multiAssetPlan.confirmed, false, "restored plans require renewed confirmation");
  const nextAsset = await fetch(`${base}/api/projects/${project.id}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "new-source.mp4", totalBytes: video.length, role: "supporting", label: "新增素材", licenseConfirmed: true }) });
  assert.equal(nextAsset.status, 201);
  project = await nextAsset.json();
  assert.equal(project.multiAssetPlan, null, "changing the source asset set invalidates the active plan");
  assert.equal(project.multiAssetPreview, null, "changing the source asset set invalidates the preview");
  assert.ok(project.multiAssetPlanHistory.some((item) => item.version === versionOne), "invalidated plans remain available for rollback");
  const incompleteAsset = project.assets.at(-1);
  const deleteIncomplete = await fetch(`${base}/api/projects/${project.id}/assets/${incompleteAsset.id}`, { method: "DELETE" });
  assert.equal(deleteIncomplete.status, 200);
  project = await deleteIncomplete.json();
  assert.equal(project.assets.some((item) => item.id === incompleteAsset.id), false, "users can remove a selected incomplete upload and retry with another file");
  console.log("multi-asset-route.verify: legacy isolation, resumable uploads, analysis, planning, confirmation, dual export, and rollback passed");
} finally {
  api.kill("SIGTERM");
  await once(api, "exit").catch(() => undefined);
  await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => anthropic.close(resolve))]);
  await fs.rm(root, { recursive: true, force: true });
}
