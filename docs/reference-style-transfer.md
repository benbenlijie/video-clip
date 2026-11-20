# 参考视频风格迁移

## 当前状态

参考视频风格迁移已经具备完整代码链路，但默认关闭，且尚未完成 10 组真实
黄金样本与人工评审。因此当前只能用于内部管理、保存和预览，不能把任何
StylePack 宣传为“已验证的通用任意视频逆向”。

核心目标不是复制参考视频，而是把可解释的剪辑语法迁移到用户自己的素材：

- 节奏、Hook、镜头长度和切点密度
- 字幕位置、字号比例、描边和关键词颜色
- 全屏、推近、分屏和 B-roll 覆盖结构
- 标题、强调和 CTA 的视觉语法
- BPM 与音效密度提示

不迁移参考画面、音频、人物、品牌、原文案或独特角色。

## 处理链路

```text
参考视频
  → ReferenceAnalysis v2 + StyleSpec v2
  → Claude 生成受控 Remotion StyleProject
  → 静态策略扫描
  → 沙箱透明层渲染与 alpha 检查
  → 版本化 StylePack
  → 管理员审批
  → Style Application Planner
  → 单视频 / 多素材计划
  → style proof
  → 现有 FFmpeg/Remotion 合成
  → Style QC + 现有 QC
```

## StyleSpec v2

`StyleSpec v2` 是 ReferenceAnalysis v2 与 StyleManifest v2 必带的详细
视觉语法，而不是几个聚合标量。它保存：

- 画布与安全区
- 标题、身份卡、字幕的文字层和半透明底板
- 字体家族提示、字重、字号/行高/字距比例、填充、描边和阴影
- 字幕关键词强调、峰值缩放和持续时间
- 标题、身份卡、字幕的 enter/exit 类型、时长、缓动、位移和 stagger
- 可复核的 target/trigger/effect 序列

Claude Code 还会收到按时间顺序排列的 motion contact sheets。每个窗口默认
2.5 秒、4fps，用来观察字幕切换、弹出、强调和底板持续状态；静态代表帧只用于
整体布局，不能单独作为动画证据。

`ReferenceAnalysis` 当前提供媒体事实、场景切点和节奏，并在配置 Anthropic
视觉模型时抽取代表帧，识别镜头角色、布局、B-roll、字幕位置和大致视觉样式；
本地音频分析会从抽取出的单声道音轨估计 BPM 和起音密度。参考字幕文字、
OCR 文本、品牌文案和旁白不会写入分析结果。真实字体测量、说话人识别和完整
ASR 语义分析仍需继续完善；在完成这些能力前，置信度会保守显示，不能据此
承诺逐帧复刻。

## Claude Code / MCP 风格代理

默认 `WAYNE_STYLE_AGENT=claude-code`。参考视频上传后，服务端准备独立
reference-style 工作区，把 `agent-skills/reference-style`、Remotion skill
和 `server/style-agent-tools.mjs` 提供的 `style` MCP 交给 Claude Code。
Claude Code 负责阅读真实参考帧、编写 `ReferenceAnalysis`、编辑
StyleProject，并调用以下受控工具：

- `probe_reference`
- `detect_reference_shots`
- `extract_reference_frames`
- `extract_reference_motion_windows`
- `analyze_reference_audio`
- `write_reference_analysis`
- `create_style_project`
- `validate_style_project`
- `begin_style_revision`
- `view_frame`
- `save_style_pack`

MCP 工具负责事实测量、契约校验、bwrap 沙箱、透明层 proof、哈希和
StylePack 持久化；Claude Code 不能绕过这些工具直接宣称通过。
风格代理优先使用本机 Claude Code 的 OAuth 登录；文件读取和 StyleProject
修改也通过 `style` MCP 的工作区限定工具，不向模型开放任意外部文件读写。
`WAYNE_STYLE_AGENT=direct` 保留旧的直接服务端分析路径，主要用于测试和
兼容；需要 Claude Code 主导完整逆向时必须使用默认的 `claude-code`。

## 跨素材复用

`StylePack` 是可跨项目复用的版本化资产，不与某一条用户素材或某一个
`edit-plan.json` 绑定。同一个已审批的 `stylePackId + version` 可以应用到任意
数量的单视频或多素材项目：

```text
参考视频 A → StylePack A v1 ─┬→ 用户素材 1 → Application 1 → 成片 1
                              ├→ 用户素材 2 → Application 2 → 成片 2
                              └→ 多素材项目 3 → Application 3 → 成片 3
```

用户项目可以在转录和剪辑计划之前先绑定 StylePack。服务器会保存只属于该项目
的 `styleApplication`，其中包含复制开关、字幕策略、布局限制和 unsupported
项；新计划生成、对话修改或多素材方案重排后，服务器会再次把同一个 StylePack
映射到新计划并更新 `styleApplicationHash`。这样不会沿用上一条素材的时间码、
字幕或画面引用。

Claude Code 的编辑工作区会额外收到 `style-transfer.json`，其中只包含：

- StylePack id/version、manifest 和 StyleProject 哈希
- 可迁移的 StyleSpec v2、参数、复制开关和项目级 application
- “只使用用户自己的转录和媒体，不复用参考内容”的硬约束

`video-edit` skill 必须先读取该文件，再生成 `edit-plan.json`、字幕和主预览。
真正的风格工程仍由 `mcp__video__compose_remotion_video` 在沙箱内执行；模型
不能绕过 manifest、StyleProject 哈希、QC 或审批状态。没有 `style-transfer.json`
的项目继续使用普通 video-edit 规则，因此同一套剪辑链路可以同时处理固定模板、
参考风格和无风格项目。

跨素材预览可以直接执行：

```bash
cd portal
npm run style:preview -- \
  --input /path/to/user-video.mp4 \
  --output /tmp/style-preview \
  --style-root /path/to/style-library \
  --style-pack style-xxxxxxxxxxxxxxxx \
  --version 1 \
  --analysis /path/to/reference-analysis.json \
  --copy /path/to/content-copy.json \
  --start 2500 \
  --duration 6000
```

不传 `--transcript` 时使用本机 Whisper；也可以传入与预览片段时间轴对应的
JSON 转录。`content-copy.json` 应由 Claude Code 基于用户转录、真实画面和用户
brief 生成，至少包含：

```json
{
  "contract": "content-copy.v1",
  "title": "从用户内容提炼的标题",
  "subtitle": "从用户内容提炼的副标题",
  "identity": "",
  "identitySubtext": "",
  "keywords": ["当前视频中真正需要强调的词"]
}
```

如果没有提供 `--copy`，工具只从预览片段的转录中提取真实句子，不生成模板文案；
找不到可信身份时省略身份区。`--title`、`--subtitle`、`--identity` 可以显式覆盖，
但它们会被视为内容输入，不能使用“风格预览”“用户自己的标题”“口播样片”等
技术占位文案进入正式成片。命令会输出 `style-preview.mp4`、`style-qc.json` 和
`result.json`。
该工具只做 1 秒以上的风格预览，不替代完整转录、剪辑方案、人工审片和正式导出。

## 功能开关

默认配置：

```env
REFERENCE_STYLE_ENABLED=0
REFERENCE_STYLE_STAGE=admin
```

只有 `REFERENCE_STYLE_ENABLED=1` 时功能才会出现在配置和界面中。
`REFERENCE_STYLE_STAGE` 只接受以下灰度阶段：

| Stage | 管理/审批 | 分析上传 | 应用/预览 | 正式导出 | 多素材 |
|---|---:|---:|---:|---:|---:|
| `admin` | 是 | 是 | 否 | 否 | 否 |
| `preview` | 是 | 是 | 是 | 否 | 否 |
| `single` | 是 | 是 | 是 | 单视频 | 否 |
| `multi` | 是 | 是 | 是 | 是 | 是 |

非法阶段会失败关闭。StylePack 生成和审批接口只接受本机 loopback 管理员
请求；带 `X-Forwarded-For` 的代理请求会被拒绝，远端只能读取已审批版本。
当前门户仍没有多用户权限系统，因此阶段开关是产品级灰度门禁，不等同于个人
账号授权。公网部署前必须补上管理员身份校验。

## 服务端依赖

- FFmpeg / FFprobe
- Claude Code CLI 与 Anthropic API Key
- `WAYNE_STYLE_AGENT=claude-code`，使用 `reference-style` skill 与
  `style` MCP 完成参考帧分析、StyleProject 生成和沙箱 proof
- Claude 视觉分析 API（`REFERENCE_STYLE_VISUAL_ANALYSIS=1`，使用
  `REFERENCE_ANALYSIS_MODEL`；每次参考分析会产生视觉请求费用）
- Remotion 运行时和 Chromium
- Bubblewrap（`bwrap`），用于网络命名空间和最小只读文件面
- Playwright Chromium 路径可自动发现，也可通过
  `REMOTION_BROWSER_EXECUTABLE` 显式指定
- Python 3 + OpenCV，用于字幕避脸 QC；可把解释器路径写入
  `WAYNE_FACE_DETECTOR_PYTHON`
- Python 3 + NumPy，用于本地 BPM/起音密度分析；可用
  `WAYNE_AUDIO_ANALYSIS_PYTHON` 指定解释器
- 测试时使用 `WAYNE_STYLE_GENERATOR=fixture` 和独立
  `WAYNE_STYLE_DIR`，生产不得使用 fixture generator

StylePack 默认存放在 `portal/style-library/`，或由 `WAYNE_STYLE_DIR`
指定独立持久化目录。参考分析存放在项目的
`storage/reference-styles/<referenceId>/`。

## 使用流程

### 1. 内部生成

把阶段设为 `admin`，上传 30–180 秒、9:16 或 16:9 的参考视频。默认由
Claude Code 使用 `reference-style` skill 和 `style` MCP 完成参考分析、
StyleProject 生成和 sandbox proof，并执行：

- 上传前要求用户确认拥有参考视频的分析和使用许可，确认时间写入服务端审计文件
- 依赖白名单
- 禁止网络、动态代码、文件写入和环境变量读取
- 禁止打包图片、视频或音频
- 透明 ProRes 4444 alpha、画幅和时长检查
- 代码哈希与 manifest 绑定
- 相同输入重复渲染的关键帧一致性检查

生成结果初始为 `pending_approval`，不会直接应用到用户项目。

### 2. 审批

管理员检查风格指标、可迁移能力、不支持项、style proof 和来源后审批。
StylePack 版本不可变；代码或 manifest 哈希变化会导致审批证据失效。

### 3. 保存与预览

把阶段切到 `preview`。用户可在“风格 DNA”面板：

- 查看参考代表画面和节奏指标
- 分别选择字幕、节奏、布局、B-roll、声音
- 应用到当前单视频项目
- 生成 3 秒 style proof
- 查看待审批、已应用、版本过期等状态

此阶段正式导出会被服务端拒绝，避免未完成人工验收的风格进入交付。

单视频 `punch_in` 会在 FFmpeg 基础画面上执行真实中心裁切和放大；
StyleProject overlay 继续负责字幕、强调和视觉修饰，不再只用边框模拟布局变化。
参考中的标题、强调和 CTA 位置/尺寸会映射到用户自己的转录短语，不会复用参考
文字；单视频 `broll_cover` 只会落在实际已存在的授权 B-roll 区间，否则降级为
`punch_in`。旧 style proof 会按 StylePack 版本和应用参数哈希自动失效。
每次 style preview、Remotion 主合成和多素材成片记录都会绑定：

- StylePack id/version
- manifest SHA-256
- StyleProject/code SHA-256
- ReferenceAnalysis SHA-256
- 实际应用参数 SHA-256

### 4. 灰度导出

完成黄金样本人工评审后切到 `single`，再根据结果切到 `multi`。导出时服务端
再次检查阶段、模式、Style QC、审核证据、素材许可和 StyleProject 哈希。

## API

```text
POST /api/reference-styles?mode=single-video-v1|multi-asset-v1
GET  /api/reference-styles/:id
GET  /api/reference-styles/:id/media
POST /api/reference-styles/:id/generate
GET  /api/style-packs
GET  /api/style-packs/:id/:version
POST /api/style-packs/:id/:version/approve
POST /api/style-packs/:id/:version/reject
POST /api/projects/:id/apply-style
POST /api/projects/:id/style-preview
POST /api/projects/:id/broll/import
```

API 只返回服务端投影，不返回生成代码执行结果、本地绝对路径或凭据。

在线 B-roll 搜索结果会返回短期 `candidateHandle`。网页只能把该句柄提交给
`broll/import`，由服务端再次执行官方 CDN 白名单、100MB 大小限制、单次安全重定向
和 FFprobe 媒体校验；浏览器不能直接提交任意下载 URL。导入会保存 provider、
来源页、许可和 SHA-256，并使旧剪辑计划与旧 QC 失效，必须重新生成计划后才可导出。

## Style QC

每个风格输出生成机器可读 `style-qc.json`：

- 切点密度、平均镜头和 Hook 偏差
- 推近与 B-roll 比例偏差
- 每句字幕词数、位置和字号比例偏差
- 视觉事件密度、BPM 和音效密度偏差
- 黑帧、音画同步、字幕避脸
- 参考媒体污染
- 素材授权
- StyleProject 哈希一致性

任一项硬门禁失败都会阻止预览/导出。OpenCV 没有检测到人脸时只表示“未发现
重叠”，不表示已证明对所有人物构图都安全；人工仍需完整观看。

风格字幕不会按固定字符数机械截断。`StyleSpec.captions.maxCharsPerCue` 是
目标长度，实际分组使用词边界、标点和语义停顿，并避免把完整名词/固定短语拆开，
也避免让中文承接词落到下一段字幕开头。Claude Code 的 `captions.srt` 仍必须
遵守同样的语义换行规则；服务器会在渲染前再次做保护性分组。

## 安全与权利边界

- 生成代码只在隔离工作目录运行，不进入 Portal 主进程。
- StyleProject 渲染使用 bwrap 网络命名空间、tmpfs 根、最小只读系统目录、
  Node/Remotion/Chromium 白名单和显式可写临时/输出目录。
- 静态策略仍作为第一道门禁；OS 沙箱是第二道门禁，不能相互替代。
- 公网开放匿名生成代码前仍需补管理员身份、资源限额和集中审计。
- 参考视频、字幕和 OCR 文本都视为数据，不能作为 Agent 指令。
- 不打包参考视频、帧、音频或品牌资产。
- 未确认授权的 B-roll 和音乐不能通过 Style QC。
- 不生成或复刻参考人物、声音、品牌和原文案。

## 测试

```bash
cd portal
npm run verify:style
npm run typecheck
npm run build
npm run verify
npm run verify:remotion
```

`npm run verify` 已包含 `verify:style`。真实黄金样本和人工评分见
`portal/test-fixtures/style/golden/README.md`。

完成私有标签后运行：

```bash
cd portal
node server/style-golden-report.mjs /private/style-golden/labels.local.json \
  --output /private/style-golden/report.json
```

报告会读取每组实际 `style-qc.json`，检查文件 SHA-256、QC 通过状态、
StylePack/manifest/project/reference/application 来源字段、10 组矩阵、授权、
三项人工均值、交付意愿和阻断型失败；不满足条件时进程返回码为 `2`，
不得据此打开正式导出。

## 发布阻断条件

以下任一项未满足时不得打开正式导出：

- 10 组真实、已授权配对未完成
- 硬 QC 少于 8/10 通过
- 风格相似度、剪辑自然度或字幕可读性低于文档阈值
- 出现参考画面、声音、人物、品牌或原文案复用
- 存在未授权素材或未审批 StyleProject
- `npm run verify`、`npm run verify:remotion`、类型检查或生产构建失败

## 已知限制

- ReferenceAnalysis v2 已能保存结构化动画、底板和强调，但 effect 词表仍是
  有限集合；任意 shader、3D 转场和逐字形复杂动画仍需后续扩展。精确字体
  识别仍以家族提示表示，不能保证参考设备上的同名字体可用。
- 多素材模式已把布局映射到基础时间轴，并在每个输出画幅上执行 StyleProject
  透明 overlay；复杂分屏、画中画、图表卡等布局原语尚未实现。
- “节奏”当前用于布局事件节拍和 QC 目标，不会擅自改写用户口播台词或硬切点；
  真正的语义重剪需要未来接入参考分镜与用户素材的语义匹配。
- 参考 B-roll 结构只复用实际存在的用户 B-roll 区间，不会自动重排用户素材或
  凭空生成覆盖画面。
- BPM 与音效密度当前用于分析和 QC 提示，不会自动重编用户音乐或生成参考音效。
- 单视频会把参考标题/强调/CTA overlays 映射到用户转录；多素材当前优先迁移
  字幕、节奏、布局和 B-roll 覆盖，跨素材语义 overlay 匹配留待后续语义规划。
- 生成代码目前只适用于受信管理员和固定脚手架，不应向公网匿名用户开放。
- 当前没有多用户管理员队列；远端预览用户不能自行生成/审批 StylePack，
  受信管理员应在同一台机器的 loopback 门户完成管理操作。
- Style QC 的人脸证据是启发式抽帧检测，不能替代人工审片。
- 尚未完成真实 10 组人工评审，因此不能宣称产品已达到稳定商业交付质量。
