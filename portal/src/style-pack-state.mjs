export function stylePanelState({ reference = null, stylePack = null, busy = false, error = "", projectStyleId = null, projectStyleVersion = null } = {}) {
  if (error) return { key: "error", label: "失败", detail: error, canAnalyze: true, canGenerate: Boolean(reference?.analysisId), canApprove: false, canApply: false, canPreview: false };
  if (busy) return { key: "generating", label: "处理中", detail: "正在分析参考视频或生成风格工程，请稍候。", canAnalyze: false, canGenerate: false, canApprove: false, canApply: false, canPreview: false };
  if (!reference) return { key: "empty", label: "等待参考", detail: "上传一条参考视频，提取节奏、字幕、布局和 B-roll 结构。", canAnalyze: true, canGenerate: false, canApprove: false, canApply: false, canPreview: false };
  if (!stylePack) return { key: "analyzed", label: "已分析", detail: "参考分析已完成，可以生成受控 Remotion 风格工程。", canAnalyze: true, canGenerate: true, canApprove: false, canApply: false, canPreview: false };
  if (stylePack.status === "rejected") return { key: "rejected", label: "已拒绝", detail: "这个风格包未通过审批，请重新生成或调整参数。", canAnalyze: true, canGenerate: true, canApprove: false, canApply: false, canPreview: false };
  if (stylePack.status !== "approved") return { key: "pending", label: "待审批", detail: "风格工程已生成，审批后才能应用到用户项目。", canAnalyze: true, canGenerate: false, canApprove: true, canApply: false, canPreview: false };
  if (String(projectStyleId || "") === String(stylePack.id) && Number(projectStyleVersion) !== Number(stylePack.version)) {
    return { key: "stale", label: "版本已过期", detail: "有更新的已审批风格版本，重新应用后才会使用新参数。", canAnalyze: true, canGenerate: true, canApprove: false, canApply: true, canPreview: false };
  }
  if (String(projectStyleId || "") === String(stylePack.id) && Number(projectStyleVersion) === Number(stylePack.version)) {
    return { key: "applied", label: "已应用", detail: "当前项目已使用这个风格版本，可以生成 style proof 或继续审片。", canAnalyze: true, canGenerate: false, canApprove: false, canApply: false, canPreview: true };
  }
  return { key: "approved", label: "可应用", detail: "风格包已审批，可以应用到当前口播项目。", canAnalyze: true, canGenerate: false, canApprove: false, canApply: true, canPreview: false };
}

export function defaultStyleCopy(analysis = null) {
  return {
    copyCaptions: true,
    copyRhythm: true,
    copyLayout: true,
    copyBroll: Boolean(analysis?.capabilities?.needsBroll),
    copyAudio: true,
  };
}

export function pickStylePackForAnalysis(stylePacks = [], analysisId = "") {
  const matches = Array.isArray(stylePacks)
    ? stylePacks.filter((stylePack) => String(stylePack?.manifest?.sourceAnalysisId || "") === String(analysisId || ""))
    : [];
  if (!matches.length) return null;
  return [...matches].sort((a, b) => Number(b.version) - Number(a.version))[0];
}

export function gateStylePanelState(state, capabilities = {}) {
  return {
    ...state,
    canAnalyze: Boolean(state.canAnalyze && capabilities.analyze !== false),
    canGenerate: Boolean(state.canGenerate && capabilities.manage !== false),
    canApprove: Boolean(state.canApprove && capabilities.manage !== false),
    canApply: Boolean(state.canApply && capabilities.apply !== false),
    canPreview: Boolean(state.canPreview && capabilities.preview !== false),
  };
}

export function selectStyleProof(project = {}) {
  const expectedVersion = Number(project.styleVersion ?? project.stylePack?.version);
  const expectedApplicationHash = String(project.styleApplicationHash || "");
  const proofs = (project.artifacts || [])
    .filter((artifact) => artifact?.kind === "style-preview" && artifact.url)
    .filter((artifact) => !Number.isInteger(expectedVersion) || Number(artifact.styleVersion) === expectedVersion)
    .filter((artifact) => !expectedApplicationHash || artifact.styleProvenance?.styleApplicationSha256 === expectedApplicationHash)
    .sort((a, b) => String(a.generatedAt || "").localeCompare(String(b.generatedAt || "")));
  const proof = proofs.at(-1);
  if (!proof) return null;
  return {
    name: String(proof.name || "style proof"),
    url: String(proof.url),
    ...(proof.generatedAt ? { generatedAt: String(proof.generatedAt) } : {}),
    ...(proof.styleVersion != null ? { styleVersion: Number(proof.styleVersion) } : {}),
  };
}
