# OpenChatCut 研究与运行记录

## 当前结论

OpenChatCut 适合作为 Claude 直剪实验底座：它提供本地视频项目、多轨时间线、Agent Skills、MCP 和 Remotion 预览/导出能力。

在本项目中，OpenChatCut 的角色已从“让 Claude 自由探索的剪辑器”调整为**成功视频工作流的执行底座**。产品入口、阶段状态、模板和验收规则见项目文档：`docs/PRODUCT.md` 与 `docs/DESIGN.md`。

研究版本：`v0.2.17`，上游 main 最新提交为 `7fa4b790`；许可证为 `AGPL-3.0-or-later`。

本地研究副本位于 `openchatcut-src/`，开发服务已启动在 `http://localhost:5199/`。

## 已验证

- Node.js 24.22.1 可用，符合仓库 `>=24 <25` 要求。
- npm 依赖安装完成。
- MediaPipe WASM 与模型同步完成。
- `npx tsc -b` 通过。
- Vite 构建通过，Remotion 相关 bundle 已产出。
- `npm run dev:shared` 启动成功，首页返回 HTTP 200。
- MCP endpoint：`http://localhost:5199/api/external-mcp/mcp`。
- MCP 初始化成功，服务名为 `openchatcut`，协议版本为 `2025-03-26`。
- 未提供 Bearer token 的 MCP 请求返回 403，鉴权边界生效。
- Claude Code CLI 的临时 MCP 连接探测已发起；本次只要求列出服务/工具，不允许编辑或渲染。网关在预算上限处结束请求，因此没有把“Claude 已成功列出工具”作为已验证结论。
- 第二次 Claude Opus 5.5 直剪冒烟测试已切换到 `permission-mode auto`，权限拒绝问题消失；但模型在 38 次工具循环、约 7 分钟后仍未返回稳定的最终状态，已主动终止。未确认 `review_edit_session` 应用成功，也未确认视频被修改。
- 测试只使用本地 `test-assets/vibe-coding-sample.mp4`；没有调用发布、上传或删除工具。

## 当前限制

- GitHub clone/codeload 和 Whisper release 下载在当前环境速度极慢或被重置。
- 因此源码是通过 GitHub API/raw 精确抓取的研究副本，不应视为完整上游镜像。
- 本地 Whisper CLI 尚未安装；需要真实 `whisper.cpp` 二进制后才能验证本地 ASR。
- 少量供应商图标使用了本地启动占位资源，仅用于构建验证，正式使用前应替换为上游资源。
- MCP token 只注入当前开发进程：`local-openchatcut-test-token`，没有写入全局 Claude 或 Codex 配置。

## Claude 接入方式

OpenChatCut 官方方式是：

```bash
claude mcp add --transport http openchatcut \
  http://localhost:5199/api/external-mcp/mcp
```

如果服务启用了 token，应改用 Claude Code 支持的 Bearer token 环境变量配置，并保持 token 仅在本机环境中保存。接入后应先调用 `begin_edit_session`，再把 `editSessionId` 传给每个编辑工具，最后调用 `review_edit_session`。

## Remotion 角色

OpenChatCut 已将 Remotion 用作预览、组合和服务端导出底座。未来产品可以复用这层：Claude 负责直剪决策和工具编排，Remotion 负责可复现的时间线/特效渲染，FFmpeg 负责媒体探测、裁切、拼接和转码。
