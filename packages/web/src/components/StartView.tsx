import { useMemo, useState } from "react";
import type { GenerationRequest, IdeaCard, SelectionAction, WorkspaceSnapshot } from "@nova-novel/shared";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  GitCompareArrows,
  Lightbulb,
  Lock,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Sparkles,
  Unlock,
  WandSparkles,
  X,
} from "lucide-react";
import { Badge } from "./UI";
import { CreationFlow } from "./CreationFlow";
import { NewProjectDialog, type NewProjectInput } from "./NewProjectDialog";

interface StartViewProps {
  snapshot: WorkspaceSnapshot;
  busy: boolean;
  aiReady: boolean;
  onGenerate: (input: string) => Promise<void>;
  onGenerateExamples: () => Promise<void>;
  onCreateProject: (input: NewProjectInput) => Promise<boolean>;
  onOpenSettings: () => void;
  onSelection: (action: SelectionAction) => Promise<void>;
  onAdopt: () => Promise<void>;
  onDirectWrite: () => void;
  onOpenGuide: () => void;
  onRehearse: (request: GenerationRequest) => Promise<string>;
}

export function StartView({ snapshot, busy, aiReady, onGenerate, onGenerateExamples, onCreateProject, onOpenSettings, onSelection, onAdopt, onDirectWrite, onOpenGuide, onRehearse }: StartViewProps) {
  const [input, setInput] = useState(snapshot.activeProject.premise);
  const [creating, setCreating] = useState(false);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [borrowCard, setBorrowCard] = useState<string | null>(null);
  const [rehearsal, setRehearsal] = useState<{ cardId: string; text: string } | null>(null);
  const [hasRehearsed, setHasRehearsed] = useState(false);
  const [rehearsing, setRehearsing] = useState<string | null>(null);
  const [rehearsalError, setRehearsalError] = useState<{ cardId: string; message: string } | null>(null);
  const draft = snapshot.authoringDraft;
  const selected = useMemo(() => new Set(draft.selectedCardRefs.map((ref) => ref.cardId)), [draft.selectedCardRefs]);

  const rehearse = async (card: IdeaCard) => {
    if (!aiReady) {
      setRehearsalError({ cardId: card.cardId, message: "试演需要先接入模型。" });
      return;
    }
    setRehearsing(card.cardId);
    setRehearsalError(null);
    try {
      const text = await onRehearse({
        projectId: snapshot.activeProject.projectId,
        draftId: draft.draftId,
        kind: "rehearsal",
        input: JSON.stringify({ cardId: card.cardId, cardRevision: card.cardRevision, fields: card.proposedFields, intent: input }),
        idempotencyKey: crypto.randomUUID(),
      });
      setRehearsal({ cardId: card.cardId, text });
      setHasRehearsed(true);
    } catch (cause) {
      setRehearsalError({ cardId: card.cardId, message: cause instanceof Error ? cause.message : "试演未完成" });
    } finally {
      setRehearsing(null);
    }
  };

  /** 换一组时把已选与锁定的方向一并告诉模型，只替换其余卡片。 */
  const withKept = () => {
    const kept = [
      ...draft.lockedDecisions.map((lock) => lock.text),
      ...draft.cards.filter((card) => selected.has(card.cardId)).map((card) => card.proposedFields.action),
    ];
    return kept.length ? `${input}\n保留这些已选或锁定的方向，只替换其余卡片：${kept.join("；")}` : input;
  };

  return (
    <div className="start-view page-scroll">
      <CreationFlow hasCards={draft.cards.length > 0} hasSelection={draft.selectedCardRefs.length > 0} hasRehearsal={hasRehearsed} />
      <section className="start-hero">
        <div className="hero-index"><span>01</span><i /><span>一个点子的开始</span></div>
        <div className="start-projectbar"><span>当前作品 · {snapshot.activeProject.title}</span><button className="button secondary small" onClick={() => setCreating(true)}><Plus size={14} />新建自己的作品</button></div>
        <p className="eyebrow">A QUIET PLACE FOR LOUD IDEAS</p>
        <h1>让第一句话，<br />长成<span>第一场戏。</span></h1>
        <p className="start-lead">不用先想好整个世界。留下一个画面、一个人，<br className="desktop-only" />或者一句让你放不下的话，我们一起找到下一步。</p>
        <div className="idea-composer">
          <label htmlFor="idea-input">第 1 步 · 留下一个起点</label>
          <textarea id="idea-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="一句话、一个人物，或者一个画面……" rows={3} />
          <div className="composer-bottom">
            <span><Lightbulb size={14} />不用完整，不确定的地方可以留空</span>
            <span>{input.length} 字</span>
          </div>
        </div>
        <div className="start-actions">
          <button className="button primary large" disabled={busy} onClick={() => void (aiReady && !input.trim() ? onGenerateExamples() : onGenerate(input))}><WandSparkles size={17} />{aiReady && input.trim() ? "围绕这个点子找方向" : "先看三个示例方向"}<ArrowUpRight size={16} /></button>
          {!aiReady && <button className="button secondary large" onClick={onOpenSettings}>接入模型，按我的点子生成<ArrowRight size={16} /></button>}
          <button className="text-button" onClick={onDirectWrite}><PenLine size={15} />在当前作品直接写</button>
          <button className="text-button" onClick={onOpenGuide}><Sparkles size={15} />AI 逐步带我列大纲</button>
        </div>
      </section>

      <section className="idea-table" aria-label="点子卡片桌">
        <div className="section-heading">
          <div><p className="eyebrow">YOUR OPENING, YOUR CHOICE</p><h2>第 2 步 · 确定想写的方向。</h2><p>AI 提供候选，你来选择、借用或改写；不预选“最佳答案”。</p></div>
          <div className="history-actions"><button className="button ghost small" disabled={draft.undoDepth === 0 || busy} onClick={() => void onSelection({ type: "undo" })}><RotateCcw size={14} />撤销</button><span>选择草稿 · v{draft.selectionVersion}</span></div>
        </div>

        {draft.cards.length === 0 ? (
          <div className="idea-empty"><Sparkles size={25} /><h3>卡片桌还空着</h3><p>从上面的点子生成三张短卡。它们只是候选，不会改写你的故事。</p><button className="button secondary" disabled={busy} onClick={() => void onGenerate(input)}>看看三个不同的方向</button></div>
        ) : (
          <div className="idea-grid">
            {draft.cards.map((card, index) => {
              const isSelected = selected.has(card.cardId);
              const activeLock = draft.lockedDecisions.find((lock) => lock.card.cardId === card.cardId);
              const isLocked = Boolean(activeLock);
              return (
                <article key={`${card.cardId}:${card.cardRevision}`} className={`idea-card ${isSelected ? "selected" : ""}`}>
                  <div className="idea-card-top"><span className="card-number">0{index + 1}</span><Badge tone={card.sourceRef.origin === "author" ? "green" : "neutral"}>{card.sourceRef.origin === "author" ? "你的卡片" : "候选方向"}</Badge>{isLocked && <Lock size={14} className="lock-indicator" aria-label="已保留含义" />}</div>
                  {editingCard === card.cardId ? (
                    <div className="card-editor"><textarea autoFocus value={editText} onChange={(event) => setEditText(event.target.value)} rows={5} /><div><button className="button primary small" onClick={() => { void onSelection({ type: "edit", card: { cardId: card.cardId, cardRevision: card.cardRevision }, fields: { action: editText } }); setEditingCard(null); }}>保存</button><button className="button ghost small" onClick={() => setEditingCard(null)}>取消</button></div></div>
                  ) : <h3>{card.proposedFields.action}</h3>}
                  <div className="idea-detail"><span>值得关注</span><p>{card.proposedFields.focus}</p></div>
                  <div className="idea-detail tradeoff"><span>选择它的取舍</span><p>{card.proposedFields.tradeoff}</p></div>
                  <p className="difference-note"><GitCompareArrows size={13} />{card.differenceNote}</p>
                  <button className={`select-card ${isSelected ? "is-selected" : ""}`} disabled={busy} onClick={() => void onSelection({ type: "select", card: { cardId: card.cardId, cardRevision: card.cardRevision } })}>{isSelected ? <><Check size={15} />已选入计划</> : <>选择这个方向<ArrowRight size={15} /></>}</button>
                  <div className="card-tools">
                    <button title={isLocked ? "解除含义保留" : "保留这一点"} onClick={() => void onSelection(activeLock ? { type: "unlock", lockId: activeLock.id } : { type: "lock", card: { cardId: card.cardId, cardRevision: card.cardRevision }, field: "action" })}>{isLocked ? <Unlock size={14} /> : <Lock size={14} />}保留</button>
                    <button title="保留已选与锁定内容，只换未保留的卡片" disabled={busy || !aiReady} onClick={() => void onGenerate(withKept())}><RotateCcw size={14} />只换</button>
                    <button title="从另一张卡借用阻碍" onClick={() => setBorrowCard(borrowCard === card.cardId ? null : card.cardId)}><Scissors size={14} />借一点</button>
                    <button title="第 3 步（可选）：看看这个方向写出来怎样" disabled={Boolean(rehearsing)} onClick={() => void rehearse(card)}><Play size={14} />{rehearsing === card.cardId ? "试写中" : "试写"}</button>
                    <button title="我来改" onClick={() => { setEditingCard(card.cardId); setEditText(card.proposedFields.action); }}><PenLine size={14} />改写</button>
                    <button className="card-dismiss" title="这次不想要" onClick={() => void onSelection({ type: "reject", card: { cardId: card.cardId, cardRevision: card.cardRevision } })}><X size={14} /></button>
                  </div>
                  {borrowCard === card.cardId && (
                    <div className="borrow-menu"><p>借另一张卡的“阻碍”到这张卡</p>{draft.cards.filter((other) => other.cardId !== card.cardId).map((other) => <button key={other.cardId} onClick={() => { void onSelection({ type: "borrow", targetCard: { cardId: card.cardId, cardRevision: card.cardRevision }, sourceCard: { cardId: other.cardId, cardRevision: other.cardRevision }, field: "obstacle" }); setBorrowCard(null); }}><Plus size={13} />{other.proposedFields.obstacle ?? other.proposedFields.tradeoff}</button>)}</div>
                  )}
                  {rehearsalError?.cardId === card.cardId && <p className="inline-note">{rehearsalError.message}{!aiReady && <button className="text-button" onClick={onOpenSettings}>去接入模型</button>}</p>}
                  {rehearsal?.cardId === card.cardId && <div className="rehearsal"><Badge tone="violet">第 3 步 · 试写候选 · 未进入正文</Badge><p>{rehearsal.text}</p><button className="text-button" onClick={() => setRehearsal(null)}>收起</button></div>}
                </article>
              );
            })}
          </div>
        )}

        <div className="selection-footer">
          <div><span className="selection-count">{draft.selectedCardRefs.length.toString().padStart(2, "0")}</span><p><strong>张卡片已选入</strong><small>选定的是计划，不是已经发生的故事事实</small></p></div>
          <button className="button secondary" disabled={busy || draft.cards.length === 0 || !aiReady} title={aiReady ? "保留已选与锁定的方向，换其余卡片" : "接入模型后可按你的点子换方向"} onClick={() => void onGenerate(withKept())}><ArrowLeft size={15} />换一组方向</button>
          <button className="button primary" disabled={busy || draft.selectedCardRefs.length === 0} onClick={() => void onAdopt()}>第 4 步 · 用这个方向写第一场<ArrowUpRight size={16} /></button>
        </div>
      </section>
      {creating && <NewProjectDialog busy={busy} onCancel={() => setCreating(false)} onCreate={onCreateProject} />}
    </div>
  );
}
