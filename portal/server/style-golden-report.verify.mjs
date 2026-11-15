import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGoldenReport, loadQcEvidence } from "./style-golden-report.mjs";

const thresholds = {
  hardQcMinimumPasses: 8,
  meanStyleSimilarity: 3.8,
  meanEditNaturalness: 4,
  meanSubtitleReadability: 4.2,
  minimumWillingToDeliver: 8,
};

function labelsWith({ hardPasses = 8, score = 5, willing = 8, consent = true } = {}) {
  return {
    contract: "style-golden-labels.v1",
    rubricVersion: "2026-11-13",
    datasetStatus: "reviewed",
    reviewThresholds: thresholds,
    pairs: Array.from({ length: 10 }, (_, index) => ({
      id: `${index < 5 ? "single" : "multi"}-${String(index % 5 + 1).padStart(2, "0")}`,
      mode: index < 5 ? "single-video-v1" : "multi-asset-v1",
      aspectRatio: index % 2 === 0 ? "9:16" : "16:9",
      reference: { hasCaptions: index % 3 !== 0, hasBroll: index % 4 !== 0 },
      styleQc: { passed: index < hardPasses, path: `style-qc-${index + 1}.json` },
      stylePack: { id: `style-${index + 1}`, version: 1 },
      humanReview: {
        styleSimilarity: score,
        subtitleReadability: score,
        editNaturalness: score,
        willingToDeliver: index < willing,
        primaryFailureCodes: index < hardPasses ? [] : ["style-rhythm-drift"],
        notes: "",
      },
      consent: { referenceClearedForEvaluation: consent, userMediaClearedForEvaluation: consent, reviewerIds: ["reviewer-1"] },
    })),
  };
}

const ready = buildGoldenReport(labelsWith());
assert.equal(ready.releaseReady, true);
assert.equal(ready.hardQcPassCount, 8);
assert.equal(ready.willingToDeliverCount, 8);
assert.deepEqual(ready.means, { styleSimilarity: 5, subtitleReadability: 5, editNaturalness: 5 });
assert.deepEqual(ready.failureCodeCounts, { "style-rhythm-drift": 2 });

const evidencedLabels = labelsWith();
evidencedLabels.pairs = evidencedLabels.pairs.map((pair) => ({
  ...pair,
  styleQc: { ...pair.styleQc, sha256: "a".repeat(64) },
}));
const qcEvidence = Object.fromEntries(evidencedLabels.pairs.map((pair) => [pair.id, {
  sha256: pair.styleQc.sha256,
  qc: {
    contract: "style-qc.v1",
    passed: pair.styleQc.passed,
    styleProvenance: {
      stylePackId: pair.stylePack.id,
      styleVersion: pair.stylePack.version,
      styleManifestSha256: "b".repeat(64),
      styleProjectHash: "c".repeat(64),
      referenceAnalysisSha256: "d".repeat(64),
      styleApplicationSha256: "e".repeat(64),
    },
  },
}]));
const evidenced = buildGoldenReport(evidencedLabels, { qcEvidence });
assert.equal(evidenced.releaseReady, true);
assert.equal(evidenced.qcEvidenceCount, 10);

const missingProvenanceEvidence = structuredClone(qcEvidence);
delete missingProvenanceEvidence[evidencedLabels.pairs[0].id].qc.styleProvenance;
const missingProvenance = buildGoldenReport(evidencedLabels, { qcEvidence: missingProvenanceEvidence });
assert.equal(missingProvenance.releaseReady, false);
assert.ok(missingProvenance.blockers.some((item) => item.code === "qc-provenance-invalid"));

const mismatchedHashEvidence = structuredClone(qcEvidence);
mismatchedHashEvidence[evidencedLabels.pairs[0].id].sha256 = "f".repeat(64);
const mismatchedHash = buildGoldenReport(evidencedLabels, { qcEvidence: mismatchedHashEvidence });
assert.equal(mismatchedHash.releaseReady, false);
assert.ok(mismatchedHash.blockers.some((item) => item.code === "qc-sha256-mismatch"));

const insufficient = buildGoldenReport(labelsWith({ hardPasses: 7, willing: 7 }));
assert.equal(insufficient.releaseReady, false);
assert.ok(insufficient.blockers.some((item) => item.code === "hard-qc-below-threshold"));
assert.ok(insufficient.blockers.some((item) => item.code === "willing-to-deliver-below-threshold"));

const unconsented = buildGoldenReport(labelsWith({ consent: false }));
assert.equal(unconsented.releaseReady, false);
assert.ok(unconsented.blockers.some((item) => item.code === "evaluation-consent-missing"));

const loweredThreshold = buildGoldenReport({
  ...labelsWith({ hardPasses: 7, willing: 7 }),
  reviewThresholds: { ...thresholds, hardQcMinimumPasses: 5, minimumWillingToDeliver: 5 },
});
assert.equal(loweredThreshold.releaseReady, false);
assert.ok(loweredThreshold.blockers.some((item) => item.code === "hard-qc-below-threshold"));

const invalidScore = buildGoldenReport(labelsWith({ score: 6 }));
assert.equal(invalidScore.releaseReady, false);
assert.ok(invalidScore.blockers.some((item) => item.code === "human-score-out-of-range"));

const incomplete = buildGoldenReport({
  ...labelsWith(),
  datasetStatus: "template-not-reviewed",
  pairs: labelsWith().pairs.map((pair) => ({ ...pair, styleQc: { ...pair.styleQc, passed: null } })),
});
assert.equal(incomplete.releaseReady, false);
assert.ok(incomplete.blockers.some((item) => item.code === "evaluation-incomplete"));

const evidenceRoot = await fs.mkdtemp(join(tmpdir(), "wayne-golden-report-"));
try {
  const fileLabels = labelsWith();
  for (const [index, pair] of fileLabels.pairs.entries()) {
    const relativePath = `qc/${pair.id}.json`;
    const qc = qcEvidence[pair.id].qc;
    const text = JSON.stringify(qc);
    await fs.mkdir(join(evidenceRoot, "qc"), { recursive: true });
    await fs.writeFile(join(evidenceRoot, relativePath), text);
    pair.styleQc.path = relativePath;
    pair.styleQc.sha256 = createHash("sha256").update(text).digest("hex");
    pair.stylePack = { id: `style-${index + 1}`, version: 1 };
  }
  const evidence = await loadQcEvidence(fileLabels, join(evidenceRoot, "labels.local.json"));
  assert.equal(Object.keys(evidence).length, 10);
  assert.equal(buildGoldenReport(fileLabels, { qcEvidence: evidence }).releaseReady, true);
} finally {
  await fs.rm(evidenceRoot, { recursive: true, force: true });
}

console.log("style-golden-report.verify: hard QC, score means, consent, willingness, failure counts, file evidence, and release blocking passed");
