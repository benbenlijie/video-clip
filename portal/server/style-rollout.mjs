const STAGES = {
  admin: {
    label: "内部管理",
    capabilities: { manage: true, analyze: true, apply: false, preview: false, export: false, multi: false },
  },
  preview: {
    label: "保存与预览",
    capabilities: { manage: true, analyze: true, apply: true, preview: true, export: false, multi: false },
  },
  single: {
    label: "单视频导出",
    capabilities: { manage: true, analyze: true, apply: true, preview: true, export: true, multi: false },
  },
  multi: {
    label: "多素材开放",
    capabilities: { manage: true, analyze: true, apply: true, preview: true, export: true, multi: true },
  },
};

const OFF_CAPABILITIES = { manage: false, analyze: false, apply: false, preview: false, export: false, multi: false };

export function referenceStyleConfig(env = process.env) {
  if (env.REFERENCE_STYLE_ENABLED !== "1") {
    return { enabled: false, stage: "off", label: "关闭", capabilities: { ...OFF_CAPABILITIES }, error: null };
  }
  const requested = String(env.REFERENCE_STYLE_STAGE || "admin").trim().toLowerCase();
  const stage = STAGES[requested];
  if (!stage) {
    return {
      enabled: false,
      stage: "off",
      label: "关闭",
      capabilities: { ...OFF_CAPABILITIES },
      error: `REFERENCE_STYLE_STAGE 必须是 ${Object.keys(STAGES).join("、")} 之一`,
    };
  }
  return { enabled: true, stage: requested, label: stage.label, capabilities: { ...stage.capabilities }, error: null };
}

export function assertReferenceStyleCapability(config, capability) {
  if (!config?.enabled) throw Object.assign(new Error("参考视频风格功能未启用"), { statusCode: 404 });
  if (!config.capabilities?.[capability]) throw Object.assign(new Error(`参考视频风格阶段“${config.label}”尚未开放 ${capability}`), { statusCode: 403 });
  return true;
}

export function assertStyleExportAllowed({ config, project }) {
  if (!project?.stylePackId) return true;
  if (!config?.enabled) throw Object.assign(new Error("参考视频风格功能未启用，不能导出风格成片"), { statusCode: 403 });
  if (!config.capabilities?.export) throw Object.assign(new Error("参考风格尚未开放导出；当前仅允许保存与预览"), { statusCode: 403 });
  if (project.workflowMode === "multi-asset-v1" && !config.capabilities.multi) throw Object.assign(new Error("参考风格多素材导出尚未开放"), { statusCode: 403 });
  return true;
}
