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

当前 API 默认运行在 `http://127.0.0.1:18787`，读取这些配置并显示配置状态。项目会持久化到 `portal/storage/<projectId>/project.json`，媒体和产物保存在同一项目目录。标准版转录会提交任务并轮询结果；未配置时 API 会返回 `needs_input`，不会伪造剪辑完成。

## 当前真实能力

- `GET /api/health`：服务健康与配置状态；
- `GET /api/config`：只返回是否已配置，不返回密钥；
- `POST /api/projects`：创建 Wayne 工作流项目；
- `POST /api/projects/:id/input`：接收 multipart 视频并通过 FFprobe 读取媒体信息；
- `POST /api/projects/:id/input/chunk` + `POST /api/projects/:id/input/complete`：移动端使用 8MB 分块上传，支持中断后从已确认字节继续；
- `GET /api/projects/:id`：读取项目状态；
- `GET /api/projects/:id/events`：SSE 状态流；
- `POST /api/projects/:id/advance`：推进阶段，转录阶段调用火山引擎，失败后自动尝试腾讯云；
- `POST /api/projects/:id/replan`：基于现有转录重新生成可执行视觉剪辑计划（Hook、重点强调、CTA），保留旧版计划和成片；
- `POST /api/projects/:id/comments`：保存时间戳批注。
- `POST /api/projects/:id/render`：根据已确认计划调用 FFmpeg，执行视觉事件、生成字幕烧录主片、5 条 9:16 Shorts、SRT、Cut List、QC 和命令日志；重复渲染使用版本化产物，只有视觉事件全部执行且 QC 通过才进入 `completed`。
- `GET /api/projects/:id/artifacts/:name`：下载项目白名单产物。

上传接口限制单文件 500MB；原始 MP4 和成片路由支持 HTTP Range，浏览器可以拖动预览。健康接口只返回服务能力状态，不暴露项目数量或密钥。

### 状态与真实能力

状态流为 `created → inspecting → transcribing → transcript_ready → planning → plan_ready → preview_ready → awaiting_revision → rendering → completed`。凭证缺失或外部服务失败会进入 `needs_input`/`failed` 并持久化错误信息；不会使用假转录或假成片填充交付页。前端通过 SSE 订阅项目状态，刷新页面会从 `localStorage` 的项目 ID 重新读取服务端快照。

公网反代需要同时转发：门户页面 `/wayne/` 到 Vite（或构建后的静态文件），`/wayne-api/` 到 `127.0.0.1:18787`。火山引擎标准版还需要能从公网 HTTPS 访问 `/media/:projectId/transcript-audio.wav`。
