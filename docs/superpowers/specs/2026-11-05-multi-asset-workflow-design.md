# 多素材剪辑工作流与双入口设计

## 目标

产品同时支持两类用户入口：

1. **单视频口播入口**：延续当前能力。用户上传一段自拍视频或口播视频，系统执行现有的转录、草剪、审核、导出流程。
2. **多素材方案入口**：面向普通用户的路线 B。用户上传多段原始素材，并提供一段剪辑方案，系统分析素材、生成有逻辑的故事线和多素材时间轴，输出完整成片。

高级用户路线 C 作为后续能力保留：接入 OpenChatCut/NLE 等专业编辑器，由 Claude 在受控编辑会话中直接操作更复杂的工程。路线 C 不作为本轮实现内容，也不改变路线 B 的基础数据模型和入口体验。

本轮的验收重点是：新增路线 B 后，现有单视频入口的行为、接口、产物和恢复方式保持兼容。

## 非目标

- 本轮不实现多机位自动同步、音频波形对齐和自动切角度。
- 本轮不让普通用户接触 OpenChatCut 工程、MCP 工具或专业时间线编辑器。
- 本轮不删除或重命名现有单视频 API，不把旧项目强制迁移为多素材项目。
- 本轮不承诺一次性支持任意复杂的 Premiere、Final Cut Pro 或 DaVinci Resolve 工程交换。

## 现状与约束

当前 Wayne Portal 将一个项目建模为一个 `project.media`，主文件保存为 `input.mp4`；前端只有一个主文件 `selectedFile`，多文件只用于 B-roll。Claude 工作区也只复制一个 `input.mp4`，渲染器从 `project.media.path` 读取输入。`timeline.v1` 的主媒体固定为 `source-video`。

这些现有约束对单视频入口是有效的，不能直接把 `media` 改成数组后让旧链路承担新语义。因此采用增量模型：保留旧字段和旧流程，新增多素材字段、路由和 `timeline.v2`，并通过 `workflowMode` 明确选择链路。

## 用户入口

### 入口 A：单视频口播

界面名称：`口播视频剪辑`

输入：

- 一段主视频；
- 可选配乐；
- 可选 B-roll；
- 目标和风格文字。

处理：继续使用当前 `project.media`、单素材转录、现有 Claude Code 剪辑工程和现有渲染器。

### 入口 B：多素材成片

界面名称：`多素材方案剪辑`

输入：

- 多段原始视频；
- 一段自然语言剪辑方案；
- 可选目标平台、目标时长、画幅和受众；
- 可选必须出现、必须避开的内容；
- 可选配乐和经许可的辅助素材。

处理：创建 `workflowMode: "multi-asset-v1"` 项目，先建立素材库，再逐素材分析和转录，最后由 Claude 生成跨素材故事结构和多轨时间轴。

两个入口在项目创建时确定模式。项目创建后不能把单视频项目直接切换为多素材项目；用户可以新建另一种项目，避免已有时间轴的时间坐标和产物被悄悄改变。

## 路线选择

### 方案一：先拼接再复用单视频流程

把多段输入预先合并为一个长视频，再交给当前流程。实现成本低，但丢失素材身份和源时间点，方案无法可靠指定“使用第 3 个素材的 00:12–00:18”，也不利于后续高级编辑。

### 方案二：素材库 + 多轨时间轴（本轮采用）

���段输入保持独立 asset，保存媒体元数据、转录、关键帧和来源。剪辑计划中的每个片段引用 `sourceAssetId`、`sourceInMs`、`sourceOutMs`，同时记录它在成片时间轴中的位置。渲染器按已校验的引用执行多输入剪辑和拼接。

优点是语义正确、可以逐素材重试、能解释每个镜头来自哪里，并为路线 C 提供稳定的中间契约。代价是需要新增资产上传、逐素材分析、契约和渲染适配。

### 方案三：直接把所有输入交给 OpenChatCut/NLE

由专业编辑器维护素材和工程，Claude 直接操作多素材时间线。它适合高级用户，但依赖 sidecar、工程状态、许可证和人工审批，不能作为普通用户的默认路径。

路线 B 采用方案二；路线 C 未来采用方案三，并复用方案二生成的素材索引和方案数据。

## 数据模型

项目新增：

```json
{
  "workflowMode": "single-video-v1 | multi-asset-v1",
  "brief": {
    "rawText": "用户提供的剪辑方案",
    "audience": "潜在客户",
    "platform": "douyin",
    "targetDurationMs": 60000,
    "aspectRatio": "9:16",
    "mustUse": [],
    "mustAvoid": []
  },
  "assets": [
    {
      "id": "asset-001",
      "role": "main | supporting | broll | voiceover",
      "filename": "素材-01.mp4",
      "path": "assets/asset-001/source.mp4",
      "durationMs": 12000,
      "width": 1920,
      "height": 1080,
      "hasAudio": true,
      "hasVideo": true,
      "order": 1,
      "label": "开场口播",
      "transcript": null,
      "analysis": null
    }
  ]
}
```

路线 B 的时间轴片段使用独立源时间和成片时间：

```json
{
  "id": "clip-001",
  "sourceAssetId": "asset-001",
  "sourceInMs": 1200,
  "sourceOutMs": 5600,
  "timelineStartMs": 0,
  "timelineEndMs": 4400,
  "track": "video-main",
  "purpose": "hook",
  "reason": "方案要求先展示问题"
}
```

单视频项目继续保存和读取现有 `media`、`transcript`、`plan` 字段。必要时由兼容函数将旧项目视为只有一个 `source-video` 的逻辑素材，但不改写磁盘上的旧项目文件。

## 处理流程

### 单视频入口

保持现有流程：

```text
创建单视频项目 → 上传 input.mp4 → FFprobe → 转录 → Claude 草剪 → 预览/QC → 审核 → 导出
```

### 多素材入口

```text
创建 multi-asset-v1 项目
→ 上传多个 asset（支持分块、断点续传）
→ 每个 asset 独立 FFprobe
→ 每个 asset 独立抽音频、转录和关键帧分析
→ 汇总 asset-inventory.json
→ 解析 brief/方案
→ Claude 生成 story-plan + timeline.v2
→ 用户确认方案
→ 多输入低分辨率预览（横屏 + 竖屏）与独立 QC
→ 用户播放检查，可定位镜头、按自然语言修改并生成新方案版本
→ 预览通过当前方案的检查后，导出正式横屏/竖屏成片
```

方案为空时，路线 B 可以根据素材索引生成方案草稿，但必须在进入正式渲染前显示给用户确认；不能把模型猜测当作用户方案。

## API 与契约

新增多素材接口：

```text
POST /api/projects                         创建项目，带 workflowMode
POST /api/projects/:id/assets              创建/上传一个素材
POST /api/projects/:id/assets/:assetId/chunk
POST /api/projects/:id/assets/:assetId/complete
GET  /api/projects/:id/assets              获取素材列表和分析状态
PUT  /api/projects/:id/brief               保存剪辑方案
POST /api/projects/:id/plan                生成或修订剪辑方案
POST /api/projects/:id/plan/confirm        确认剪辑方案
POST /api/projects/:id/preview             生成低分辨率横竖屏预览
POST /api/projects/:id/render              预览通过后导出正式成片
GET  /api/projects/:id/timeline            返回 timeline.v1 或 timeline.v2
```

现有 `/input`、`/input/chunk`、`/input/complete` 继续服务 `single-video-v1`。多素材项目拒绝使用旧 `/input` 路由，避免把一段素材误当成主媒体覆盖项目。

新增 `contracts/timeline.v2.schema.json`，至少包含：

- 项目模式和版本；
- asset 元数据和安全的相对引用；
- 每个 asset 的转录引用；
- video、audio、overlay 轨道；
- `sourceAssetId`、`sourceInMs`、`sourceOutMs`、`timelineStartMs`、`timelineEndMs`；
- 方案要求与执行证据；
- 素材许可和 SHA-256 信息。

`timeline.v1` 不变，旧渲染器继续只接收旧契约。路线 C 的 OpenChatCut 适配器未来可以消费 `timeline.v2` 或其转换结果。

## 兼容与隔离策略

1. `workflowMode` 默认值为 `single-video-v1`，保证旧客户端创建项目时行为不变。
2. 旧项目没有 `workflowMode` 时按单视频处理。
3. 单视频入口不读取 `assets[]`，多素材入口不读取 `project.media.path` 作为主输入。
4. 单视频渲染器和多素材渲染器共享底层 FFmpeg/媒体探测工具，但不共享未经适配的时间轴校验逻辑。
5. 旧项目产物命名和下载地址保持不变。
6. 多素材项目使用独立目录 `assets/<assetId>/` 和版本化 `timeline-v2-<version>.json`，失败时保留已经完成的素材分析。
7. 多素材项目任何一条素材失败时显示可重试状态，不把整个项目伪装成“无素材”或“已完成”。

## 分期计划

### Phase 0：契约和兼容层

- 增加 `workflowMode`、`brief`、`assets` 的持久化字段。
- 为旧项目补充内存层默认值，不迁移、不覆盖旧文件。
- 增加 `timeline.v2` 类型、JSON Schema 和纯校验函数。
- 增加单视频回归测试，确认旧接口和旧产物不变。

### Phase 1：多素材入口与上传

- 新增多素材入口页面和项目创建请求。
- 支持多文件选择、排序、命名、角色和上传进度。
- 每个 asset 独立支持分块上传、断点续传、FFprobe 和状态保存。
- 增加素材列表 API 和项目 SSE 事件。

### Phase 2：素材分析与方案

- 每个 asset 独立转录并保存 `transcript.json`。
- 生成关键帧、音频状态和基础内容标签。
- 增加方案编辑器和结构化字段。
- 让 Claude 读取 `asset-inventory.json` 与 brief，输出故事结构和 `timeline.v2` 草案。

### Phase 3：多素材预览、审核和导出

- 实现多输入 FFmpeg 渲染，先支持硬切、字幕、标题卡、配乐和基础 B-roll。
- 预览中显示源素材名称、源时间点和成片时间点。
- 支持“替换某段素材”“延长/缩短某个源片段”等对话修改。
- 增加多素材专用 QC：源引用完整、时间范围合法、无空洞/重叠、音画同步、黑帧、字幕和方案执行覆盖。

### Phase 4：高级路线 C

- 在不改变 B 的情况下接入 OpenChatCut/NLE sidecar。
- 使用人工审批的导入和编辑会话。
- 复用素材索引、方案和许可证据。
- 严格要求 `begin_edit_session → edit → review_edit_session → readback`，并保留可回退的 Wayne 时间轴和导出产物。

## 已确认决策

- 路线 B 是当前实施重点，路线 C 只记录设计并后续实现。
- 单视频口播和多素材成片使用两个独立入口；旧单视频入口及其链路必须保持可用。
- 多素材项目素材分析失败时，先阻止生成方案，用户只重试失败素材。
- 路线 B 首版只接收视频素材，不接受独立音频或图片素材。
- 多素材项目至少需要 2 个可用视频 asset；最多 20 个 asset，单个不超过 500MB，项目总计不超过 5GB。
- 路线 B 同时支持横屏和竖屏。默认同时导出 1920×1080 横屏和 1080×1920 竖屏两个版本；用户明确指定单一画幅时只导出对应版本。
- `targetDurationMs` 是软目标，允许约 ±10% 偏差。
- 首版只支持单主视频轨、B-roll 覆盖轨和音频轨，先支持硬切、淡入淡出，不实现复杂转场。
- 方案草稿需用户确认后生成低分辨率横屏/竖屏预览；预览通过 QC 且用户播放检查后，才能导出正式成片。
- 方案修改生成新版本并使旧预览失效；旧方案、预览和正式产物保留并可回退。
- asset 角色可以由用户修改，首版作为 Claude 的提示标签使用；不强制恰好一个 `main` 角色。
- 每个 asset 都记录授权确认；未确认授权的素材不能进入正式导出。
- 首版沿用现有单语言转录和字幕流程。

## 验收标准

### 单视频入口

- 现有单段自拍视频仍能创建、上传、转录、生成预览和导出。
- 旧项目刷新后仍可继续处理。
- 旧 `timeline.v1`、下载路由和产物命名不变。

### 多素材入口

- 用户能上传至少 2 段不同视频并看到独立状态。
- 用户能输入一段方案并确认结构化 brief。
- Claude 生成的时间轴至少引用两个不同 asset，并且每个引用的源时间范围有效。
- 渲染输出是一条连续可播放的视频，音画同步、无意外黑帧，字幕和方案要求可追溯。
- 任意素材或某阶段失败时，可以重试该素材/阶段，不需要重新上传全部文件。
- 用户能在预览中定位某个镜头的源素材和源时间点，并通过对话要求替换。

## 已确认的首版默认值

以下默认值已由产品确认：

- 单个多素材项目最多 20 个视频 asset；
- 单个 asset 最大 500 MB，项目总大小最大 5 GB；
- 首版只支持独立素材组合，不支持多机位同步；
- 首版路线 B 默认同时生成横屏和竖屏两个主片；Shorts 继续只由现有单视频入口生成；
- 首版必须由用户确认 Claude 生成的方案草稿后才进入渲染。
