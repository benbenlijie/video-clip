---
name: talking-head-edit-review
description: Evaluate or compare the editing form of talking-head videos with project MCP measurements and frame inspection. Use for rhythm, shot organization, visual support, captions/graphics, audio editing, continuity, technical quality, and viewing load; exclude speaker charisma, spoken content, factual correctness, and traffic metrics.
---

# 口播视频剪辑评价

你评价的是视频的时间轴和视听编排，不是人物的表现，也不是讲话内容。人物只作为构图、位置、跳剪连续性和画面覆盖的分析对象；讲话只保留语速、停顿、重音等时间锚点，不评价观点、事实、口才或音色。

## 工作边界

- 只处理用户授权的本地工作区视频；不要上传素材或调用外部服务。
- 评价对象是剪辑，不是人物吸引力、穿搭、口才、观点正确性或信息价值。
- 播放量、完播率、点赞数不是剪辑质量本身；只能作为外部参考，且必须说明混杂因素。
- MCP 返回的数值是证据，不是最终结论。B-roll、字幕、图形、构图、视觉层级和“剪辑动机”必须看帧判断。
- 不声称自己“听过音频”。只能报告静音、响度、峰值、流级同步等测量结果和已知限制。

## 必须使用项目 MCP

项目 MCP 位于 `portal/server/edit-review-tools.mjs`，工具名前缀由 MCP 配置决定；下文使用裸工具名：

- `analyze_edit`：单条视频的事实测量；
- `compare_edits`：两条视频的指标与差值；
- `extract_contact_sheet`：低成本查看全片代表帧；
- `view_frame`：查看精确时间点的证据帧；
- `write_review_report`：写入版式化 JSON 与 Markdown 报告。

如果 MCP 不可用，明确说明无法完成可复核评价，不要用猜测代替测量或画面证据。

## 执行流程

### 1. 确认可比性

先确认两条视频的品类、时长、画幅和分发平台是否相近。若差异很大，先说明不可直接比较的原因，再决定是否继续做“风格差异”而不是“质量高低”的比较。

建议每条视频抽取：

- 开头 30 秒；
- 主体中段 30 秒；
- 结尾或转折段 30 秒；
- 完整视频的整体判断。

### 2. 获取自动测量

单条视频调用 `analyze_edit`；两条视频优先调用 `compare_edits`。记录返回的：

- `analysisId`、`sha256`、时长、分辨率、帧率、音轨信息；
- 切点和镜头节奏；
- 运动与静态采样；
- 静音、停顿、响度、峰值；
- 黑帧、静态段、流级音画偏差；
- `reviewCandidates` 中的证据时间点。

不要把这些指标直接相加成“剪辑总分”。尤其不要认为切得越多、运动越大、音量越高就越好。

### 3. 看代表帧

对每条视频调用一次 `extract_contact_sheet`，建议 9 帧。先看整体画面组织，再对以下位置调用 `view_frame`：

- 切点前后；
- B-roll 或演示画面的进入/退出；
- 字幕或图形出现、变化和遮挡处；
- 黑帧、静态段、音画偏差候选点；
- 明显的构图、景别、背景或色彩跳变。

如果客户端没有渲染接触表图片，改用 `view_frame` 逐点抽帧；不能把图片文件名、工具成功响应或 JSON 数值当成视觉证据。

看帧时重点记录：

- 视觉是否接上当前表达单元；
- B-roll 是补充信息还是装饰；
- 字幕是否可读、是否遮挡人物或关键画面；
- 图形是否有清晰层级，是否长时间占据画面；
- 切点是否服务停顿、重音、动作、段落或视觉证据；
- 人物位置、尺度、背景、光线和色彩是否连续。

### 4. 阅读评分细则

在评分前读取 [references/rubric.md](references/rubric.md)。评分必须使用其中固定的六个维度、0-4 分标准、硬伤等级和 A/B 对比流程。

### 5. 证据化评分

每个维度填 0-4 分，并至少给出一个证据。证据尽量包含视频标签和精确时间点；没有时间戳的指标证据要写清来源字段，例如“静音比例来自音频分析”。

将以下情况列为硬伤，不并入维度加权分：

- 全黑、冻结、持续黑屏、无法解码；
- 音轨缺失、严重削波、明显音频接缝或长段无声；
- 字幕不可读、长时间越界、遮挡眼睛/嘴部/关键画面；
- 明显可见的跳剪穿帮或音画不同步；
- 明显重复镜头、空镜或节奏断层。

硬伤按 `critical`、`major`、`minor` 分级。严重问题不能被其他维度的高分掩盖。

### 6. 写入报告

调用 `write_review_report`，使用固定契约：

```json
{
  "contract": "talking-head-edit-review.v1",
  "mode": "single|pairwise",
  "summary": "一句话结论和理由",
  "winner": "A|B|tie",
  "confidence": 0.7,
  "videos": [
    {
      "label": "A",
      "path": "relative/video.mp4",
      "analysisPath": ".edit-review/analyses/....json",
      "dimensions": [
        {
          "id": "rhythmAndShots",
          "score": 3,
          "note": "为什么是这个分数",
          "evidence": [
            { "video": "A", "timeSeconds": 12.4, "note": "切点与停顿的关系" }
          ]
        }
      ],
      "hardDefects": [],
      "strengths": [],
      "weaknesses": []
    }
  ],
  "limitations": []
}
```

六个维度必须完整出现一次：

`rhythmAndShots`、`visualSupport`、`captionsAndGraphics`、`audioEditing`、`continuityAndTechnical`、`loadAndStyle`。

### 7. 最终输出

报告写入后，向用户汇报：

1. 结论先行：哪条更顺、更清楚、更不累，或没有足够证据选赢家；
2. 硬伤与关键时间点；
3. 六维评分和加权分；
4. 自动指标能证明什么、不能证明什么；
5. 报告 JSON/Markdown 路径。

如果证据不足、视频不可比或 MCP 失败，保留真实错误并说明未完成，不要编造分数。
