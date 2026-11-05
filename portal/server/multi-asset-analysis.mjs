import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assetDir, assertMultiAssetReady } from "./multi-asset.mjs";
import { transcribeVideo } from "./transcription.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`)));
  });
}

export async function extractAssetKeyframes(project, asset) {
  if (!asset?.path || !Number.isFinite(Number(asset.durationMs)) || Number(asset.durationMs) <= 0) throw new Error("素材缺少可抽帧的视频或时长信息");
  const durationMs = Math.round(Number(asset.durationMs));
  const keyframeTimesMs = [...new Set([0, Math.floor(durationMs / 2), Math.floor(durationMs * 0.8)])];
  const target = join(assetDir(project, asset.id), "contact-sheet.jpg");
  const filters = keyframeTimesMs.map((_, index) => `[${index}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1[f${index}]`);
  filters.push(`${keyframeTimesMs.map((_, index) => `[f${index}]`).join("")}hstack=inputs=${keyframeTimesMs.length}[sheet]`);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const timeMs of keyframeTimesMs) args.push("-ss", String(timeMs / 1000), "-i", asset.path);
  args.push("-filter_complex", filters.join(";"), "-map", "[sheet]", "-frames:v", "1", "-q:v", "5", target);
  await run("ffmpeg", args);
  return { keyframeTimesMs, filename: "contact-sheet.jpg", path: target, width: keyframeTimesMs.length * 320, height: 180 };
}

function transcriptPayload(result) {
  const transcript = result.primary?.transcript;
  if (!transcript) throw new Error(result.primaryError || "素材没有返回云端转录文本");
  return {
    provider: result.primary.provider,
    requestId: result.primary.requestId || null,
    text: String(transcript.text || ""),
    durationMs: Math.max(0, Number(transcript.durationMs) || 0),
    segments: (transcript.segments || []).map((segment, index) => ({
      id: String(segment.id || `segment-${index + 1}`),
      startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(segment.endMs) || 0)),
      text: String(segment.text || ""),
      ...(Array.isArray(segment.words) ? { words: segment.words } : {}),
    })).filter((segment) => segment.endMs > segment.startMs && segment.text.trim()),
  };
}

export async function analyzeMultiAssetProject(project, { transcribe = transcribeVideo, extractKeyframes = extractAssetKeyframes, persist = async () => undefined, onAsset = async () => undefined, publicMediaBaseUrl = "" } = {}) {
  if (project?.workflowMode !== "multi-asset-v1") throw new Error("只有多素材项目可以执行素材分析");
  if (!Array.isArray(project.assets) || project.assets.length < 2) throw new Error("多素材项目至少需要2个视频素材");
  let lastError = null;
  for (const asset of project.assets) {
    if (["ready", "complete"].includes(asset.analysisStatus)) continue;
    if (asset.status !== "ready" || !asset.path) {
      asset.analysisStatus = "failed";
      asset.analysisError = "素材上传尚未完成";
      lastError = new Error(asset.analysisError);
      await onAsset({ asset, status: "failed", error: asset.analysisError });
      await persist(project);
      continue;
    }
    asset.analysisStatus = "running";
    asset.analysisError = null;
    await persist(project);
    await onAsset({ asset, status: "running" });
    try {
      const directory = assetDir(project, asset.id);
      await fs.mkdir(directory, { recursive: true });
      asset.visualEvidence = await extractKeyframes(project, asset);
      await persist(project);
      const result = asset.hasAudio ? await transcribe({
        videoPath: asset.path,
        projectDir: directory,
        projectId: project.id,
        audioPath: join(directory, "transcript-audio.wav"),
        publicAudioUrl: publicMediaBaseUrl ? `${publicMediaBaseUrl.replace(/\/$/, "")}/media/${project.id}/assets/${asset.id}/transcript-audio.wav` : null,
        onPass: (event) => onAsset({ asset, status: "transcribing", ...event }),
      }) : null;
      const transcript = result ? transcriptPayload(result) : { provider: "none", requestId: null, text: "", durationMs: Number(asset.durationMs) || 0, segments: [] };
      await fs.writeFile(join(directory, "transcript.json"), JSON.stringify(transcript, null, 2));
      if (result?.secondary) await fs.writeFile(join(directory, "transcript.whisper.json"), JSON.stringify(result.secondary, null, 2));
      asset.transcript = transcript;
      asset.audioSha256 = result?.audioSha256 || null;
      asset.analysisStatus = "ready";
      asset.analysisError = null;
      await onAsset({ asset, status: "ready" });
    } catch (error) {
      asset.analysisStatus = "failed";
      asset.analysisError = String(error?.message || error || "素材分析失败");
      lastError = error instanceof Error ? error : new Error(asset.analysisError);
      await onAsset({ asset, status: "failed", error: asset.analysisError });
    }
    await persist(project);
  }
  const failed = project.assets.filter((asset) => asset.analysisStatus === "failed");
  const pending = project.assets.filter((asset) => !["ready", "complete"].includes(asset.analysisStatus));
  project.assetAnalysis = {
    status: failed.length ? "failed" : pending.length ? "pending" : "ready",
    completed: project.assets.length - failed.length - pending.length,
    failed: failed.length,
    updatedAt: new Date().toISOString(),
  };
  await persist(project);
  if (failed.length || pending.length) throw lastError || new Error(`还有 ${pending.length} 个素材未完成分析`);
  assertMultiAssetReady(project);
  return project.assetAnalysis;
}

export function buildAssetInventory(project) {
  if (project?.workflowMode !== "multi-asset-v1") throw new Error("只有多素材项目可以生成素材清单");
  const assets = project.assets || [];
  if (assets.some((asset) => asset.analysisStatus === "failed")) throw new Error("素材分析失败，请先重试失败素材");
  if (assets.some((asset) => !["ready", "complete"].includes(asset.analysisStatus))) throw new Error("所有素材必须完成分析后才能生成清单");
  return {
    projectId: String(project.id),
    createdAt: new Date().toISOString(),
    brief: project.brief || null,
    assets: assets.map((asset) => ({
      id: String(asset.id),
      filename: String(asset.filename || ""),
      role: String(asset.role || "supporting"),
      label: String(asset.label || asset.filename || ""),
      durationMs: Math.max(0, Number(asset.durationMs) || 0),
      width: Math.max(0, Number(asset.width) || 0),
      height: Math.max(0, Number(asset.height) || 0),
      hasAudio: Boolean(asset.hasAudio),
      licenseConfirmed: Boolean(asset.licenseConfirmed),
      sha256: asset.sha256 || null,
      audioSha256: asset.audioSha256 || null,
      visualEvidence: asset.visualEvidence ? { filename: asset.visualEvidence.filename, keyframeTimesMs: asset.visualEvidence.keyframeTimesMs, width: asset.visualEvidence.width, height: asset.visualEvidence.height } : null,
      transcript: asset.transcript ? { text: String(asset.transcript.text || ""), durationMs: Number(asset.transcript.durationMs) || 0, segments: asset.transcript.segments || [] } : null,
    })),
  };
}
