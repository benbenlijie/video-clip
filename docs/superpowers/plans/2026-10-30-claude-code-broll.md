# Claude Code 自主 B-roll 工作流实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opus 5.5 可选择性搜索、查看、自动下载并把已授权候选剪入预览，服务端能验证下载来源和每段素材的实际画面审阅。

**Architecture:** 复用 B-roll provider 查询/排序逻辑，通过项目专属 MCP 提供受限 `search_broll` / `download_broll` 工具。下载证据由服务端私有审计账本保存，剪辑工作区只获得下载后的素材。计划验证、项目存储和前端展示以该账本为事实依据。

**Tech Stack:** Node.js ESM, Anthropic MCP SDK, Zod, Pexels/Pixabay API, Bubblewrap 隔离 FFmpeg, Node assert-based verification.

**Spec:** `docs/superpowers/specs/2026-10-30-claude-code-broll-design.md`

## Global Constraints

- 搜索最多 3 个镜头意图、每个镜头最多 2 个查询、每个查询最多 8 个候选。
- 单个下载默认最多 100 MB；下载来源只能为本次 API 返回的精确候选，重定向只能到 Pexels/Pixabay 官方媒体 CDN。
- 媒体 shell 继续断网；联网能力仅由 B-roll MCP 工具承载。
- 只有通过素材授权许可流程的候选才允许下载和用于预览；保留 provider、provider ID、source URL、creator、license name/URL、下载时间、SHA-256。
- B-roll 不适用时允许零搜索、零下载、零插入；不要求每条视频生成 Shorts。
- 未获用户要求时，不提交代码、不切分支、不重启公网 API。

## Review Focus

- 搜索提示词包含意外多条或超长搜索意图 → 搜索边界测试拒绝超限。
- 候选 ID 被篡改或重复下载 → 仅接受当前 MCP 会话中登记的 ID，并限制重复/累计下载。
- HTTP 重定向到任意主机、错误 content-type、超大响应或下载损坏 → 重定向和文件校验测试拒绝，工作区不留下可用素材。
- Claude 生成不存在或未下载的 assetId → 计划校验失败，保留现有预览和项目状态。
- 已下载素材没有实际进入/出现在预览中 → B-roll 使用区间必须有同版本预览帧审阅证据，否则阶段不能通过。

---

### Task 1: 复用 B-roll provider 搜索与候选记录

**Files:**
- Modify: `portal/server/broll-search.mjs`
- Test: `portal/server/broll-search.verify.mjs`
- Modify: `portal/package.json`

**Interfaces:**
- Produces: `searchBrollScenes({ scenes, orientation, cachePath, fetchImpl }) -> { orientation, scenes }`; 每个 scene 返回按相关度排序的候选。
- Existing `searchOnlineBroll` 保持 API 兼容，内部转用共享搜索函数。

- [ ] **Step 1: 写失败测试**，覆盖每意图查询上限、每查询候选上限、排序和不同 scene 的候选隔离。
- [ ] **Step 2: 运行验证脚本确认 RED**：`node server/broll-search.verify.mjs`。
- [ ] **Step 3: 抽出可供 MCP 调用的 provider 搜索函数**，搜索输入限制 3 scene × 2 query；候选最多 8/scene，去重并保留 provider 来源。
- [ ] **Step 4: 再次运行脚本确认 GREEN**。

### Task 2: 为 Claude Code 增加安全搜索与自动下载工具

**Files:**
- Create: `portal/server/video-broll-tools.mjs`
- Create: `portal/server/video-broll-tools.verify.mjs`
- Modify: `portal/package.json`

**Interfaces:**
- `startBrollTools({ projectId, workspaceDir, auditPath, cachePath, fetchImpl })` 注册 MCP `search_broll`、`download_broll`。
- `search_broll` 接收 1–3 个 `{id, visualIntent, queries}`，输出候选的 `candidateHandle`、来源、作者、许可和缩略图。
- `download_broll` 只接受当前会话返回的 `candidateHandle`；下载只从候选登记的 provider CDN 获取；每项目每阶段最多下载 3 个文件、单个最多 100 MB。
- 下载证据写入 MCP 私有 `downloads.jsonl`，包含候选元数据、相对路径、hash 和时间；不写入任何 API key 或带密钥 URL。

- [ ] **Step 1: 写失败测试**：搜索不超界、只有已登记 handle 可下载、redirect 外域拒绝、100MB+拒绝、成功下载 hash/许可元数据完整、重复 handle 拒绝。
- [ ] **Step 2: 运行 `node server/video-broll-tools.verify.mjs` 确认 RED**。
- [ ] **Step 3: 实现 MCP 工具和受限 HTTP 下载**。所有下载 URL/重定向 hostname 每跳验证；拒绝非 MP4/WebM、非 2xx、无效长度、超时和过大响应；下载成功后重新 ffprobe 校验媒体流与时长。
- [ ] **Step 4: 再次运行验证脚本确认 GREEN**。

### Task 3: 持久化下载资产并让剪辑计划执行 B-roll

**Files:**
- Modify: `portal/server/claude-code-editor.mjs`
- Modify: `portal/server/edit-plan.mjs`
- Modify: `portal/agent-skills/video-edit/SKILL.md`
- Modify: `portal/server/claude-code-editor.verify.mjs`
- Modify: `portal/server/edit-plan.verify.mjs`
- Modify: `portal/server/claude-code-editor.mjs` 中 manifest/QC 验证

**Interfaces:**
- 项目专属 MCP 由现有媒体工具加 B-roll 工具共同提供；`downloads.jsonl` 位于 workspace 同级私有 control 目录。
- `saveAgentOutput` 先登记账本下载项到 `project.brollAssets`（ID 使用不可预测 UUID），随后验证 `edit-plan.json.brollEvents` 并版本化保存素材与许可元数据。
- 剪辑 skill 要求 Opus 选择是否搜索、查看候选缩略图、下载最多 3 个、只使用实际下载且已验证 ID；manifest 为每段实际使用的素材提供输出时间区间和审阅时间。

- [ ] **Step 1: 写失败测试**：`allowCustomVisualEvents` 保留合法 B-roll 事件，拒绝未下载 asset ID、越界区间与未确认许可；MCP 下载记录形成项目资产，并能在同一编辑工程渲染阶段复用。
- [ ] **Step 2: 运行相关 verify 脚本确认 RED**。
- [ ] **Step 3: 通过 UUID 将账本下载记录映射到项目资产，校验 hash/许可并复制到持久项目目录；把 B-roll 事件从自定义计划校验中保留下来；Claude skill 加入选择性搜索和插入步骤**。
- [ ] **Step 4: 检查每个实际使用区间均有同版本预览/终稿 `view_frame` 审片证据；在 QC 中分别报告下载数、计划数、使用数、资产元数据和未用原因**。
- [ ] **Step 5: 运行编辑器与计划验证确认 GREEN**。

### Task 4: 将素材使用证据呈现于网站并跑完整回归

**Files:**
- Modify: `portal/src/App.tsx`
- Modify: `portal/server/claude-code-editor.verify.mjs`
- Modify: `portal/package.json`
- Modify: `portal/README.md`

**Interfaces:**
- 前端只展示后端持久化的 B-roll 资产、许可来源、计划插入和 QC 实际审片记录；不再把手动搜索卡片作为 Claude 剪辑流程的必经步骤。

- [ ] **Step 1: 写失败测试**，模拟下载但未使用、计划但没有审片、预览实际审片三种状态，确保 QC/交付区分真实使用与仅有候选。
- [ ] **Step 2: 运行新验证确认 RED**。
- [ ] **Step 3: 展示“搜索/下载/实际插入/未采用原因”的项目记录；更新流程文档**。
- [ ] **Step 4: 运行** `npm run verify && npm run typecheck && npm run build` **并确认 GREEN**。

## Execution Ruling

Ruling: 在现有脏工作区原地实施 — 用户明确要求继续此项目实施，工作区含此前用户与代理的未提交文件；新 worktree 会缺少这些已存在的预览工程和改动 — 不创建分支、不覆盖任何现存文件。
