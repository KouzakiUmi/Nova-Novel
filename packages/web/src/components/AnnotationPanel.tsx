import { useMemo, useState } from "react";
import type { SceneAnnotation, Scene, WorkspaceSnapshot } from "@nova-novel/shared";
import { Check, CircleAlert, MessageSquareText, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

export interface AnnotationDraftRange { from: number; to: number; baseText: string; textHash: string }

export function AnnotationPanel({ snapshot, scene, body, draftRange, onClearDraft, onChanged }: { snapshot: WorkspaceSnapshot; scene: Scene; body: string; draftRange?: AnnotationDraftRange; onClearDraft: () => void; onChanged: () => Promise<unknown> }) {
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const [kind, setKind] = useState<SceneAnnotation["kind"]>("comment");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [error, setError] = useState("");
  const annotations = useMemo(() => snapshot.annotations.filter(annotation => annotation.sceneId === scene.sceneId && (filter === "all" || annotation.status === filter)), [snapshot.annotations, scene.sceneId, filter]);
  const create = async () => {
    if (!text.trim()) { setError("先写一句批注，再保存。"); return; }
    setBusy(true); setError("");
    try {
      await api.createAnnotation({ projectId: scene.projectId, sceneId: scene.sceneId, kind, body: text.trim(), ...(draftRange ? { range: draftRange } : {}) });
      setText(""); setComposerOpen(false); onClearDraft(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "批注保存失败"); }
    finally { setBusy(false); }
  };
  const update = async (annotation: SceneAnnotation, status: SceneAnnotation["status"]) => {
    setBusy(true);
    try { await api.updateAnnotation(annotation.annotationId, { status }); await onChanged(); }
    finally { setBusy(false); }
  };
  return (
    <div className="side-panel-content annotation-panel">
      <p className="eyebrow">DISCUSS WITHOUT REWRITING</p>
      <div className="annotation-heading"><h3>正文批注</h3><select aria-label="筛选批注" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="open">待处理</option><option value="resolved">已解决</option><option value="all">全部</option></select></div>
      <p className="panel-description">批注只用于讨论和整理，不直接改正文。原文变化时保留批注并标记锚点。</p>
      {!composerOpen && !draftRange && <button className="button ghost full" onClick={() => setComposerOpen(true)}><MessageSquareText size={14} />记录整场想法</button>}
      {(composerOpen || draftRange) && <section className="annotation-composer">{draftRange && <><Badge tone="green">已选 {draftRange.baseText.length} 字</Badge><blockquote>{draftRange.baseText}</blockquote></>}<select aria-label="批注类型" value={kind} onChange={event => setKind(event.target.value as SceneAnnotation["kind"])}><option value="comment">评论</option><option value="question">疑问</option><option value="todo">待办</option></select><textarea aria-label="批注内容" rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="例如：这里父亲的反应需要再想一下，不要急着解释原因。" /><div className="annotation-composer-actions"><button className="text-button" onClick={() => { setComposerOpen(false); onClearDraft(); }}>取消</button><button className="button primary small" disabled={busy} onClick={() => void create()}>保存批注</button></div></section>}
      {error && <p className="inline-note error">{error}</p>}
      {annotations.length === 0 ? <p className="quiet-empty">还没有批注。选中一段文字后点“批注”，或先记录整场的想法。</p> : <div className="annotation-list">{annotations.map(annotation => {
        const stale = annotation.range && body.slice(annotation.range.from, annotation.range.to) !== annotation.range.baseText;
        return <article className="annotation-card" key={annotation.annotationId}><div className="annotation-card-heading"><Badge tone={annotation.status === "resolved" ? "green" : annotation.kind === "todo" ? "amber" : "violet"}>{annotation.kind === "question" ? "疑问" : annotation.kind === "todo" ? "待办" : "评论"}</Badge><span>{annotation.status === "resolved" ? "已解决" : "待处理"}</span></div>{annotation.range && <blockquote className={stale ? "stale" : ""}>{annotation.range.baseText}</blockquote>}{stale && <p className="annotation-stale"><CircleAlert size={12} />原文已变化，请重新确认这段批注。</p>}<p className="annotation-body">{annotation.body}</p><button className="text-button" disabled={busy} onClick={() => void update(annotation, annotation.status === "open" ? "resolved" : "open")}>{annotation.status === "open" ? <><Check size={13} />标为解决</> : <><RotateCcw size={13} />重新打开</>}</button></article>;
      })}</div>}
    </div>
  );
}
