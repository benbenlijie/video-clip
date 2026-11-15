# 参考视频风格迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有口播剪辑系统支持“参考视频 → StylePack → 用户自己的口播视频”，同时覆盖单视频和多素材工作流。

**Architecture:** 参考分析器把视频拆成可测量的事实；Claude 从受控 Remotion 脚手架生成独立 StyleProject；StyleProject 在沙箱中渲染透明 overlay；新的 Style Application Planner 把风格参数映射到现有 `edit-plan.json`、多素材方案和 `timeline.v1/v2`；最后由现有 FFmpeg/Remotion/QC 链路产出可审片成片。

**Tech Stack:** Node.js ESM、Remotion 4、FFmpeg/ffprobe、现有 Claude Code adapter、现有 Portal、JSON Schema、Node verify scripts。

**Spec:** [2026-11-13-reference-style-transfer-design.md](../specs/2026-11-13-reference-style-transfer-design.md)

## Global Constraints

- 同时支持 `single-video-v1` 和 `multi-asset-v1`，不能只实现单视频。
- 首版目标为 30–180 秒、单主讲人、9:16 和 16:9。
- 只迁移风格、节奏、布局、字幕、动效、声音和 B-roll 结构；不得复用参考视频的画面、音频、人物、品牌和文案。
- Claude 生成的是独立 Remotion style project，但必须从受控脚手架开始，不能从空白项目任意发挥。
- 生成代码是不可信输入：必须通过静态策略扫描、隔离渲染和审批后才能成为 `approved` StylePack。
- 保留现有 FFmpeg 基础合成和 QC；MVP 不替换现有主合成链路。
- 任何 StylePack 变更都必须产生新版本，并绑定 manifest/code hash；旧成片不得被悄然改变。
- 不新增 git commit 或 git 分支操作；本项目要求只有用户明确要求时才做版本控制操作。
- 质量优先，按阶段出口条件推进，不用固定日期压缩范围。

## Review Focus

- 参考视频 OCR/VLM 文本是否被当成指令，导致生成器执行视频内容中的提示注入。
- 生成工程是否通过 `fetch`、`child_process`、`fs`、`process.env`、动态导入或外部 URL 访问宿主机/网络。
- 风格节奏映射到用户转录时，是否改变语义、切断完整句子或破坏字幕与口播时间轴。
- 多素材模式下，参考分镜/B-roll 结构是否导致时间轴空洞、重叠、素材越界或无授权 B-roll。
- StylePack 版本变化、素材变化或重复渲染时，旧预览和旧成片是否仍被错误复用。

---

## Phase 0: 基线与测试资料

### Task 0: 建立风格迁移测试基线

**Files:**
- Create: `portal/test-fixtures/style/README.md`
- Create: `portal/test-fixtures/style/synthetic-reference.json`
- Create: `portal/server/style-baseline.verify.mjs`
- Modify: `portal/package.json`

**Interfaces:**
- Produces: `style-baseline.verify.mjs` 作为后续所有风格模块的基础阈值检查。
- Produces: `portal/test-fixtures/style/` 的合成元数据；不把受版权保护的参考视频提交到仓库。

- [x] **Step 1: 写入基线测试**

测试至少覆盖：

```text
9:16 参考视频
16:9 参考视频
有字幕 / 无字幕
有 B-roll / 无 B-roll
单视频用户素材
多素材用户素材
```

测试数据使用 JSON 元数据和合成视频；真实视频通过本地未提交样本补充。

- [x] **Step 2: 运行测试确认基线失败**

Run: `cd portal && node server/style-baseline.verify.mjs`

Expected: FAIL，因为风格迁移模块尚未建立。

- [x] **Step 3: 在 `portal/package.json` 增加 `verify:style` 脚本**

脚本只串联后续风格模块的 verify 文件，不替代现有 `verify`。

- [x] **Step 4: 运行脚本确认命令可被 npm 识别**

Run: `cd portal && npm run verify:style`

Expected: 当前只运行基线检查并明确报告缺少后续模块。

---

## Phase 1: 参考分析与 StylePack 契约

### Task 1: 定义 ReferenceAnalysis 契约

**Files:**
- Create: `portal/contracts/reference-analysis.v1.schema.json`
- Create: `portal/server/reference-analysis.mjs`
- Create: `portal/server/reference-analysis.verify.mjs`

**Interfaces:**

```js
export function normalizeReferenceAnalysis(raw): ReferenceAnalysis;
export function validateReferenceAnalysis(analysis): ReferenceAnalysis;
export async function analyzeReference({ videoPath, workDir, mode }): Promise<ReferenceAnalysis>;
```

- [x] **Step 1: 写失败测试**

测试文件名：`portal/server/reference-analysis.verify.mjs`

覆盖：

- 缺少 `shots` 或时间区间无效时拒绝。
- 16:9、9:16、30–180 秒输入可接受。
- `unsupported` 可包含 `multi_camera`、`3d_scene`。
- 不允许参考文案被写入 `StylePack` 的自由文本字段。

- [x] **Step 2: 运行测试确认失败**

Run: `cd portal && node server/reference-analysis.verify.mjs`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现最小分析器**

职责拆分：

- `ffprobe` 读取时长、尺寸、fps、音轨。
- 切镜使用现有可用的 FFmpeg 场景检测或独立的 `detectReferenceShots`。
- 字幕/文字通过 OCR 或 VLM 适配器读取；MVP 允许“VLM 读文字 + 像素测量样式”，但必须标出置信度。
- BPM/音效使用现有音频分析或 FFmpeg 音频特征。
- VLM 只负责镜头角色和布局语义。

- [x] **Step 4: 运行测试确认通过**

Run: `cd portal && node server/reference-analysis.verify.mjs`

Expected: PASS。

### Task 2: 定义 StyleProject 与 StyleManifest 契约

**Files:**
- Create: `portal/contracts/style-project.v1.schema.json`
- Create: `portal/contracts/style-manifest.v1.schema.json`
- Create: `portal/server/style-project.mjs`
- Create: `portal/server/style-project.verify.mjs`
- Create: `portal/style-project-template/package.json`
- Create: `portal/style-project-template/tsconfig.json`
- Create: `portal/style-project-template/src/index.tsx`
- Create: `portal/style-project-template/src/Root.tsx`
- Create: `portal/style-project-template/src/StyleOverlay.tsx`
- Create: `portal/style-project-template/src/CaptionLayer.tsx`
- Create: `portal/style-project-template/src/LayoutLayer.tsx`
- Create: `portal/style-project-template/src/manifest.ts`
- Create: `portal/style-project-template/README.md`

**Interfaces:**

```js
export function validateStyleManifest(manifest): StyleManifest;
export function validateStyleProject(project): StyleProject;
export async function createDraftStyleProject({ analysis, outDir }): Promise<StyleProject>;
```

- [x] **Step 1: 写失败测试**

测试：

- manifest 缺少 `supportedModes` 时拒绝。
- manifest 声明 `multi-asset-v1` 却没有 `requirements.needsMainFootage` 时拒绝。
- scaffold 的 composition 能接收 `captions`、`layoutEvents`、`styleParams`。
- 项目模板不允许外部网络和任意依赖。

- [x] **Step 2: 运行测试确认失败**

Run: `cd portal && node server/style-project.verify.mjs`

Expected: FAIL。

- [x] **Step 3: 实现受控脚手架**

脚手架只暴露以下输入：

```ts
type StyleProjectProps = {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  captions: CaptionCue[];
  visualEvents: VisualEvent[];
  layoutEvents: LayoutEvent[];
  styleParams: StyleParams;
};
```

`StyleOverlay`、`CaptionLayer`、`LayoutLayer` 必须保持可独立测试；
禁止在模板中加入随机数、当前时间、网络请求和外部文件读取。

- [x] **Step 4: 运行测试确认通过**

Run: `cd portal && node server/style-project.verify.mjs`

Expected: PASS。

### Task 3: 实现 StylePack 存储与版本

**Files:**
- Create: `portal/server/style-pack-store.mjs`
- Create: `portal/server/style-pack.verify.mjs`
- Modify: `portal/server/project-store.mjs`（如项目存储需要保存 stylePackId）

**Interfaces:**

```js
export async function saveStylePack({ project, manifest, projectDir, status }): Promise<StylePack>;
export async function loadStylePack(id, version): Promise<StylePack>;
export function assertStylePackCompatible(stylePack, mode): void;
```

- [x] **Step 1: 写失败测试**

覆盖：

- 重复保存同一版本被拒绝。
- 更新参数必须创建新版本。
- 不兼容 `multi-asset-v1` 的 StylePack 不能被多素材项目使用。
- manifest/code hash 不一致时拒绝加载。

- [x] **Step 2: 实现存储**

目录结构：

```text
styles/<style-id>/v<n>/
  style-manifest.json
  style-project/
  preview.mp4
  preview.jpg
  approval.json
```

- [x] **Step 3: 运行测试**

Run: `cd portal && node server/style-pack.verify.mjs`

Expected: PASS。

---

## Phase 2: Claude 生成与安全门禁

### Task 4: 实现 StyleProject Generator

**Files:**
- Create: `portal/server/style-generator.mjs`
- Create: `portal/server/style-generator.verify.mjs`
- Create: `portal/server/style-policy.mjs`
- Create: `portal/server/style-policy.verify.mjs`
- Modify: `portal/server/claude-code-editor.mjs`（复用现有 Claude CLI 调用模式）

**Interfaces:**

```js
export async function generateStyleProject({
  analysis,
  scaffoldDir,
  outDir,
  claudeRunner,
}): Promise<{ project: StyleProject; manifest: StyleManifest }>;
export function scanStyleSource(source, manifest): PolicyResult;
```

- [x] **Step 1: 写静态策略测试**

必须拒绝：

```text
fetch / http / https / WebSocket
child_process / exec / spawn
fs.writeFile / fs.rm / fs.rename
process.env / process.exit
eval / Function / dynamic import
外部 npm 依赖
绝对文件路径
引用参考视频或参考音频
```

必须允许的依赖必须来自显式白名单，而不是 `@remotion/*` 全放行：

```text
react
remotion
@remotion/captions
@remotion/media
@remotion/media-utils
项目内相对导入
CSS / SVG / 静态 SVG 图形
```

必须拒绝 `@remotion/renderer`、`@remotion/bundler`、`@remotion/studio`、
`@remotion/cli` 以及任何新增 npm 依赖。

- [x] **Step 2: 写失败测试**

Run: `cd portal && node server/style-policy.verify.mjs`

Expected: FAIL。

- [x] **Step 3: 实现策略扫描**

扫描 `src/**/*.{js,jsx,ts,tsx}`、`package.json`、`style-manifest.json`；
输出错误码、文件、行号和修复建议。

- [x] **Step 4: 实现生成器**

生成器只传入：

- `ReferenceAnalysis`
- scaffold 结构
- 允许的组件/依赖清单
- 输出目录

不得把参考视频原始帧作为生成工程输入。

- [x] **Step 5: 运行策略与生成器测试**

Run: `cd portal && node server/style-policy.verify.mjs && node server/style-generator.verify.mjs`

Expected: PASS。

### Task 5: 实现代码沙箱与渲染门禁

**Files:**
- Create: `portal/server/style-sandbox.mjs`
- Create: `portal/server/style-sandbox.verify.mjs`
- Create: `portal/style-project-runtime/README.md`
- Modify: `portal/server/remotion-overlay.mjs` 或新增 `portal/server/style-renderer.mjs`

**Interfaces:**

```js
export async function renderStyleProject({
  projectDir,
  props,
  outputPath,
  compositionId,
  timeoutMs,
}): Promise<StyleRenderResult>;
export async function assertStyleProjectSandboxed(projectDir): Promise<void>;
```

- [x] **Step 1: 写沙箱测试**

覆盖：

- 禁止网络调用。
- 禁止读写工作区外文件。
- 超时进程被终止。
- 生成代码失败时不留下半成品。
- 透明层必须有 alpha 和可见像素。

- [x] **Step 2: 实现隔离层**

优先使用容器或 `bwrap`；MVP 必须在开放“用户上传参考视频”之前具备隔离能力。
如果运行环境没有隔离能力，只允许 trusted/admin StylePack，不允许用户触发的任意生成代码直接渲染。
渲染前预置浏览器和依赖缓存，隔离运行期间禁止联网下载。

- [x] **Step 3: 生成 3–5 秒 style proof**

用不含参考画面/参考音频的中性测试输入渲染 style proof；proof 只证明生成工程可运行、透明层有效、动效可审阅，不代表用户成片已经通过风格迁移验收。

- [x] **Step 4: 运行测试**

Run: `cd portal && node server/style-sandbox.verify.mjs`

Expected: PASS。

---

## Phase 3: 风格应用到用户素材

### Task 6: 实现 Style Application Planner

**Files:**
- Create: `portal/server/style-application.mjs`
- Create: `portal/server/style-application.verify.mjs`
- Modify: `portal/server/edit-plan.mjs`
- Modify: `portal/server/multi-asset-plan.mjs`

**Interfaces:**

```js
export function buildStyleApplication({
  stylePack,
  workflowMode,
  transcript,
  media,
  assets,
  brief,
}): StyleApplication;

export function applyStyleToEditPlan({
  plan,
  application,
  transcript,
}): EditPlan;

export function applyStyleToMultiAssetPlan({
  plan,
  application,
  assets,
}): MultiAssetPlan;
```

- [x] **Step 1: 写映射测试**

覆盖：

- 参考 42 秒、用户 75 秒时，切点密度按比例映射。
- Hook 时长按用户开头语义映射，不复制参考文案。
- 字幕按用户逐词时间重新分组。
- 参考 B-roll 比例高于用户可用 B-roll 时，降级为 punch-in 或标题卡。
- `multi-asset-v1` 的 B-roll 不产生时间轴空洞。
- 风格参数只影响视觉和节奏，不改变转录事实。

- [x] **Step 2: 实现单视频映射**

扩展 `edit-plan.json`：

```json
{
  "stylePackId": "style-clean-punch",
  "styleVersion": 1,
  "styleParameters": {},
  "layoutEvents": [],
  "visualEvents": [],
  "captionStyle": {}
}
```

保留现有 `segments`、`shorts`、`brollEvents` 合约。

- [x] **Step 3: 实现多素材映射**

扩展 `multiAssetPlan.clips` 的可选字段：

```json
{
  "shotRole": "full|punch_in|split|broll_cover",
  "layout": {
    "type": "full|punch_in|split|broll_cover",
    "params": {}
  }
}
```

`timeline.v2` 增加对应可选字段，但保持现有主轨连续和素材许可校验。

- [x] **Step 4: 运行测试**

Run: `cd portal && node server/style-application.verify.mjs && node server/edit-plan.verify.mjs && node server/multi-asset-plan.verify.mjs`

Expected: PASS。

### Task 7: 单视频工作流接入

**Files:**
- Modify: `portal/server/index.mjs`
- Modify: `portal/server/remotion-main.mjs`
- Modify: `portal/server/remotion-overlay.mjs`
- Modify: `portal/server/project-store.mjs`
- Modify: `portal/server/remotion-main.verify.mjs`
- Modify: `portal/server/edit-plan.verify.mjs`

**Interfaces:**

- `POST /api/projects/:id/apply-style`
- `POST /api/projects/:id/style-preview`
- `project.stylePackId`
- `project.styleVersion`
- `project.styleParameters`
- `composeRemotionMain` 支持 `styleProjectId`

- [x] **Step 1: 写失败测试**

覆盖：

- 没有 approved StylePack 时拒绝渲染。
- 风格包版本变化后旧预览失效。
- 渲染记录包含 style manifest/code hash。
- 字幕和原有 `captionStyle` 不丢失。
- 参考文案不会出现在输出 SRT 或 `visualEvents`。

- [x] **Step 2: 实现单视频接入**

优先使用现有 `edit-plan.json`/`timeline.json`/`captions.srt`；
StyleProject 只生成透明 overlay，基础视频仍由现有 FFmpeg 合成。

- [x] **Step 3: 运行测试**

Run: `cd portal && node server/remotion-main.verify.mjs && node server/edit-plan.verify.mjs`

Expected: PASS。

### Task 8: 多素材工作流接入

**Files:**
- Modify: `portal/server/index.mjs`
- Modify: `portal/server/multi-asset-plan.mjs`
- Modify: `portal/server/timeline-v2.mjs`
- Modify: `portal/contracts/timeline.v2.schema.json`
- Modify: `portal/server/multi-asset-render.mjs`
- Modify: `portal/server/multi-asset-plan.verify.mjs`
- Modify: `portal/server/timeline-v2.verify.mjs`
- Modify: `portal/server/multi-asset-route.verify.mjs`

**Interfaces:**

- `POST /api/projects/:id/apply-style` 支持 `workflowMode: "multi-asset-v1"`
- `multiAssetPlan.clips[]` 可携带 `shotRole`/`layout`
- `timeline.v2.clips[]` 可携带 `layout`
- `multi-asset-render` 能执行 punch-in、B-roll cover 和简单 split

- [x] **Step 1: 写失败测试**

覆盖：

- 参考分镜映射到两条不同用户素材。
- B-roll event 必须落在主片段内。
- split/punch-in 不产生重叠或越界。
- StylePack 不兼容多素材时阻止渲染。
- 素材许可和输入 revision 失效规则仍生效。

- [x] **Step 2: 实现多素材接入**

保持现有 `video-main` 连续主轨和 `video-overlay` 覆盖轨；
新增布局变换只在主轨或覆盖轨内执行，不引入第三套时间轴。

- [x] **Step 3: 运行测试**

Run: `cd portal && node server/multi-asset-plan.verify.mjs && node server/timeline-v2.verify.mjs && node server/multi-asset-route.verify.mjs`

Expected: PASS。

---

## Phase 4: API、UI 与用户审阅

### Task 9: 增加参考风格 API

**Files:**
- Modify: `portal/server/index.mjs`
- Create: `portal/server/reference-style-route.verify.mjs`

**Interfaces:**

```text
POST /api/reference-styles
GET  /api/reference-styles/:id
POST /api/reference-styles/:id/generate
GET  /api/style-packs
GET  /api/style-packs/:id/:version
POST /api/projects/:id/apply-style
POST /api/projects/:id/style-preview
```

- [x] **Step 1: 写路由测试**

覆盖上传、分析、生成、审批、应用、失败回退和路径隐私。

- [x] **Step 2: 实现路由**

所有路径使用现有 `workspacePath` 约束；不暴露本地绝对路径。

- [x] **Step 3: 运行测试**

Run: `cd portal && node server/reference-style-route.verify.mjs`

Expected: PASS。

### Task 10: 增加“风格 DNA”审阅界面

**Files:**
- Modify: `portal/src/App.tsx`
- Modify: `portal/src/ReviewWorkspace.tsx`
- Modify: `portal/src/styles.css`
- Create: `portal/src/ReferenceStylePanel.tsx`
- Create: `portal/src/StylePackCard.tsx`

**UI requirements:**

- 显示参考视频代表帧
- 显示切点密度、Hook、B-roll 比例、字幕样式
- 显示可迁移/不可迁移能力
- 显示 “只复制字幕 / 节奏 / 布局 / B-roll / 声音” 开关
- 显示 style proof
- 显示 StylePack 版本和来源
- 显示生成中、需审批、不可用、已应用状态

- [x] **Step 1: 写组件状态测试**

覆盖：没有风格包、生成中、生成失败、未审批、可用、版本过期。

- [x] **Step 2: 实现面板**

不在前端执行或解析任意生成代码；只展示 manifest 和服务端状态。

- [x] **Step 3: 运行前端检查**

Run: `cd portal && npm run typecheck && npm run build`

Expected: PASS。

---

## Phase 5: 质量、评测与上线

### Task 11: Style QC 与风格匹配指标

**Files:**
- Create: `portal/server/style-qc.mjs`
- Create: `portal/server/style-qc.verify.mjs`
- Modify: `portal/server/render.mjs` 或 `multi-asset-render.mjs`
- Create: `portal/test-fixtures/style/golden/README.md`

**Metrics:**

- `cutDensityDelta`
- `avgShotLengthDelta`
- `hookLengthDelta`
- `punchInRatioDelta`
- `brollRatioDelta`
- `captionWordsPerCueDelta`
- `captionPositionDelta`
- `captionFontRatioDelta`
- `visualEventRateDelta`
- `bpmDelta`
- `sfxDensityDelta`

**Hard gates:**

- 无意外黑帧
- 音画同步不超过现有阈值
- 字幕不遮脸
- 无参考画面/参考音频进入输出
- 无未授权素材
- StyleProject 代码 hash 与 manifest 一致

- [x] **Step 1: 写失败测试**

用合成参考/用户配对验证指标计算和越界拒绝。

- [x] **Step 2: 实现 Style QC**

输出机器可读 `style-qc.json`，并和现有 QC 合并到预览/导出记录。

- [x] **Step 3: 运行测试**

Run: `cd portal && node server/style-qc.verify.mjs`

Expected: PASS。

### Task 12: 建立黄金样本与人工评审

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-reference-style-transfer-design.md`
- Create: `portal/test-fixtures/style/golden/README.md`
- Create: `portal/test-fixtures/style/golden/labels.example.json`

**Dataset:**

- 10 组参考/用户配对
- 5 组单视频
- 5 组多素材
- 9:16 与 16:9 各至少 2 组
- 有字幕/无字幕
- 有 B-roll/无 B-roll

**Human review:**

- 风格相似度 1–5
- 字幕可读性 1–5
- 剪辑自然度 1–5
- 是否愿意交付给客户
- 主要失败原因

- [x] **Step 1: 写评审 rubric**
- [x] **Step 2: 建立样本清单，不提交未授权视频**
- [ ] **Step 3: 运行 Style QC 和人工评审**（等待 10 组已授权真实配对）
- [ ] **Step 4: 记录通过率和失败类型**（依赖 Step 3）

### Task 13: 质量优先的发布门禁

**Files:**
- Modify: `portal/package.json`
- Modify: `portal/README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/DESIGN.md`
- Create: `docs/reference-style-transfer.md`

**Rollout:**

1. `REFERENCE_STYLE_ENABLED=0` 默认关闭。
2. 内部管理员生成并审批 StylePack。
3. 仅对现有口播用户开放上传参考视频。
4. 先允许保存/预览，不允许直接导出。
5. 通过 10 组黄金样本后开放导出。
6. 再开放多素材和批量应用。

**Go criteria:**

- 所有生成 StyleProject 通过静态策略扫描。
- 所有可导出 StylePack 通过透明层、画幅、时长和 alpha 检查。
- 10 组配对中至少 8 组通过硬 QC。
- 人工风格相似度和剪辑自然度达到团队阈值。
- 没有参考画面、参考音乐或参考人物复用。
- 现有 `npm run verify` 和 `npm run build` 通过。

---

## 后续完整产品迭代

### Phase 2：风格资产化

- StylePack 命名、标签、收藏和版本历史。
- 个人风格库和品牌风格库。
- 同一 StylePack 应用到多条口播。
- 风格强度、局部覆盖、仅字幕/仅节奏等预设。
- 风格包的删除、归档和恢复。

**出口条件：** 用户能在不重新分析参考视频的情况下复用 5 条以上口播。

### Phase 3：更强的编辑语法

- 更丰富的布局原语：画中画、半屏、图表卡、引用、章节、进度。
- 参考分镜和用户素材的语义匹配。
- 多说话人、多人对话、采访和播客。
- 长视频分段和跨段风格一致性。
- 多语言字幕样式迁移，不复制参考文案。
- 评估将 StyleProject 从透明 overlay 扩展为完整 Remotion composition，
  用于布局复杂、必须由 Remotion 承担基础画面编排的参考风格；在此之前保留
  现有 FFmpeg 基础合成和 QC 作为稳定路径。

**出口条件：** 多素材模式在 10 组不同内容类型上通过风格 QC；复杂布局不会破坏现有时间轴契约。

### Phase 4：团队与商业化

- 团队共享 StylePack。
- 品牌约束、字体授权和素材许可检查。
- 批量应用和变体比较。
- API/MCP 接口。
- 风格表现数据与模板市场。
- 私有化部署和审计日志。

**出口条件：** 至少 3 个真实团队连续使用 4 周；有可解释的时间节省和复购信号。

## Tests to run

```bash
cd portal
node server/style-baseline.verify.mjs
node server/reference-analysis.verify.mjs
node server/style-project.verify.mjs
node server/style-pack.verify.mjs
node server/style-policy.verify.mjs
node server/style-generator.verify.mjs
node server/style-sandbox.verify.mjs
node server/style-application.verify.mjs
node server/reference-style-route.verify.mjs
node server/style-qc.verify.mjs
npm run typecheck
npm run build
npm run verify:style
npm run verify
npm run verify:remotion
```

## 阶段验收摘要

| 阶段 | 交付 | 验收 |
|---|---|---|
| Phase 1 | ReferenceAnalysis + StyleProject 契约 | 两类画幅、两类工作流、合成样本通过 |
| Phase 2 | Claude 生成与安全门禁 | 静态扫描、沙箱、alpha 渲染通过 |
| Phase 3 | 单视频/多素材风格应用 | 切点、字幕、B-roll、布局不破坏现有契约 |
| Phase 4 | API + UI + 风格 DNA 审阅 | 用户可以分析、审阅、保存、应用 |
| Phase 5 | Style QC + 黄金样本 | 10 组配对达到质量门槛，默认关闭后灰度开放 |
| 后续 | 风格库、团队、批量、市场 | 复用、留存和商业验证 |

## 成本与风险控制

- 先生成单条参考的 StylePack，再允许批量复用。
- 先做字幕、标题、强调、推近和 B-roll 覆盖，再做复杂布局。
- 所有生成代码只在沙箱中执行，不在 Portal 主进程执行。
- 不对参考视频做内容重演，不生成参考人物、音乐和品牌素材。
- 每个 StylePack 有明确 `unsupported`，不能静默降级后宣称完全还原。
- 质量优先阶段不追求“任意视频”，先追求“口播视频的稳定高保真”。
