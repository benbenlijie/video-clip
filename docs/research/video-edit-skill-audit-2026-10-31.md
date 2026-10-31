# 视频剪辑 Skill 公开项目审查

日期：2026-10-31

## 结论

没有找到一个可以直接覆盖当前项目的“万能 Skill”。最稳妥的方案是组合采用四类公开经验：Remotion 动效硬规则、HyperFrames 短视频编辑语法、FFmpeg/Whisper 基础管线、以及 fail-closed 工作流和 provenance。当前项目已经有自己的 Claude Code、MCP、HyperFrames、FFmpeg 和 QC 契约，直接安装外部 Skill 会引入不同的输入输出格式、依赖和素材许可证边界。

## 候选与来源

| 候选 | 许可证 | 采用内容 | 不直接采用的原因 |
| --- | --- | --- | --- |
| [haidrrrry/claude-remotion-skill](https://github.com/haidrrrry/claude-remotion-skill) | MIT | springs/easing、stagger、主题令牌、逐词字幕、渲染后抽帧复核 | 当前门户不是 Remotion 项目 |
| [nopefallacy/vertical-video-editing-skills](https://github.com/nopefallacy/vertical-video-editing-skills) | MIT | beat map、A-roll/B-roll、split layout、非匀速剪辑、SFX、style pack、render gate | 其目录契约和 HyperFrames 工程结构不同 |
| [6missedcalls/video-editing-skill](https://github.com/6missedcalls/video-editing-skill) | MIT | trim/jump-cut/caption/overlay 的简单顺序 | 当前项目已经有自己的媒体 MCP 和服务器端 QC |
| [KyaniteLabs/kinocut](https://github.com/KyaniteLabs/kinocut) | Apache-2.0 | 严格工作流 schema、fail-closed、receipt、resume、provenance | 直接安装 MCP 会重复现有工具并扩大运行时范围 |
| [kevinbadi/open-edits](https://github.com/kevinbadi/open-edits) | MIT | FULL/SPLIT/HERO 镜头角色、短语字幕、真实素材优先 | 模板中带有项目专属品牌、字体和外部素材流程 |

## 当前适配结果

适配后的 Skill 位于：

`portal/agent-skills/video-edit/`

新增内容：

- `references/public-skill-audit.md`：来源、许可证、依赖、输入输出和采用边界；
- `references/editorial-grammar.md`：Wayne/Cutline 的 beat map、Hook/teaser/context/payoff/CTA、镜头角色、字幕、声音和品牌令牌；
- `references/verification.md`：预览、终稿、字幕、B-roll、黑帧、同步和可回退产物门禁；
- `scripts/verify-render.mjs`：可在 Claude Code 隔离工作区中运行的本地媒体验证脚本。

## 证据边界

公开项目的许可证只覆盖其代码和文档，不覆盖它们引用的字体、Logo、GIF、音乐或股票视频。当前适配版默认不下载外部素材，不把远程 URL 当成最终资产，也不允许把没有许可证明的素材写入 `brollEvents`。

本次验证使用仓库内已有的真实样片和已生成产物，执行本地 FFprobe、FFmpeg 黑帧检查、项目验证脚本、类型检查和构建；没有为了验证重复调用 Claude 或产生新的外部模型费用。
