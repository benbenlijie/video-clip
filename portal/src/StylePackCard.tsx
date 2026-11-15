import { Check, Film, Flag, Play } from "./icons";
import type { StylePanelState } from "./style-pack-state";
import type { StyleCopy } from "./style-pack-state";

type TypographySpec = {
  fontFamily: string;
  fontWeight: number;
  fontSizeRatio: number;
  lineHeight: number;
  letterSpacingRatio: number;
  color: string;
  strokeColor: string;
  strokeWidthRatio: number;
  shadowOpacity: number;
  shadowBlurRatio: number;
  shadowOffsetYRatio: number;
};

type PanelSpec = { enabled: boolean; color: string; opacity: number; radiusRatio: number; paddingXRatio: number; paddingYRatio: number; blurPx: number };
type AnimationSpec = { type: string; durationMs: number; delayMs: number; easing: string; scaleFrom: number; translateYRatio: number; stagger: string; staggerMs: number };

export type StyleSpecV2 = {
  contract: "style-spec.v2";
  canvas: { aspectRatio: string; safeArea: { topRatio: number; rightRatio: number; bottomRatio: number; leftRatio: number } };
  title: { anchor: string; widthRatio: number; maxLines: number; panel: PanelSpec; primary: TypographySpec; secondary: TypographySpec; motion: { enter: AnimationSpec; exit: AnimationSpec } };
  identity: { anchor: string; maxWidthRatio: number; panel: PanelSpec; primary: TypographySpec; secondary: TypographySpec; motion: { enter: AnimationSpec; exit: AnimationSpec } };
  captions: { grouping: string; maxCharsPerCue: number; anchor: string; maxWidthRatio: number; panel: PanelSpec; typography: TypographySpec; highlight: { strategy: string; color: string; strokeColor: string; scalePeak: number; durationMs: number }; motion: { enter: AnimationSpec; exit: AnimationSpec } };
  effects: Array<{ id: string; target: string; trigger: string; type: string; durationMs: number; delayMs: number; easing: string; intensity: number }>;
};

export type ReferenceAnalysis = {
  contract: "reference-analysis.v1" | "reference-analysis.v2";
  analysisId: string;
  source: {
    filename: string;
    durationMs: number;
    width: number;
    height: number;
    aspectRatio: string;
    fps: number;
    hasAudio: boolean;
    sha256: string;
  };
  shots: Array<{ id: string; startMs: number; endMs: number; role: string; layout: string; broll: boolean }>;
  rhythm: { hookMs: number; avgShotMs: number; cutsPerMinute: number; punchInRatio: number; brollRatio: number };
  captions: { grouping: string; maxWordsPerCue: number; position: string; fontSizeRatio: number; primaryColor: string; strokeColor: string; strokeWidth: number; keywordColor: string; animation: string };
  audio: { bpm: number | null; voice: string; sfxDensity: string };
  capabilities: { needsBroll: boolean; needsScreenshots: boolean; needsSplitScreen: boolean };
  unsupported: string[];
  confidence: { overall: number; rhythm: number; captions: number; layout: number };
  styleSpec?: StyleSpecV2;
};

export type StylePackManifest = {
  contract: "style-manifest.v1" | "style-manifest.v2";
  id: string;
  name: string;
  version: number;
  status: string;
  sourceAnalysisId: string;
  supportedModes: string[];
  parameters: Record<string, string | number | boolean>;
  capabilities: string[];
  requirements: { minAssets: number; needsMainFootage: boolean; needsBroll: boolean };
  unsupported: string[];
  preview: { video: string; poster: string } | null;
  styleSpec?: StyleSpecV2;
};

export type StylePack = {
  contract: "style-pack.v1";
  id: string;
  version: number;
  status: string;
  manifest: StylePackManifest;
  manifestSha256?: string;
  codeSha256?: string;
};

export type StyleProof = {
  name: string;
  url: string;
  generatedAt?: string;
  styleVersion?: number;
};

type Props = {
  analysis: ReferenceAnalysis | null;
  stylePack: StylePack | null;
  state: StylePanelState;
  copy: StyleCopy;
  busy: boolean;
  proof: StyleProof | null;
  onToggleCopy: (key: keyof StyleCopy, checked: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
  onApply: () => void;
  onPreview: () => void;
};

const capabilityLabels: Record<string, string> = {
  captions: "字幕",
  title_card: "标题卡",
  emphasis: "重点强调",
  cta: "行动号召",
  callout: "标注框",
  punch_in: "推近",
  split: "分屏",
  broll_cover: "B-roll 覆盖",
};

const copyLabels: Array<{ key: keyof StyleCopy; label: string; detail: string; capability?: string }> = [
  { key: "copyCaptions", label: "字幕", detail: "字号、位置、描边和关键词颜色", capability: "captions" },
  { key: "copyRhythm", label: "节奏", detail: "布局事件节拍和 QC 目标；不改写口播台词或硬切点" },
  { key: "copyLayout", label: "布局", detail: "全屏、推近、分屏、覆盖和参考视觉标注", capability: "layout" },
  { key: "copyBroll", label: "B-roll", detail: "仅在有授权素材时迁移覆盖镜头", capability: "broll_cover" },
  { key: "copyAudio", label: "声音", detail: "节拍和音效密度提示，不复制原音频" },
];

function time(ms: number) {
  return `${Math.max(0, ms / 1000).toFixed(1)}s`;
}

function percent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function StylePackCard({ analysis, stylePack, state, copy, busy, proof, onToggleCopy, onApprove, onReject, onApply, onPreview }: Props) {
  const manifest = stylePack?.manifest || null;
  const hasTransferableCapabilities = Boolean(manifest?.capabilities?.length);
  return <article className="style-pack-card" aria-label="风格包与迁移范围">
    <header className="style-pack-card-heading">
      <div>
        <p className="eyebrow">STYLE PACK</p>
        <h4>{manifest?.name || "尚未生成风格工程"}</h4>
      </div>
      <span className={`style-state-pill ${state.key}`}>{state.label}</span>
    </header>

    {analysis ? <div className="style-dna-grid" aria-label="参考视频风格指标">
      <div><span>切点密度</span><strong>{analysis.rhythm.cutsPerMinute}</strong><small>次 / 分钟</small></div>
      <div><span>Hook</span><strong>{time(analysis.rhythm.hookMs)}</strong><small>首镜停留</small></div>
      <div><span>B-roll</span><strong>{percent(analysis.rhythm.brollRatio)}</strong><small>画面占比</small></div>
      <div><span>字幕</span><strong>{analysis.captions.maxWordsPerCue || "—"}</strong><small>{analysis.captions.position === "unknown" ? "位置待识别" : analysis.captions.position}</small></div>
      <div><span>BPM</span><strong>{analysis.audio.bpm || "—"}</strong><small>{analysis.audio.bpm ? "节拍估计" : "未检测到稳定节拍"}</small></div>
      <div><span>音效</span><strong>{analysis.audio.sfxDensity === "unknown" ? "—" : analysis.audio.sfxDensity}</strong><small>起音密度</small></div>
    </div> : <div className="style-pack-empty"><Film size={20} /><strong>先上传参考视频</strong><p>系统会提取节奏、Hook、B-roll 和字幕结构，并生成受控的 Remotion 风格工程。</p></div>}

    {analysis && <div className="style-caption-summary" aria-label="参考字幕样式摘要">
      <span><i style={{ backgroundColor: analysis.captions.primaryColor }} />主色 {analysis.captions.primaryColor}</span>
      <span><i style={{ backgroundColor: analysis.captions.keywordColor }} />关键词 {analysis.captions.keywordColor}</span>
      <span>描边 {analysis.captions.strokeWidth}px · {analysis.captions.strokeColor}</span>
      <span>分组 {analysis.captions.grouping === "unknown" ? "待识别" : analysis.captions.grouping}</span>
      <span>动画 {analysis.captions.animation === "none" ? "无" : analysis.captions.animation}</span>
      {analysis.styleSpec && <span>字幕底板 {analysis.styleSpec.captions.panel.enabled ? `${analysis.styleSpec.captions.panel.color} · ${percent(analysis.styleSpec.captions.panel.opacity)}` : "无"}</span>}
      {analysis.styleSpec && <span>标题底板 {analysis.styleSpec.title.panel.enabled ? `${analysis.styleSpec.title.panel.color} · ${percent(analysis.styleSpec.title.panel.opacity)}` : "无"}</span>}
      {analysis.styleSpec && <span>入场 {analysis.styleSpec.captions.motion.enter.type} · {analysis.styleSpec.captions.motion.enter.durationMs}ms · {analysis.styleSpec.captions.motion.enter.easing}</span>}
      {analysis.styleSpec && <span>强调 {analysis.styleSpec.captions.highlight.strategy} · {analysis.styleSpec.captions.highlight.color}</span>}
    </div>}

    {analysis && <div className="style-capabilities">
      <div>
        <strong><Check size={15} /> 可迁移</strong>
        <div className="style-capability-list">{manifest?.capabilities?.length ? manifest.capabilities.map((item) => <span key={item}>{capabilityLabels[item] || item}</span>) : <span>待分析</span>}</div>
      </div>
      <div>
        <strong><Flag size={15} /> 不迁移</strong>
        <div className="style-capability-list muted">
          {(manifest?.unsupported?.length ? manifest.unsupported : analysis.unsupported.length ? analysis.unsupported : ["参考画面、人物、品牌、原文案和原音频"]).map((item) => <span key={item}>{item}</span>)}
        </div>
      </div>
    </div>}

    {manifest && <div className="style-pack-meta">
      <span>版本 v{manifest.version}</span>
      <span>{manifest.supportedModes.map((mode) => mode === "single-video-v1" ? "单视频" : "多素材").join(" / ")}</span>
      <span title={manifest.sourceAnalysisId}>来源 {analysis?.source.filename || manifest.sourceAnalysisId.slice(0, 12)}</span>
    </div>}

    <p className="style-pack-state-copy">{state.detail}</p>

    <fieldset className="style-copy-controls" disabled={busy || !manifest}>
      <legend>迁移范围</legend>
      <p>只复用编辑语法；关闭的维度不会被本次应用改写，用户自己的画面、声音和文案始终保留。</p>
      <div>{copyLabels.map((item) => {
        const availableCapabilities = manifest?.capabilities || [];
        const capabilityAvailable = !item.capability
          || (item.capability === "layout"
            ? ["punch_in", "split", "broll_cover", "title_card", "emphasis", "cta"].some((capability) => availableCapabilities.includes(capability))
            : availableCapabilities.includes(item.capability));
        return <label key={item.key} className={capabilityAvailable ? "" : "unavailable"}>
        <input type="checkbox" disabled={!capabilityAvailable} checked={copy[item.key] && capabilityAvailable} onChange={(event) => onToggleCopy(item.key, event.target.checked)} />
        <span><strong>{item.label}</strong><small>{item.detail}</small></span>
      </label>;
      })}</div>
    </fieldset>

    <div className="style-pack-actions">
      {state.canApprove && <button type="button" className="text-button" disabled={busy} onClick={onReject}>拒绝并重新生成</button>}
      {state.canApprove && <button type="button" className="secondary-button" disabled={busy} onClick={onApprove}>审批风格包</button>}
      {state.canApply && hasTransferableCapabilities && <button type="button" className="continue-button" disabled={busy} onClick={onApply}>应用到当前项目</button>}
      {state.canPreview && <button type="button" className="secondary-button" disabled={busy} onClick={onPreview}><Play size={15} /> 生成 style proof</button>}
    </div>
    {state.canApply && !hasTransferableCapabilities && <p className="style-no-capabilities">这个风格包没有检测到可迁移的镜头或字幕能力。请开启视觉分析，或换一条更清晰的参考视频后重新生成。</p>}

    <div className={`style-proof ${proof ? "ready" : ""}`}>
      <div><strong>Style proof</strong><small>{proof ? `来自 v${proof.styleVersion || stylePack?.version || 1}` : "应用风格后可生成 3 秒透明层预览"}</small></div>
      {proof ? <><video controls playsInline preload="metadata" src={proof.url} /><a href={proof.url} target="_blank" rel="noreferrer">{proof.name}</a></> : <span>尚未生成</span>}
    </div>
  </article>;
}
