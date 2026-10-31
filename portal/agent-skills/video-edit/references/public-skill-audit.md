# 公开视频剪辑 Skill 审查与采用记录

审查日期：2026-10-31

本项目采用“吸收规则、保留当前运行时”的方式。公开仓库中的脚本、品牌资源和专属运行时不会直接覆盖当前 `mcp__video__*` 工具契约。

## 候选审查

| 项目 | 许可证 | 主要依赖 | 可复用内容 | 当前决定 |
| --- | --- | --- | --- | --- |
| [claude-remotion-skill](https://github.com/haidrrrry/claude-remotion-skill) | MIT | Remotion、React、FFmpeg | 动效硬规则、主题令牌、逐词字幕、渲染后抽帧复核 | 采用规则；不引入 Remotion 运行时 |
| [vertical-video-editing-skills](https://github.com/nopefallacy/vertical-video-editing-skills) | MIT | HyperFrames、FFmpeg、GSAP、style pack | beat map、A-roll/B-roll、非匀速节奏、镜头推进、SFX、render gate | 采用方法；适配现有 HyperFrames 和 FFmpeg |
| [video-editing-skill](https://github.com/6missedcalls/video-editing-skill) | MIT | Bash、FFmpeg、Whisper | 简单的 trim → jump cut → caption → overlay 管线 | 采用低级兜底思路；不复制脚本 |
| [kinocut](https://github.com/KyaniteLabs/kinocut) | Apache-2.0 | Python、FFmpeg、MCP、CLI | 严格 schema、fail-closed、工作流 receipt、resume 和 provenance | 采用契约思想；不安装其 MCP 服务 |
| [open-edits](https://github.com/kevinbadi/open-edits) | MIT | Python、OpenCV、Whisper、PIL、外部素材 | FULL/SPLIT/HERO 镜头角色、短语字幕、真实素材优先 | 采用镜头角色；不复制其品牌资产和模板代码 |

## 依赖与输入输出边界

当前工作区已经提供：

- `input.mp4`、`transcript.json`、`brief.json` 和 `assets.json`；
- `mcp__video__execute`、`mcp__video__read_file`、`mcp__video__write_file`、`mcp__video__view_frame`；
- 受限的 `search_broll`、`view_broll_candidate` 和 `download_broll`；
- 离线 FFmpeg、FFprobe、Node、HyperFrames CLI；
- `edit-plan.json`、`manifest.json`、`captions.srt` 和可编辑源码的服务端校验。

因此公开 Skill 的 Remotion 专用组件、外部下载脚本和全局安装命令不适合直接使用。适配版把它们转换为：

```text
转录与素材检查
→ beat map / 镜头角色
→ 当前 edit-plan.json
→ 自有 edit.py 或 HyperFrames 源码
→ preview.mp4
→ 真实抽帧审阅
→ feedback 修订
→ final.mp4 + captions.srt + manifest.json
```

## 许可证结论

- MIT 和 Apache-2.0 允许在本项目中参考和改写方法，但仍需保留来源记录；本文件就是来源与采用证据。
- 没有明确许可证的项目不进入运行时，也不复制其代码或资源。
- 任何下载的 B-roll、字体、Logo、GIF 和音乐仍然需要单独核对来源和使用许可；公开 Skill 的许可证不等于素材许可证。
