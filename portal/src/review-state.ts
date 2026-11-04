export type ReviewArtifact = { name: string; url: string; kind: string; version?: number; durationMs?: number; width?: number; height?: number; engine?: string; createdBy?: string; slot?: number; title?: string };
type ReviewProject = {
  status: string;
  artifacts?: ReviewArtifact[];
  plan?: unknown;
  error?: string;
  proofreading?: { status: string; previewStale?: boolean } | null;
  editSession?: { status: string } | null;
  qc?: { passed: boolean; version?: number } | null;
};

export function reviewState(project?: ReviewProject | null, viewVersion: number | null = null, transcriptDraftDirty = false) {
  const artifacts = project?.artifacts || [];
  const playable = artifacts.filter((artifact) => ["preview", "video"].includes(artifact.kind));
  const versions = [...new Set(playable.map((artifact) => artifact.version || 1))].sort((a, b) => b - a);
  const latestVersion = versions[0] || 1;
  const displayVersion = viewVersion && versions.includes(viewVersion) ? viewVersion : latestVersion;
  const historical = displayVersion !== latestVersion;
  const displayArtifacts = artifacts.filter((artifact) => (artifact.version || 1) === displayVersion);
  const video = [...displayArtifacts].reverse().find((artifact) => artifact.kind === "video") || [...displayArtifacts].reverse().find((artifact) => artifact.kind === "preview") || null;
  const latestArtifacts = artifacts.filter((artifact) => (artifact.version || 1) === latestVersion);
  const preview = [...latestArtifacts].reverse().find((artifact) => artifact.kind === "preview") || null;
  const working = Boolean(project && (["inspecting", "transcribing", "planning", "rendering", "chat_editing"].includes(project.status) || project.editSession?.status === "running"));
  const reviewRequired = Boolean(project?.proofreading && !["ready", "confirmed"].includes(project.proofreading.status));
  const final = [...latestArtifacts].reverse().find((artifact) => artifact.kind === "video") || null;
  const downloadable = Boolean(final && !transcriptDraftDirty && !reviewRequired && !project?.proofreading?.previewStale && project?.status === "completed" && project.qc?.passed && (project.qc.version || 1) === latestVersion);
  const action = historical ? "back-latest" : working ? "working" : transcriptDraftDirty ? "save-subtitles" : reviewRequired ? "review-subtitles" : project?.proofreading?.previewStale ? "refresh-preview" : downloadable ? "download" : preview && project?.plan ? "export" : "retry";
  return { versions, latestVersion, displayVersion, historical, video, preview, final, latestArtifacts, displayArtifacts, working, reviewRequired, action, canSendEdit: Boolean(video && !historical && !working && !transcriptDraftDirty) };
}
