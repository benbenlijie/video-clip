import { useEffect, useRef, useState } from "react";
import { FileVideo, Plus, Sparkles } from "./icons";
import type { Project } from "./App";
import { defaultStyleCopy, gateStylePanelState, pickStylePackForAnalysis, selectStyleProof, stylePanelState, type StyleCopy, type StyleRolloutCapabilities } from "./style-pack-state";
import { StylePackCard, type ReferenceAnalysis, type StylePack, type StyleProof } from "./StylePackCard";

type Props = {
  project: Project;
  apiBase: string;
  onProjectChange: (project: Project) => void;
  capabilities: StyleRolloutCapabilities;
  rolloutLabel: string;
};

type StylePackResponse = { stylePacks?: StylePack[] };
type ReferenceTrim = { originalDurationMs: number; analysisDurationMs: number; startMs: number };
type ReferenceResponse = { id: string; analysis: ReferenceAnalysis; sourceTrim?: ReferenceTrim };
type StoredStyleSelection = { id: string; version: number };

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error((payload as { error?: string }).error || `请求失败 (${response.status})`), { status: response.status });
  return payload as T;
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function styleMode(project: Project) {
  return project.workflowMode === "multi-asset-v1" ? "multi-asset-v1" : "single-video-v1";
}

function storageKey(projectId: string, kind: "reference" | "style") {
  return `wayne-reference-style:${projectId}:${kind}`;
}

function readStorage(projectId: string, kind: "reference" | "style") {
  try {
    return window.localStorage.getItem(storageKey(projectId, kind));
  } catch {
    return null;
  }
}

function writeStorage(projectId: string, kind: "reference" | "style", value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(storageKey(projectId, kind));
    else window.localStorage.setItem(storageKey(projectId, kind), value);
  } catch {
    // Private browsing or storage quotas must not block the editing flow.
  }
}

function rememberPack(projectId: string, pack: StylePack | null) {
  writeStorage(projectId, "style", pack ? JSON.stringify({ id: pack.id, version: pack.version }) : null);
}

function storedSelection(projectId: string): StoredStyleSelection | null {
  try {
    const value = JSON.parse(readStorage(projectId, "style") || "null");
    if (!value || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(value.id)) || !Number.isInteger(Number(value.version))) return null;
    return { id: String(value.id), version: Number(value.version) };
  } catch {
    return null;
  }
}

export function ReferenceStylePanel({ project, apiBase, onProjectChange, capabilities, rolloutLabel }: Props) {
  const storedReferenceId = readStorage(project.id, "reference");
  const [referenceId, setReferenceId] = useState<string | null>(project.referenceStyleId || storedReferenceId || null);
  const [analysis, setAnalysis] = useState<ReferenceAnalysis | null>(null);
  const [stylePack, setStylePack] = useState<StylePack | null>(project.stylePack || null);
  const [copy, setCopy] = useState<StyleCopy>(() => project.styleCopy || defaultStyleCopy(null));
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [panelOpen, setPanelOpen] = useState(Boolean(project.stylePackId));
  const [referenceUsageConfirmed, setReferenceUsageConfirmed] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const busy = Boolean(busyAction);
  const mode = styleMode(project);
  const effectiveCapabilities = {
    ...capabilities,
    apply: capabilities.apply && (project.workflowMode !== "multi-asset-v1" || capabilities.multi),
    preview: capabilities.preview && project.workflowMode !== "multi-asset-v1",
  };
  const state = gateStylePanelState(stylePanelState({
    reference: analysis,
    stylePack,
    busy,
    error,
    projectStyleId: project.stylePackId || project.stylePack?.id || null,
    projectStyleVersion: project.styleVersion || project.stylePack?.version || null,
  }), effectiveCapabilities);
  const proof = selectStyleProof(project) as StyleProof | null;

  useEffect(() => {
    let active = true;
    const id = project.referenceStyleId || storedReferenceId;
    if (!id) return () => { active = false; };
    void fetch(`${apiBase}/api/reference-styles/${encodeURIComponent(id)}`)
      .then((response) => responseJson<ReferenceResponse>(response))
      .then(async (payload) => {
        if (!active) return;
        setReferenceId(payload.id);
        setAnalysis(payload.analysis);
        setCopy(project.styleCopy || defaultStyleCopy(payload.analysis));
        if (!project.stylePack) {
          try {
            const response = await fetch(`${apiBase}/api/style-packs`);
            const data = await responseJson<StylePackResponse>(response);
            const selection = storedSelection(project.id);
            const restored = selection
              ? (data.stylePacks || []).find((pack) => pack.id === selection.id && Number(pack.version) === selection.version)
              : null;
            const matched = restored || pickStylePackForAnalysis(data.stylePacks || [], payload.analysis.analysisId);
            if (matched) {
              setStylePack(matched);
              rememberPack(project.id, matched);
            }
          } catch {
            setNotice("参考分析已恢复，但风格包列表暂时无法读取。");
          }
        }
      })
      .catch((loadError) => {
        if (active) {
          if ((loadError as { status?: number }).status === 404) {
            writeStorage(project.id, "reference", null);
            setReferenceId(null);
          }
          setNotice(loadError instanceof Error ? loadError.message : "参考视频分析读取失败");
        }
      });
    return () => { active = false; };
  }, [apiBase, project.id, project.referenceStyleId]);

  async function packsForAnalysis(analysisId: string) {
    const response = await fetch(`${apiBase}/api/style-packs`);
    const payload = await responseJson<StylePackResponse>(response);
    return pickStylePackForAnalysis(payload.stylePacks || [], analysisId);
  }

  async function applyReference(payload: ReferenceResponse) {
    setReferenceId(payload.id);
    writeStorage(project.id, "reference", payload.id);
    rememberPack(project.id, null);
    setAnalysis(payload.analysis);
    setCopy(defaultStyleCopy(payload.analysis));
    const existing = await packsForAnalysis(payload.analysis.analysisId);
    setStylePack(existing);
    rememberPack(project.id, existing);
    const trimNote = payload.sourceTrim
      ? `原片 ${formatClock(payload.sourceTrim.originalDurationMs)}，已截取 ${formatClock(payload.sourceTrim.startMs)}–${formatClock(payload.sourceTrim.startMs + payload.sourceTrim.analysisDurationMs)} 用于风格分析。`
      : "";
    setNotice(existing ? `${trimNote}已找到这条参考视频的风格包 v${existing.version}。` : `${trimNote}参考视频已分析，可以生成风格工程。`);
  }

  async function uploadReference(file: File) {
    setBusyAction("正在上传并分析参考视频…");
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("referenceUsageConfirmed", "true");
      const response = await fetch(`${apiBase}/api/reference-styles?mode=${encodeURIComponent(mode)}`, { method: "POST", body: form });
      await applyReference(await responseJson<ReferenceResponse>(response));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "参考视频分析失败");
    } finally {
      setBusyAction("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function importReferenceLink() {
    const link = linkValue.trim();
    if (!link) {
      setError("请先粘贴视频号链接");
      return;
    }
    if (!referenceUsageConfirmed) {
      setError("请先确认你拥有这条参考视频的分析和使用许可");
      return;
    }
    setError("");
    setNotice("");
    try {
      setBusyAction("正在解析视频号链接…");
      const resolved = await responseJson<{ title?: string; author?: string }>(await fetch(`${apiBase}/api/wechat-video/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link }),
      }));
      const label = resolved.title ? `「${resolved.title.slice(0, 28)}${resolved.title.length > 28 ? "…" : ""}」` : resolved.author ? `「${resolved.author}」` : "";
      setBusyAction(`正在下载${label}…`);
      const source = await responseJson<{ id: string }>(await fetch(`${apiBase}/api/wechat-video/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link, mode }),
      }));
      setBusyAction("参考视频已下载，正在分析…");
      const payload = await responseJson<ReferenceResponse>(await fetch(`${apiBase}/api/reference-styles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: source.id, mode, referenceUsageConfirmed: true }),
      }));
      setLinkValue("");
      await applyReference(payload);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "视频号链接导入失败");
    } finally {
      setBusyAction("");
    }
  }

  async function generateStyle() {
    if (!referenceId) return;
    setBusyAction("Claude 正在生成 Remotion 风格工程…");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/reference-styles/${encodeURIComponent(referenceId)}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const pack = await responseJson<StylePack>(response);
      setStylePack(pack);
      rememberPack(project.id, pack);
      setNotice(`风格工程 v${pack.version} 已生成，审批后才能应用。`);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "风格工程生成失败");
    } finally {
      setBusyAction("");
    }
  }

  async function approveStyle() {
    if (!stylePack) return;
    setBusyAction("正在审批风格包…");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/style-packs/${encodeURIComponent(stylePack.id)}/${stylePack.version}/approve`, { method: "POST" });
      const approved = await responseJson<StylePack>(response);
      setStylePack(approved);
      rememberPack(project.id, approved);
      setNotice("风格包已审批，可以选择迁移范围后应用。");
    } catch (approveError) {
      setNotice(approveError instanceof Error ? approveError.message : "风格包审批失败");
    } finally {
      setBusyAction("");
    }
  }

  async function rejectStyle() {
    if (!stylePack) return;
    const reason = window.prompt("请简要说明主要问题（可留空）", "");
    if (reason === null) return;
    setBusyAction("正在拒绝风格包…");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/style-packs/${encodeURIComponent(stylePack.id)}/${stylePack.version}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const rejected = await responseJson<StylePack>(response);
      setStylePack(rejected);
      rememberPack(project.id, rejected);
      setNotice("风格包已拒绝，可以重新分析并生成新版本。");
    } catch (rejectError) {
      setNotice(rejectError instanceof Error ? rejectError.message : "风格包拒绝失败");
    } finally {
      setBusyAction("");
    }
  }

  async function applyStyle() {
    if (!stylePack) return;
    setBusyAction("正在把风格结构应用到当前项目…");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/projects/${encodeURIComponent(project.id)}/apply-style`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stylePackId: stylePack.id, version: stylePack.version, styleCopy: copy }),
      });
      const nextProject = await responseJson<Project>(response);
      onProjectChange(nextProject);
      setStylePack(nextProject.stylePack || stylePack);
      if (nextProject.styleCopy) setCopy(nextProject.styleCopy);
      writeStorage(project.id, "reference", referenceId);
      rememberPack(project.id, nextProject.stylePack || stylePack);
      setNotice("参考风格已应用；请重新检查计划，再生成 style proof。");
    } catch (applyError) {
      setNotice(applyError instanceof Error ? applyError.message : "风格应用失败");
    } finally {
      setBusyAction("");
    }
  }

  async function previewStyle() {
    setBusyAction("正在渲染 style proof…");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/projects/${encodeURIComponent(project.id)}/style-preview`, { method: "POST" });
      const nextProject = await responseJson<Project>(response);
      onProjectChange(nextProject);
      setNotice("Style proof 已生成，可播放检查字幕、布局和节奏。");
    } catch (previewError) {
      setNotice(previewError instanceof Error ? previewError.message : "Style proof 生成失败");
    } finally {
      setBusyAction("");
    }
  }

  function toggleCopy(key: keyof StyleCopy, checked: boolean) {
    setCopy((current) => ({ ...current, [key]: checked }));
  }

  return <details className="reference-style-panel" open={panelOpen} onToggle={(event) => setPanelOpen(event.currentTarget.open)}>
    <summary>
      <div>
        <p className="eyebrow">REFERENCE STYLE DNA</p>
        <h3>从参考视频提取可复用风格</h3>
        <p>分析节奏、Hook、字幕和布局，把编辑语法转成受控模板，再应用到自己的素材。</p>
      </div>
      <span className={`style-panel-status ${state.key}`}>{busy ? busyAction : state.label}</span>
    </summary>

    <div className="reference-style-body">
      <p className="style-rollout-note">灰度阶段：{rolloutLabel}。{capabilities.export ? "已允许符合条件的正式导出。" : "当前仅允许分析和保存/预览，正式导出尚未开放。"}</p>
      {!capabilities.manage && <p className="style-admin-note">风格工程由本机管理员生成和审批。参考分析已保存；管理员完成后刷新页面即可选择版本。</p>}
      <section className="reference-source-card" aria-label="参考视频">
        <div className="reference-source-heading">
          <div><p className="eyebrow">REFERENCE</p><h4>{analysis?.source.filename || "上传参考视频"}</h4></div>
          <label className={`secondary-button reference-upload ${busy || !capabilities.analyze || !referenceUsageConfirmed ? "disabled" : ""}`}>
            <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" disabled={busy || !capabilities.analyze || !referenceUsageConfirmed} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadReference(file); }} />
            {referenceId ? <Plus size={15} /> : <FileVideo size={15} />}
            {referenceId ? "更换参考" : "选择参考"}
          </label>
        </div>

        <label className="license-check reference-license-check">
          <input type="checkbox" checked={referenceUsageConfirmed} onChange={(event) => setReferenceUsageConfirmed(event.target.checked)} />
          <span>我确认拥有这条参考视频的分析和使用许可，并且不会要求系统复制其中的人物、品牌、画面、音频或原文案。</span>
        </label>

        <div className="reference-link-import">
          <input
            type="url"
            inputMode="url"
            placeholder="或粘贴视频号链接：https://weixin.qq.com/sph/…"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
            disabled={busy || !capabilities.analyze || !referenceUsageConfirmed}
            aria-label="视频号分享链接"
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !capabilities.analyze || !referenceUsageConfirmed || !linkValue.trim()}
            onClick={() => void importReferenceLink()}
          >
            用链接导入
          </button>
        </div>

        {referenceId ? <video className="reference-style-video" controls playsInline muted preload="metadata" src={`${apiBase}/api/reference-styles/${encodeURIComponent(referenceId)}/media#t=0.1`} aria-label={`${analysis?.source.filename || "参考视频"} 的代表画面`} /> : <div className="reference-video-empty"><FileVideo size={24} /><strong>参考视频只用于提取结构</strong><p>支持 30–180 秒的横屏或竖屏视频；不会复制画面、音频、人物、品牌或原文案。</p></div>}

        {analysis && <div className="reference-source-meta">
          <span>{analysis.source.width} × {analysis.source.height}</span>
          <span>{analysis.source.aspectRatio}</span>
          <span>{(analysis.source.durationMs / 1000).toFixed(1)} 秒</span>
          <span>{analysis.shots.length} 个镜头</span>
          <span>置信度 {Math.round(analysis.confidence.overall * 100)}%</span>
        </div>}

        <div className="reference-actions">
          <button type="button" className="continue-button" disabled={!state.canGenerate || busy} onClick={() => void generateStyle()}>
            <Sparkles size={15} /> {stylePack ? "重新生成风格工程" : "生成风格工程"}
          </button>
          <small>生成由服务端 Claude Code 完成，浏览器只读取 manifest 和状态。</small>
        </div>

        {error && <div className="api-alert" role="alert"><strong>{error}</strong><small>可以更换参考视频后重新分析；失败任务不会生成可用风格包。</small></div>}
        {notice && <p className={`style-panel-notice ${/失败|错误|not|未/.test(notice) ? "is-error" : ""}`} role="status">{notice}</p>}
      </section>

      <StylePackCard
        analysis={analysis}
        stylePack={stylePack}
        state={state}
        copy={copy}
        busy={busy}
        proof={proof}
        onToggleCopy={toggleCopy}
        onApprove={() => void approveStyle()}
        onReject={() => void rejectStyle()}
        onApply={() => void applyStyle()}
        onPreview={() => void previewStyle()}
      />
    </div>
  </details>;
}
