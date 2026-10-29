import { useState } from "react";
import type { ArcAssistProposal, ArcDiagnosisReport, ArcDilemmaProposal, Entity, WorldEvent, WorkspaceSnapshot } from "@nova-novel/shared";
import { ArrowRight, BookmarkPlus, Check, Clock3, LoaderCircle, Sparkles, Stethoscope, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

export function CharacterArcPanel({
  snapshot,
  entity,
  events,
  onOpenScene,
  onChanged,
}: {
  snapshot: WorkspaceSnapshot;
  entity: Entity;
  events: WorldEvent[];
  onOpenScene: (id: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const stored = snapshot.characterArcs.find((arc) => arc.entityId === entity.entityId);
  const [motivation, setMotivation] = useState(stored?.motivation ?? "");
  const [goal, setGoal] = useState(stored?.goal ?? "");
  const [conflict, setConflict] = useState(stored?.conflict ?? "");
  const [epiphany, setEpiphany] = useState(stored?.epiphany ?? "");
  const [notes, setNotes] = useState(stored?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [assistBusy, setAssistBusy] = useState<"propose" | "diagnose" | null>(null);
  const [assistPrompt, setAssistPrompt] = useState("");
  const [proposals, setProposals] = useState<ArcAssistProposal[] | null>(null);
  const [diagnosis, setDiagnosis] = useState<ArcDiagnosisReport | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    setStatusMsg("");
    try {
      await api.saveCharacterArc(entity.entityId, { motivation, goal, conflict, epiphany, notes });
      await onChanged();
      setStatusMsg("人物弧线已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "弧线保存失败");
    } finally {
      setBusy(false);
    }
  };

  const runPropose = async () => {
    if (assistBusy) return;
    setAssistBusy("propose");
    setError("");
    setStatusMsg("");
    try {
      const result = await api.assistArc({
        projectId: snapshot.activeProject.projectId,
        entityId: entity.entityId,
        mode: "propose",
        ...(assistPrompt.trim() ? { prompt: assistPrompt.trim() } : {}),
      });
      setProposals(result.proposals ?? []);
      setDiagnosis(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 推演人物弧线失败");
    } finally {
      setAssistBusy(null);
    }
  };

  const runDiagnose = async () => {
    if (assistBusy) return;
    setAssistBusy("diagnose");
    setError("");
    setStatusMsg("");
    try {
      const result = await api.assistArc({
        projectId: snapshot.activeProject.projectId,
        entityId: entity.entityId,
        mode: "diagnose",
        ...(assistPrompt.trim() ? { prompt: assistPrompt.trim() } : {}),
      });
      setDiagnosis(result.diagnosis ?? null);
      setProposals(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 对照实际剧情诊断失败");
    } finally {
      setAssistBusy(null);
    }
  };

  const applyProposal = async (prop: ArcAssistProposal) => {
    setMotivation(prop.motivation);
    setGoal(prop.goal);
    setConflict(prop.conflict);
    setEpiphany(prop.epiphany);
    setNotes(prop.notes);
    setBusy(true);
    setError("");
    try {
      await api.saveCharacterArc(entity.entityId, {
        motivation: prop.motivation,
        goal: prop.goal,
        conflict: prop.conflict,
        epiphany: prop.epiphany,
        notes: prop.notes,
      });
      await onChanged();
      setStatusMsg(`已应用并保存「${prop.label}」`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存人物弧线失败");
    } finally {
      setBusy(false);
    }
  };

  const saveDilemmaAsNote = async (dilemma: ArcDilemmaProposal) => {
    setBusy(true);
    setError("");
    try {
      await api.createNote({
        projectId: snapshot.activeProject.projectId,
        title: `${entity.name}的两难：${dilemma.title}`,
        body: `冲突：${dilemma.conflict}\n抉择 A：${dilemma.choiceA}\n抉择 B：${dilemma.choiceB}`,
        elementId: entity.entityId,
        tags: ["弧线诊断", entity.name],
      });
      await onChanged();
      setStatusMsg(`已将「${dilemma.title}」存入便签盒`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存便签失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="character-arc-panel">
      <div className="character-arc-heading">
        <div>
          <p className="eyebrow">CHARACTER ARC · 拟定计划</p>
          <h3>
            <UserRound size={18} />
            {entity.name} 的人物弧线
          </h3>
          <p>抽象欲望、具体目标、阻碍与预期变化。它们不是自动成立的世界事实。</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge tone="amber">可修改的计划</Badge>
          <button className="button ghost small" disabled={busy || assistBusy !== null} onClick={() => void runPropose()}>
            {assistBusy === "propose" ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
            AI 推演弧线
          </button>
          <button className="button ghost small" disabled={busy || assistBusy !== null} onClick={() => void runDiagnose()}>
            {assistBusy === "diagnose" ? <LoaderCircle size={13} className="spin" /> : <Stethoscope size={13} />}
            对照实际剧情诊断
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <input
          aria-label="人物弧线AI补充要求"
          value={assistPrompt}
          onChange={(event) => setAssistPrompt(event.target.value)}
          placeholder="可选：补充你想尝试的人物变化方向或当前卡壳点，再点上方 AI 按钮"
        />
      </div>

      {proposals && proposals.length > 0 && (
        <div className="note-composer" style={{ marginBottom: 14 }} aria-label="AI人物弧线推演方案">
          <div className="note-composer-heading">
            <Sparkles size={16} />
            <div>
              <strong>AI 人物弧线方案（共 {proposals.length} 套）</strong>
              <p>可一键填入并保存，也可以只借用其中某一项。</p>
            </div>
            <button className="button ghost small" onClick={() => setProposals(null)}>
              收起
            </button>
          </div>
          <div className="fact-grid">
            {proposals.map((prop) => (
              <div key={prop.proposalId} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>{prop.label}</strong>
                  <Badge tone="amber">{prop.differenceNote}</Badge>
                </div>
                <small>
                  <b>抽象欲望：</b>
                  {prop.motivation}
                </small>
                <small>
                  <b>具体目标：</b>
                  {prop.goal}
                </small>
                <small>
                  <b>核心阻碍：</b>
                  {prop.conflict}
                </small>
                <small>
                  <b>预期变化：</b>
                  {prop.epiphany}
                </small>
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  <button className="button primary small" disabled={busy} onClick={() => void applyProposal(prop)}>
                    <Check size={12} />
                    采用整套弧线
                  </button>
                  <button className="button ghost small" onClick={() => setConflict(prop.conflict)}>
                    只借用阻碍
                  </button>
                  <button className="button ghost small" onClick={() => setEpiphany(prop.epiphany)}>
                    只借用变化
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {diagnosis && (
        <div className="note-composer" style={{ marginBottom: 14 }} aria-label="AI人物弧线诊断报告">
          <div className="note-composer-heading">
            <Stethoscope size={16} />
            <div>
              <strong>计划与实际事件对照诊断</strong>
              <p>{diagnosis.progressSummary}</p>
            </div>
            <button className="button ghost small" onClick={() => setDiagnosis(null)}>
              收起
            </button>
          </div>
          {diagnosis.unfulfilledConflicts.length > 0 && (
            <div>
              <small style={{ fontWeight: 600 }}>尚未在正文中充分兑现的矛盾：</small>
              <ul style={{ margin: "4px 0 8px 18px", fontSize: 13 }}>
                {diagnosis.unfulfilledConflicts.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {diagnosis.nextDilemmaProposals.length > 0 && (
            <div className="fact-grid">
              {diagnosis.nextDilemmaProposals.map((dilemma, idx) => (
                <div key={idx} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <strong>下一步两难：{dilemma.title}</strong>
                  <small>{dilemma.conflict}</small>
                  <small>· 抉择 A：{dilemma.choiceA}</small>
                  <small>· 抉择 B：{dilemma.choiceB}</small>
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <button className="button ghost small" disabled={busy} onClick={() => void saveDilemmaAsNote(dilemma)}>
                      <BookmarkPlus size={12} />
                      存为创作便签
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="character-arc-grid">
        <label>
          抽象欲望（他真正想要什么）
          <textarea
            aria-label="人物抽象欲望"
            rows={2}
            value={motivation}
            onChange={(event) => setMotivation(event.target.value)}
            placeholder="例如：想被父亲认可，而不是只想守住修鞋铺"
          />
        </label>
        <label>
          具体目标（现在想完成什么）
          <textarea
            aria-label="人物具体目标"
            rows={2}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：关店前结清最后一笔旧账"
          />
        </label>
        <label>
          核心阻碍（为什么难以做到）
          <textarea
            aria-label="人物核心阻碍"
            rows={2}
            value={conflict}
            onChange={(event) => setConflict(event.target.value)}
            placeholder="例如：害怕承认父亲也有未完成的事"
          />
        </label>
        <label>
          预期变化（他可能学会什么）
          <textarea
            aria-label="人物预期变化"
            rows={2}
            value={epiphany}
            onChange={(event) => setEpiphany(event.target.value)}
            placeholder="例如：接受有些账不必替父亲继续承担"
          />
        </label>
      </div>
      <label className="character-arc-notes">
        补充笔记
        <textarea
          aria-label="人物弧线笔记"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="暂定，不必现在确定结局"
        />
      </label>
      <div className="character-arc-actions">
        <button className="button primary small" disabled={busy} onClick={() => void save()}>
          <Check size={13} />
          保存人物弧线
        </button>
        <span>
          {epiphany.trim()
            ? events.length
              ? "可对照下方事件检查人物是否按预期变化"
              : "尚未记录实际变化，先写或整理相关场景"
            : "可以先保留欲望与目标，变化暂不确定"}
        </span>
      </div>
      {statusMsg && (
        <p className="inline-note" role="status">
          <Check size={13} />
          {statusMsg}
        </p>
      )}
      {error && <p className="inline-note error">{error}</p>}
      <section className="character-arc-events">
        <h4>
          <Clock3 size={14} />
          实际事件对照
        </h4>
        {events.length ? (
          events
            .slice(-5)
            .reverse()
            .map((event) => (
              <article key={event.eventId}>
                <Badge tone={event.reviewState === "confirmed" ? "green" : "amber"}>{event.kind}</Badge>
                <div>
                  <strong>{event.toValue ?? event.location ?? "状态未知"}</strong>
                  <p>{event.fromValue ? `此前：${event.fromValue}` : "此前状态未知"}</p>
                  <small>{event.storyTime ?? "时间未知"}</small>
                  {event.sceneId && (
                    <button className="text-button" onClick={() => onOpenScene(event.sceneId!)}>
                      {snapshot.scenes.find((scene) => scene.sceneId === event.sceneId)?.title ?? "打开来源场景"}
                      <ArrowRight size={12} />
                    </button>
                  )}
                </div>
              </article>
            ))
        ) : (
          <p className="quiet-empty">还没有状态事件。人物弧线可以先保持为计划，不必立即证明它。</p>
        )}
      </section>
    </section>
  );
}
