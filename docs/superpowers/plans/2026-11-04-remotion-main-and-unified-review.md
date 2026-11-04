# Remotion 主合成与统一审核工作台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remotion 动效真实合成进新工程的主预览和正式成片，用户在同一个工作台审核字幕、提出修改并导出。

**Architecture:** 复用本地 Remotion 4.0.539 透明层输出和 FFmpeg，在受限 MCP 内增加按实际剪辑映射合成主视频的工具。新工程持久化 `compositionMode: "remotion-main.v1"`，无标记的旧工程维持原方式；统一前端以已登记产物选择版本与可用操作。

**Tech Stack:** Node.js ESM、现有 MCP/Zod、Remotion、FFmpeg、React/TypeScript、现有 CSS。

**Spec:** `docs/superpowers/specs/2026-11-04-remotion-main-workflow-design.md`、`docs/superpowers/specs/2026-11-04-unified-review-workspace-design.md`。

## Global Constraints

- 原生执行当前会话，不切分支、不创建 worktree、不提交、不推送；保留此前未提交的源码类型和字幕 QC 修复。
- 不安装新依赖、不修改系统配置、不调用真实 Claude/云 ASR/素材 API；保留旧工程与原片。
- 新工程使用实际帧对齐的裁剪映射；基础视频时长误差不超过一个输出帧，音画同步沿用 250ms 检查。
- 字幕确认、预览过期和最终 QC 保护不因界面简化而取消。Remotion 失败不得默默降级。
- 上线重启只在全部实现可审阅并验证后处理；本轮隔离服务不得写真实项目。

## Review Focus

- 原片删去中间区间或事件跨多个裁剪片段时，动效必须跟随实际输出时间，错误映射拒绝合成（任务 1/2）。
- 字幕、基础视频、计划或透明层被更换后，旧合成记录不得用于主视频验收（任务 2/3）。
- 延后出现的标题也必须通过实际时点的透明度检查；无可见事件不能假称成功（任务 1/2）。
- 修改失败或新版本仅有草剪时，界面保留真实版本，不把上一版成片当新版结果（任务 4/5）。
- 正在编辑、未保存字幕、未确认字幕或过期预览均阻止导出；历史版本不允许误编辑（任务 4/5）。

### Task 1: 实际剪辑映射与透明层检查

**Files:** 创建 `portal/server/remotion-main.mjs`、`portal/server/remotion-main.verify.mjs`；修改 `portal/server/remotion-overlay.mjs`。

**Interfaces:** `validateEditMap({ map, plan, sourceDurationMs, durationMs, fps })` 返回规范化 `pieces: [{ src: [startMs,endMs], out: [startMs,endMs] }]`；`mapRemotionEvents(events, pieces)` 返回按输出时间的受支持事件。

- [x] 编写映射测试：中间删除、分段事件、完全删除事件、重叠/倒序/时长错误、未知类型、帧对齐误差；先看到失败。
- [x] 实现映射与校验，支持现有 `timeline.json` 的 `pieces/src/out` 形态；实际保留区间须与计划帧对齐区间一致。
- [x] 将 alpha 取样改到实际事件时点并验证透明背景，保持现有对照功能兼容。
- [x] 运行定向验证，确认通过并记录结果。

### Task 2: 受限 MCP 主视频合成与证据

**Files:** 修改 `remotion-main.mjs`、`remotion-overlay.mjs`、`video-agent-tools.mjs`；创建 `portal/server/remotion-main-tools.verify.mjs`。

**Interfaces:** `compose_remotion_video({ baseVideo, phase })` 从当前工作区读取 `brief.json`、`edit-plan.json`、`timeline.json`、`transcript.json`、`captions.srt`，返回唯一输出的主视频、透明层、输入配置、源码快照和哈希记录。`validateRemotionComposition({ dir, phase, manifest, audit })` 验证实际工具输出绑定 `manifest.main`，返回须保存的文件及 QC 元数据。

- [x] 编写真实本地渲染集成测试：4 秒原片中间删 2 秒，动效移动到 2 秒主视频；工具输出有音轨、字幕、alpha 层和记录；先看到失败。
- [x] 实现工具，严格工作区路径验证，输出使用唯一编号并拒绝覆盖；保留模板与输入用于复现，不额外生成对照。
- [x] 实现关联哈希、阶段、尺寸、时长和事件验证；替换计划/字幕/基础视频/输出/透明层均拒绝验收。
- [x] 验证预览与正式导出相同动效设计可按各自分辨率重渲染；运行定向集成验证。

### Task 3: 新旧工程、Claude 指令与主产物门禁

**Files:** 修改 `portal/server/index.mjs`、`claude-code-editor.mjs`、`claude-code-editor.verify.mjs`、`agent-skills/video-edit/SKILL.md` 及相关验证。

**Interfaces:** 新工程保存 `compositionMode: "remotion-main.v1"`；`prepareWorkspace` 将模式写入 `brief.json`；主工程 `manifest` 同样声明模式并绑定工具输出。旧工程继续使用现有 HyperFrames 规则。

- [x] 编写新工程模式持久化与旧工程不迁移的回归验证；新主视频缺少真实合成记录必须失败；先看到失败。
- [x] 更新准备、提示和保存规则；新模式不再要求 HyperFrames 或自动对照，新模式主视频必须来自主合成工具。
- [x] 将 Remotion 透明层/输入/模板/记录保存为版本化工程产物；字幕覆盖支持实际 Remotion 输入证据，字幕 QC 使用相同实际映射。
- [x] 验证旧测试兼容、新模式预览/正式阶段与过期证据拒绝。

### Task 4: 审核状态与版本规则

**Files:** 创建 `portal/src/review-state.ts`、`portal/server/review-state.verify.mjs`；修改 `portal/server/index.mjs`、`edit-chat.mjs` 的必要版本门禁。

**Interfaces:** `reviewState(project, viewVersion, transcriptDraftDirty)` 返回已成功登记的版本、当前播放器/成片、历史标记、任务状态与唯一导出区动作。后端对话检查请求 `baseVersion`，导出阻止 `chat_editing`。

- [x] 编写最新草剪+旧成片、失败轮次、处理中、待确认/过期/未保存字幕、历史查看等行为测试；先看到失败。
- [x] 实现状态选择，导出不得回退到上一版成片；修改时码绑定预览版本和实际长度。
- [x] 保留历史批注读取，不产生额外收费请求；必要后端门禁仅收紧并发与过期版本。
- [x] 运行定向验证。

### Task 5: 一个审核工作台

**Files:** 修改 `portal/src/App.tsx`、`portal/src/styles.css`、`portal/README.md`、`portal/package.json`。

- [x] 先阅读现有 UI/响应式规范，复用当前视觉令牌与对话组件。
- [x] 合并 review/conversation，单播放器、版本选择、可折叠字幕与制作详情、唯一修改输入框，主操作随真实状态变化。
- [x] 下架主要界面的 Remotion 对照操作；历史对照进入详情；错误不再统一显示为“需要配置”，移除页面索引伪百分比。
- [x] 导出中/完成仍提供明确视频版本和下载；历史模式要求回最新版本后才能编辑；移动端无溢出且触控目标足够大。
- [x] 更新说明与验证脚本，运行 typecheck/build 及相关验证。

### Task 6: 全体验验证与独立复核

- [x] 跑本地真实 Remotion 主合成工具及版本化保存，再用隔离 API 验证主 MP4 的 HTTP 200/206 与哈希；不修改真实项目。
- [x] 用真实浏览器检查桌面/手机、字幕展开、版本切换、错误、制作中、导出门禁及唯一主视频；收费路径使用隔离演示状态，不调用外部服务。
- [x] 跑 `npm run typecheck && npm run build && npm run verify` 及适配的 Remotion 验证。
- [x] 根据 executing-plans 要求，派一次独立只读复核，对重要问题定向修正再验证；记录限制。
- [x] 检查 `git diff --check` 和任务范围；关闭本轮临时服务，更新设计/计划状态。需要上线重启时在验证后说明并按已有授权范围操作。

## Execution Ledger

- 用户已确认两份具体设计；使用当前会话原生执行，不重复询问执行方式。
- Ruling: 沿用当前工作区 — 用户明确禁止未经请求的分支操作，且已有未提交修复需原地保留 — 通过精确改动范围及最终 diff 检查隔离。
- 初始基线为 `cce251e`；已有 8 个修改文件属于此前源码类型/字幕 QC 修复，均保留。

- Task 1: complete — 先失败再通过的实际映射测试与延后标题 alpha 测试。
- Task 2/3: 主工具真实预览、高清同设计输出、保存登记、哈希失效与新旧准备提示已验证；HTTP 与接口模式回归待总验收。
- Task 4: complete — 版本/状态纯逻辑和过期编辑基准门禁先失败再通过。
- Task 5: 界面已合并，typecheck/build 通过；浏览器与全量检查待执行。
- Ruling: 将现有 workspacePath 原样抽到 workspace-path.mjs 并保留旧导出 — 主合成和媒体工具共享路径边界、避免循环依赖 — 既有安全路径测试继续覆盖。
- Ruling: 复用源工程帧率并允许最多 256 个分段动效 — 裁剪后一个源事件可分成多段，原 32 条上限不足 — 仍对输入规模设界限。

- Task 6 review: 独立复核发现 4 个重要问题，均已红绿验证并修正：新主视频只认成片字幕时码；视觉覆盖绑定真实事件/时间；跨阶段使用语义设计指纹、同阶段仍检查文件字节哈希；主产物版本与轮次统一。
- Ruling: 字幕大小/位置/描边/颜色作为安全 captionStyle 参数进入计划与主合成 — 统一修改框已有“字幕大一点”入口，不能只改文案不改视频 — 参数有限且严格验证，不接收任意 ASS/滤镜代码。
- 真实工具链验证已覆盖 prepareWorkspace → 正式高分辨率合成 → 同版保存 → 隔离 API 的预览/终稿下载哈希及 Range；未调用 Claude/ASR。
- 浏览器隔离验收已覆盖单播放器、历史只读、草稿阻止编辑、保存后过期提示、待确认字幕、制作中、失败草稿恢复、导出下载，以及 375/414/768/1024/1440px 无页面横溢。

- 最终验证：`npm run typecheck && npm run build && npm run verify && npm run verify:remotion` 全部退出码 0，真实主合成包含样式参数、语义跨阶段指纹、同版终稿保存和 HTTP 读取。
- 实际旧项目 53ce67c2-7b8e-4e22-ad20-4bd45dbfcfbf 只读恢复确认：主播放器 1 个，草剪 86.7 秒，无浏览器错误；字幕仍需人工确认，未跳过或重跑。
- 界面截图保存在 `/tmp/wayne-unified-review-evidence/live-desktop.jpg` 和 `live-mobile.jpg`。
- 定向复核通过：上述四项修复及 captionStyle 的参数边界、持久化、设计指纹和 FFmpeg 应用链路未发现重要问题；复核代理另跑字幕、计划、聊天版本验证及 diff 检查通过。
- 上线收尾：重查全部 25 个项目，无 planning/rendering/chat_editing/transcribing 或运行中的编辑会话；核对旧 API 的命令与 cwd 后按已有授权范围温和重启。新 API PID 2975141，监听 127.0.0.1:18787，独立日志 `/tmp/wayne-api-remotion-main-20261104-184406.log`；保留原进程环境，未修改配置文件或凭证。
- 前端 5174 和现有 AutoSSH 的 25174/28787 两个转发均未改动或重复创建。`https://watchdeep.net/wayne/` 返回 200 且引用本轮构建；本地与公网 health、旧项目详情均 200，主预览 Range 均 206。
- 本地/公网完整主预览下载均为 HTTP 200、7,241,383 字节，SHA-256 同为 `d975e857f6462ed7f199f7b656aba84ce7ad586ad56402db189f23a8a0c79e97`；旧项目仍为 plan_ready、33 个产物、无新主模式标记，未迁移或重跑。
- 隔离 5175 服务已退出，按监听端口和隔离 cwd 扫描确认无残留进程；测试文件及截图保留。最终 diff 检查通过，未执行 git commit/push、分支操作、依赖安装或无关文件清理。
- 限制：新增公网浏览器标签的补充检查因浏览器工具超时未完成；已完成的实际旧项目桌面/手机浏览器证据保留，公网可用性以本轮 HTTP、Range 和下载哈希实测为准。未调用真实 Claude/云 ASR/素材 API，不宣称已跑通收费 Claude 自主剪辑全会话。
