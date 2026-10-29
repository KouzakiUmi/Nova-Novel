import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthoringEvent, WorkspaceSnapshot } from "@nova-novel/shared";
import { ArrowRight, Download, History, LoaderCircle, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { Badge, EmptyState } from "./UI";

const LABELS: Record<string, string> = {
  "suggestion-open": "打开建议",
  "candidate-presented": "出现候选",
  "candidate-dismiss": "关闭候选",
  "candidate-accept": "采用候选",
  "candidate-revise": "退回修改",
  "candidate-reject": "拒绝候选",
  "review-open": "打开审阅",
  "review-dismiss": "关闭审阅",
  "review-decided": "记录审阅决定",
  "note-promoted": "便签转为场景",
  "scene-structure-saved": "保存结构",
  "scene-plan-saved": "保存场景计划",
};

const DECISION_LABELS: Record<string, string> = { accept: "采用候选", revise: "退回修改", reject: "拒绝候选" };
function eventLabel(event: AuthoringEvent): string {
  if (event.kind === "review-decided" && typeof event.meta?.answer === "string") return DECISION_LABELS[event.meta.answer] ?? "记录审阅决定";
  return LABELS[event.kind] ?? event.kind;
}

export function InteractionReplay({ snapshot, onOpenScene }: { snapshot: WorkspaceSnapshot; onOpenScene: (sceneId: string) => void }) {
  const [events, setEvents] = useState<AuthoringEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState("all");
  const [error, setError] = useState("");
  const requestSeq = useRef(0);
  const load = async () => {
    const projectId = snapshot.activeProject.projectId;
    const seq = ++requestSeq.current;
    setLoading(true); setError("");
    try {
      const result = await api.listInteractions(projectId);
      if (seq === requestSeq.current) setEvents(result.events);
    }
    catch (cause) { if (seq === requestSeq.current) setError(cause instanceof Error ? cause.message : "回放读取失败"); }
    finally { if (seq === requestSeq.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { requestSeq.current += 1; }; }, [snapshot.activeProject.projectId]);
  const visible = useMemo(() => events.filter(event => kind === "all" || event.kind === kind), [events, kind]);
  return (
    <section className="interaction-replay">
      <div className="interaction-replay-heading"><div><p className="eyebrow">PROCESS, NOT JUST OUTCOME</p><h2>过程回放</h2><p>只看操作过程，不把采用率当成写作质量。这里不记录正文或提示词。</p></div><div className="interaction-replay-actions"><select aria-label="筛选交互事件" value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部事件</option>{[...new Set(events.map(event => event.kind))].map(kind => <option key={kind} value={kind}>{LABELS[kind] ?? kind}</option>)}</select><button className="button ghost small" onClick={() => void load()}><RotateCcw size={13} />刷新</button><button className="button ghost small" onClick={() => void api.download(`/api/events/export?projectId=${encodeURIComponent(snapshot.activeProject.projectId)}`, `${snapshot.activeProject.title}-交互回放.json`).catch(cause => setError(cause instanceof Error ? cause.message : "回放导出失败"))}><Download size={13} />导出回放</button></div></div>
      {error && <p className="inline-note error">{error}</p>}
      {loading ? <p className="quiet-empty"><LoaderCircle size={16} className="spin" />正在读取过程记录…</p> : visible.length === 0 ? <EmptyState icon={<History size={26} />} title="还没有过程记录" detail="打开建议、审阅候选或退回修改后，这里会显示事件顺序。" /> : <ol className="interaction-timeline">{visible.map(event => {
        const scene = event.sceneId ? snapshot.scenes.find(item => item.sceneId === event.sceneId) : undefined;
        return <li key={event.seq}><span className="interaction-seq">{String(event.seq).padStart(3, "0")}</span><div className="interaction-event"><div className="interaction-event-heading"><Badge tone={event.actor === "system" ? "violet" : "green"}>{eventLabel(event)}</Badge><time>{new Date(event.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div><p>{scene?.title ?? "作品级操作"}{event.meta?.answer ? ` · ${event.meta.answer}` : ""}</p>{scene && <button className="text-button" onClick={() => onOpenScene(scene.sceneId)}>打开来源场景<ArrowRight size={12} /></button>}</div></li>;
      })}</ol>}
    </section>
  );
}
