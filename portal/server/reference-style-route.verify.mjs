import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function ffmpeg(args, cwd) {
  const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { cwd });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  const code = await new Promise((resolveRun, reject) => { child.on("error", reject); child.on("close", resolveRun); });
  assert.equal(code, 0, error);
}

const storageRoot = await fs.mkdtemp(join(tmpdir(), "wayne-reference-route-"));
const styleRoot = join(storageRoot, "style-library");
const projectDir = join(storageRoot, "project-style");
const earlyProjectDir = join(storageRoot, "project-style-early");
await fs.mkdir(projectDir, { recursive: true });
await fs.mkdir(earlyProjectDir, { recursive: true });
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "input.mp4"], projectDir);
await fs.copyFile(join(projectDir, "input.mp4"), join(earlyProjectDir, "input.mp4"));
const project = {
  id: "project-style",
  workflowId: "wayne-video-editing",
  workflowMode: "single-video-v1",
  compositionMode: "remotion-main.v1",
  status: "plan_ready",
  goal: "用户自己的口播",
  style: "Wayne / clean creator",
  dir: projectDir,
  media: { filename: "input.mp4", path: join(projectDir, "input.mp4"), durationMs: 30000, width: 160, height: 90, hasAudio: true, hasVideo: true },
  transcript: { provider: "fixture", text: "用户自己的口播", durationMs: 30000, segments: [{ id: "s1", startMs: 0, endMs: 30000, text: "用户自己的口播" }] },
  plan: { summary: "用户计划", segments: [{ id: "keep", startMs: 0, endMs: 30000, action: "keep", title: "用户内容", note: "" }], shorts: [], visualEvents: [{ id: "v1", type: "title_card", startMs: 0, endMs: 1000, text: "用户自己的口播" }], brollEvents: [] },
  artifacts: [],
  comments: [],
  brollAssets: [],
  multiAssetPlan: null,
  multiAssetPlanHistory: [],
  multiAssetRevision: 0,
  multiAssetInputRevision: 0,
  evidence: {},
};
await fs.writeFile(join(projectDir, "project.json"), JSON.stringify(project));
const earlyProject = {
  ...project,
  id: "project-style-early",
  dir: earlyProjectDir,
  status: "transcript_ready",
  goal: "第二条任意用户素材",
  media: { ...project.media, filename: "early-input.mp4", path: join(earlyProjectDir, "input.mp4") },
  transcript: {
    provider: "fixture",
    text: "第二条任意用户素材的真实口播",
    durationMs: 30000,
    segments: [{ id: "early-1", startMs: 0, endMs: 30000, text: "第二条任意用户素材的真实口播" }],
  },
  plan: null,
};
await fs.writeFile(join(earlyProjectDir, "project.json"), JSON.stringify(earlyProject));

const referencePath = join(storageRoot, "reference.mp4");
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "reference.mp4"], storageRoot);

const port = await freePort();
const child = spawn(process.execPath, [resolve("server/index.mjs")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    WAYNE_STORAGE_DIR: storageRoot,
    WAYNE_STYLE_DIR: styleRoot,
    WAYNE_STYLE_GENERATOR: "fixture",
    WAYNE_STYLE_AGENT: "direct",
    WAYNE_IGNORE_DOTENV: "1",
    REFERENCE_STYLE_ENABLED: "1",
    REFERENCE_STYLE_STAGE: "preview",
    REFERENCE_STYLE_VISUAL_ANALYSIS: "0",
    REFERENCE_STYLE_AUDIO_ANALYSIS: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;
let referenceId;
let styleId;
try {
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(health?.status, 200, `API did not start: ${stderr}`);
  const runtimeConfig = await fetch(`${base}/api/config`).then((response) => response.json());
  assert.equal(runtimeConfig.referenceStyle.stage, "preview");
  assert.equal(runtimeConfig.referenceStyle.capabilities.export, false);

  const unconfirmedForm = new FormData();
  unconfirmedForm.append("file", new Blob([await fs.readFile(referencePath)], { type: "video/quicktime" }), "reference-source.mov");
  const unconfirmed = await fetch(`${base}/api/reference-styles?mode=single-video-v1`, { method: "POST", body: unconfirmedForm });
  const unconfirmedBody = await unconfirmed.json();
  assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmedBody));
  assert.match(unconfirmedBody.error, /确认.*许可/);

  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(referencePath)], { type: "video/quicktime" }), "reference-source.mov");
  form.append("referenceUsageConfirmed", "true");
  const uploaded = await fetch(`${base}/api/reference-styles?mode=single-video-v1`, { method: "POST", body: form });
  const uploadBody = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(uploadBody));
  referenceId = uploadBody.id;
  assert.ok(referenceId);
  assert.equal(uploadBody.analysis.contract, "reference-analysis.v1");
  assert.equal(uploadBody.analysis.source.filename, "reference-source.mov");
  assert.ok(uploadBody.analysis.shots.length >= 1);
  assert.equal(JSON.stringify(uploadBody).includes(storageRoot), false);

  const referenceResponse = await fetch(`${base}/api/reference-styles/${referenceId}`);
  assert.equal(referenceResponse.status, 200);
  const referenceBody = await referenceResponse.json();
  assert.equal(referenceBody.analysis.contract, "reference-analysis.v1");
  assert.match(referenceBody.referenceUsageConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);

  const referenceMedia = await fetch(`${base}/api/reference-styles/${referenceId}/media`, { headers: { Range: "bytes=0-99" } });
  assert.equal(referenceMedia.status, 206, "reference media should support bounded video playback");
  assert.equal(referenceMedia.headers.get("content-type"), "video/quicktime");
  assert.match(referenceMedia.headers.get("content-range") || "", /^bytes 0-99\/\d+$/);
  assert.equal((await referenceMedia.arrayBuffer()).byteLength, 100);

  const remoteGenerate = await fetch(`${base}/api/reference-styles/${referenceId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: "{}",
  });
  assert.equal(remoteGenerate.status, 403);

  const storedReferencePath = join(storageRoot, "reference-styles", referenceId, "analysis.json");
  const storedReference = JSON.parse(await fs.readFile(storedReferencePath, "utf8"));
  const legacyReference = { ...storedReference };
  delete legacyReference.referenceUsageConfirmedAt;
  await fs.writeFile(storedReferencePath, JSON.stringify(legacyReference, null, 2));
  const legacyGenerate = await fetch(`${base}/api/reference-styles/${referenceId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const legacyGenerateBody = await legacyGenerate.json();
  assert.equal(legacyGenerate.status, 409, JSON.stringify(legacyGenerateBody));
  assert.match(legacyGenerateBody.error, /许可确认/);
  await fs.writeFile(storedReferencePath, JSON.stringify(storedReference, null, 2));

  const generated = await fetch(`${base}/api/reference-styles/${referenceId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const generatedBody = await generated.json();
  assert.equal(generated.status, 201, JSON.stringify(generatedBody));
  styleId = generatedBody.id;
  assert.equal(generatedBody.status, "pending_approval");
  assert.equal(JSON.stringify(generatedBody).includes(storageRoot), false);

  const remoteLibrary = await fetch(`${base}/api/style-packs`, { headers: { "x-forwarded-for": "203.0.113.9" } }).then((response) => response.json());
  assert.equal(remoteLibrary.stylePacks.some((item) => item.id === styleId), false);
  const remoteApprove = await fetch(`${base}/api/style-packs/${styleId}/1/approve`, {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  assert.equal(remoteApprove.status, 403);
  const approved = await fetch(`${base}/api/style-packs/${styleId}/1/approve`, { method: "POST" });
  assert.equal(approved.status, 200, await approved.text());
  const regenerated = await fetch(`${base}/api/reference-styles/${referenceId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const regeneratedBody = await regenerated.json();
  assert.equal(regenerated.status, 201, JSON.stringify(regeneratedBody));
  assert.equal(regeneratedBody.id, styleId);
  assert.equal(regeneratedBody.version, 2);
  assert.equal(regeneratedBody.status, "pending_approval");
  const remoteReject = await fetch(`${base}/api/style-packs/${styleId}/2/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ reason: "remote" }),
  });
  assert.equal(remoteReject.status, 403);
  const rejected = await fetch(`${base}/api/style-packs/${styleId}/2/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "caption too large" }),
  });
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 200, JSON.stringify(rejectedBody));
  assert.equal(rejectedBody.status, "rejected");
  const remoteLibraryAfterApproval = await fetch(`${base}/api/style-packs`, { headers: { "x-forwarded-for": "203.0.113.9" } }).then((response) => response.json());
  assert.equal(remoteLibraryAfterApproval.stylePacks.some((item) => item.id === styleId && item.version === 1), true);
  assert.equal(remoteLibraryAfterApproval.stylePacks.some((item) => item.id === styleId && item.version === 2), false);
  const listed = await fetch(`${base}/api/style-packs`).then((response) => response.json());
  assert.ok(listed.stylePacks.some((item) => item.id === styleId && item.version === 1));
  const loaded = await fetch(`${base}/api/style-packs/${styleId}/1`);
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).status, "approved");

  const earlyApplied = await fetch(`${base}/api/projects/project-style-early/apply-style`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stylePackId: styleId,
      version: 1,
      styleCopy: { copyCaptions: true, copyRhythm: true, copyLayout: true, copyBroll: false, copyAudio: false },
    }),
  });
  const earlyAppliedBody = await earlyApplied.json();
  assert.equal(earlyApplied.status, 200, JSON.stringify(earlyAppliedBody));
  assert.equal(earlyAppliedBody.status, "transcript_ready", "attaching a style must not invent a plan");
  assert.equal(earlyAppliedBody.plan, null);
  assert.equal(earlyAppliedBody.stylePackId, styleId);
  assert.equal(earlyAppliedBody.referenceStyleId, referenceId);
  assert.equal(earlyAppliedBody.transcript.text, "第二条任意用户素材的真实口播");
  assert.equal(earlyAppliedBody.styleApplicationHash, null);
  assert.ok(earlyAppliedBody.styleApplication);

  const applied = await fetch(`${base}/api/projects/project-style/apply-style`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stylePackId: styleId,
      version: 1,
      styleCopy: { copyCaptions: false, copyRhythm: true, copyLayout: true, copyBroll: false, copyAudio: false },
    }),
  });
  const appliedBody = await applied.json();
  assert.equal(applied.status, 200, JSON.stringify(appliedBody));
  assert.equal(appliedBody.stylePackId, earlyAppliedBody.stylePackId);
  assert.equal(appliedBody.referenceStyleId, referenceId);
  assert.equal(appliedBody.referenceAnalysis.contract, "reference-analysis.v1");
  assert.equal(appliedBody.styleCopy.copyCaptions, false);
  assert.equal(appliedBody.styleApplication.parameters.copyCaptions, false);
  assert.equal(appliedBody.styleApplication.parameters.copyLayout, false);
  assert.match(appliedBody.styleApplicationHash, /^[a-f0-9]{64}$/);
  assert.equal(appliedBody.plan.stylePackId, styleId);
  assert.equal(appliedBody.plan.styleVersion, 1);
  assert.equal(appliedBody.plan.captionStyle, undefined);
  assert.equal(appliedBody.plan.layoutEvents, undefined);
  assert.equal(JSON.stringify(appliedBody).includes(storageRoot), false);

  const stylePreview = await fetch(`${base}/api/projects/project-style/style-preview`, { method: "POST" });
  const stylePreviewBody = await stylePreview.json();
  assert.equal(stylePreview.status, 201, JSON.stringify(stylePreviewBody));
  const stylePreviewArtifact = (stylePreviewBody.artifacts || []).find((item) => item.kind === "style-preview");
  assert.ok(stylePreviewArtifact);
  assert.match(stylePreviewArtifact.styleProvenance.styleManifestSha256, /^[a-f0-9]{64}$/);
  assert.match(stylePreviewArtifact.styleProvenance.styleProjectHash, /^[a-f0-9]{64}$/);
  assert.match(stylePreviewArtifact.styleProvenance.referenceAnalysisSha256, /^[a-f0-9]{64}$/);
  assert.match(stylePreviewArtifact.styleProvenance.styleApplicationSha256, /^[a-f0-9]{64}$/);
  assert.equal(stylePreviewArtifact.styleProvenance.styleApplicationSha256, appliedBody.styleApplicationHash);
  assert.equal(JSON.stringify(stylePreviewBody).includes(storageRoot), false);

  const previewOnlyExport = await fetch(`${base}/api/projects/project-style/render`, { method: "POST" });
  const previewOnlyExportBody = await previewOnlyExport.json();
  assert.equal(previewOnlyExport.status, 403, JSON.stringify(previewOnlyExportBody));
  assert.match(previewOnlyExportBody.error, /尚未开放导出/);

  const missing = await fetch(`${base}/api/reference-styles/not-found`);
  assert.equal(missing.status, 404);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("close", done));
  }
  await fs.rm(storageRoot, { recursive: true, force: true });
}

console.log("reference-style-route.verify: upload, analysis, generate, approve, list, apply, privacy, and 404 passed");
