import { validateEditPlan } from "./edit-plan.mjs";

export const TIMELINE_CONTRACT_VERSION = "timeline.v1";
export const RENDER_MANIFEST_CONTRACT_VERSION = "render-manifest.v1";

const SUPPORTED_ENGINES = new Set(["wayne", "remotion", "openchatcut"]);

function safeMedia(media) {
  if (!media) return null;
  const filename = String(media.filename || "input.mp4").replaceAll("\\", "/").split("/").at(-1) || "input.mp4";
  return {
    assetId: "source-video",
    filename,
    durationMs: Math.max(1, Number(media.durationMs) || 1),
    width: Math.max(1, Number(media.width) || 1),
    height: Math.max(1, Number(media.height) || 1),
    hasAudio: Boolean(media.hasAudio),
    hasVideo: Boolean(media.hasVideo),
  };
}

function safeTranscript(transcript) {
  if (!transcript) return null;
  return {
    language: transcript.language ? String(transcript.language) : null,
    segments: (Array.isArray(transcript.segments) ? transcript.segments : []).map((segment, index) => ({
      id: String(segment.id || `caption-${index + 1}`),
      startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(segment.endMs) || 0)),
      text: String(segment.text || ""),
    })).filter((segment) => segment.endMs > segment.startMs && segment.text.trim()),
  };
}

export function toTimelineV1(project) {
  if (!project?.id || !project?.media || !project?.plan) {
    throw new Error("生成 timeline.v1 需要项目、媒体信息和已确认的剪辑计划");
  }
  const media = safeMedia(project.media);
  const plan = validateEditPlan(project.plan, media.durationMs, {
    requireFiveShorts: false,
    allowCustomVisualEvents: true,
    brollAssets: project.brollAssets || [],
  });

  return {
    contract: TIMELINE_CONTRACT_VERSION,
    project: {
      id: String(project.id),
      workflowId: String(project.workflowId || "wayne-video-editing"),
      goal: String(project.goal || ""),
      style: String(project.style || ""),
      sourceVersion: Math.max(1, Number(project.editor?.version) || 1),
    },
    media,
    transcript: safeTranscript(project.transcript),
    assets: {
      broll: (project.brollAssets || []).map((asset) => ({
        id: String(asset.id),
        filename: String(asset.filename || "broll"),
        durationMs: Math.max(1, Number(asset.durationMs) || 1),
        width: Math.max(1, Number(asset.width) || 1),
        height: Math.max(1, Number(asset.height) || 1),
        licenseConfirmed: Boolean(asset.licenseConfirmed),
        licenseName: asset.licenseName ? String(asset.licenseName) : null,
        licenseUrl: asset.licenseUrl ? String(asset.licenseUrl) : null,
        sourceUrl: asset.sourceUrl ? String(asset.sourceUrl) : null,
        sha256: asset.sha256 ? String(asset.sha256) : null,
      })),
    },
    segments: plan.segments.map((segment) => ({
      id: String(segment.id),
      startMs: segment.startMs,
      endMs: segment.endMs,
      action: segment.action,
      title: segment.title,
      note: segment.note,
    })),
    visualEvents: plan.visualEvents.map((event) => ({ ...event })),
    brollEvents: plan.brollEvents.map((event) => ({ ...event })),
    shorts: plan.shorts.map((short) => ({ ...short })),
    music: project.music?.path ? {
      filename: String(project.music.filename || "music"),
      licenseConfirmed: Boolean(project.music.licenseConfirmed),
    } : null,
  };
}

export function createRenderManifest({ timeline, engine, engineVersion = null, status = "planned", inputs = null, artifacts = [], qc = null, error = null, createdAt = new Date().toISOString() }) {
  if (!timeline || timeline.contract !== TIMELINE_CONTRACT_VERSION) throw new Error("render manifest 需要 timeline.v1 输入");
  if (!SUPPORTED_ENGINES.has(engine)) throw new Error(`不支持的渲染引擎: ${engine}`);
  if (!new Set(["planned", "running", "completed", "failed", "disabled"]).has(status)) throw new Error(`无效的渲染状态: ${status}`);
  return {
    contract: RENDER_MANIFEST_CONTRACT_VERSION,
    projectId: timeline.project.id,
    timelineContract: timeline.contract,
    engine,
    engineVersion: engineVersion ? String(engineVersion) : null,
    status,
    createdAt,
    inputs: inputs ? {
      timelineSha256: inputs.timelineSha256 ? String(inputs.timelineSha256) : null,
      sourceMediaSha256: inputs.sourceMediaSha256 ? String(inputs.sourceMediaSha256) : null,
    } : { timelineSha256: null, sourceMediaSha256: null },
    artifacts: artifacts.map((artifact) => ({
      name: String(artifact.name),
      kind: String(artifact.kind || "output"),
      version: Math.max(1, Number(artifact.version) || timeline.project.sourceVersion),
      width: Number.isFinite(Number(artifact.width)) ? Number(artifact.width) : null,
      height: Number.isFinite(Number(artifact.height)) ? Number(artifact.height) : null,
      durationMs: Number.isFinite(Number(artifact.durationMs)) ? Number(artifact.durationMs) : null,
      sha256: artifact.sha256 ? String(artifact.sha256) : null,
    })),
    qc: qc ? { passed: Boolean(qc.passed), checks: Array.isArray(qc.checks) ? qc.checks.map(String) : [] } : null,
    error: error ? String(error) : null,
  };
}

export function getEngineAvailability({ remotion = false, openchatcut = false } = {}) {
  return {
    wayne: { enabled: true, mode: "integrated", license: "project-local" },
    remotion: { enabled: Boolean(remotion), mode: remotion ? "installed" : "not-installed", license: "free-license-eligibility-must-be-maintained" },
    openchatcut: { enabled: Boolean(openchatcut), mode: openchatcut ? "sidecar" : "disabled", license: "AGPL-3.0-or-later" },
    motionCanvas: { enabled: false, mode: "template-authoring-only", license: "MIT" },
  };
}
