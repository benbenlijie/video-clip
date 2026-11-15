# Transcript Correction Timing Design

## Intent

When a user corrects subtitle text, Wayne should update the segment's word timings automatically so the user does not need to describe how the edit should preserve that sentence. The existing preview and source transcript remain intact.

## Behavior

- Compare the old and corrected text as Unicode grapheme sequences.
- Preserve timing spans for unchanged graphemes. Distribute replacement graphemes over the old changed span; distribute inserted graphemes inside the nearest existing recognition-word span.
- Mark reconstructed word timings as estimated. They are anchored to the original ASR timing data and are not a claim that the audio was re-heard.
- If the old word timings are missing, invalid, or cannot safely host the text diff, mark the corrected segment as protected.
- For older saved projects without the protection marker, infer protection when saved word timings are missing, invalid, or do not match the current transcript text.
- Before media tools render from an edit plan, automatically expand a partial cut across a protected segment to retain the full segment. A plan that removes the entire segment may still do so. The plan adjustment is recorded and shown to the editor agent so subtitles and media are regenerated from the same plan.
- Keep final subtitle text and timeline QC enabled as a defense against unrelated text or timing errors.

## Approaches

1. **Text-diff timing with a protected-segment fallback (selected).** Reuse the ASR word intervals, map unchanged and changed graphemes locally, then preserve the entire corrected segment if the available intervals cannot support that mapping. No new service or per-correction API call is required.
2. **Run a forced aligner after every correction.** This may produce tighter acoustic alignment, but needs a new tool/model path, adds latency and operational cost, and still requires a fallback when alignment fails.

## Constraints and non-goals

- Do not add dependencies or make a new ASR/Claude API call when the user saves a correction.
- Never mutate the original ASR transcript or its timing evidence.
- Do not fabricate word-level precision from segment duration alone.
- Do not change the corrected text, segment identity, or source segment bounds.
- This change does not implement a forced-alignment model or redesign the transcript editor UI.

## Acceptance

- Same-length substitutions keep unaffected character timing spans and re-time only the replacement span.
- Insertions/deletions update affected local timings without negative, reversed, out-of-segment, or overlapping intervals.
- Invalid source timings trigger protected-segment behavior rather than guessed word timings.
- Protected segments are made whole in the edit plan before rendering; fully removing one remains valid.
- Existing subtitle text, timeline, and render QC continue to reject genuine mismatches.
