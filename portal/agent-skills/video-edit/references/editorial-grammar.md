# Wayne / Cutline 编辑语法

这份规则是公开 Skill 的项目化适配层。它规定 Claude 如何把内容理解转成当前工作区可以执行的编辑，而不是要求使用某个特定渲染器。

## 1. 先建立 beat map

在写 `edit-plan.json` 前，先为每个内容段记录：

```text
beat:
  source: 原始时间区间
  purpose: hook | teaser | context | proof | payoff | brand | cta
  energy: quiet | build | hit | release
  a_roll: 主讲人是否继续作为声音和画面骨架
  b_roll: none | screen | uploaded | licensed-stock | build-in-editor
  camera: full | punch_in | punch_out | split | broll_cover
  graphic: none | title_card | emphasis | cta | callout | number_card
  caption: 1–4 个词的短语组、关键词和安全位置
  transition: hard_cut | dip | push | whip | match_cut
  sfx: none | hit | whoosh | tick | custom
```

`beat map` 是编辑决策的中间层。最终仍必须写入当前门户能验证的 `segments`、`visualEvents` 和 `brollEvents`；不能只把决策留在自然语言备注中。

## 2. Wayne 结构

- **Hook**：前 0–3 秒先说明冲突、结果或收益。没有证据时不制造夸张承诺。
- **Teaser**：如果后文有清晰的结果画面或关键句，可在开头短暂预告一次，再回到上下文。
- **Context**：用完整句子交代问题，不为了追求快而切碎语义。
- **Proof / Payoff**：关键论点必须配合 punch-in、屏幕录制、真实 B-roll 或克制的图形强调。
- **Brand / CTA**：只有原片或项目 brief 明确提供 CTA 时才生成 CTA；没有就保留真实结尾并在报告中说明。

## 3. 镜头角色

优先从以下角色中选择，避免每段都用同一种标题卡：

- `FULL`：完整保留主讲人，适合上下文和重要语句。
- `PUNCH_IN`：1.06–1.16 倍局部推进，用于关键词或情绪击打；脸和字幕安全区必须重新检查。
- `SPLIT`：主讲人和屏幕录制/B-roll 同时出现，适合解释操作或产品界面。
- `BROLL_COVER`：B-roll 覆盖画面但保留主讲人声音；只使用已审查和已授权素材。
- `TEASER`：短暂展示后文结果，不改变原片事实顺序以外的含义。
- `CTA`：结尾品牌或行动提示，必须与 brief 或原片一致。

每 20–45 秒至少出现一次有理由的画面变化，但节奏必须由语义和能量决定，不能机械地每秒切一次。

## 4. 字幕与动效

- 字幕按短语分组，通常 1–4 个词；长句拆分但不改变语义。
- 每个字幕组只强调一个关键词，避免整句同时高亮。
- 进入动画至少同时改变透明度、位移或缩放中的两项；退出比进入更快。
- 所有时间由素材 FPS 和真实时间戳推导；禁止用随机数或无法复现的网络素材。
- 人脸特写时字幕放在胸口或安全带，不能遮挡眼睛、嘴和关键屏幕内容。
- 当前 Wayne 视觉令牌：`--ink: #f1f3ea`、`--mint: #c6f475`、`--orange: #f58c53`、`--panel: #111311`。新颜色必须先加入主题说明，不能在单个组件中随意写色值。

## 5. 声音

- 主讲人声音是第一轨；B-roll 不得覆盖口播语义。
- 配乐默认低于人声，并在口播或强调音效出现时自动 duck。
- 没有授权音乐时可以使用本地合成的短 SFX，但必须在报告中标注来源为 `ffmpeg-synthesized`。
- 最终交付应测量响度；目标参考为综合响度约 `-16 LUFS`、真峰值不高于 `-1.5 dBTP`。如果源素材噪声被放大，必须在报告中说明并保留人工听感复核。

## 6. 当前门户映射

| 编辑意图 | 当前字段或产物 |
| --- | --- |
| 保留/收紧/删除 | `edit-plan.json.segments` |
| Hook、强调、CTA | `edit-plan.json.visualEvents` |
| 已下载 B-roll 的源区间 | `edit-plan.json.brollEvents` |
| 逐词或短语字幕 | `captions.srt`，必要时另存 `captions.ass` |
| 镜头推进、声音处理、复杂转场 | `edit.py` 或 HyperFrames 源码及 `manifest.sources` |
| 每个阶段的理由与限制 | `manifest.review.notes` 与 `edit-report.md` |
