import { useEffect, useRef, useState } from "react";
import type { GuidedSession, OutlineProposalScene } from "@nova-novel/shared";
import { ArrowLeft, ArrowRight, Check, CircleAlert, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

interface GuidedOutlineDialogProps {
  projectId: string;
  session?: GuidedSession;
  aiReady: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}

const STEP_LABELS = ["目标", "阻碍", "结果", "大纲"];

export function GuidedOutlineDialog({ projectId, session, aiReady, onChanged, onClose, onOpenSettings }: GuidedOutlineDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [custom, setCustom] = useState("");
  const [draft, setDraft] = useState<OutlineProposalScene[]>([]);
  const [adoptIds, setAdoptIds] = useState<Set<string>>(new Set());
  const dirtyProposal = useRef(false);
  const pending = session?.pending;

  useEffect(() => { setSelected(""); setCustom(""); setError(""); dirtyProposal.current = false; }, [session?.sessionId, pending?.stepId]);
  useEffect(() => { if (session?.proposal && !dirtyProposal.current) { setDraft(structuredClone(session.proposal)); setAdoptIds(new Set(session.proposal.map(scene => scene.proposalId))); } }, [session?.proposal]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "这一步尚未完成，请重试"); await onChanged().catch(() => undefined); }
    finally { setBusy(false); }
  };
  const start = () => run(() => api.createGuide(projectId));
  const answer = (skip = false) => {
    if (!session) return;
    const input = skip ? { skip: true } : custom.trim() ? { custom: custom.trim() } : { optionId: selected };
    if (!skip && !custom.trim() && !selected) { setError("请先选择一个方向，或填写自己的回答。"); return; }
    void run(() => api.answerGuide(session.sessionId, input));
  };
  const updateScene = (index: number, key: keyof OutlineProposalScene, value: string) => {
    dirtyProposal.current = true;
    setDraft(current => current.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, [key]: value } : scene));
  };
  const saveProposal = () => { if (session) void run(async () => { await api.updateGuideProposal(session.sessionId, draft); dirtyProposal.current = false; }); };
  const applyProposal = () => {
    if (!session) return;
    void run(async () => { await api.updateGuideProposal(session.sessionId, draft); dirtyProposal.current = false; await api.applyGuide(session.sessionId, [...adoptIds]); });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="guided-outline-dialog" role="dialog" aria-modal="true" aria-label="交互式大纲" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow">GUIDED OUTLINE · 每一步都由你决定</p><h2>一起想出一组三场景大纲</h2><p>AI 每次只问一个问题。你可以选择、自己回答、跳过或返回；只有最后点击采用，内容才会进入作品。</p></div>
          <button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭并保留进度"><X size={17} /></button>
        </header>
        <div className="guide-progress" aria-label="大纲引导进度">{STEP_LABELS.map((label, index) => <span key={label} className={session && index < session.stepIndex ? "done" : session && index === session.stepIndex ? "current" : ""}>{index + 1}. {label}</span>)}</div>

        <div className="guided-outline-body">
          {!session && !aiReady && <div className="guide-empty"><Sparkles size={25} /><h3>交互式大纲需要模型</h3><p>先接入一个模型服务。已有作品、正文和版本功能不受影响。</p><button className="button primary" onClick={onOpenSettings}>去接入模型<ArrowRight size={14} /></button></div>}
          {!session && aiReady && <div className="guide-empty"><Sparkles size={25} /><h3>从三个小问题开始</h3><p>先确定人物想做什么，再看阻碍和结果。最后由 AI 提供三场景提案，你逐场检查后才决定是否采用。</p><button className="button primary" disabled={busy} onClick={() => void start()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}开始交互式大纲</button></div>}

          {session?.status === "active" && pending && (
            <div className="guide-question">
              <div className="guide-question-heading"><Badge tone="green">第 {session.stepIndex + 1} 步 · {STEP_LABELS[session.stepIndex]}</Badge><h3>{pending.question}</h3><p>{pending.why}</p></div>
              <div className="guide-options" role="group" aria-label="可选择的回答">
                {pending.options.map((option) => <button key={option.id} className={selected === option.id && !custom.trim() ? "selected" : ""} disabled={busy || Boolean(custom.trim())} onClick={() => setSelected(option.id)}><span>{selected === option.id && !custom.trim() ? <Check size={14} /> : null}</span><strong>{option.label}</strong><small>{option.detail}</small></button>)}
              </div>
              {pending.allowCustom && <label className="field-label">或者，我自己回答<textarea value={custom} disabled={busy} onChange={(event) => setCustom(event.target.value)} rows={3} placeholder="不必完整，写下你现在确定的一点就可以……" /></label>}
              <div className="guide-answer-actions">
                <button className="button ghost" disabled={busy || session.stepIndex === 0} onClick={() => void run(() => api.backGuide(session.sessionId))}><ArrowLeft size={14} />上一步</button>
                {pending.allowSkip && <button className="button ghost" disabled={busy} onClick={() => answer(true)}>暂时跳过</button>}
                <button className="button primary" disabled={busy || (!selected && !custom.trim())} onClick={() => answer(false)}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}保存回答，继续</button>
              </div>
            </div>
          )}

          {session?.status === "active" && !pending && <div className="guide-empty"><RotateCcw size={24} /><h3>下一题还没有生成</h3><p>回答已经保存。可以重新请求当前步骤，不会丢失之前的答案。</p><button className="button primary" disabled={busy} onClick={() => void run(() => api.nextGuide(session.sessionId))}>{busy ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}继续当前步骤</button></div>}

          {session?.status === "ready" && session.proposal && (
            <div className="guide-proposal">
              <div className="guide-proposal-heading"><Badge tone="green">提案已就绪</Badge><h3>这三场只是建议，还没有进入作品。</h3><p>将新增 {adoptIds.size} 个场景，不修改已有正文或场景；未选提案只保留在本次会话。</p></div>
              <div className="guide-proposal-scenes">{draft.map((scene, index) => <article key={scene.proposalId} className={adoptIds.has(scene.proposalId) ? "" : "not-adopted"}><span>0{index + 1}</span><label className="proposal-adopt-toggle"><input type="checkbox" aria-label={`采用第 ${index + 1} 场`} checked={adoptIds.has(scene.proposalId)} disabled={busy} onChange={() => setAdoptIds(current => { const next = new Set(current); if (next.has(scene.proposalId)) next.delete(scene.proposalId); else next.add(scene.proposalId); return next; })} />加入作品</label><input className="proposal-scene-title" aria-label={`第 ${index + 1} 场标题`} value={scene.title} disabled={busy} onChange={event => updateScene(index, "title", event.target.value)} /><label>目标<textarea aria-label={`第 ${index + 1} 场目标`} value={scene.goal} disabled={busy} onChange={event => updateScene(index, "goal", event.target.value)} rows={3} /></label><label>阻碍<textarea aria-label={`第 ${index + 1} 场阻碍`} value={scene.conflict} disabled={busy} onChange={event => updateScene(index, "conflict", event.target.value)} rows={3} /></label><label>结果 / 变化<textarea aria-label={`第 ${index + 1} 场结果`} value={scene.summary} disabled={busy} onChange={event => updateScene(index, "summary", event.target.value)} rows={3} /></label></article>)}</div>
              <div className="guide-answer-actions"><button className="button ghost" disabled={busy} onClick={() => void run(() => api.backGuide(session.sessionId))}><ArrowLeft size={14} />修改上一个回答</button><button className="button secondary" disabled={busy} onClick={saveProposal}>保存提案修改</button><button className="button primary" disabled={busy || adoptIds.size === 0} onClick={applyProposal}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}采用 {adoptIds.size} 个场景</button></div>
            </div>
          )}

          {session?.status === "applied" && <div className="guide-empty"><Check size={26} /><h3>{session.appliedProposalIds?.length ?? 3} 个场景已经加入作品</h3><p>新场景仍以“拟发生”计划存在，正文由你继续决定。可以打开故事画布查看，或开始新的交互式大纲。</p><div className="guide-complete-actions"><button className="button ghost" disabled={busy} onClick={() => void start()}>再生成一组</button><button className="button primary" onClick={onClose}>查看作品<ArrowRight size={14} /></button></div></div>}
          {error && <p className="inline-note error" role="alert"><CircleAlert size={14} />{error}</p>}
        </div>
        <footer><p><ShieldCheck size={13} />关闭会保留进度。Agent 只能读取资料并提出建议，不能直接写入大纲。</p>{session && session.status !== "applied" && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm("放弃这次交互式大纲？已产生的场景提案不会加入作品。")) void run(async () => { await api.cancelGuide(session.sessionId); onClose(); }); }}>放弃本次</button>}</footer>
      </section>
    </div>
  );
}
