# Transcript Audio Proofreading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare the existing cloud transcript with a local CPU Whisper pass, let Claude proofread both in the existing edit-planning call, and carry the reviewed text into the final subtitles.

**Architecture:** Extract one WAV, then start the existing cloud-ASR fallback chain and local Whisper.cpp independently with `Promise.allSettled`. Keep Volcengine/Tencent behavior intact; a local failure must not discard a successful cloud transcript. Pass both results into the existing Claude Code plan call, persist the original, secondary, corrected transcript and change report, and let the user resolve uncertain text before final rendering.

**Tech Stack:** Node.js ESM, `whisper.cpp` v1.9.2 CLI, React/TypeScript, existing FFmpeg and project store.

**Spec:** `docs/superpowers/specs/2026-11-02-transcript-audio-proofreading-design.md`

## Global Constraints

- Use the verified `small-q5_1` CPU model by default; model file is about 190 MB.
- Always pass `--no-gpu`; default to 8 CPU threads, capped by the configured value.
- Run cloud ASR and local Whisper only after one shared WAV extraction; cloud-provider fallback order stays Volcengine then Tencent.
- Do not start an additional Claude API session for proofreading; include both transcripts in the existing `plan` phase.
- A failed or missing Whisper binary/model must leave a successful cloud transcript usable and visibly request human proofreading.
- Never overwrite the original cloud transcript; corrected text and per-change reasons remain traceable.
- Keep model and CLI outside Git and avoid global/system installation. Reuse the hash-verified benchmark files under `/tmp/wayne-whisper-cpu-20261104/` for this host.
- Never call a cloud ASR or Claude API during verification.

## Review Focus

- One ASR finishing early must not cause the second task to be skipped; prove both start before either is awaited.
- Both pass callbacks must not race through `project-store.mjs`'s shared `.project.json.tmp`; serialize project saves or save one combined state after both settle.
- A failed local process must not turn a successful cloud transcript into a failed project; test missing binary, timeout and non-zero exit.
- Concurrent projects must not launch multiple 8-thread Whisper processes; test the single local inference slot.
- A restart or retry must not replace the original transcript with a partial/failed local result.
- Replacing the Whisper CLI/model bytes or changing inference parameters must invalidate the secondary transcript cache.
- Manual correction must invalidate stale subtitle state and be the text loaded for final render.

## File Map

- Create `portal/server/local-whisper.mjs` for CLI config, bounded process execution, SRT normalization and a one-process CPU slot.
- Create `portal/server/local-whisper.verify.mjs` for runner and normalization tests.
- Modify `portal/server/transcription.mjs` to expose the single extracted WAV to both recognition paths and persist separate results.
- Create `portal/server/transcription.verify.mjs` for parallel-start, fallback, partial-failure and persistence tests.
- Modify `portal/server/index.mjs` for per-pass status, environment loading, project persistence and transcript-correction API.
- Modify `portal/server/claude-code-editor.mjs` and its verification for dual-transcript input, correction artifacts and validation.
- Modify `portal/src/App.tsx` and `portal/src/styles.css` for parallel progress and the uncertain/manual correction view.
- Modify `portal/package.json`, `portal/.env.example` and `portal/README.md` for checks and local model setup.

### Task 1: Add the local Whisper.cpp runner

**Files:**
- Create: `portal/server/local-whisper.mjs`
- Create: `portal/server/local-whisper.verify.mjs`
- Modify: `portal/package.json`
- Modify: `portal/.env.example`
- Modify: `portal/README.md`

**Interfaces:**
- `getWhisperConfig(env = process.env)` returns `{ cliPath, modelPath, threads, timeoutMs, available }`; `available` is true only when both files exist and the configuration is valid.
- `transcribeWithWhisper({ audioPath, config, spawnImpl = spawn })` returns `{ provider: "whisper.cpp", model: "small-q5_1", durationMs, text, segments }` or throws a bounded error that does not include secrets.
- Configuration keys: `WAYNE_WHISPER_CLI_PATH`, `WAYNE_WHISPER_MODEL_PATH`, `WAYNE_WHISPER_THREADS` (default `8`), and `WAYNE_WHISPER_TIMEOUT_MS` (default `1800000`).
- Store the verified release directory and model in ignored `portal/storage/whisper/`; the CLI and its shared libraries stay together. Do not add them to the repository or install globally.

- [x] **Step 1: Write failing runner tests** for missing files, invalid thread count, Chinese SRT parsing with millisecond timestamps, `--no-gpu` and thread arguments, non-zero exit, timeout, and no more than one active local inference.
- [x] **Step 2: Run `node server/local-whisper.verify.mjs` and confirm expected failures.**
- [x] **Step 3: Implement the runner** with `spawn` argument arrays (no shell), bounded stderr, timeout/kill handling, SRT parsing and a FIFO single-process slot.
- [x] **Step 4: Copy the verified Linux x64 binary folder and `ggml-small-q5_1.bin` from `/tmp/wayne-whisper-cpu-20261104/` into ignored `portal/storage/whisper/`; verify both pinned SHA-256 hashes and run CLI `--version`.**
- [x] **Step 5: Run the runner tests and confirm they pass.**

### Task 2: Run both recognition paths in parallel

**Files:**
- Modify: `portal/server/transcription.mjs`
- Create: `portal/server/transcription.verify.mjs`
- Modify: `portal/server/index.mjs`
- Modify: `portal/package.json`

**Interfaces:**
- Refactor audio extraction into `extractAudio(videoPath, audioPath)`; call it once before either recognition task starts.
- Export `runRecognitionPasses({ cloud, local, onPass })`; invoke both functions immediately and return their independent settled results.
- `transcribeVideo` returns `{ primary, secondary, primaryStatus, secondaryStatus }`; `primary` is nullable if all existing cloud providers fail, and their Volcengine/Tencent fallback order remains unchanged. Preserve the cloud error separately so the route can retain its current failure message while saving any successful secondary result.
- Persist `transcript.original.json` and `transcript.whisper.json` independently; project state records each pass as `running`, `complete`, `failed`, or `unavailable`, plus the selected model and a sanitized error.

- [x] **Step 1: Write a barrier-based test** proving cloud and local recognizers both start before either promise resolves; add tests for local failure with cloud success and unchanged Volcengine-to-Tencent fallback order.
- [x] **Step 2: Run `node server/transcription.verify.mjs` and confirm expected failures.**
- [x] **Step 3: Refactor `transcribeVideo`** so the primary provider chain and local Whisper run in parallel on the same extracted WAV. Use `Promise.allSettled`; keep the cloud transcript as the active transcript when Whisper is unavailable.
- [x] **Step 4: Persist each pass result to its own atomic artifact as it completes**; after both settle, mutate and save project state once, avoiding concurrent writes to the shared project-store temp file. Reuse a completed local result on retry only when its WAV SHA-256, model id, CLI/model file identity and inference settings match.
- [x] **Step 5: Integrate `transcribeWithWhisper`, expose statuses through `projectView`, load only the four allowlisted Whisper env keys, and add both verification scripts to `npm run verify`.**
- [x] **Step 6: Run transcription tests and confirm concurrent execution and independent failure handling.**

### Task 3: Proofread in the existing Claude plan call

**Files:**
- Modify: `portal/server/claude-code-editor.mjs`
- Modify: `portal/server/claude-code-editor.verify.mjs`
- Modify: `portal/agent-skills/video-edit/SKILL.md`

**Interfaces:**
- Plan workspace receives `transcript.original.json` and, when available, `transcript.whisper.json`; `transcript.json` remains the final active transcript.
- Claude writes `transcript-proofread.json` with `{ transcript: { language, text, durationMs, segments }, changes: [{ segmentId, before, after, evidence, reason }], unresolved: [{ segmentId, primaryText, secondaryText, reason }] }`.
- If Whisper is unavailable, Claude must leave the primary transcript unchanged and record `status: "manual_review_required"`; it must not claim an audio-based correction.
- Server validation rejects malformed timestamps, missing original text coverage, corrections without an evidence source, and missing proofread output when Whisper succeeded.

- [x] **Step 1: Add failing validation tests** for valid correction output, unresolved disagreement, missing correction artifact, malformed timestamp, and changes unsupported by either source transcript.
- [x] **Step 2: Run `node server/claude-code-editor.verify.mjs` and confirm expected failures.**
- [x] **Step 3: Write both source transcripts into the workspace and update the existing `plan` prompt** to compare them, correct only supported words, preserve oral wording, and emit the correction schema before building the edit plan.
- [x] **Step 4: Validate and persist the corrected active transcript plus `transcript-corrections.json`; keep original and Whisper source files immutable.**
- [x] **Step 5: Verify missing Whisper output falls back to the original transcript and the existing single plan call remains the only Claude call in this phase.**

### Task 4: Surface unresolved text and protect final subtitles

**Files:**
- Modify: `portal/server/index.mjs`
- Modify: `portal/server/claude-code-editor.mjs`
- Modify: `portal/server/claude-code-editor.verify.mjs`
- Modify: `portal/server/render.mjs` or the Claude output validator, depending on where the authoritative SRT is assembled
- Modify: `portal/src/App.tsx`
- Modify: `portal/src/styles.css`

**Interfaces:**
- Add `POST /api/projects/:id/transcript` accepting `{ segments: [{ startMs, endMs, text }], confirmedUnresolvedSegmentIds: string[] }`; validate finite ordered timestamps and require an explicit confirmation for every unresolved segment before updating the active transcript plus `transcript.srt`. Original ASR artifacts stay unchanged.
- Review UI shows model results, correction reasons and unresolved segments; each row can play the original WAV at its timestamp and edit the text. When local Whisper is unavailable, allow review of the full primary transcript.
- Saving a correction updates the exact transcript supplied to final render and clears its resolved marker. A transcript edit marks any existing caption preview as stale so the UI does not present it as matching the corrected text.
- Final SRT must match the active corrected transcript segment text and time range; unresolved rows block final export until edited or explicitly retained by the user.

- [x] **Step 1: Write failing API tests** for valid edits, invalid timestamps, original transcript preservation, corrected SRT persistence, and unresolved-export blocking.
- [x] **Step 2: Run the focused API verification and confirm expected failures.**
- [x] **Step 3: Implement the correction endpoint** with no ASR or Claude calls and invalidate any subtitle artifact whose text no longer matches.
- [x] **Step 4: Add responsive review controls** for unresolved text and local Whisper unavailable/manual review; keep buttons and audio seek controls touch-accessible.
- [x] **Step 5: Add QC comparison** between active transcript segments and final SRT; fail the export if unresolved text remains or caption text is missing/rewritten.
- [x] **Step 6: Run `npm run typecheck`, `npm run build`, and `npm run verify`; confirm a corrected transcript is what `prepareWorkspace` supplies to the final render phase.**

## Execution Handoff

The implementation was completed natively in the listed order. See the completion ledger below for verification results and deferred items.


## Completion Ledger — 2026-11-04

- All 22 implementation steps are complete. Fresh checks passed: `npm run typecheck`, `npm run build`, and `npm run verify` from `portal/` (exit code 0). The full verification includes the local Whisper, parallel transcription, proofreading, review API, subtitle QC, renderer, and Claude tool suites.
- The installed local runtime reports whisper.cpp 1.9.2. The `small-q5_1` model and CLI remain under ignored `portal/storage/whisper/`; they are not part of Git changes.
- Stopped only this task's temporary local API and mobile UI test servers on ports 18788 and 5175. Browser inventory showed no remaining 5175 test tab; the older preview on 5174 and shared browser/MCP processes were left alone.
- Deferred limitations: subtitle text QC currently ignores punctuation-only differences; shortening a reviewed segment can leave its word-level timing map stale, in which case export is rejected until timing data is refreshed. Both cases fail safely or skip punctuation-only checks and do not silently export changed spoken text.
