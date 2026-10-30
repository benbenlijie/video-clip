# Wayne CASE 01 Real MVP Implementation Plan

> **For agentic workers:** Use this plan task-by-task. Git commits are intentionally omitted because the user did not request them.

**Goal:** 将当前 Wayne 工作流原型变成可公网访问、可恢复、能生成真实 MP4/Shorts 产物的单机 MVP。

**Architecture:** 保留现有 Vite React 门户与 Node HTTP API；项目目录使用 `storage/<projectId>/project.json` 持久化，媒体和产物留在同一目录。API 以有限状态机驱动真实 FFprobe、转录、Claude 计划、批注和 FFmpeg 渲染，前端读取项目快照和 SSE 状态。

**Tech Stack:** React + TypeScript + Vite；Node ESM HTTP server；FFmpeg/FFprobe；Anthropic HTTP API；火山引擎/腾讯云 ASR。

**Spec:** `docs/superpowers/specs/2026-10-29-wayne-real-mvp-design.md`

## Global Constraints

- 不伪造转录、Claude 计划、渲染或 QC 成功。
- 原始上传媒体保留，产物写入项目目录的 `artifacts/`。
- 服务重启后通过 `project.json` 恢复项目索引。
- 下载路由只能访问项目目录内的白名单产物。
- 不执行 git commit、push、reset 或删除操作。

## Review Focus

- 空项目或无媒体调用推进时必须返回可解释的 409；由 Task 1 验证。
- 服务重启后项目和状态仍可读取；由 Task 1 验证。
- Claude/ASR 凭证缺失时状态必须为 `needs_input`；由 Task 2 验证。
- 空计划、越界时间段或异常 JSON 不得进入渲染；由 Task 2/3 验证。
- 下载路径穿越和项目外路径必须被拒绝；由 Task 1 验证。

### Task 1: 持久化项目存储与安全媒体路由

**Files:**
- Create: `portal/server/project-store.mjs`
- Modify: `portal/server/index.mjs`
- Test: `portal/server/project-store.verify.mjs`

**Interfaces:**
- `createProject(body) -> Promise<Project>`
- `loadProjects() -> Promise<Map<string, Project>>`
- `saveProject(project) -> Promise<Project>`
- `artifactPath(project, name) -> string | null`

- [ ] 写验证脚本，覆盖创建、保存、重新加载、路径穿越拒绝和状态字段保留。
- [ ] 运行验证脚本确认当前内存实现不满足持久化断言。
- [ ] 在 `project-store.mjs` 实现目录初始化、JSON 原子写入、项目重载和白名单路径解析。
- [ ] 将 `index.mjs` 的项目 Map 初始化、项目变更和媒体下载路由切换到 store，并补充 `/api/projects/:id/artifacts/:name`。
- [ ] 运行验证脚本及 API 健康检查，确认重启后项目可恢复。

### Task 2: 真实剪辑计划、转录产物和批注接口

**Files:**
- Create: `portal/server/edit-plan.mjs`
- Modify: `portal/server/index.mjs`
- Modify: `portal/server/transcription.mjs`
- Test: `portal/server/edit-plan.verify.mjs`

**Interfaces:**
- `buildFallbackPlan(transcript, media, goal) -> EditPlan`（仅用于已明确允许的规则化计划，不伪造 ASR/LLM）
- `validateEditPlan(plan, durationMs) -> EditPlan`
- `planWithClaude({ transcript, media, goal, style, comments }) -> Promise<EditPlan>`
- `writeTranscriptArtifacts(project, transcript) -> Promise<void>`

- [ ] 写计划校验验证，覆盖合法区间、空区间、负数、超出媒体时长和 Shorts 数量。
- [ ] 运行验证脚本确认校验函数尚不存在。
- [ ] 实现计划 schema 校验、SRT/cut-list 序列化和 Claude JSON 请求；解析失败进入 `needs_input`。
- [ ] 在转录完成后写 `transcript.json`/`transcript.srt`，在推进流程中接入 Claude 计划和计划产物。
- [ ] 将批注接口写入持久化项目，并让下一次推进只允许一次 revision 计划生成。
- [ ] 运行验证脚本并用无凭证环境验证清晰的 `needs_input` 响应。

### Task 3: FFmpeg 主片、Shorts 与 QC

**Files:**
- Create: `portal/server/render.mjs`
- Modify: `portal/server/index.mjs`
- Test: `portal/server/render.verify.mjs`

**Interfaces:**
- `renderProject(project) -> Promise<{ artifacts, qc }>`
- `probeOutput(path) -> Promise<MediaProbe>`
- `renderClip(input, output, startMs, endMs, options) -> Promise<void>`

- [ ] 写渲染验证脚本，使用仓库测试视频断言主片、5 个竖屏 Shorts、SRT、cut-list 和 QC 文件真实存在且可被 FFprobe 读取。
- [ ] 运行验证脚本确认当前 API 没有渲染路由。
- [ ] 实现安全时间区间归一化、主片 concat、竖屏 scale/crop、字幕文件生成和 FFmpeg stderr 日志。
- [ ] 在渲染完成后写 `qc.json`，至少验证视频流、音频流、时长和输出尺寸；失败保持 `failed`。
- [ ] 接入 `POST /api/projects/:id/render` 和产物列表，成功后状态为 `completed`。
- [ ] 运行渲染验证脚本，检查重复渲染的幂等行为和失败保留日志。

### Task 4: 前端真实状态、播放器、批注和下载

**Files:**
- Modify: `portal/src/App.tsx`
- Modify: `portal/src/styles.css`

**Interfaces:**
- 项目快照使用服务端 `status`, `media`, `transcript`, `plan`, `comments`, `artifacts`, `qc`。
- 所有下载链接使用 `/wayne-api/api/projects/:id/artifacts/:name`。

- [ ] 将阶段状态从本地演示数组映射到服务端状态，刷新时从 URL/localStorage 恢复 projectId。
- [ ] 上传后展示真实媒体探测信息和 `<video>` 播放器；转录/计划/批注状态来自 API。
- [ ] 批注通过真实 POST 保存，渲染按钮调用 `/render` 并显示 SSE 进度、失败和重试。
- [ ] 交付页展示主片播放器、5 条 Shorts 和 SRT/cut-list/QC 下载链接。
- [ ] 保留无凭证时的清晰配置提示，不渲染假成功状态。
- [ ] 运行 `npm run typecheck`、`npm run build`，并用浏览器检查窄屏与桌面布局。

### Task 5: 公网运行与端到端验收

**Files:**
- Modify: `portal/README.md`
- Modify: `portal/.env.example`
- Modify: `portal/vite.config.ts`（仅在公网反代需要时）

- [ ] 启动 API 和构建后的前端，确认监听地址可被现有反代访问。
- [ ] 使用测试视频执行真实上传、探测、凭证状态、计划/批注/渲染接口链路。
- [ ] 通过公网域名验证页面、健康接口、静态资源、项目恢复和产物下载。
- [ ] 记录未完成的外部凭证验证项；只有真实产物和 QC 通过才报告 MVP 完成。
