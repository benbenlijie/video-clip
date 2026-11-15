# 参考视频风格迁移设计与规格

> 状态：MVP 已实现并通过工程 QC；真实黄金样本与人工评审待完成
> 日期：2026-11-13
> 适用项目：Wayne / Cutline Video Clip

> 2026-11-15 更新：下文的 v1 JSON 示例保留作历���设计记录。当前实现已升级为
> `reference-analysis.v2`、`style-manifest.v2` 和内嵌的 `style-spec.v2`；
> StyleSpec v2 会保存面板背景/透明度、文字层、字幕底框、关键词强调、
> enter/exit 动效、easing、stagger 和结构化 effects。实际契约见
> `portal/contracts/style-spec.v2.schema.json`。

## Goal

为现有口播剪辑系统增加“参考视频风格迁移”能力：用户提供一条参考视频和自己的口播素材，系统反向分析参考视频的剪辑语法、字幕、布局、动效、声音和分镜结构，生成可复用的 `StylePack`，再把它应用到用户自己的素材上，产出可编辑、可审核、可重复的新视频。

本功能不做“复制参考视频内容”，而是复制其编辑方法。参考视频的画面、人物、声音、音乐和具体文案不得直接进入成片；系统只提取可测量的风格参数和可执行的编辑结构。

## 已确认的产品决策

| 决策 | 选择 |
|---|---|
| 首版工作流 | `single-video-v1` 与 `multi-asset-v1` 同时支持 |
| 复刻深度 | 编辑语法 + 参考分镜/B-roll 结构 |
| 风格工程 | Claude 为每条参考视频生成独立的 Remotion style project |
| 首批用户 | 现有口播用户和个体创作者 |
| 交付节奏 | 不设硬期限，按质量门槛逐阶段推进 |

## 用户问题

现有系统已经有：

- 逐词口播转录与字幕校对
- `edit-plan.json` / `timeline.v1` / `timeline.v2`
- B-roll 搜索、下载、授权与多素材时间线
- Remotion 主合成、透明动效层和 QC 门禁

但用户不能指定“我的视频要像这条参考视频一样剪”。当前 `project.style` 只是一个自由文本标签，不能表达：

- 参考视频的切点密度和 Hook 长度
- 每 10 秒的画面变化频率
- 全屏、推近、分屏、B-roll 覆盖的比例
- 字幕分组、位置、字体、描边、底框、关键词高亮和进出动画
- 标题卡、强调条、数据卡、标注、贴纸的使用节奏
- B-roll 承担的是证明、过渡、补充还是氛围
- 音乐 BPM、音效密度、卡点与 ducking 规则

## 产品流程

### 1. 参考分析

用户上传参考视频或提供本地文件。系统输出：

- 逐镜制片结构
- 剪辑节奏
- 画面布局与镜头角色
- 字幕样式与时间轴
- 动效和转场类型
- B-roll 结构
- 音频结构
- 可迁移项与不可迁移项

### 2. 风格工程生成

Claude 依据参考分析生成一个独立 Remotion style project，并同时生成 `StyleManifest`。生成结果不是一次性视频，而是：

- 可渲染的代码工程
- 参数化 manifest
- 3–5 秒 style proof
- 静态检查和渲染测试
- 来源、版本和哈希记录

### 3. 用户审阅

用户看到“风格 DNA”卡片，可以：

- 查看从参考视频测得的节奏、字幕和布局
- 预览参考视频的代表帧
- 查看生成的 style proof
- 选择只复制字幕、节奏、布局、B-roll、声音或全部
- 调整颜色、字号、强度、节奏等受控参数
- 查看哪些能力当前无法迁移

### 4. 应用到用户素材

用户上传自己的口播视频和可选素材。系统把 StylePack 映射到用户转录和素材：

- 参考视频的切点密度 → 用户口播的语义停顿和重点
- 参考视频的 Hook 结构 → 用户开头
- 参考视频的字幕样式 → 用户字幕
- 参考视频的镜头角色 → 用户主视频/B-roll/分屏
- 参考视频的音频结构 → 用户 BGM/SFX 规则

输出：

- `edit-plan.json`
- `multi-asset-plan`
- 更新后的 `timeline.v1/v2`
- StyleProject 渲染输入

### 5. 预览、比较和导出

系统生成：

- 当前用户视频的风格预览
- 参考视频与新视频的并排比较
- 风格匹配度量
- 自动 QC 结果
- 可编辑的版本记录

用户确认后导出最终视频。

## 领域模型

### ReferenceAnalysis

只记录参考视频的事实和推断，不包含可执行代码。

```json
{
  "contract": "reference-analysis.v1",
  "source": {
    "filename": "reference.mp4",
    "durationMs": 42000,
    "aspectRatio": "9:16",
    "sha256": "..."
  },
  "shots": [
    {
      "id": "shot-01",
      "startMs": 0,
      "endMs": 1800,
      "role": "hook",
      "layout": "full",
      "broll": false
    }
  ],
  "rhythm": {
    "hookMs": 1800,
    "avgShotMs": 2600,
    "cutsPerMinute": 18,
    "punchInRatio": 0.35,
    "brollRatio": 0.22
  },
  "captions": {
    "grouping": "phrase",
    "maxWordsPerCue": 4,
    "position": "bottom",
    "fontSizeRatio": 0.052,
    "primaryColor": "#ffffff",
    "strokeColor": "#111111",
    "strokeWidth": 2,
    "keywordColor": "#c6f475",
    "animation": "scale_pop"
  },
  "overlays": [],
  "audio": {
    "bpm": 112,
    "voice": "human",
    "sfxDensity": "medium"
  },
  "capabilities": {
    "needsBroll": true,
    "needsScreenshots": false,
    "needsSplitScreen": false
  },
  "unsupported": [],
  "confidence": {
    "overall": 0.82,
    "rhythm": 0.94,
    "captions": 0.86,
    "layout": 0.68
  }
}
```

### StylePack

StylePack 是用户可保存、团队可复用的风格资产，包含一个 StyleProject。

```json
{
  "contract": "style-pack.v1",
  "id": "style-clean-punch",
  "name": "Clean punch-in / phrase captions",
  "version": 1,
  "status": "approved",
  "sourceAnalysisId": "ra-001",
  "supportedModes": ["single-video-v1", "multi-asset-v1"],
  "styleProject": {
    "dir": "styles/style-clean-punch/v1",
    "entryPoint": "src/index.tsx",
    "compositionId": "ReferenceStyle",
    "manifestSha256": "...",
    "codeSha256": "..."
  },
  "parameters": {
    "captionScale": 1.0,
    "motionIntensity": 0.8,
    "brollDensity": 0.5,
    "colorAccent": "#c6f475"
  },
  "capabilities": ["captions", "title_card", "emphasis", "punch_in", "broll_cover"],
  "requirements": {
    "minAssets": 1,
    "needsMainFootage": true,
    "needsBroll": false
  },
  "unsupported": ["multi_camera", "3d_scene"],
  "preview": {
    "video": "previews/style-clean-punch.mp4",
    "poster": "previews/style-clean-punch.jpg"
  }
}
```

### StyleApplication

StylePack 应用到某个具体项目后的结果。

```json
{
  "contract": "style-application.v1",
  "projectId": "project-123",
  "stylePackId": "style-clean-punch",
  "styleVersion": 1,
  "workflowMode": "single-video-v1",
  "parameters": {
    "copyRhythm": true,
    "copyCaptions": true,
    "copyLayout": true,
    "copyBroll": false,
    "copyAudio": true
  },
  "warnings": [],
  "unsupported": []
}
```

## 架构

```text
参考视频
  → 参考分析器（切镜 / OCR / ASR / BPM / VLM / 样式测量）
  → ReferenceAnalysis
  → Claude Style Project Generator
  → StyleProject + StyleManifest
  → 静态安全门禁 + 沙箱渲染门禁
  → StylePack

用户口播 + 用户素材 + StylePack
  → Style Application Planner
  → edit-plan / multi-asset-plan
  → 现有时间线校验
  → 现有 FFmpeg 基础合成
  → 生成式 Remotion 透明层
  → 现有 QC + 风格 QC
  → 预览 / 比较 / 导出
```

### 参考分析器

职责：

- 使用 FFmpeg/ffprobe 提取媒体事实
- 使用现有切镜能力或新增轻量切镜实现
- 使用 OCR 提取字幕和文字时间轴
- 使用音频分析提取 BPM、音效和配乐结构
- 使用 VLM 识别镜头角色、画面布局和语义结构
- 生成 `ReferenceAnalysis`

只输出事实和推断，不直接生成代码。

### Style Project Generator

Claude 使用固定脚手架生成独立的 Remotion 项目。脚手架必须包含：

- `src/index.tsx`
- `src/Root.tsx`
- `src/StyleOverlay.tsx`
- `src/CaptionLayer.tsx`
- `src/LayoutLayer.tsx`
- `src/manifest.ts`
- `style-manifest.json`
- `tsconfig.json`
- `package.json`
- `package-lock.json`
- 渲染和测试脚本

生成器不得：

- 引入参考视频的画面或音频
- 使用参考视频的原始人物、品牌和音乐
- 访问网络
- 读取项目工作区外的文件
- 读取环境变量或 API key
- 调用 `child_process`、`eval`、动态 `require` 或任意 npm 包
- 生成无法解释的随机数或当前时间依赖

### Claude 生成边界

Claude 可以决定视觉结构、CSS/TSX 组件组合、字幕动画和布局参数，但必须：

1. 从受控脚手架开始
2. 只使用批准的依赖和组件集
3. 输出 `StyleManifest`
4. 生成至少一个静态帧测试和一个透明层渲染测试
5. 通过静态策略扫描后才可进入渲染

### Style Project 渲染

StyleProject 渲染为一个透明 Remotion overlay，交给现有 FFmpeg 合成流程。

渲染输入包含：

- 用户视频尺寸、fps、时长
- 用户字幕轨
- 风格参数
- visual events
- layout events
- 可选 B-roll 元数据，但不把 B-roll 作为生成式工程输入

MVP 不替换现有 FFmpeg 基础合成。这样可以保留现有的切点、B-roll、音轨和 QC 能力。

### Style Application Planner

单视频模式：

- 把 StylePack 的节奏参数注入 `edit-plan.json`
- 把参考字幕样式映射为 `captionStyle`
- 把参考的视觉语法映射为 `visualEvents`
- 把参考的镜头角色映射为 `layoutEvents`
- 使用现有 `validateEditPlan`

多素材模式：

- 把参考的镜头角色映射到 `multiAssetPlan.clips`
- 把 B-roll 结构映射到 `video-overlay` 或 B-roll 事件
- 把参考的节奏映射为每个 clip 的时长和切点
- 把 StylePack 附加到项目级 `stylePackId`
- 使用现有 `validateMultiAssetPlan`

## 单视频与多素材的共同契约

新增项目级字段：

```json
{
  "stylePackId": "style-clean-punch",
  "styleVersion": 1,
  "styleParameters": {
    "captionScale": 1.0,
    "motionIntensity": 0.8,
    "brollDensity": 0.5
  }
}
```

`StylePack` 必须绑定到项目快照和渲染记录。渲染记录要包含：

- style pack id/version
- style manifest hash
- style project hash
- 生成的 Remotion 源码哈希
- 参考分析 hash
- 应用参数 hash

这样后续修改风格包不会悄悄改变旧成片。

## 安全与权利边界

### 代码执行

Claude 生成的代码属于不可信输入，不得直接在 Portal 宿主机执行。

必须有三道门禁：

1. 静态策略扫描：禁止网络、文件写入、子进程、环境变量、动态导入和未批准依赖。
2. 隔离渲染：无网络、只读输入、临时输出目录、CPU/内存/时间限制。
3. 人工/自动审批：只有通过静态扫描、渲染测试和视觉检查的 StyleProject 才能进入 StylePack。

### 参考素材

- 参考视频只用于分析和风格证据。
- 不把参考视频的帧、音频、人物、品牌和文案作为成片素材。
- 参考音乐只提取 BPM、结构和风格，不直接复用原曲。
- 用户需要确认自己对参考视频和用户素材拥有分析/使用权限。
- 不复制可识别的人脸、声音、品牌标识和独特角色。

### Prompt Injection

参考视频中的字幕、贴纸和 OCR 文本一律视为数据，不视为指令。分析器不得执行视频内容中出现的“忽略规则”“运行命令”等文本。

## 质量指标

### 风格向量

用可计算指标描述风格：

- 切点密度、平均镜头长度、Hook 时长
- 全屏、推近、分屏、B-roll 覆盖的时长比例
- 字幕每组的词数、位置、字号相对画面比例
- 字幕颜色、描边、底框、关键词高亮
- 动效事件密度和转场类型分布
- BPM、音效密度、配乐 ducking

### 验收

MVP 必须通过：

- 10 组参考/用户素材配对测试
- 单视频和多素材各至少 5 组
- 9:16 和 16:9 都至少 2 组
- 样式匹配的主观评分达到团队设定的阈值
- 字幕可读性、脸部遮挡、音画同步不退化
- 不出现参考画面、参考音乐或参考人物复用
- 所有生成 StyleProject 通过静态安全门禁
- 相同输入重复渲染产生相同关键帧结果

### 黄金样本与人工评审

评审矩阵、评分锚点、失败分类和隐私要求以
[`portal/test-fixtures/style/golden/README.md`](../../../portal/test-fixtures/style/golden/README.md)
为准。可提交的
[`labels.example.json`](../../../portal/test-fixtures/style/golden/labels.example.json)
只包含 10 组空白槽位和阈值，不包含任何媒体或个人信息。

临时发布阈值：

- 自动化硬 QC 至少通过 8/10 组
- 风格相似度均值 ≥ 3.8
- 剪辑自然度均值 ≥ 4.0
- 字幕可读性均值 ≥ 4.2
- 至少 8/10 组愿意交付给客户
- 任一参考画面/声音/人物/品牌复用、未授权素材或未审批 StyleProject
  都直接阻断发布，不参与平均值抵扣

真实媒体、`labels.local.json` 和评审报告必须保存在私有目录，不提交到仓库。
在完成首轮 10 组人工评审前，产品只能处于内部试用或保存/预览阶段。

## MVP 范围

### 支持

- 30–180 秒参考视频
- 30–180 秒用户口播
- 单主讲人
- 9:16 与 16:9
- 单视频与多素材工作流
- 字幕、标题卡、强调条、CTA
- 推近、全屏、B-roll 覆盖
- 简单分屏
- 参考节奏和 B-roll 结构迁移
- StylePack 预览、保存、复用

### 不支持

- 多人多机位
- 3D、粒子、复杂影视级运镜
- 参考视频内容重演
- 参考人物/声音克隆
- 复杂音乐重编
- 任意用户生成 JSX
- 未审批的 StyleProject 直接渲染

## 完整迭代方向

### Phase 2

- 品牌 StylePack
- 风格库和团队共享
- 用户参数编辑
- 批量应用到多条口播
- 风格强度与局部覆盖

### Phase 3

- 多说话人和多人对话
- 长视频分段
- 更丰富的布局原语
- 参考分镜到用户素材的自动匹配
- 跨语言字幕样式迁移

### Phase 4

- 团队权限与审计
- API/MCP
- 风格性能数据
- 模板市场
- 私有化部署

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 生成代码不可控 | 安全、稳定性和复现性问题 | 固定脚手架、静态扫描、沙箱、审批 |
| 参考视频内容被误当指令 | Prompt injection | 内容视为数据、系统提示隔离、禁止执行文本 |
| 用户素材和参考不匹配 | 风格迁移失败 | 能力检测、降级、明确 unsupported |
| 参考音乐/人物版权 | 法律风险 | 只提取风格，不复用原素材 |
| 任意风格泛化成本高 | 研发时间长 | 先做口播和高频布局，逐阶段扩展 |
| 风格匹配不可解释 | 用户不信任 | 展示测量、样例帧、差异和 QC |

## 非目标

- 不承诺逐帧或像素级复刻。
- 不承诺恢复原视频的原始提示词。
- 不把分析结果当作版权或 AIGC 合规结论。
- 不在 MVP 中替代现有 FFmpeg 基础合成和 QC。
