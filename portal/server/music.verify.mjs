import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wayne-music-api-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.mjs"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WAYNE_STORAGE_DIR: root, WAYNE_IGNORE_DOTENV: "1", PEXELS_API_KEY: "", PIXABAY_API_KEY: "" }, stdio: "ignore" });
try {
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; } } catch { /* Wait for the isolated API to bind. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, "isolated API should start");
  const created = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "music upload test" }) });
  const project = await created.json();
  assert.equal(created.status, 201);
  const unavailableSearch = await fetch(`${base}/api/projects/${project.id}/broll/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "someone working late at night" }) });
  assert.equal(unavailableSearch.status, 503, "missing stock-provider keys should be reported before any paid Claude request");
  assert.deepEqual((await unavailableSearch.json()).providers, { pexels: false, pixabay: false });

  const musicPath = path.join(root, "licensed-bed.wav");
  const generated = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", musicPath], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = await fs.readFile(musicPath);
  const form = () => { const data = new FormData(); data.append("file", new Blob([bytes], { type: "audio/wav" }), "licensed-bed.wav"); return data; };
  const denied = form();
  denied.append("licenseConfirmed", "false");
  const deniedResponse = await fetch(`${base}/api/projects/${project.id}/music`, { method: "POST", headers: { "X-Music-Filename": "licensed-bed.wav" }, body: denied });
  assert.equal(deniedResponse.status, 400);
  assert.match((await deniedResponse.json()).error, /使用许可/);

  const accepted = form();
  accepted.append("licenseConfirmed", "true");
  const acceptedResponse = await fetch(`${base}/api/projects/${project.id}/music`, { method: "POST", headers: { "X-Music-Filename": "licensed-bed.wav" }, body: accepted });
  assert.equal(acceptedResponse.status, 200);
  const saved = await acceptedResponse.json();
  assert.equal(saved.music.filename, "licensed-bed.wav");
  assert.equal(saved.music.licenseConfirmed, true);
  assert.equal("path" in saved.music, false, "local storage path must not be exposed by the API");
  const persisted = await (await fetch(`${base}/api/projects/${project.id}`)).json();
  assert.equal(persisted.music.filename, "licensed-bed.wav");

  const brollPath = path.join(root, "licensed-cutaway.mp4");
  const brollGenerated = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", brollPath], { encoding: "utf8" });
  assert.equal(brollGenerated.status, 0, brollGenerated.stderr);
  const brollBytes = await fs.readFile(brollPath);
  // Exercise Unicode filenames, replayed chunks and legacy filenames against the real API.
  for (const [filename, encoded] of [["口播 100% + 🎬.mp4", true], ["clip%20+raw.mp4", false]]) {
    const uploadProject = await (await fetch(`${base}/api/projects`, { method: "POST" })).json();
    const midpoint = Math.floor(brollBytes.length / 2);
    const sendChunk = (offset, end, name = filename, useEncoding = encoded) => fetch(`${base}/api/projects/${uploadProject.id}/input/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream", "X-Upload-Offset": String(offset),
        "X-Upload-Length": String(end - offset), "X-Upload-Total": String(brollBytes.length),
        "X-Upload-Filename": useEncoding ? encodeURIComponent(name) : name,
        ...(useEncoding ? { "X-Upload-Filename-Encoding": "uri" } : {}),
      },
      body: brollBytes.subarray(offset, end),
    });
    assert.equal((await sendChunk(0, midpoint)).status, 200);
    let state = await (await fetch(`${base}/api/projects/${uploadProject.id}`)).json();
    assert.equal(state.upload.filename, filename, "stored filename must match the original Unicode or literal-percent filename");
    assert.equal((await sendChunk(0, midpoint, filename, true)).status, 200, "encoded requests can resume legacy uploads without changing literal percent signs");
    assert.equal((await sendChunk(midpoint, brollBytes.length, "different.mp4")).status, 409);
    if (encoded) {
      const malformed = await fetch(`${base}/api/projects/${uploadProject.id}/input/chunk`, {
        method: "POST", headers: { "X-Upload-Filename": "%broken", "X-Upload-Filename-Encoding": "uri" }, body: "x",
      });
      assert.equal(malformed.status, 400);
      assert.match((await malformed.json()).error, /文件名编码无效/);
    }
    assert.equal((await sendChunk(midpoint, brollBytes.length, filename, true)).status, 200);
    const completed = await fetch(`${base}/api/projects/${uploadProject.id}/input/complete`, { method: "POST" });
    assert.equal(completed.status, 201);
    state = await completed.json();
    assert.equal(state.media.filename, filename);
    assert.equal(state.upload, null);
    assert.deepEqual(await fs.readFile(path.join(root, uploadProject.id, "input.mp4")), brollBytes);
  }
  const brollForm = (confirmed) => { const data = new FormData(); data.append("file", new Blob([brollBytes], { type: "video/mp4" }), "licensed-cutaway.mp4"); data.append("licenseConfirmed", String(confirmed)); return data; };
  const brollDenied = await fetch(`${base}/api/projects/${project.id}/broll`, { method: "POST", headers: { "X-Broll-Filename": "licensed-cutaway.mp4" }, body: brollForm(false) });
  assert.equal(brollDenied.status, 400);
  assert.match((await brollDenied.json()).error, /使用许可/);
  const brollAccepted = await fetch(`${base}/api/projects/${project.id}/broll`, { method: "POST", headers: { "X-Broll-Filename": "licensed-cutaway.mp4" }, body: brollForm(true) });
  assert.equal(brollAccepted.status, 201);
  const savedBroll = await brollAccepted.json();
  assert.equal(savedBroll.brollAssets.length, 1);
  assert.equal(savedBroll.brollAssets[0].filename, "licensed-cutaway.mp4");
  assert.equal(savedBroll.brollAssets[0].durationMs, 2000);
  assert.equal("path" in savedBroll.brollAssets[0], false);
  const reloaded = await (await fetch(`${base}/api/projects/${project.id}`)).json();
  assert.equal(reloaded.brollAssets[0].licenseConfirmed, true);
  console.log("assets.verify: music and B-roll license gates, media probe, upload persistence, and path redaction passed");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(root, { recursive: true, force: true });
}
