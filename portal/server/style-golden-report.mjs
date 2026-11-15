import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERIOUS_FAILURE_CODES = new Set([
  "rights-reference-reuse",
  "rights-asset-unlicensed",
  "security-unapproved-style",
]);

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length * 10) / 10 : null;
}

function failureCounts(pairs) {
  const counts = {};
  for (const pair of pairs) {
    for (const code of pair?.humanReview?.primaryFailureCodes || []) {
      const key = String(code || "").trim();
      if (key) counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function validProvenance(pair, qc) {
  const provenance = qc?.styleProvenance;
  const hashes = ["styleManifestSha256", "styleProjectHash", "referenceAnalysisSha256", "styleApplicationSha256"];
  return Boolean(provenance)
    && String(provenance.stylePackId || "") === String(pair?.stylePack?.id || "")
    && Number(provenance.styleVersion) === Number(pair?.stylePack?.version)
    && hashes.every((key) => /^[a-f0-9]{64}$/i.test(String(provenance[key] || "")));
}

export function buildGoldenReport(labels, { qcEvidence = null } = {}) {
  if (!labels || labels.contract !== "style-golden-labels.v1") throw new Error("invalid golden label contract");
  if (!Array.isArray(labels.pairs) || labels.pairs.length !== 10) throw new Error("golden labels require exactly 10 pairs");
  const evidenceMode = qcEvidence != null;
  const minimumThresholds = {
    hardQcMinimumPasses: 8,
    meanStyleSimilarity: 3.8,
    meanEditNaturalness: 4,
    meanSubtitleReadability: 4.2,
    minimumWillingToDeliver: 8,
  };
  const thresholds = Object.fromEntries(Object.entries(minimumThresholds).map(([key, minimum]) => [
    key,
    Math.max(minimum, Number(labels.reviewThresholds?.[key]) || minimum),
  ]));
  const blockers = [];
  if (labels.datasetStatus !== "reviewed") blockers.push({ code: "evaluation-incomplete", message: "完成并评审全部 10 组样本后才能评估发布" });
  if (labels.pairs.filter((pair) => pair.mode === "single-video-v1").length !== 5) blockers.push({ code: "mode-coverage-invalid", message: "单视频必须正好 5 组" });
  if (labels.pairs.filter((pair) => pair.mode === "multi-asset-v1").length !== 5) blockers.push({ code: "mode-coverage-invalid", message: "多素材必须正好 5 组" });
  for (const aspect of ["9:16", "16:9"]) {
    if (labels.pairs.filter((pair) => pair.aspectRatio === aspect).length < 4) blockers.push({ code: "aspect-coverage-invalid", message: `${aspect} 至少需要 4 组` });
  }
  for (const key of ["hasCaptions", "hasBroll"]) {
    const values = new Set(labels.pairs.map((pair) => pair.reference?.[key]));
    if (!values.has(true) || !values.has(false)) blockers.push({ code: "reference-coverage-invalid", message: `参考矩阵必须同时覆盖 ${key}=true 和 false` });
  }
  if (new Set(labels.pairs.map((pair) => pair.id)).size !== labels.pairs.length) blockers.push({ code: "duplicate-pair-id", message: "黄金样本 pair id 必须唯一" });
  const incompletePairs = labels.pairs.filter((pair) => !pair.styleQc || typeof pair.styleQc.passed !== "boolean"
    || !pair.humanReview || !Number.isFinite(Number(pair.humanReview.styleSimilarity))
    || !Number.isFinite(Number(pair.humanReview.subtitleReadability))
    || !Number.isFinite(Number(pair.humanReview.editNaturalness))
    || typeof pair.humanReview.willingToDeliver !== "boolean"
    || !pair.consent?.referenceClearedForEvaluation
    || !pair.consent?.userMediaClearedForEvaluation
    || !Array.isArray(pair.consent?.reviewerIds)
    || pair.consent.reviewerIds.length === 0
    || (evidenceMode && (!qcEvidence[pair.id]?.qc || qcEvidence[pair.id]?.error)));
  if (incompletePairs.length) blockers.push({ code: "evaluation-incomplete", message: `仍有 ${incompletePairs.length} 组缺少授权、QC 或人工评分` });
  const invalidScores = labels.pairs.flatMap((pair) => ["styleSimilarity", "subtitleReadability", "editNaturalness"]
    .filter((key) => {
      const value = Number(pair.humanReview?.[key]);
      return Number.isFinite(value) && (value < 1 || value > 5);
    }));
  if (invalidScores.length) blockers.push({ code: "human-score-out-of-range", message: "人工评分必须全部位于 1–5" });
  if (labels.pairs.some((pair) => !pair.consent?.referenceClearedForEvaluation || !pair.consent?.userMediaClearedForEvaluation)) {
    blockers.push({ code: "evaluation-consent-missing", message: "所有参考和用户媒体必须明确授权评估" });
  }
  if (evidenceMode) {
    const missingHash = labels.pairs.filter((pair) => !/^[a-f0-9]{64}$/i.test(String(pair.styleQc?.sha256 || "")));
    const hashMismatch = labels.pairs.filter((pair) => {
      const evidence = qcEvidence[pair.id];
      return evidence?.qc && /^[a-f0-9]{64}$/i.test(String(pair.styleQc?.sha256 || "")) && evidence.sha256 !== String(pair.styleQc.sha256).toLowerCase();
    });
    const contractMismatch = labels.pairs.filter((pair) => qcEvidence[pair.id]?.qc && qcEvidence[pair.id].qc.contract !== "style-qc.v1");
    const passedMismatch = labels.pairs.filter((pair) => {
      const qc = qcEvidence[pair.id]?.qc;
      return qc && (typeof qc.passed !== "boolean" || qc.passed !== pair.styleQc?.passed);
    });
    const provenanceMismatch = labels.pairs.filter((pair) => qcEvidence[pair.id]?.qc && !validProvenance(pair, qcEvidence[pair.id].qc));
    if (missingHash.length) blockers.push({ code: "qc-sha256-missing", message: `${missingHash.length} 组缺少 style-qc.json SHA-256` });
    if (hashMismatch.length) blockers.push({ code: "qc-sha256-mismatch", message: `${hashMismatch.length} 组 style-qc.json 哈希不一致` });
    if (contractMismatch.length) blockers.push({ code: "qc-contract-invalid", message: `${contractMismatch.length} 组 style-qc 文件合同无效` });
    if (passedMismatch.length) blockers.push({ code: "qc-pass-label-mismatch", message: `${passedMismatch.length} 组 QC 文件与标签通过状态不一致` });
    if (provenanceMismatch.length) blockers.push({ code: "qc-provenance-invalid", message: `${provenanceMismatch.length} 组 QC 文件缺少匹配的 StylePack/manifest/project/reference/application 哈希` });
  }
  const hardQcPassCount = labels.pairs.filter((pair) => evidenceMode
    ? qcEvidence[pair.id]?.qc?.passed === true
    : pair.styleQc?.passed === true).length;
  const willingToDeliverCount = labels.pairs.filter((pair) => pair.humanReview?.willingToDeliver === true).length;
  const means = {
    styleSimilarity: mean(labels.pairs.map((pair) => pair.humanReview?.styleSimilarity)),
    subtitleReadability: mean(labels.pairs.map((pair) => pair.humanReview?.subtitleReadability)),
    editNaturalness: mean(labels.pairs.map((pair) => pair.humanReview?.editNaturalness)),
  };
  if (hardQcPassCount < thresholds.hardQcMinimumPasses) blockers.push({ code: "hard-qc-below-threshold", message: `硬 QC 通过 ${hardQcPassCount}/10，要求 ${thresholds.hardQcMinimumPasses}/10` });
  if (means.styleSimilarity == null || means.styleSimilarity < thresholds.meanStyleSimilarity) blockers.push({ code: "mean-style-similarity-below-threshold", message: `风格相似度均值 ${means.styleSimilarity ?? "缺失"}，要求 ${thresholds.meanStyleSimilarity}` });
  if (means.subtitleReadability == null || means.subtitleReadability < thresholds.meanSubtitleReadability) blockers.push({ code: "mean-subtitle-readability-below-threshold", message: `字幕可读性均值 ${means.subtitleReadability ?? "缺失"}，要求 ${thresholds.meanSubtitleReadability}` });
  if (means.editNaturalness == null || means.editNaturalness < thresholds.meanEditNaturalness) blockers.push({ code: "mean-edit-naturalness-below-threshold", message: `剪辑自然度均值 ${means.editNaturalness ?? "缺失"}，要求 ${thresholds.meanEditNaturalness}` });
  if (willingToDeliverCount < thresholds.minimumWillingToDeliver) blockers.push({ code: "willing-to-deliver-below-threshold", message: `愿意交付 ${willingToDeliverCount}/10，要求 ${thresholds.minimumWillingToDeliver}/10` });
  const codes = failureCounts(labels.pairs);
  const serious = Object.keys(codes).filter((code) => SERIOUS_FAILURE_CODES.has(code));
  if (serious.length) blockers.push({ code: "serious-rights-or-safety-failure", message: `存在阻断型失败：${serious.join(", ")}` });
  return {
    contract: "style-golden-report.v1",
    checkedAt: new Date().toISOString(),
    releaseReady: blockers.length === 0,
    thresholds,
    pairCount: labels.pairs.length,
    hardQcPassCount,
    qcEvidenceCount: evidenceMode ? labels.pairs.filter((pair) => qcEvidence[pair.id]?.qc).length : null,
    willingToDeliverCount,
    means,
    failureCodeCounts: codes,
    blockers,
  };
}

export async function loadQcEvidence(labels, labelsPath) {
  const base = dirname(resolve(labelsPath));
  const evidence = {};
  for (const pair of labels.pairs || []) {
    if (!pair?.id || !pair.styleQc?.path) continue;
    try {
      const text = await fs.readFile(resolve(base, pair.styleQc.path), "utf8");
      evidence[pair.id] = {
        qc: JSON.parse(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      };
    } catch (error) {
      evidence[pair.id] = { error: error.message };
    }
  }
  return evidence;
}

async function main() {
  const labelsPath = process.argv[2] || process.env.WAYNE_STYLE_GOLDEN_LABELS;
  if (!labelsPath) throw new Error("usage: node server/style-golden-report.mjs /private/labels.local.json");
  const labels = JSON.parse(await fs.readFile(resolve(labelsPath), "utf8"));
  const qcEvidence = await loadQcEvidence(labels, labelsPath);
  const report = buildGoldenReport(labels, { qcEvidence });
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await fs.writeFile(resolve(outputPath), text);
  else process.stdout.write(text);
  if (!report.releaseReady) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
