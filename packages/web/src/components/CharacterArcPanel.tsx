import { useState } from "react";
import type { CharacterArcProfile, Entity, Scene, WorldEvent, WorkspaceSnapshot } from "@nova-novel/shared";
import { ArrowRight, Check, Clock3, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

export function CharacterArcPanel({ snapshot, entity, events, onOpenScene, onChanged }: { snapshot: WorkspaceSnapshot; entity: Entity; events: WorldEvent[]; onOpenScene: (id: string) => void; onChanged: () => Promise<unknown> }) {
  const stored = snapshot.characterArcs.find(arc => arc.entityId === entity.entityId);
  const [motivation, setMotivation] = useState(stored?.motivation ?? "");
  const [goal, setGoal] = useState(stored?.goal ?? "");
  const [conflict, setConflict] = useState(stored?.conflict ?? "");
  const [epiphany, setEpiphany] = useState(stored?.epiphany ?? "");
  const [notes, setNotes] = useState(stored?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { await api.saveCharacterArc(entity.entityId, { motivation, goal, conflict, epiphany, notes }); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "弧线保存失败"); }
    finally { setBusy(false); }
  };
  return (
    <section className="character-arc-panel">
      <div className="character-arc-heading"><div><p className="eyebrow">CHARACTER ARC · 拟定计划</p><h3><UserRound size={18} />{entity.name} 的人物弧线</h3><p>抽象欲望、具体目标、阻碍与预期变化。它们不是自动成立的世界事实。</p></div><Badge tone="amber">可修改的计划</Badge></div>
      <div className="character-arc-grid">
        <label>抽象欲望（他真正想要什么）<textarea aria-label="人物抽象欲望" rows={2} value={motivation} onChange={event => setMotivation(event.target.value)} placeholder="例如：想被父亲认可，而不是只想守住修鞋铺" /></label>
        <label>具体目标（现在想完成什么）<textarea aria-label="人物具体目标" rows={2} value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：关店前结清最后一笔旧账" /></label>
        <label>核心阻碍（为什么难以做到）<textarea aria-label="人物核心阻碍" rows={2} value={conflict} onChange={event => setConflict(event.target.value)} placeholder="例如：害怕承认父亲也有未完成的事" /></label>
        <label>预期变化（他可能学会什么）<textarea aria-label="人物预期变化" rows={2} value={epiphany} onChange={event => setEpiphany(event.target.value)} placeholder="例如：接受有些账不必替父亲继续承担" /></label>
      </div>
      <label className="character-arc-notes">补充笔记<textarea aria-label="人物弧线笔记" rows={2} value={notes} onChange={event => setNotes(event.target.value)} placeholder="暂定，不必现在确定结局" /></label>
      <div className="character-arc-actions"><button className="button primary small" disabled={busy} onClick={() => void save()}><Check size={13} />保存人物弧线</button><span>{epiphany.trim() ? events.length ? "可对照下方事件检查人物是否按预期变化" : "尚未记录实际变化，先写或整理相关场景" : "可以先保留欲望与目标，变化暂不确定"}</span></div>
      {error && <p className="inline-note error">{error}</p>}
      <section className="character-arc-events"><h4><Clock3 size={14} />实际事件对照</h4>{events.length ? events.slice(-5).reverse().map(event => <article key={event.eventId}><Badge tone={event.reviewState === "confirmed" ? "green" : "amber"}>{event.kind}</Badge><div><strong>{event.toValue ?? event.location ?? "状态未知"}</strong><p>{event.fromValue ? `此前：${event.fromValue}` : "此前状态未知"}</p><small>{event.storyTime ?? "时间未知"}</small>{event.sceneId && <button className="text-button" onClick={() => onOpenScene(event.sceneId!)}>{snapshot.scenes.find(scene => scene.sceneId === event.sceneId)?.title ?? "打开来源场景"}<ArrowRight size={12} /></button>}</div></article>) : <p className="quiet-empty">还没有状态事件。人物弧线可以先保持为计划，不必立即证明它。</p>}</section>
    </section>
  );
}
