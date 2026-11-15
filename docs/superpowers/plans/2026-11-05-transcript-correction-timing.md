# Transcript Correction Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Automatically remap word timings after subtitle corrections and protect a corrected segment as a whole when source timings cannot support a safe remap.

**Architecture:** Add a pure Unicode-grapheme timing remapper and call it from transcript review. Add an edit-plan helper that retains protected segments as complete intervals, then invoke it whenever the editor workspace writes or executes an edit plan, before rendering. Keep final subtitle QC as the last guard.

**Tech Stack:** Node.js ESM, built-in `Intl.Segmenter`, existing Node assert verification scripts; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-transcript-correction-timing-design.md`

## Global Constraints

- Do not add dependencies or make a new ASR/Claude API call when the user saves a correction.
- Never mutate the original ASR transcript or its timing evidence.
- Do not fabricate word-level precision from segment duration alone.
- Do not change the corrected text, segment identity, or source segment bounds.
- A whole corrected segment may be removed; a partial cut must retain it whole when alignment is protected.

## Review Focus

- Repeated graphemes can make alignment ambiguous; test repeated-character substitutions and ensure the timing map remains monotonic.
- Insertions at the beginning or end lack two anchors; test borrowing from the nearest ASR word interval.
- Punctuation and whitespace are excluded from timing alignment; test punctuation-only edits preserve the existing word timings.
- Missing, reversed, or incomplete ASR word timings must produce protected status rather than guessed mappings.
- Partial keep/remove plan ranges may cross the same protected sentence; test automatic whole-segment retention and full-segment deletion.

---

### Task 1: Remap corrected transcript timings

**Files:**
- Create: `portal/server/transcript-word-timing.mjs`
- Modify: `portal/server/transcript-review.mjs`
- Test: `portal/server/transcript-review.verify.mjs`

**Interface:** `remapWordTimings({ previousText, nextText, words, startMs, endMs })` returns reconstructed per-grapheme intervals or `null` when the source cannot safely support them.

- [x] Add failing verification cases for replacement, insertion, deletion, punctuation-only edits, Unicode graphemes, repeated text, and invalid source timing.
- [x] Run `node server/transcript-review.verify.mjs` and confirm failures describe the missing remap behavior.
- [x] Implement bounded edit-distance alignment over normalized graphemes; preserve equal spans, distribute replacements over replaced intervals, and allocate pure insertions within the nearest source word's interval.
- [x] Integrate correction results: set `wordTimingStatus: "estimated"` when remapping succeeds; clear stale words and set `wordTimingStatus: "protected"` when it fails.
- [x] Re-run the focused verification and confirm original transcript input remains unchanged.

### Task 2: Protect corrected segments in edit plans

**Files:**
- Modify: `portal/server/edit-plan.mjs`
- Test: `portal/server/edit-plan.verify.mjs`

**Interface:** `protectTranscriptCorrections(plan, transcript)` returns `{ plan, adjustedSegmentIds }`; for every protected segment, a partial keep becomes one full-range keep, while a fully removed segment remains removed.

- [x] Add failing cases for partial keep, mixed keep/remove, already-whole keep, and whole-segment removal.
- [x] Run `node server/edit-plan.verify.mjs` and confirm the partial-plan cases fail.
- [x] Implement interval splitting around protected source ranges and insert a full-range keep interval with an audit-friendly note.
- [x] Verify plan interval ordering, visual events, and B-roll remain valid after adjustment.

### Task 3: Apply protection before rendering and preserve clear QC

**Files:**
- Modify: `portal/server/video-agent-tools.mjs`
- Modify: `portal/server/claude-code-editor.mjs`
- Test: `portal/server/video-agent-tools.verify.mjs`
- Test: `portal/server/claude-code-editor.verify.mjs`
- Test: `portal/server/claude-remotion-tools.verify.mjs`

- [x] Add a failing MCP verification showing edit-plan writes and completed execute calls automatically persist the protected-range adjustment before subsequent render calls.
- [x] Run the focused MCP verification and confirm the protected interval remains partial before the implementation.
- [x] Normalize and persist `edit-plan.json` after `write_file` and after `execute`; audit changed segment IDs and return them to the editor agent.
- [x] Update the editor prompt to treat estimated timings as estimates, preserve protected segments automatically, and render again if a plan-writing command also produced media before normalization.
- [x] Keep final output validation rejecting any protected partial segment and genuine subtitle text/timeline mismatch.
- [x] Run focused editor and Remotion verification, including re-render warnings for wrapped commands and adjusted Remotion plan reporting.

### Final verification

- [x] Run `npm run verify` from `portal/`.
- [x] Run `npm run build` from `portal/`.
- [x] Run `git diff --check` and review the final worktree diff. Do not commit or restart services as part of this plan.
