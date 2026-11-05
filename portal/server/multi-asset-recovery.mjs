const INTERRUPTED_STATUSES = new Set(["analyzing_assets", "planning", "rendering_preview", "rendering"]);

function previewIsCurrent(project) {
  const preview = project.multiAssetPreview;
  return Boolean(preview?.qc?.passed)
    && Number(preview.planVersion) === Number(project.multiAssetPlan?.version)
    && Number(preview.inputRevision) === Number(project.multiAssetRevision || 0);
}

function finalOutputIsCurrent(project) {
  return (project.artifacts || []).some((artifact) => artifact.kind === "video"
    && Number(artifact.planVersion) === Number(project.multiAssetPlan?.version)
    && Number(artifact.inputRevision) === Number(project.multiAssetRevision || 0));
}

export function recoverInterruptedMultiAssetProject(project) {
  if (project?.workflowMode !== "multi-asset-v1" || !INTERRUPTED_STATUSES.has(project.status)) return false;
  const interruptedStatus = project.status;
  if (interruptedStatus === "analyzing_assets") {
    for (const asset of project.assets || []) if (asset.analysisStatus === "running") asset.analysisStatus = "pending";
    project.assetAnalysis = { ...(project.assetAnalysis || {}), status: "pending", currentAssetId: null, currentStatus: null, recoveredAt: new Date().toISOString() };
    project.status = "needs_input";
    project.error = "服务在素材分析完成前重启；已完成素材保留，可重新开始分析";
    return true;
  }

  const hasPlan = Boolean(project.multiAssetPlan);
  const planConfirmed = Boolean(project.multiAssetPlan?.confirmed);
  if (interruptedStatus === "rendering" && finalOutputIsCurrent(project)) project.status = "completed";
  else if (interruptedStatus === "rendering_preview" && previewIsCurrent(project)) project.status = "preview_ready";
  else if (previewIsCurrent(project)) project.status = "preview_ready";
  else if (planConfirmed) project.status = "plan_confirmed";
  else if (hasPlan) project.status = "plan_ready";
  else project.status = project.assetAnalysis?.status === "ready" ? "assets_ready" : "needs_input";

  project.error = `服务在${interruptedStatus === "planning" ? "生成方案" : interruptedStatus === "rendering_preview" ? "生成预览" : "正式渲染"}期间重启；已保留上一版方案和产物，可重试`;
  return true;
}
