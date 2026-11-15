# Reference-style golden evaluation

This directory contains the evaluation rubric and an empty, committable label
template. It must not contain third-party videos, frames, audio, personal
media, brand assets, or generated customer deliverables.

Store approved media and completed labels in a private location outside Git,
for example:

```text
$WAYNE_STYLE_GOLDEN_DIR/
  labels.local.json
  single/
  multi/
```

## Required matrix

The MVP evaluation has 10 reference/user pairs:

| Pair | Mode | Aspect | Captions | B-roll |
|---|---|---:|---|---|
| single-01 | single-video-v1 | 9:16 | yes | yes |
| single-02 | single-video-v1 | 16:9 | yes | no |
| single-03 | single-video-v1 | 9:16 | no | yes |
| single-04 | single-video-v1 | 16:9 | no | no |
| single-05 | single-video-v1 | 9:16 | yes | no |
| multi-01 | multi-asset-v1 | 16:9 | yes | yes |
| multi-02 | multi-asset-v1 | 9:16 | yes | no |
| multi-03 | multi-asset-v1 | 16:9 | no | yes |
| multi-04 | multi-asset-v1 | 9:16 | no | no |
| multi-05 | multi-asset-v1 | 16:9 | yes | yes |

Five pairs must be single-video, five must be multi-asset. Each aspect ratio
has at least four pairs across the matrix.

## Review procedure

1. Copy `labels.example.json` to the private labels file and replace every
   `path`, hash, StylePack id, and review value with real evidence.
2. Watch the complete reference and user output. Do not score only a thumbnail
   or contact sheet.
3. Run the normal Style QC pipeline and attach its `style-qc.json` path,
   SHA-256, and outcome before human scoring. The release report reads the QC
   file itself and rejects missing files, hash mismatches, pass-state mismatches,
   or missing StylePack/manifest/project/reference/application provenance.
4. Score each output independently. Reviewers must not see another reviewer's
   score before submitting.
5. Record failure codes and a short factual note for every score below 4.
6. Resolve disagreements of 2 or more points with a second review.

## Score anchors

### Style similarity

- `5`: unmistakably follows the reference editing grammar while using only the
  user's content.
- `4`: clearly similar rhythm, captions, and layout with minor deviations.
- `3`: recognizable similarity but at least one major style dimension drifts.
- `2`: only superficial similarity; the difference is visible immediately.
- `1`: not recognizably related to the reference style.

### Subtitle readability

- `5`: every cue is readable without pausing; safe position and contrast.
- `4`: consistently readable with one minor crowding or timing issue.
- `3`: mostly readable but needs manual correction before delivery.
- `2`: frequent overlap, clipping, poor contrast, or unsafe face coverage.
- `1`: unusable or materially misleading.

### Edit naturalness

- `5`: cuts, Hook, B-roll, captions, and audio feel intentional and publishable.
- `4`: natural with minor polish left.
- `3`: coherent but noticeably mechanical or uneven.
- `2`: frequent pacing, transition, or audio problems.
- `1`: unwatchable.

## MVP release thresholds

- At least 8 of 10 pairs pass every automated hard gate.
- Mean style similarity is at least 3.8.
- Mean edit naturalness is at least 4.0.
- Mean subtitle readability is at least 4.2.
- `willingToDeliver` is true for at least 8 of 10 pairs.
- No pair may have reference footage, audio, person, brand, or transcript
  reuse, an unlicensed asset, or an unapproved StyleProject.
- Any serious safety or rights failure blocks release regardless of the score
  average.

These thresholds are provisional until a human evaluator reviews the first
complete 10-pair run.

## Failure taxonomy

- `rights-reference-reuse`
- `rights-asset-unlicensed`
- `security-unapproved-style`
- `qc-black-frames`
- `qc-av-sync`
- `qc-caption-face-overlap`
- `style-hook-weak`
- `style-rhythm-drift`
- `style-layout-drift`
- `style-caption-drift`
- `style-broll-overuse`
- `style-audio-drift`
- `edit-naturalness`
- `caption-readability`
- `render-artifact`
- `analysis-low-confidence`

## Reporting

The local run should produce a report containing:

- hard-QC pass count and failed pair ids
- automation evidence that no reference material entered the output
- score averages and distribution
- customer-delivery willingness count
- failure-code frequency
- every pair that missed a threshold
- reviewer ids and review dates

Do not commit the generated report if it contains personal names, private
filenames, customer media, or review comments that identify a person.
