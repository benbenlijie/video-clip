# Portal Unified Style and B-roll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let portal users import a searched, licensed B-roll candidate and then regenerate the same reference-style, fluency-cleaned Claude Code plan without leaving the normal portal workflow.

**Architecture:** Reuse the existing B-roll downloader behind a server-side candidate handle. Add one project import route, invalidate the stale plan, and expose a one-click import in the existing search result card. StylePack, fluency and B-roll continue to meet in the existing Claude Code plan rather than in a side path.

**Tech Stack:** Node.js HTTP server, MCP SDK, React/TypeScript, FFprobe, existing Claude Code and StylePack pipeline.

**Spec:** `docs/superpowers/specs/2026-11-15-portal-unified-style-broll-design.md`

## Global Constraints

- Do not accept arbitrary media URLs from the browser.
- Keep `multi-asset-v1` on its uploaded asset-library workflow.
- Do not call live Claude, Pexels or Pixabay APIs in tests.
- Preserve public response path redaction.
- Do not commit or push unless explicitly requested.

## Review Focus

- A candidate handle from another project or after expiry must not import.
- A redirect must not escape the official CDN allowlist.
- Import must not leave an exportable plan that still lacks the new asset.
- Duplicate imports must not create duplicate assets.
- Public project views must not reveal local absolute paths.

---

### Task 1: Shared secure B-roll downloader

**Files:**
- Modify: `portal/server/video-broll-tools.mjs`
- Test: `portal/server/video-broll-tools.verify.mjs`

**Interfaces:**
- Produces: `downloadBrollCandidate({ candidate, workspaceDir, fetchImpl, fileStem }) -> Promise<asset>`
- Produces asset fields: `assetId, filename, path, provider, providerId, sourceUrl, licenseName, licenseUrl, sha256, bytes, durationMs, width, height`

- [x] **Step 1: Add assertions for official-host rejection and a direct helper download.**
- [x] **Step 2: Run `node server/video-broll-tools.verify.mjs` and confirm the new helper import fails.**
- [x] **Step 3: Extract the existing validated response/merge/probe logic into the exported helper and let the MCP tool call it.**
- [x] **Step 4: Re-run `node server/video-broll-tools.verify.mjs` and expect all assertions to pass.**

### Task 2: Project-bound candidate import route

**Files:**
- Modify: `portal/server/index.mjs`
- Test: `portal/server/music.verify.mjs`

**Interfaces:**
- Consumes: `downloadBrollCandidate(...)` from Task 1.
- Produces: search candidates with `candidateHandle`.
- Produces: `POST /api/projects/:id/broll/import` with `{ candidateHandle }`.

- [x] **Step 1: Add route assertions for unknown handles and multi-asset rejection.**
- [x] **Step 2: Run `node server/music.verify.mjs` and confirm the route is missing.**
- [x] **Step 3: Add the 30-minute project-bound handle registry and import route.**
- [x] **Step 4: Persist validated provenance, reject duplicates and over-limit projects, clear `plan`/`qc`, and return a redacted project view.**
- [x] **Step 5: Re-run `node server/music.verify.mjs` and expect pass.**

### Task 3: One-click import in the portal UI

**Files:**
- Modify: `portal/src/App.tsx`

**Interfaces:**
- Consumes: `candidateHandle` from search results and the import route from Task 2.
- Produces: per-candidate busy/imported state and a visible “replan required” notice.

- [x] **Step 1: Extend the candidate type and add an import handler that calls the new route and updates project state.**
- [x] **Step 2: Add an “加入项目” control for the selected candidate, disabling duplicates and in-flight rows.**
- [x] **Step 3: Explain that import invalidates the old plan and the next generation will include StylePack, fluency cleanup and B-roll.**
- [x] **Step 4: Run `npm run typecheck` and `npm run build`.**

### Task 4: End-to-end regression

**Files:**
- Modify: `portal/package.json` only if a new verification file is added.

- [x] **Step 1: Run `node server/video-broll-tools.verify.mjs`.**
- [x] **Step 2: Run `node server/music.verify.mjs`.**
- [x] **Step 3: Run `npm run typecheck && npm run build`.**
- [x] **Step 4: Run `npm run verify`.**
- [x] **Step 5: Start an isolated portal with fixture storage and verify the UI/API contract without external paid calls.**
