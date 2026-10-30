# Wayne Visual Edit Execution Upgrade

> Implementation plan. Git commits are intentionally omitted per project instructions.

**Goal:** Turn Claude's edit plan into visible, reviewable edits in the rendered video while preserving the original source and prior delivery artifacts.

**Architecture:** Claude returns a validated visual-event timeline alongside cut segments and Shorts. FFmpeg maps events into each retained segment, burns the aligned captions, and renders Wayne-style title, emphasis, and CTA overlays. Replanning a legacy project is explicit; new renders receive versioned artifact names and QC gates completion on the requested edit elements.

**Tech Stack:** Node ESM, Anthropic Messages API, FFmpeg drawtext/drawbox/subtitles filters, React + TypeScript + Vite.

## Global Constraints

- Never overwrite the original upload or a previously rendered delivery.
- Never claim visual events were applied when the plan has none or the renderer did not apply them.
- Do not send existing media or call external model APIs during local verification.
- Claude remains the edit decision maker; FFmpeg executes deterministic instructions.
- Do not commit or push.

## Review Focus

- Events outside media duration or with invalid types must fail plan validation.
- Events across removed timeline gaps must map to retained clip-local timestamps correctly.
- Empty transcripts remain valid and must not produce malformed subtitle filters.
- Existing projects without visual events must offer explicit re-planning and cannot produce a new “full edit” QC pass.
- New renders must not overwrite prior artifact files and the latest delivery must remain downloadable.

### Task 1: Visual edit plan contract

**Files:** `portal/server/edit-plan.mjs`, `portal/server/edit-plan.verify.mjs`

- [ ] Add failing tests for valid visual events, invalid type, out-of-range timestamps, and legacy plans.
- [ ] Add `visualEvents` validation and prompt Claude for 3–6 bounded title/emphasis/CTA events.
- [ ] Run the verification script.

### Task 2: Deterministic visual renderer and versioned artifacts

**Files:** `portal/server/render.mjs`, `portal/server/render.verify.mjs`

- [ ] Add failing tests for event mapping around removed cuts, overlays, subtitles, aspect ratios, QC, and output version selection.
- [ ] Render title cards, emphasis callouts, and CTA overlays from validated events; burn segment-aligned subtitles.
- [ ] Preserve the source display orientation for the main cut; render Shorts as 9:16.
- [ ] Version repeat outputs; QC checks expected streams, display dimensions, subtitle artifact, visual event count, and five Shorts.
- [ ] Run a real local render against a copied fixture without external API calls.

### Task 3: Replan existing projects and expose edit instructions

**Files:** `portal/server/index.mjs`, `portal/src/App.tsx`, `portal/src/styles.css`

- [ ] Add an explicit re-plan API for projects with existing transcript and media.
- [ ] Show visual events in the plan review stage and clarify legacy deliveries that have captions/cuts only.
- [ ] Add a legacy-delivery action to generate a new visual plan and keep prior renders available.
- [ ] Fix the shoot-goal field so its value reaches the project and Claude.
- [ ] Build, restart the local preview/API, and verify public page, re-plan state, versioned downloads, and QC.
