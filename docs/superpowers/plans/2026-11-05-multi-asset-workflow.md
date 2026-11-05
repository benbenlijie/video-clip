# Multi-Asset Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不破坏现有单视频口播链路的前提下，增加“多段视频 + 剪辑方案 → 横屏/竖屏成片”的路线 B，并为未来高级路线 C 保留稳定的素材与时间轴契约。

**Architecture:** 项目创建时通过 `workflowMode` 选择 `single-video-v1` 或 `multi-asset-v1`。旧模式继续使用 `project.media`、现有转录和现有渲染器；新模式使用独立 `assets[]`、`brief` 和 `timeline.v2`，素材分析和渲染按 asset 引用执行。共享 FFprobe、FFmpeg、SSE、版本和 QC 基础工具，但不让新模式修改旧模式的时间坐标语义。

**Tech Stack:** Node.js ESM HTTP API、React/TypeScript/Vite、FFprobe/FFmpeg、现有 Claude Code MCP 编辑器、JSON 文件持久化、Node `assert` 验证脚本。

**Spec:** `docs/superpowers/specs/2026-11-05-multi-asset-workflow-design.md`

## Global Constraints

- `workflowMode` 缺失的旧项目按 `single-video-v1` 处理。
- 现有 `/input`、`/input/chunk`、`/input/complete`、`timeline.v1` 和旧产物命名保持兼容。
- 路线 B 只接受视频；至少 2 个可用视频 asset，最多 20 个 asset，单个最多 500MB，项目总计最多 5GB。
- 任一 asset 分析失败时，项目不能生成方案；用户只能重试失败 asset，不必重新上传成功 asset。
- 路线 B 默认同时导出横屏 1920×1080 和竖屏 1080×1920；明确指定单一画幅时只导出对应版本。
- `targetDurationMs` 为软目标，允许约 ±10% 偏差。
- 首版只支持主视频轨、B-roll 覆盖轨和音频轨，先实现硬切和淡入淡出。
- 方案草稿必须由用户确认后才允许生成低分辨率预览；预览通过 QC 且用户检查后才允许正式导出。每次修改生成新版本并使旧预览失效，旧版本可回退。
- 未确认授权的 asset 不得进入正式导出；所有 asset 保存 SHA-256 和授权状态。
- 不执行 git commit、push、reset 或分支操作。

## Review Focus

- 旧项目没有 `workflowMode`：必须按单视频流程恢复，并且不能要求 `assets[]`。
- 多素材上传中断：已确认字节和已完成 asset 必须保留，重试只补缺口。
- 混合横竖屏源素材：必须按目标画幅裁切/缩放，不能生成错误尺寸或意外黑边。
- 失败 asset：必须阻止计划生成，但不丢弃其他 asset 的分析结果。
- timeline.v2 的源时间范围：非法 `sourceAssetId`、负时间和超出素材时长必须在渲染前拒绝。
- 软目标时长：规划结果在 ±10% 内通过，超出时应提示而非静默标记完成。

## File Map

- Create: `portal/server/multi-asset.mjs` — asset 元数据、配额、路径、状态和时间轴片段校验。
- Create: `portal/server/multi-asset.verify.mjs` — 多素材领域逻辑验证。
- Create: `portal/server/timeline-v2.mjs` — timeline.v2 转换、路径脱敏和计划校验。
- Create: `portal/server/timeline-v2.verify.mjs` — timeline.v2 验证。
- Create: `portal/server/multi-asset-render.mjs` — 多输入横屏/竖屏渲染和 QC。
- Create: `portal/server/multi-asset-render.verify.mjs` — 使用真实小视频 fixture 的渲染验证。
- Create: `portal/contracts/timeline.v2.schema.json` — 多素材时间轴公开契约。
- Modify: `portal/server/index.mjs` — 模式字段、asset/brief 路由、模式分流和项目视图。
- Modify: `portal/server/project-store.mjs` — 仅在需要时补充资产目录辅助函数，保持持久化格式向后兼容。
- Modify: `portal/src/App.tsx` — 双入口选择、多素材上传、方案输入、资产状态和双输出展示。
- Modify: `portal/src/styles.css` — 多素材入口和资产列表的响应式布局。
- Modify: `portal/package.json` — 将新增验证脚本加入 `npm run verify`。
- Modify: `portal/README.md` — 记录两个入口、路线 B API 和输出约束。

## Implementation Plan

### Task 1: Add mode-safe project state and domain validation

**Files:**
- Create: `portal/server/multi-asset.mjs`
- Create: `portal/server/multi-asset.verify.mjs`
- Modify: `portal/server/index.mjs: project creation and projectView`

**Interfaces:**
- `normalizeWorkflowMode(value): "single-video-v1" | "multi-asset-v1"`
- `normalizeBrief(input): Brief`
- `validateAssetUpload({ filename, byteLength, currentAssetCount, currentTotalBytes }): void`
- `createAssetRecord({ id, filename, path, bytes, metadata, role, licenseConfirmed }): AssetRecord`
- `assetDir(project, assetId): string`
- `assertMultiAssetReady(project): void`

- [x] **Step 1: Write validation checks** for legacy mode default, multi mode, 2-asset minimum, 20-asset maximum, 500MB asset limit, 5GB project limit, video-only metadata, and failed-asset gating.
- [x] **Step 2: Run `node server/multi-asset.verify.mjs` and confirm the new checks fail before implementation.**
- [x] **Step 3: Implement the pure functions** with no filesystem side effects except `assetDir`; reject invalid roles and unconfirmed export assets with clear Chinese errors.
- [x] **Step 4: Extend `createProject`** so missing `workflowMode` remains `single-video-v1`, while multi projects persist `brief`, `assets`, `assetAnalysis`, `outputProfiles`, and `multiAssetPlan` defaults.
- [x] **Step 5: Run the verification script and confirm all domain checks pass.**

### Task 2: Define and validate timeline.v2

**Files:**
- Create: `portal/contracts/timeline.v2.schema.json`
- Create: `portal/server/timeline-v2.mjs`
- Create: `portal/server/timeline-v2.verify.mjs`

**Interfaces:**
- `toTimelineV2(project): TimelineV2`
- `validateTimelineV2(timeline, project): TimelineV2`
- `createOutputProfiles(brief): OutputProfile[]`

- [x] **Step 1: Write schema and pure validation cases** for source asset references, `[sourceInMs, sourceOutMs)` ranges, track overlap rules, target profiles, licensing and path privacy.
- [x] **Step 2: Run `node server/timeline-v2.verify.mjs` and confirm invalid references/ranges fail.**
- [x] **Step 3: Implement conversion** from project assets, brief and `multiAssetPlan` to a path-safe `timeline.v2`; never expose absolute paths.
- [x] **Step 4: Implement horizontal/vertical profiles** with defaults `1920×1080` and `1080×1920`; honor an explicit single profile.
- [x] **Step 5: Run verification and JSON schema checks, including a legacy project that still converts through `timeline.v1`.**

### Task 3: Add multi-asset upload and brief APIs

**Files:**
- Modify: `portal/server/index.mjs: project routes and media routes`
- Modify: `portal/server/project-store.mjs` only if asset directory helpers are required
- Modify: `portal/src/App.tsx: start workflow and upload helpers`
- Modify: `portal/src/styles.css: responsive asset upload UI`

**Interfaces:**
- `POST /api/projects` accepts `{ workflowMode, goal, style, brief }`.
- `POST /api/projects/:id/assets` accepts one multipart video plus `role`, `label`, `licenseConfirmed`.
- `POST /api/projects/:id/assets/:assetId/chunk` and `/complete` support 8MB resumable upload.
- `GET /api/projects/:id/assets` returns public metadata/status only.
- `PUT /api/projects/:id/brief` validates and persists the structured brief.

- [x] **Step 1: Add API route tests** for mode separation, duplicate asset IDs, upload quotas, non-video rejection, license state, and resume offsets.
- [x] **Step 2: Run route checks and confirm the new endpoints reject single-mode misuse.**
- [x] **Step 3: Implement asset storage under `project.dir/assets/<assetId>/source.<ext>`**, using existing path validation and atomic project saves.
- [x] **Step 4: Implement resumable writes** with the same retry-safe offset semantics as the existing main input upload.
- [x] **Step 5: Add the separate UI entry** with multiple file selection, ordering, role/label editing, per-asset progress, removal before analysis, and brief fields.
- [x] **Step 6: Add responsive styles** so the asset list remains usable on narrow screens without changing the old single-video layout.
- [x] **Step 7: Run `npm run typecheck` and the route verification script.**

### Task 4: Add per-asset inspection and transcription orchestration

**Files:**
- Create: `portal/server/multi-asset-analysis.mjs`
- Create: `portal/server/multi-asset-analysis.verify.mjs`
- Modify: `portal/server/index.mjs: advance flow and SSE events`
- Modify: `portal/server/claude-code-editor.mjs` only for multi-mode workspace preparation

**Interfaces:**
- `inspectAsset(assetPath): Promise<MediaMetadata>`
- `buildAssetInventory(project): Promise<AssetInventory>`
- `transcribeAssets(project, { onPass }): Promise<AssetTranscriptMap>`
- `advanceMultiAsset(project): Promise<Project>`

- [x] **Step 1: Write checks** for independent metadata, independent transcript paths, partial retry, all-success gating, and SSE event payloads without absolute paths.
- [x] **Step 2: Run the analysis verification and confirm failures are isolated per asset.**
- [x] **Step 3: Implement inventory and transcript persistence** as `assets/<assetId>/metadata.json`, `transcript.json`, and project-level `asset-inventory.json`.
- [x] **Step 4: Implement retry selection** so completed assets are skipped and failed assets are retried only after their source file exists.
- [x] **Step 5: Add a multi-mode Claude workspace manifest** containing asset names, metadata, transcript references, brief and role labels; do not replace legacy `input.mp4` preparation.
- [x] **Step 6: Run analysis verification and the existing transcription verification suite.**

### Task 5: Generate user-confirmed multi-asset story plan

**Files:**
- Create: `portal/server/multi-asset-plan.mjs`
- Create: `portal/server/multi-asset-plan.verify.mjs`
- Modify: `portal/server/index.mjs: multi-mode advance/replan/chat routes`

**Interfaces:**
- `planMultiAssetWithClaude({ inventory, brief, comments, previousPlan }): Promise<MultiAssetPlan>`
- `validateMultiAssetPlan(plan, project): MultiAssetPlan`
- `confirmMultiAssetPlan(project, confirmation): Project`

- [x] **Step 1: Write plan validation checks** for source references, source ranges, ±10% duration target, minimum two assets, unsupported effects, and user-confirmation gating.
- [x] **Step 2: Run plan verification and confirm invalid model JSON is rejected without changing the active plan.**
- [x] **Step 3: Implement a strict JSON prompt** that asks Claude for story sections, clip references, output profiles, reasons, and unsupported-feature warnings; keep Claude as decision-maker and FFmpeg/Remotion deterministic executors.
- [x] **Step 4: Implement bounded repair/needs-input behavior** for invalid JSON or unsupported effects; never silently clamp a bad source reference into a different shot.
- [x] **Step 5: Add the plan-review API and UI** so the user can inspect section order, source asset, source range and purpose before confirming.
- [x] **Step 6: Run plan verification and existing edit-plan/edit-chat verification.**

### Task 6: Render horizontal and vertical multi-asset outputs

**Files:**
- Create: `portal/server/multi-asset-render.mjs`
- Create: `portal/server/multi-asset-render.verify.mjs`
- Modify: `portal/server/index.mjs: render route and artifact view`

**Interfaces:**
- `renderMultiAssetProject(project): Promise<{ artifacts, qc, profiles }>`
- `renderProfile({ project, timeline, profile, outputPath }): Promise<ProbeResult>`
- `validateMultiAssetQc(qc, timeline): void`

- [x] **Step 1: Create real fixture-based failing checks** for two source videos, cross-asset hard cuts, low-resolution dual-profile preview, full-resolution dual-profile final output, subtitle timing, music, black frames, and source-path privacy.
- [x] **Step 2: Implement per-profile FFmpeg input mapping** using validated `sourceAssetId` and source offsets; scale/crop to 1920×1080 or 1080×1920 without exposing arbitrary paths.
- [x] **Step 3: Implement shared audio rules**: retain selected source audio, mix licensed music at the existing reduced volume, and use fade in/out at profile boundaries.
- [x] **Step 4: Generate versioned preview and final artifacts** for each requested profile, `timeline-v2.json`, captions and QC without overwriting prior versions; record the plan version on each artifact.
- [x] **Step 5: Implement QC** for dimensions, audio/video streams, synchronization, black frames, source reference coverage, license confirmation and duration tolerance.
- [x] **Step 6: Run the fixture render verification and compare old `render.verify.mjs` output behavior.**

### Task 7: Integrate review, versions, documentation and regression checks

**Files:**
- Modify: `portal/src/App.tsx: review state, artifacts and chat controls`
- Modify: `portal/src/ReviewWorkspace.tsx` only where source asset labels/timeline ranges are shown
- Modify: `portal/server/index.mjs: project view and version/retry handling`
- Modify: `portal/package.json`
- Modify: `portal/README.md`

**Interfaces:**
- Multi-mode project view exposes `workflowMode`, asset summaries, brief, plan confirmation, profile artifacts and QC.
- Existing single-mode project view remains structurally compatible.

- [x] **Step 1: Add regression checks** that create a legacy project, run the existing single-input path, and assert the old status/artifact contract remains unchanged.
- [x] **Step 2: Add multi-mode review checks** for source-to-output mapping, dual-profile artifacts, version increments, stale-base rejection and rollback visibility.
- [x] **Step 3: Implement separate review cards** for horizontal and vertical previews/finals; show the source asset and source range for each planned clip before enabling final export.
- [x] **Step 4: Make chat edits mode-aware**: single mode keeps current prompt; multi mode passes the selected output range and source mapping, then creates a new version.
- [x] **Step 5: Add `multi-asset.verify.mjs`, `timeline-v2.verify.mjs`, `multi-asset-analysis.verify.mjs`, `multi-asset-plan.verify.mjs`, and `multi-asset-render.verify.mjs` to `npm run verify`.
- [x] **Step 6: Update README** with the two entry points, API routes, quotas, dual-profile output and route C future boundary.
- [x] **Step 7: Run the full verification suite, `npm run typecheck`, and `npm run build`; inspect changed files and report any environment-only failures without marking them as product success.**

## Verification Commands

From `portal/`:

```bash
npm run typecheck
npm run build
npm run verify
```

The new fixture checks must pass independently before the full suite is considered valid. Existing single-video verification remains the regression gate for compatibility.

## Execution Record

- Route B is implemented with separate single-video and multi-asset entry points. Horizontal and vertical outputs are both supported by default; a single profile can be selected.
- Route C remains documented as a future advanced-user route and is not part of this implementation.
- Final review follow-ups: public error strings redact custom absolute paths; interrupted multi-asset analysis/planning/rendering recovers to a retryable or previously valid state; historical plans are bound to a source-input fingerprint; completed assets are matched by content; resumed uploads verify confirmed chunk hashes and continue from the server-acknowledged offset.
- Verification on 2026-11-05: `npm run verify`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.
