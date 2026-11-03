# Wayne 视频引擎分层接入

## 目标

为 Wayne Portal 定义稳定的时间线和渲染产物契约，并以可选 adapter 接入 Remotion、Motion Canvas 模板和 OpenChatCut sidecar。保留现有 FFmpeg/HyperFrames/Claude Code 主链作为默认执行路径。

## 已确认约束

- 当前使用场景为个人或不超过 3 人小团队的本地免费使用。
- Remotion 官方当前 Free License 覆盖符合资格的个人/团队，包括自动化；团队规模和部署方式变化时重新核对官方条款。
- OpenChatCut 使用 AGPL-3.0-or-later，保持独立 sidecar，不复制进 Portal 源码。
- Motion Canvas 使用 MIT，作为独立模板作者工作区，不成为 Portal 服务运行时依赖。
- 所有渲染输出仍经过 FFprobe、音画同步、黑帧及项目级 QC。

## 当前实现

- `portal/server/timeline-contract.mjs`：从 Wayne 项目生成 `timeline.v1`；清理本地绝对路径；定义 `render-manifest.v1` 和引擎可用状态。
- `GET /api/projects/:id/timeline`：只读输出标准时间线契约。
- `GET /api/engines`：报告 Wayne、Remotion、OpenChatCut、Motion Canvas 的配置/集成状态。
- `GET /api/engines/openchatcut/projects`：loopback-only 只读列出项目 ID、名称和更新时间；Portal 选择器只保留当前页的目标，不会切换 sidecar 工程或上传媒体。
- `portal/remotion-runtime/`：Remotion `4.0.539` 独立运行时，渲染三类 Wayne visualEvents 为 ProRes 4444 alpha，并提供真实渲染验证。
- `portal/server/remotion-overlay.mjs`：输入校验、隔离子进程、alpha/尺寸检查和 FFmpeg 合成预览。
- `portal/server/video-agent-tools.mjs`：向 Claude Code 开放无路径参数的 `render_remotion_preview`，每轮最多生成两次对照；至少检查两帧；哈希匹配当前计划后才保存为项目产物。
- `portal/server/openchatcut-sidecar.mjs`：本机 MCP Streamable HTTP 探测，只初始化并列工具，不启动编辑事务。
- `motion-templates/wayne-mg/`：Motion Canvas `3.17.2` 官方脚手架和 Hook 标题卡模板，使用 Vite 5 loopback 开发服务并通过图像序列交给 Wayne FFmpeg。
- `openchatcut-adapter/`：独立 MCP/文件交换边界和 AGPL 说明。

## 已验证结果

- `npm run verify:remotion`：真实生成 ProRes 4444 alpha overlay，FFmpeg 合成对照 MP4，API 写入 overlay/preview/manifest 并通过项目级探测。
- `claude-remotion-tools.verify`：通过 Claude Code 使用的受限 MCP 启动真实 Remotion 渲染、检查源片和对照视频帧，并验证项目产物只保存经过帧审查且仍对应当前计划的预览。
- 已使用用户提供的 113.6 秒竖屏视频运行真实火山 ASR 和 Claude plan；第一轮按旧 12 分钟硬上限超时，但留下 92.37 秒草剪、31 段计划、7 个视觉事件和 3 个已授权 B-roll。Claude 的费用回执未返回，因此实际 API 费用未知。
- 之后用本机 Remotion 4.0.539 生成 113.592 秒对照，ProRes-alpha、尺寸、时长（8ms差）、音画同步（0ms起始/25ms时长差）及无黑帧检查均通过；测试计划的 B-roll 审查与哈希校验已补入工具。
- Claude Code 计划阶段的默认会话硬上限现为 30 分钟，单轮费用上限仍是 `$4`；下一次同片 replan 可验证新时限和修复后的 B-roll → Remotion 路径。
- `motion-templates/wayne-mg/npm run build`：TypeScript 检查和 Motion Canvas/Vite production bundle 通过。
- OpenChatCut 本机 Streamable HTTP MCP 探测通过；当前隔离 profile 返回 131 个工具和 3 个工程，Portal 只读列表及目标选择已在浏览器验证。README 推荐的 `npm run dev` predev 流程停在可选 whisper.cpp GitHub release 下载；因此本次没有验证 local ASR。
- Remotion runtime `npm audit`：在固定 4.0.539 后将其传递依赖 Zod 覆盖为 4.6.7，审计为 0 vulnerabilities。
- Motion Canvas starter 使用与官方插件兼容的 Vite 5、无额外 FFmpeg exporter wrapper；production build 和 production dependencies audit 通过。完整开发依赖 audit 仍报告 1 high、2 moderate，开发服务限制在 loopback。

## 后续实施

1. 在用户提供的视频上运行新的 30 分钟上限 Claude Code plan，检查已有计划/素材是否保留并生成新的 Remotion 对照；盲看 Wayne 草剪与 Remotion 动效，决定哪些视觉事件确实更清晰；不要仅凭工具可调用就将 Remotion 样式设为默认。
2. 让 Motion Canvas 作者工作区的标题卡进入模板清单，先由设计/开发选择和调整参数，再将对应视觉实现移植为 Remotion composition。
3. OpenChatCut 项目列表和显式目标选择已完成；实际媒体导入仍须先解决 OpenChatCut 的手动审批与活动会话，再在单独测试项目完成 readback。不得在用户取消后自动重提导入。
4. 只有当独立 OpenChatCut 项目回传产物格式和媒体路径契约被验证后，才实现 Wayne project 到 OpenChatCut 的自动导入；MCP 握手成功本身不代表 timeline 已导入。
5. 如果未来希望 Remotion 取代 HyperFrames 透明层，需在实际 portrait 和 landscape 口播上比较字体、帧准确度、长视频性能和视觉质量；目前 Remotion 只作为经审查的对照预览。
6. 每个 adapter 均保留输入时间线、引擎版本、源媒体哈希、输出哈希、渲染日志和 QC 报告。

## 当前非目标

- 不替换 FFmpeg/HyperFrames 默认渲染链。
- 不把 OpenChatCut 代码复制到 Portal。
- 不让 Remotion/Motion Canvas/OpenChatCut 直接读取服务端 `.env` 或任意项目路径。
- 不因为安装了包或 MCP 可连接就将引擎状态标为可用；必须有真实渲染产物和 QC 证据。

## 2026-11-02 OpenChatCut 联调检查点

- `Wayne MCP Integration Test`（`b0dff199-042a-4b73-a5fb-f70420eafb7a`）仍在隔离 profile 中，当前为空项目。
- 手动会话 `0a83f801-e2c8-4dea-a8c7-a5294d0bc86a` 处于 `drafting`、`approvalMode=manual`，并由原 MCP transport 持有；Agent 检查器记录 `import_media action=create_session` 已取消，实际素材字节没有传输。
- 新 transport 的恢复请求被 OpenChatCut 拒绝，原因是该会话尚未 orphan。不要丢弃、重建或重提导入；等待原 transport 释放后，再由用户决定是否重新发起 manual 导入。
