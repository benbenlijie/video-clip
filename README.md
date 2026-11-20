# Wayne Workflow Portal

An AI-assisted talking-head video workflow: upload footage, transcribe it, plan the edit, review a rendered preview, revise it in natural language, and export a verified final cut. The project is designed as a local, single-user workstation rather than a hosted SaaS.

一个面向口播视频的 AI 辅助剪辑工作流：上传素材 → 转录与字幕校对 → 生成剪辑方案 → 渲染预览 → 对话式修改 → 质量门禁 → 导出成片。当前形态是本地单用户工作站，不是注册即用的在线服务。

> 状态：开发预览版。真实剪辑依赖本机 Claude Code、FFmpeg、可选的 Whisper/云 ASR；未配置的服务会明确返回 `needs_input`，不会伪造完成结果。

## 能力概览

| 模块 | 能力 |
| --- | --- |
| 素材接入 | 单条口播、多素材方案、分块上传、HTTP Range 预览 |
| 转录 | 火山引擎 / 腾讯云 ASR，可选本地 Whisper.cpp 二次校对 |
| 剪辑方案 | Claude Code + Opus 读取真实帧、逐词转录和素材授权后生成可执行方案 |
| 预览与修改 | FFmpeg / Remotion 渲染，版本化草剪，自然语言对话式改稿 |
| 视觉与声音 | 字幕、动效、配乐、B-roll、响度/黑帧/音画同步检查 |
| B-roll | Pexels、Pixabay、Mixkit、Coverr、影视飓风，保留许可与来源记录 |
| 参考风格 | 参考视频拆解、StylePack 审批、受控模板应用（默认关闭） |
| 质量门禁 | 剪辑流畅度、字幕遮挡、技术质量、审片证据与导出前检查 |
| 素材导入工具 | 视频号链接、百度网盘分享、多源 B-roll 下载 |

## 架构

```text
portal/src/                     React + Vite 前端
portal/server/                  Node.js HTTP API、SSE、MCP、Claude Code 编排
portal/contracts/               时间轴、风格、翻译与渲染契约
portal/agent-skills/            剪辑、参考风格、审片与素材下载技能
portal/remotion-runtime/        Remotion 主合成运行时
portal/hyperframes-runtime/     旧工程兼容的 HyperFrames 运行时
portal/style-project-template/  受控 Remotion 风格工程模板
docs/                           架构、方案和实现记录
```

核心链路：

```text
上传 → FFprobe / ASR → 转录校对 → Claude Code 剪辑 → 预览
     → 人工审片 / 对话修改 → QC → 终稿导出
```

服务端把项目、素材、版本和审片证据保存在 `portal/storage/<projectId>/`。该目录、下载缓存和渲染产物都不进入 Git。

## 快速开始

要求：

- Node.js 22+
- npm
- FFmpeg / FFprobe
- 本机 Claude Code CLI（真实剪辑阶段）
- 可选：Whisper.cpp、bwrap、Python 3 + OpenCV

```bash
cd portal
cp .env.example .env
# 只在服务端填写需要的 Key，不要把密钥放进 src/ 或 VITE_* 变量
npm install
```

终端 1：

```bash
cd portal
npm run api
```

终端 2：

```bash
cd portal
npm run dev
```

打开 `http://localhost:5174/`。API 默认监听 `http://127.0.0.1:18787`。

生产预览：

```bash
cd portal
npm run build
npm run preview -- --host 0.0.0.0 --port 5174
```

更完整的配置、API、素材许可和多素材流程见 [portal/README.md](portal/README.md) 与 [docs/reference-style-transfer.md](docs/reference-style-transfer.md)。

## 测试

常用验证：

```bash
cd portal
npm run typecheck
npm run verify
npm run verify:style
npm run verify:remotion
```

部分验证需要 FFmpeg、Chromium、本地 Whisper 或隔离运行环境。测试默认使用本地 fixture，不应调用真实 Claude、Pexels 或 Pixabay，也不应产生付费请求。

## 安全与隐私

- 所有 API Key、ASR 凭证和 MCP Token 只放在服务端 `.env`。
- 浏览器端只拿到能力状态，不拿到密钥、签名直链或服务端绝对路径。
- 上传视频、转录、渲染产物和审计日志默认写入被忽略的运行时目录。
- B-roll 和配乐必须记录来源与许可；工具不会绕过登录、实名校验、付费或授权订单。
- 模型工具受工作区路径校验约束；当前兼容模式不是内核级沙箱，部署者仍需限制网络与宿主目录权限。
- 公开仓库不包含用户素材、模型凭证或本地运行数据。

## 第三方组件与许可

本项目代码以 MIT License 发布。仓库中的第三方运行时和素材保留各自许可：

- Remotion 按其免费/商业许可使用；
- GSAP 按其 Standard License 使用；
- OpenChatCut 通过独立 sidecar 的 MCP 接口集成，不复制其 AGPL-3.0-or-later 源码；
- Mixkit、Coverr、Pexels、Pixabay、影视飓风等素材遵循各自许可，不能因为“可下载”就视为可商用。

## 参与贡献

提交前请先运行与改动相关的验证脚本，并确保不提交 `.env`、用户素材、模型凭证或未授权的 B-roll。涉及素材许可、密钥和公开响应的改动必须附带对应测试。

## License

[MIT](LICENSE)
