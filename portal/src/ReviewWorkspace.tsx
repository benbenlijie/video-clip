import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, MessageSquareText, RotateCcw } from "./icons";
import type { Project } from "./App";
import { reviewState } from "./review-state";

type Segment = NonNullable<Project["transcript"]>["segments"][number];
type EditRequest = { baseVersion: number; timeMs: number | null; rangeEndMs: number | null };
type Props = {
  project: Project;
  busy: boolean;
  message: string;
  apiBase: string;
  onSend: (text: string, request: EditRequest) => Promise<boolean>;
  onSaveTranscript: (segments: Segment[], confirmed: string[]) => Promise<boolean>;
  onExport: () => Promise<void>;
  onRetry: () => Promise<void>;
  onNew: () => void;
  extraDetails?: ReactNode;
};
function time(value = 0) { const seconds = Math.floor(Math.max(0, value) / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function workingLabel(status: string) { return status === "rendering" ? "正在导出并检查成片" : status === "chat_editing" ? "正在制作新版本" : "正在制作视频"; }

export function ReviewWorkspace({ project, busy, message, apiBase, onSend, onSaveTranscript, onExport, onRetry, onNew, extraDetails }: Props) {
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [localError, setLocalError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captionsRef = useRef<HTMLDetailsElement | null>(null);
  const segments = project.transcript?.segments || [];
  const dirty = segments.some((segment) => edits[segment.id] != null && edits[segment.id] !== segment.text);
  const state = reviewState(project, viewVersion, dirty);
  const targets = project.proofreading?.status === "manual_review_required" ? segments.map((segment) => segment.id) : ["ready", "confirmed"].includes(project.proofreading?.status || "ready") ? [] : (project.proofreading?.unresolved || []).map((item) => item.segmentId);
  const allConfirmed = targets.every((id) => confirmed.includes(id));
  const remaining = targets.filter((id) => !confirmed.includes(id)).length;
  const disabled = busy || state.working || state.historical;
  const turn = project.editSession?.turns?.at(-1);
  useEffect(() => { if (turn?.status === "failed" && turn.request) setDraft((current) => current || turn.request); }, [turn?.id, turn?.status, turn?.request]);
  const artifactUrl = (url: string) => `${apiBase}${url}`;
  const openCaptions = () => { setCaptionsOpen(true); captionsRef.current?.scrollIntoView({ block: "nearest" }); };
  async function send(text = draft, updateCaptions = false) {
    if (!state.canSendEdit || disabled || !text.trim()) return;
    const start = startTime === "" ? null : Number(startTime) * 1000;
    const end = endTime === "" ? null : Number(endTime) * 1000;
    if (!updateCaptions && ((start !== null && (!Number.isFinite(start) || start < 0 || start > (state.video?.durationMs || 0))) || (end !== null && (!Number.isFinite(end) || end <= (start || 0) || end > (state.video?.durationMs || 0))))) { setLocalError("修改时间需落在当前视频内，结束时间须晚于开始时间。"); return; }
    setLocalError("");
    const ok = await onSend(text, { baseVersion: state.latestVersion, timeMs: updateCaptions ? null : start, rangeEndMs: updateCaptions ? null : end });
    if (ok && !updateCaptions) { setDraft(""); setStartTime(""); setEndTime(""); }
  }
  async function saveCaptions() {
    if (disabled || !allConfirmed) return;
    const ok = await onSaveTranscript(segments.map((segment) => ({ ...segment, text: edits[segment.id] ?? segment.text })), confirmed);
    if (ok) { setEdits({}); setConfirmed([]); }
  }
  function captionRow(segment: Segment, confirm: boolean) {
    const dispute = project.proofreading?.unresolved?.find((item) => item.segmentId === segment.id);
    return <article className="transcript-review-row" key={segment.id}>
      <div className="transcript-row-meta"><time>{time(segment.startMs)} · 原片</time><audio controls preload="none" src={`${apiBase}/api/projects/${project.id}/transcript-audio#t=${(segment.startMs / 1000).toFixed(2)}`} aria-label={`播放 ${time(segment.startMs)} 起的原音`} /></div>
      {dispute && <div className="transcript-compare"><p><span>原始识别</span>{dispute.primaryText}</p>{dispute.secondaryText && <p><span>第二次识别</span>{dispute.secondaryText}</p>}<small>{dispute.reason}</small></div>}
      <label className="transcript-edit-field"><span>字幕文字</span><textarea disabled={disabled} value={edits[segment.id] ?? segment.text} rows={2} onChange={(event) => setEdits((current) => ({ ...current, [segment.id]: event.target.value }))} /></label>
      {confirm && <label className="transcript-confirm-check"><input disabled={disabled} type="checkbox" checked={confirmed.includes(segment.id)} onChange={(event) => setConfirmed((current) => event.target.checked ? [...new Set([...current, segment.id])] : current.filter((id) => id !== segment.id))} /><span>我已核对原音，确认这句字幕</span></label>}
    </article>;
  }
  const actionLabels: Record<string, string> = { "back-latest": "回到最新版本", "save-subtitles": "保存字幕", "review-subtitles": targets.length > 0 && allConfirmed ? "保存并确认字幕" : `校对 ${targets.length || "待确认"} 处字幕`, "refresh-preview": "更新字幕预览", export: project.error && project.status === "failed" ? "重试导出成片" : "确认并导出成片", working: workingLabel(project.status), retry: "继续本项目" };
  async function primaryAction() {
    if (state.action === "back-latest") setViewVersion(null);
    else if (state.action === "save-subtitles") { openCaptions(); await saveCaptions(); }
    else if (state.action === "review-subtitles") { if (targets.length > 0 && allConfirmed) await saveCaptions(); else openCaptions(); }
    else if (state.action === "refresh-preview") await send("只根据当前已确认的 transcript.json 更新 captions.srt 和预览。保留现有剪辑计划、镜头、画面事件、配乐及其他工程决定，不修改任何台词文字；重新审查实际合成视频。", true);
    else if (state.action === "export") await onExport();
    else if (state.action === "retry") await onRetry();
  }
  return <section className="unified-review" aria-label="视频审核与修改工作台">
    <div className="panel-header"><div><p className="eyebrow">03 / 审核与导出</p><h3>{state.historical ? `历史版本 v${state.displayVersion}` : state.working ? workingLabel(project.status) : state.action === "download" ? "成片可以下载了" : "看视频，直接说你想怎么改"}</h3><p className="review-project-name">{project.media?.filename}</p></div><span className="soft-tag">当前 v{state.displayVersion}</span></div>
    <div className="review-workspace-layout">
      <section className="review-video-column" aria-label="当前视频与字幕">
        <div className="review-version-bar"><label htmlFor="review-version">查看版本<select id="review-version" value={state.displayVersion} disabled={!state.versions.length} onChange={(event) => { const value = Number(event.target.value); setViewVersion(value === state.latestVersion ? null : value); }}>{state.versions.length ? state.versions.map((version) => <option value={version} key={version}>v{version}{version === state.latestVersion ? " · 最新" : " · 历史"}</option>) : <option value={1}>尚无可播放版本</option>}</select></label><span>{state.video?.kind === "video" ? "正式成片" : "草剪预览"}{state.video?.durationMs ? ` · ${time(state.video.durationMs)}` : ""}</span></div>
        {state.video ? <video key={state.video.name} ref={videoRef} className="source-player unified-player" controls playsInline preload="metadata" src={artifactUrl(state.video.url)} aria-label={`播放 v${state.displayVersion} ${state.video.kind === "video" ? "成片" : "草剪"}`} /> : <div className="review-empty"><strong>还没有可播放的视频</strong><p>素材和已完成步骤仍在，继续本项目即可重试。</p></div>}
        {state.historical ? <div className="review-notice"><strong>当前查看的是历史版本。</strong><p>修改和导出需要先回到最新版本 v{state.latestVersion}。</p></div> : <p className="review-player-note">{state.working ? `正在制作下一份结果，上方仍是可查看的 v${state.displayVersion}。` : "先播放检查效果；需要修改时，在右侧或下方直接描述。"}</p>}
        {project.error && <div className="review-notice is-error" role="status"><strong>本轮制作未完成{state.video ? "，上一版仍可查看" : "，项目已保留"}。</strong><p>可继续提出修改，或按当前提示重试。</p><details><summary>查看错误详情</summary><pre>{project.error}</pre></details></div>}
        {message && <p className="review-feedback" role="status">{message}</p>}
        {!state.historical && project.proofreading && <>
          {(targets.length > 0 || dirty || project.proofreading.previewStale) && <button type="button" className="caption-attention" onClick={openCaptions}><span>{dirty ? "字幕修改尚未保存" : project.proofreading.previewStale ? "字幕已保存，视频需要更新" : remaining ? `还有 ${remaining} 处字幕需要确认` : "已核对字幕，保存后生效"}</span><ArrowRight size={17} /></button>}
          <details className="unified-captions" ref={captionsRef} open={captionsOpen} onToggle={(event) => setCaptionsOpen(event.currentTarget.open)}><summary>字幕校对{project.proofreading.status === "confirmed" ? " · 已确认" : targets.length ? ` · ${targets.length} 处待核对` : " · 可逐句修改"}</summary>
            <p className="review-player-note">对照原音修改文字。保存后若视频字幕已过期，需更新预览再导出。{project.proofreading.status === "manual_review_required" ? "本次只有一份识别稿，请逐句确认。" : ""}</p>
            <div className="transcript-review-list">{segments.filter((segment) => targets.includes(segment.id)).map((segment) => captionRow(segment, true))}</div>
            {segments.some((segment) => !targets.includes(segment.id)) && <details className="transcript-all-review"><summary>查看全部字幕（{segments.length} 句）</summary><div>{segments.filter((segment) => !targets.includes(segment.id)).map((segment) => captionRow(segment, false))}</div></details>}
          </details>
        </>}
        <div className="review-export-area">
          {state.action === "download" && state.final ? <a className="continue-button" href={artifactUrl(state.final.url)} download>下载成片 v{state.latestVersion} <ArrowRight size={17} /></a> : <button type="button" className="continue-button" disabled={busy || state.action === "working" || (state.action === "save-subtitles" && !allConfirmed)} onClick={() => void primaryAction()}>{busy ? "正在处理…" : actionLabels[state.action]} <ArrowRight size={17} /></button>}
          <small>{state.action === "review-subtitles" ? "先核对字幕，再确认导出。" : state.action === "save-subtitles" ? "先保存文字，确保视频使用的是确认稿。" : state.action === "refresh-preview" ? "点击后会运行现有 AI 修改流程，并按原服务计费。" : state.action === "download" ? "发布前请完整观看成片。修改后需要重新导出新版本。" : "原片和旧版本都会保留。"}</small>
        </div>
      </section>
      <section className="chat-panel unified-chat" aria-label="提出视频修改">
        <div className="chat-heading"><div><p className="eyebrow">修改意见</p><h3>直接告诉 AI 怎么改</h3></div><span className="chat-base-badge">基于 v{state.latestVersion}</span></div>
        <div className="chat-history" aria-live="polite">{(project.editSession?.messages || []).length ? project.editSession?.messages.map((item) => <article className={`chat-message ${item.role} ${item.error ? "error" : ""}`} key={item.id}><div className="chat-message-meta"><strong>{item.role === "assistant" ? "AI 剪辑" : "你"}</strong>{item.version ? <span>v{item.version}</span> : item.timeMs != null ? <span>{time(item.timeMs)}</span> : null}</div><p>{item.text}</p></article>) : <div className="chat-empty"><MessageSquareText size={21} /><strong>有想改的地方，直接说</strong><p>例如“00:18 这里太慢，删掉停顿”，或“字幕大一点”。每轮修改都会生成新版本。</p></div>}{state.working && <div className="review-job-status" role="status">{workingLabel(project.status)}。完成后会自动显示新结果。</div>}</div>
        <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <div className="chat-suggestions"><button type="button" disabled={disabled} onClick={() => setDraft("删掉这段停顿，其他地方保持不变")}>删停顿</button><button type="button" disabled={disabled} onClick={() => setDraft("字幕再大一点，保持现有位置和配色")}>调字幕</button><button type="button" disabled={disabled} onClick={() => setDraft("这句话出现时增加一次轻微推近，其他地方保持不变")}>加推近</button></div>
          <details className="review-time-range"><summary>指定修改时间（可选）</summary><button type="button" className="text-button" disabled={!state.canSendEdit || disabled} onClick={() => setStartTime((videoRef.current?.currentTime || 0).toFixed(1))}>使用当前播放时间</button><div className="chat-context-fields"><label>开始（秒）<input disabled={disabled} type="number" min="0" max={(state.video?.durationMs || 0) / 1000} step="0.1" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label><label>结束（秒）<input disabled={disabled} type="number" min="0" max={(state.video?.durationMs || 0) / 1000} step="0.1" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label></div></details>
          <div className="chat-composer"><textarea disabled={disabled} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} placeholder="例如：这一段节奏太慢，删掉停顿，其他地方保持不变" aria-label="修改意见" /><button type="submit" className="primary-button" disabled={!draft.trim() || !state.canSendEdit || disabled}>发送修改 <ArrowRight size={17} /></button></div>
        </form>
        {localError && <p className="review-feedback is-error" role="alert">{localError}</p>}
        <small className="chat-footnote">{state.historical ? "先回到最新版本，再提出修改。" : dirty ? "请先保存字幕修改，再发送新的制作意见。" : "每次发送会运行 AI 修改流程。旧版保留，可随时查看。"}</small>
      </section>
    </div>
    <details className="review-production-details"><summary>制作详情与更多下载</summary>
      <p>当前显示 v{state.displayVersion}。以下工程和下载均标记所属版本。</p>
      {project.plan?.summary && <p>{project.plan.summary}</p>}
      {project.qc?.visualReview?.notes && <details><summary>查看检查记录</summary><p>{project.qc.visualReview.notes}</p></details>}
      <div className="artifact-links">{state.displayArtifacts.filter((item) => !["video", "preview", "remotion-preview"].includes(item.kind)).map((item) => <a key={item.name} href={artifactUrl(item.url)}>v{item.version || 1} · {item.kind === "subtitle" ? "字幕" : item.kind === "short" ? "短视频" : "工程文件"} · {item.name} <ArrowRight size={14} /></a>)}</div>
      {(project.artifacts || []).some((item) => item.kind === "remotion-preview") && <details><summary>历史动效试验文件</summary><p>这些文件仅用于旧工程样式试验，不是本页审核的主视频。</p>{(project.artifacts || []).filter((item) => item.kind === "remotion-preview").map((item) => <p key={item.name}><a href={artifactUrl(item.url)}>v{item.version || 1} · {item.name}</a></p>)}</details>}
      {!!project.comments?.length && <details><summary>历史批注（{project.comments.length} 条）</summary>{project.comments.map((item, index) => <p key={index}>{time(item.timeMs)} · {item.text}</p>)}<button type="button" className="secondary-button" disabled={disabled} onClick={() => setDraft(project.comments?.map((item) => `${time(item.timeMs)}：${item.text}`).join("\n") || "")}>载入修改框，由我检查后发送</button></details>}
      <details><summary>最近制作活动</summary>{project.editor?.activity?.map((item, index) => <p key={index}>{item.tool || item.message}</p>)}</details>
      {extraDetails}
    </details>
    <button type="button" className="text-button review-new-project" disabled={busy || state.working || dirty} onClick={onNew}><RotateCcw size={16} /> 制作下一条视频</button>
  </section>;
}
