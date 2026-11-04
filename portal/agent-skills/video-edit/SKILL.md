---
name: video-edit
description: Edit real talking-head videos with Claude Code, word-timed transcripts, FFmpeg, Remotion main compositions, legacy HyperFrames and optional licensed B-roll. Use for every video editing phase.
---

# Claude Code 视频剪辑 / Cutline 项目适配版

你是剪辑师，不是只会输出 JSON 的计划器。你必须检查真实素材、建立 beat map、写入可执行剪辑计划、制作可编辑工程、渲染预览、用视觉工具审片、按证据修订，然后才交付终稿。

先读取以下文件：

1. `brief.json`：本轮目标、风格、批注和媒体信息；
2. `transcript.json`：逐词或逐句时间戳；
3. `assets.json`：已授权的 B-roll 和配乐；
4. `.claude/skills/video-edit/references/public-skill-audit.md`：公开 Skill 的来源与采用边界；
5. `.claude/skills/video-edit/references/editorial-grammar.md`：Wayne/Cutline 编辑语法、镜头角色、字幕、声音和品牌令牌；
6. `.claude/skills/video-edit/references/verification.md`：预览与终稿验证门禁。

这些规则吸收了公开的 MIT/Apache-2.0 项目经验，但不复制它们的品牌、字体、模板或外部素材流程。当前工作区的输入输出、MCP 工具和服务器 QC 是最终契约。

## 主视频制作方式

先读 `brief.compositionMode`。值为 `remotion-main.v1` 的新工程必须使用以下主流程：

1. Claude 决定剪辑、授权 B-roll、声音与视觉设计。用 FFmpeg 制作已实际裁剪的基础视频；基础视频不得提前烧入字幕或重复标题层。
2. `edit-plan.json` 的标准动效使用 `title_card`、`emphasis`、`cta`。把实际逐帧裁剪结果写为 `timeline.json`：`{"pieces":[{"src":[0,1000],"out":[0,1000]},{"src":[3000,4000],"out":[1000,2000]}]}`，时间单位为毫秒，源区间与计划保留区间一致，输出连续。
3. `captions.srt` 使用剪辑后的播放时间，所有文字来自当前确认的 `transcript.json`。字幕字号、垂直边距、描边与颜色通过 `edit-plan.json.captionStyle`（`fontSize` 8–64、`marginV` 0–160、`outline` 0–5、`color` 为 `#RRGGBB`）控制；用户要求字幕变大时须修改此样式，不能只改报告。完整保留语义，不用上下文猜词。读取 `.claude/skills/remotion/SKILL.md` 的动画和透明层规则。
4. 调用 `mcp__video__compose_remotion_video({baseVideo:"实际基础视频.mp4",phase:"plan|chat-edit|render"})`。工具按剪辑映射渲染 Remotion、烧字幕、保留基础音轨，并返回唯一的 `outputPath`、透明层、源码快照和哈希记录。
5. 对返回的主视频重新执行 `view_frame` 审查，至少三张跨时段帧，并覆盖每个实际动效和 B-roll；`manifest.main` 必须是这个准确的 `outputPath`，声明 `compositionMode: "remotion-main.v1"`。
6. 终稿使用源片目标尺寸重做基础视频和动效，沿用已审核的 `edit-plan.json`、`timeline.json`、`captions.srt` 与动效设计。不要修改终稿计划来绕过一致性检查。修改意见的时码属于 `brief.chatTurn.baseVersion` 的预览，不属于原片时间；根据已有映射定位素材。

此模式下不生成独立 Remotion 对照，也不强制生成 HyperFrames；同一个动效不要做两遍。合成失败即本轮未完成，保留旧版并说明原因，不能悄悄去掉动效。下面关于 HyperFrames 和动效对照的要求仅适用于没有此模式标记的旧工程；其余转录、授权、审片与 QC 规则共同适用。

## 工具与隔离环境

- `mcp__video__execute`：离线 Linux shell。可写目录只有 `/work`；FFmpeg、FFprobe、Python、Node 和已安装的 HyperFrames 可用。禁止安装包、访问任意外网或读取工作区外文件。
- `mcp__video__search_broll`：对 9:16 口播默认先评估 1–3 个具体场景意图。没有产品 UI 时，仍可使用与口播语义匹配的通用剪辑、工作流、键盘、素材整理等画面；只有会误导事实或没有任何视觉增量时才跳过。
- `mcp__video__view_broll_candidate`：下载前必须查看候选缩略图和许可信息。
- `mcp__video__download_broll`：只下载紧接着搜索得到并审查过的候选；一轮最多 3 个。任何 `brollEvents` 只能引用实际下载的素材。
- `mcp__video__write_file` / `mcp__video__read_file`：管理脚本、字幕、HyperFrames 源码、计划和报告。
- `mcp__video__view_frame`：真实视觉审片。不能用 FFmpeg 退出码、文件大小或文字描述代替。
- `mcp__video__compose_remotion_video`：新模式下真正合成主视频；输出不可替换为独立对照，真实合成记录必须能与主视频绑定。
- `mcp__video__render_remotion_preview`：从当前 `input.mp4`、`brief.json` 和已校验的 `edit-plan.json` 生成 Remotion 动效对照预览；不接受路径或代码参数。预览只用于比较视觉样式，不替代 Wayne 正式草剪或终稿。

## 必须遵守的编辑流程

### 1. 检查素材

用 FFprobe 检查真实显示宽高、旋转、帧率、视频/音频轨和时长。原片至少查看开头、中段、结尾三帧；先确认脸、屏幕和字幕安全区，再决定构图。发现旋转时以显示方向为准，不要直接使用编码宽高。

读取逐词时间戳：忽略负时间的占位项，保留完整单词和完整语义。删除停顿、口误和明显重录，但不要为了追求快而切碎句子。ASR 不确定时保留原词或在报告中标注，不得编造事实。

计划阶段收到 `transcript.original.json` 和 `transcript.whisper.json` 时，在同一次计划调用中比较两份 ASR 文本并输出 `transcript-proofread.json`。Claude Code CLI 不能直接听音频：不得声称已听音；每项更正必须引用 primary、whisper 或 both 文本证据。无法从两份识别稿支持的分歧记入 unresolved，保留原始台词，不得按语境猜词。保留原稿、第二稿和来源时间戳；将校对稿同步写入 `transcript.json`。若没有 Whisper 第二稿，原文不变并标记 `manual_review_required`。

### 2. 建立 beat map

先按 `.claude/skills/video-edit/references/editorial-grammar.md` 写出内部 beat map：`hook`、`teaser`、`context`、`proof`、`payoff`、`brand`、`cta`，并为每段选择 `FULL`、`PUNCH_IN`、`SPLIT`、`BROLL_COVER` 或 `TEASER` 镜头角色。节奏由语义和能量决定，禁止机械地每秒切一次。

然后写入当前门户契约的 `edit-plan.json`：

```json
{
  "summary": "string",
  "segments": [{"id":"string","startMs":0,"endMs":1000,"action":"keep|tighten|remove","title":"string","note":"string"}],
  "shorts": [{"id":"string","startMs":0,"endMs":1000,"title":"string","note":"string"}],
  "visualEvents": [{"id":"string","type":"title_card|emphasis|cta","startMs":0,"endMs":1000,"text":"string","subtext":"string"}],
  "brollEvents": [{"id":"string","assetId":"string","startMs":0,"endMs":1000,"sourceStartMs":0}]
}
```

`segments` 必须覆盖所有决定保留、收紧或删除的原始区间；`tighten` 必须由实际脚本执行，不能只写备注。`visualEvents` 必须落在保留片段内，文案必须来自转录或用户目标。没有真实 CTA 时不要发明 CTA。短素材可以使用 `shorts: []`，不能为了满足数量制造重复片段。

复杂镜头推进、屏幕插入、转场、动态字幕和声音处理必须写入 `edit.py` 或 HyperFrames 源码，并列入 `manifest.sources`；只写在 `note` 中不会产生任何画面变化。

### 3. 设计与渲染

- 进入动画至少同时改变透明度、位移或缩放中的两项；列表和字幕要错峰进入；退出通常比进入更快。
- 所有时间由 `fps` 和真实时间戳推导，禁止随机数、当前时间和运行时网络请求。
- 统一使用项目令牌：`#f1f3ea`（ink）、`#c6f475`（mint）、`#f58c53`（orange）、`#111311`（panel）。新颜色、字体和动效先写入项目说明。
- 竖屏 9:16 画面必须优先为手机观看设计：关键文字放在中间 70% 安全区；标题卡不超过画面高度约 22%，持续 0.8–2.5 秒；每个字幕组 1–4 个词或一行短语；不要让大段文字长期覆盖头顶或胸口。
- 9:16 口播至少安排两类画面变化：`PUNCH_IN` 加 `BROLL_COVER`/`SPLIT`/`HyperFrames` 动效中的至少一类。每 8–15 秒应有一次可解释的视觉变化，但不要把所有变化都做成同一种卡片。
- 旧工程中 HyperFrames 不是可选装饰：在可用时至少制作一个 Hook、重点或转场动效，并在 `manifest.sources` 和 `manifest.review.notes` 中列出实际执行的动效源与审片时间。新主模式用 Remotion 实现并验收同样的真实动效。
- 人脸特写字幕放在胸口或安全带，通常 1–2 行；不能遮挡眼睛、嘴或屏幕关键内容。不要同时显示内容完全重复的标题和字幕。
- 字幕必须覆盖所有保留的口播。如果某些口播词由对应时间的 HyperFrames 动效逐字呈现、因此从 `captions.srt` 隐藏，必须在 `edit-plan.json.captionCoverage` 中写出 `eventId`、精确源时间和逐字文本；不能用概述或语义相近的文案代替。该词句必须能在 `manifest.sources` 声明的 HTML/JS 动效源码中找到，并在成片审片帧中确认。
- A-roll 是声音骨架；B-roll 覆盖画面但不能改变口播事实。B-roll 必须有来源、许可和最终审片帧。
- 配乐必须低于人声并自动 duck。可使用 `ffmpeg` 合成短 SFX；最终目标参考为约 `-16 LUFS`、真峰值不高于 `-1.5 dBTP`，噪声被放大时要写入限制。

优先使用可编辑的 HyperFrames HTML/GSAP 或 Python/FFmpeg 工程；不要使用无法复现的截图拼接或一次性命令。保留所有脚本、字幕、素材索引和命令日志。

### Remotion 动效对照

仅在旧工程的 `plan` 和修改 `visualEvents` 的 `chat-edit` 阶段，先稳定 `edit-plan.json`，再调用一次 `mcp__video__render_remotion_preview`。用 `mcp__video__view_frame` 检查至少两个不同事件时点，判断标题是否更清楚、有没有挡住人物或关键信息。只有调整了 `visualEvents` 才进行第二次对照渲染；每轮最多两次。Remotion 输出会作为单独的对照视频保存到项目中，不能把原片叠字对照说成已完成剪辑，也不能替代 Wayne 的标准预览、HyperFrames 动效或终稿 QC。工具失败时记录原因并继续标准流程。

### 4. plan 阶段

制作低清但完整的 `preview.mp4`，不要导出终稿。至少查看：

- 三个跨时段的预览帧；
- 每个 B-roll 插入区间的一帧；
- 一个字幕/动效高峰；
- 一个 Hook 或 teaser；
- 一个结尾或 CTA（若真实存在）。

运行 `node .claude/skills/video-edit/scripts/verify-render.mjs preview.mp4`（必要时传入宽高和时长约束），然后修复发现的问题。写入：

```json
{
  "phase": "plan",
  "main": "preview.mp4",
  "subtitle": "captions.srt",
  "sources": ["edit.py", "captions.ass"],
  "shorts": [],
  "broll": [{"assetId":"...","startMs":0,"endMs":1000,"sourceStartMs":0,"reviewTimeSeconds":1.2}],
  "hyperframes": {"rendered": true, "source": "overlay/index.html", "reviewTimeSeconds": 1.2},
  "review": {"passed": true, "notes": "实际检查了什么、仍有哪些限制"}
}
```

### 5. render 阶段

读取已有预览、源码、计划、brief 和时间戳批注，在同一个工程上应用修改。渲染 `final.mp4` 和适合素材的 Shorts；保持原片显示方向，除非 brief 明确要求改变。终稿必须重新查看至少三张跨时段帧，并重新查看每个修改点和 B-roll 区间。任何重渲染后都要重新审片，不能复用旧帧哈希。

写入 `manifest.json`：

```json
{
  "phase": "render",
  "main": "final.mp4",
  "subtitle": "captions.srt",
  "sources": ["edit.py", "captions.ass", "edit-report.md"],
  "shorts": [{"path":"short-01.mp4","title":"...","slot":1}],
  "broll": [],
  "hyperframes": {"rendered": true, "source": "overlay/index.html", "reviewTimeSeconds": 1.2},
  "review": {"passed": true, "notes": "实际视觉检查、音频检查和限制"}
}
```

## 完成门禁

在报告中记录 `ffprobe`、`blackdetect`、音视频同步、字幕、B-roll、视觉事件、响度和人工限制。服务端还会独立校验：真实视觉工具调用、音视频流、持续黑帧、源码白名单、B-roll provenance、Shorts 尺寸和计划执行数。

以下任一项失败都不能把结果标为通过：没有真实 `view_frame` 证据；B-roll 没有来源或许可；字幕遮挡脸；画面有意外黑帧；音视频不同步；输出依赖未声明的外部网络/包；或生成了原片没有提供的 CTA、事实、人物和产品画面。

最多进行两轮修复。无法解决时保留当前工程和真实错误，不能伪造 `manifest.json` 或 QC 通过。
