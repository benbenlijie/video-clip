# Wayne Workflow Portal

这是 Wayne St Ledger / Claude Video Editing / CASE 01 的本地工作流门户。

## 开通服务

- [火山引擎豆包语音识别控制台](https://console.volcengine.com/speech/new/)
- [火山引擎录音文件标准版任务提交](https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=zh)
- [火山引擎录音文件标准版结果查询](https://docs.volcengine.com/docs/doubao-voice/result-query-http-1?lang=zh)
- [腾讯云语音识别控制台](https://console.cloud.tencent.com/asr)
- [腾讯云录音文件识别文档](https://cloud.tencent.com.cn/document/product/1093/35682)

主通道按标准版文档填写火山引擎 `App ID`、`Access Token`、`Cluster ID` 和公网 HTTPS 地址；备用通道填写腾讯云 `SecretId` 和 `SecretKey`。两套凭证只放在服务端 `.env`，不要写入前端代码。
标准版不能读取 `localhost` 或 `127.0.0.1` 的音频地址；门户会提供 `/media/:projectId/transcript-audio.wav`，需要配置一个火山引擎可以访问的公网 HTTPS 域名。

## 运行

终端 1：

```bash
cd /home/ben/Documents/projects/video-clip/portal
npm run api
```

终端 2：

```bash
cd /home/ben/Documents/projects/video-clip/portal
npm run dev -- --host 0.0.0.0
```

打开 `http://localhost:5174/`。

公网或稳定预览使用构建产物，避免把 Vite HMR 开发客户端暴露到公网：

```bash
npm run build
npm run preview -- --host 0.0.0.0 --port 5174
```

## 服务端 Key

复制 `.env.example` 为 `.env`，只在服务端填写：

```env
ANTHROPIC_API_KEY=你的 Anthropic API Key
# 可选：有兼容 Anthropic Messages API 的模型网关时填写
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-opus-5-5
TRANSCRIPTION_PROVIDER=volcengine

# 主通道：火山引擎豆包 ASR 标准版
VOLCENGINE_ASR_MODE=standard
VOLCENGINE_APP_ID=你的火山引擎 App ID
VOLCENGINE_ACCESS_TOKEN=你的火山引擎 Access Token
VOLCENGINE_ASR_CLUSTER=控制台显示的 Cluster ID
VOLCENGINE_ASR_PUBLIC_BASE_URL=https://你的公网域名
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.auc

# 如果你明确选择极速版 HTTP，才改成 fast 并填写 API Key
VOLCENGINE_ASR_MODE=fast
VOLCENGINE_ASR_API_KEY=你的火山引擎 APP Key

# 备用通道：腾讯云 ASR
TENCENTCLOUD_SECRET_ID=你的腾讯云 SecretId
TENCENTCLOUD_SECRET_KEY=你的腾讯云 SecretKey
TENCENTCLOUD_REGION=ap-guangzhou
```

当前 API 默认运行在 `http://127.0.0.1:18787`，读取这些配置并显示配置状态。项目会持久化到 `portal/storage/<projectId>/project.json`，媒体和产物保存在同一项目目录。标准版转录会提交任务并轮询结果；未配置时 API 会返回 `needs_input`，不会伪造剪辑完成。视频剪辑使用本机 Claude Code CLI，以 `claude-opus-5-5` 固定模型运行，不自动降级；该 CLI 使用同一 Anthropic API Key 和可选的 `ANTHROPIC_BASE_URL`。

### Claude Code 媒体编辑器

剪辑阶段会在项目中加载 `agent-skills/video-edit/SKILL.md`。Opus 检查旋转、音轨、真实原片帧和逐词转录，自主决定是否需要 B-roll；需要时通过受限 MCP 搜索 Pexels/Pixabay、查看候选缩略图、自动下载最多 3 条素材，并把实际来源、许可信息、SHA-256 和插入时间写入工程。随后它编写字幕、剪辑脚本、HyperFrames 工程（按需）与低清预览；批注后继续修改同一工程、导出终稿并重新查看成片抽帧。短样例可以没有额外 Shorts、标题卡或 CTA。媒体 shell 保持断网，任意 URL、外域重定向、超大或无效媒体都会被拒绝。

Claude Code 只拿到这个样例工作区和媒体 MCP 工具。工具可返回真实视频帧供视觉审查，FFmpeg/FFprobe/Python/Node 命令通过 Bubblewrap 在断网隔离环境运行，只能写入本轮工作区；工作区之外的项目、门户 `.env`、Claude 用户配置和宿主环境密钥不可读。每阶段模型费用限额为计划 `$4`、终稿 `$6`，Claude Code 会话硬上限为 30 分钟。产物保留原视频之外的版本化预览、终稿、SRT/ASS、源码、工具日志和 QC 报告。人工仍须完整观看交付视频；AI 抽帧报告不是最终验收。

## 当前真实能力

- `GET /api/health`：服务健康与配置状态；
- `GET /api/config`：只返回是否已配置，不返回密钥；
- `POST /api/projects`：创建 Wayne 工作流项目；
- `POST /api/projects/:id/input`：接收 multipart 视频并通过 FFprobe 读取媒体信息；
- `POST /api/projects/:id/input/chunk` + `POST /api/projects/:id/input/complete`：移动端使用 8MB 分块上传，支持中断后从已确认字节继续；
- `POST /api/projects/:id/music`：可选上传 MP3/WAV/M4A/AAC/OGG/FLAC（最多 50MB），要求确认音乐使用许可；项目 API 不会泄露本地文件路径；
- `POST /api/projects/:id/broll`：可上传 MP4/MOV/M4V/WebM B-roll（最多 100MB/个），需确认素材使用许可；Claude 只会在已上传素材中安排时间点，缺少素材时返回空列表；
- `POST /api/projects/:id/broll/search`：保留手动候选搜索入口；正式 Claude Code 剪辑由 Opus 自己调用 MCP 搜索、查看和下载，搜索结果、实际下载、计划插入和最终审片分别记录；
- `GET /api/projects/:id`：读取项目状态；
- `GET /api/projects/:id/timeline`：将已确认计划转换为 path-safe `timeline.v1`，用于独立渲染器或 OpenChatCut sidecar；尚无计划时返回 409；
- `GET /api/engines`：读取引擎集成状态；未完成真实渲染和 QC 的 adapter 明确标记为 disabled；
- `POST /api/engines/openchatcut/probe`：连接本机 OpenChatCut MCP 并只读列出工具；需要配置本机 URL 和 Bearer token，不会选择项目或发起编辑；
- `GET /api/engines/openchatcut/projects`：只在 loopback Wayne 页面读取 OpenChatCut 工程 ID、名称和更新时间；服务卡片中的目标选择只保存在当前页面，不会切换 OpenChatCut 工程或传输素材；
- `GET /api/projects/:id/events`：SSE 状态流；
- `POST /api/projects/:id/advance`：推进阶段，转录阶段调用火山引擎，失败后自动尝试腾讯云；
- `POST /api/projects/:id/replan`：在现有工程和批注基础上重新启动 Claude Code / Opus 5.5，制作修订预览并视觉审查；
- `GET /api/projects/:id/chat`：读取当前项目的多轮对话编辑会话、消息和版本历史；
- `POST /api/projects/:id/chat/messages`：把一条自然语言修改请求加入当前会话；请求立即返回，后台基于最新成功版本运行 Claude Code，并通过项目 SSE 推送 `chat_started`、`chat_completed` 或 `chat_failed`；
- `POST /api/projects/:id/comments`：保存时间戳批注。
- `POST /api/projects/:id/render`：继续同一个 Opus 5.5 剪辑工程，按批注生成终稿、短视频（适合时）和字幕，逐帧检查并修正。服务端独立检查真实审片帧、音视频流与同步、持续黑帧、白名单路径和导出分辨率；失败不会标记为 `completed`。
- `POST /api/projects/:id/render/remotion-preview`：可选生成 Remotion ProRes 4444 alpha overlay 和 FFmpeg 合成对照预览；检查 alpha、画面尺寸、音视频同步和黑帧，不改变 Wayne 正式导出路径；
- `GET /api/projects/:id/artifacts/:name`：下载项目白名单产物。

### 多轮对话调整

导出首个版本后，可以进入“对话调整”工作台继续修改。每条消息都默认基于最近一次 QC 通过的版本，生成新的版本号（例如 v1 → v2 → v3）；历史视频和工程产物不会被覆盖。发送请求时可以附带 `timeMs` 和 `rangeEndMs`，界面会把它们显示为本轮修改范围。

对话会话保存在项目的 `editSession` 中，编辑工作区会复用同一份 Claude Code 工程并保存每轮的输入、会话 ID、审片证据和 QC。只有新版本通过 QC 才会推进 `latestVersion`；失败时上一版仍然是当前可编辑版本。前端的“查看版本”只切换播放内容，下一轮修改仍以页面明确显示的最新版本为基准。

上传接口限制单文件 500MB；原始 MP4 和成片路由支持 HTTP Range，浏览器可以拖动预览。健康接口只返回服务能力状态，不暴露项目数量或密钥。

### 状态与真实能力

状态流为 `created → inspecting → transcribing → transcript_ready → planning → plan_ready → preview_ready → awaiting_revision → planning → plan_ready → preview_ready → rendering → completed`。计划和终稿会调用本机 Claude Code；CLI、模型或工具失败会保留工作区和错误信息，不会使用固定模板假装已完成。前端通过 SSE 订阅项目状态，刷新页面会从 `localStorage` 的项目 ID 重新读取服务端快照。

公网反代需要同时转发：门户页面 `/wayne/` 到 Vite（或构建后的静态文件），`/wayne-api/` 到 `127.0.0.1:18787`。火山引擎标准版还需要能从公网 HTTPS 访问 `/media/:projectId/transcript-audio.wav`。

## 配乐与验证

素材阶段可上传已获授权的配乐和 B-roll 并确认使用许可。在线搜索需要在服务端 `.env` 配置 `PEXELS_API_KEY` 和/或 `PIXABAY_API_KEY`；密钥不发送到浏览器。每次搜索最多 3 个分镜、每个分镜最多 2 个关键词；结果按关键词、方向、分辨率、时长预排序，不代表 VLM 视觉验证。搜索结果缓存 24 小时，每个来源 IP 每小时最多 20 次搜索；用户需在授权页确认具体素材许可，再自行下载并上传到项目，当前不会自动抓取/保存搜索结果。HyperFrames 使用单独锁定的 `hyperframes-runtime/`，不共享门户和 OpenChatCut 的 `node_modules`；Hook、重点、CTA 会渲染成透明 ProRes 4444 MOV，并与 HTML/GSAP 源码一起交付。FFmpeg 将其叠加到主片和 Shorts，再处理已上传 B-roll、字幕和配乐。运行 `npm run verify` 可验证计划约束、候选规范化与排序、透明动效、实际 FFmpeg 合成/QC，以及隔离存储中的素材许可校验和上传 API；`WAYNE_STORAGE_DIR` 可指定独立项目存储目录。手动查看 HyperFrames 样例：`cd hyperframes-demo && npm run check && npm run render`。

### 可选视频引擎接入层

当前默认引擎仍为 Wayne/Claude Code + FFmpeg + HyperFrames。共享契约位于 `contracts/timeline.v1.schema.json` 和 `contracts/render-manifest.v1.schema.json`，纯转换与校验代码在 `server/timeline-contract.mjs`。`GET /api/projects/:id/timeline` 只返回媒体元数据、剪辑事件和资源许可信息，不返回本机绝对路径；渲染器需要由受控 worker 根据 project ID 在授权工作区解析媒体文件。

- `remotion-runtime/` 是独立 Remotion 4.0.539 renderer，自己锁定 `@remotion/*` 版本并把 Zod 覆盖到已修补版本，不复用 OpenChatCut 的 `node_modules`。Claude Code 可通过无路径参数的 `mcp__video__render_remotion_preview`，按当前 `edit-plan.json` 生成最多两次动效对照，并用 `view_frame` 审查；成功且与当前计划哈希一致的 MP4 会作为独立 `remotion-preview` 项目产物保存。它只把标题/重点叠加到原视频上，不替代 Wayne 草剪或正式导出。`npm run verify:remotion` 会真实渲染透明 ProRes overlay、验证 Claude MCP 调用、视觉审查和产物保存，并跑 API 合成 QC。当前本地免费使用假设为个人或不超过 3 人团队；官方规则见 [Remotion Free License FAQ](https://www.remotion.dev/docs/license/faq)。
- `motion-templates/wayne-mg/` 是官方 Motion Canvas 3.17.2 脚手架，含 Hook 标题卡样例；Vite 5 只监听 `127.0.0.1`。模板可以导出图像序列，由 Wayne 现有 FFmpeg 组装，移植到 Remotion 并通过 QC 后才能被项目调用。
- `openchatcut-adapter/` 通过本机 MCP 连接独立 OpenChatCut sidecar，不复制 AGPL-3.0-or-later 源码。只读探测和项目列表优先使用服务端环境变量 token，否则读取本机 `~/.openchatcut/mcp-token`；不把 token 返回浏览器。隔离开发 profile 使用各自的 token，联调时通过 Portal 服务端环境变量提供，不能把 token 放入 `VITE_*`。目标工程选择目前只读且不自动导入；实际编辑必须遵循 `begin_edit_session → edit tools → review_edit_session → readback`，并保留 OpenChatCut 的人工审批。

项目验证新增 `node server/timeline-contract.verify.mjs` 和 `node server/engine-adapters.verify.mjs`；运行 `npm run verify:remotion` 可额外检查真实 Remotion alpha 渲染、FFmpeg 合成预览和 API 产物写入。
