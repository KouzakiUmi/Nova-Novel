import { useMemo, useState } from "react";
import type { ElementDesignCard, ElementGuideSession, Entity, Evidence, FactAssertion, Scene, WorkspaceSnapshot, WorldEvent } from "@nova-novel/shared";
import { ArrowLeft, ArrowRight, Box, Check, CheckCircle2, ChevronDown, Clock3, Compass, FileText, History, KeyRound, LoaderCircle, MapPin, Network, PenLine, Plus, Search, Shield, Sparkles, UserRound } from "lucide-react";
import { Badge, EmptyState } from "./UI";
import { CharacterArcPanel } from "./CharacterArcPanel";
import { api } from "../lib/api";

const typeNames: Record<Entity["type"], string> = {
  character: "角色",
  item: "物品",
  location: "地点",
  organization: "组织",
  ability: "能力",
  rule: "规则",
  event: "事件",
  secret: "秘密",
  custom: "自定义",
};
const creatableTypes = ["character", "item", "location", "rule", "organization", "secret"] as const;
const semanticTypeLabels: Record<FactAssertion["semanticType"], string> = {
  world_fact: "世界事实",
  belief: "角色信念",
  rumor: "传闻",
  deception: "假象/欺瞒",
  plan: "计划",
  hypothesis: "推测",
};

export function ElementsView({
  snapshot,
  selectedElementId,
  onSelect,
  onOpenScene,
  onChanged,
}: {
  snapshot: WorkspaceSnapshot;
  selectedElementId: string;
  onSelect: (id: string) => void;
  onOpenScene: (id: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [filter, setFilter] = useState<"all" | Entity["type"]>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"overview" | "relations" | "timeline" | "evidence" | "history">("overview");
  const [timeSceneId, setTimeSceneId] = useState(snapshot.scenes.at(-1)?.sceneId ?? "");
  const [composerOpen, setComposerOpen] = useState(false);
  const [newType, setNewType] = useState<Entity["type"]>("character");
  const [newName, setNewName] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [newAliases, setNewAliases] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editAliases, setEditAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  // AI 设定共创状态（支持快速卡片共创 & 一步步引导我）
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<"fast" | "guided">("fast");
  const [aiType, setAiType] = useState<Entity["type"]>("character");
  const [aiTargetEntityId, setAiTargetEntityId] = useState<string>("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiRoleHint, setAiRoleHint] = useState("");
  const [aiRelatedIds, setAiRelatedIds] = useState<string[]>([]);
  const [aiCards, setAiCards] = useState<ElementDesignCard[]>([]);
  const [aiArtifactId, setAiArtifactId] = useState("");
  const [selectedCardIdx, setSelectedCardIdx] = useState(0);
  const [guideSession, setGuideSession] = useState<ElementGuideSession | undefined>(snapshot.elementGuide);
  const [guideCustomAnswer, setGuideCustomAnswer] = useState("");

  // 手动添加事实、秘密知情区间与事件状态
  const [factPredicate, setFactPredicate] = useState("");
  const [factValue, setFactValue] = useState("");
  const [factEntityId, setFactEntityId] = useState("");
  const [factSemantic, setFactSemantic] = useState<FactAssertion["semanticType"]>("world_fact");
  const [eventKind, setEventKind] = useState("status.change");
  const [eventFrom, setEventFrom] = useState("");
  const [eventTo, setEventTo] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [eventSceneId, setEventSceneId] = useState("");

  const elements = useMemo(
    () =>
      snapshot.elements.filter(
        (entity) =>
          (filter === "all" || entity.type === filter) &&
          `${entity.name}${entity.aliases.join("")}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [snapshot.elements, filter, query],
  );
  const selected = snapshot.elements.find((entity) => entity.entityId === selectedElementId) ?? elements[0];
  const facts = selected
    ? snapshot.facts.filter(
        (fact) =>
          fact.subjectId === selected.entityId ||
          (typeof fact.value === "object" && fact.value !== null && fact.value.entityId === selected.entityId),
      )
    : [];
  const events = selected
    ? snapshot.events.filter((event) => event.subjectId === selected.entityId).sort((a, b) => a.storyOrder - b.storyOrder)
    : [];
  const evidenceIds = new Set([...facts.flatMap((fact) => fact.evidenceIds), ...events.flatMap((event) => event.evidenceIds)]);
  const evidence = snapshot.evidence.filter((item) => evidenceIds.has(item.evidenceId));
  const timeScene = snapshot.scenes.find((scene) => scene.sceneId === timeSceneId);

  const createElement = async () => {
    if (busy || !newName.trim()) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const aliases = newAliases
        .split(/[,，、]/)
        .map((alias) => alias.trim())
        .filter(Boolean);
      const created = await api.createElement({
        projectId: snapshot.activeProject.projectId,
        type: newType,
        name: newName.trim(),
        summary: newSummary.trim(),
        ...(aliases.length ? { aliases } : {}),
      });
      await onChanged();
      onSelect(created.entity.entityId);
      setComposerOpen(false);
      setNewName("");
      setNewSummary("");
      setNewAliases("");
      setNewType("character");
      setNote(`已记下${typeNames[created.entity.type]}「${created.entity.name}」`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "元素尚未保存，请重试");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = () => {
    if (!selected) return;
    setEditName(selected.name);
    setEditSummary(selected.summary);
    setEditAliases(selected.aliases.join("、"));
    setEditOpen(true);
    setError("");
    setNote("");
  };

  const saveEdit = async () => {
    if (!selected || busy || !editName.trim()) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api.updateElement(selected.entityId, {
        projectId: snapshot.activeProject.projectId,
        name: editName.trim(),
        summary: editSummary.trim(),
        // 全量同步：不在列表中的旧别名会被服务端删除。
        aliases: editAliases
          .split(/[,，、]/)
          .map((alias) => alias.trim())
          .filter(Boolean),
      });
      await onChanged();
      setEditOpen(false);
      setNote("元素已更新");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "元素尚未保存，请重试");
    } finally {
      setBusy(false);
    }
  };

  const openAiCoCreate = (forEntity?: Entity) => {
    setAiOpen(true);
    setError("");
    setNote("");
    if (forEntity) {
      setAiType(forEntity.type);
      setAiTargetEntityId(forEntity.entityId);
      setAiPrompt(forEntity.summary || `展开并深化「${forEntity.name}」的设定`);
    } else {
      setAiTargetEntityId("");
      setAiPrompt("");
    }
  };

  const runFastElementDesign = async () => {
    if (busy || !aiPrompt.trim()) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const result = await api.elementDesign({
        projectId: snapshot.activeProject.projectId,
        type: aiType,
        ...(aiTargetEntityId ? { targetEntityId: aiTargetEntityId } : {}),
        prompt: aiPrompt.trim(),
        ...(aiRoleHint.trim() ? { roleHint: aiRoleHint.trim() } : {}),
        ...(aiRelatedIds.length ? { relatedEntityIds: aiRelatedIds } : {}),
      });
      setAiCards(result.cards);
      setAiArtifactId(result.artifactId);
      setSelectedCardIdx(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 设定共创生成失败");
    } finally {
      setBusy(false);
    }
  };

  const startElementGuide = async (forceNew = false) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const result = await api.createElementGuide({
        projectId: snapshot.activeProject.projectId,
        type: aiType,
        ...(aiTargetEntityId ? { targetEntityId: aiTargetEntityId } : {}),
        ...(aiPrompt.trim() ? { prompt: aiPrompt.trim() } : {}),
        ...(aiRoleHint.trim() ? { roleHint: aiRoleHint.trim() } : {}),
        ...(aiRelatedIds.length ? { relatedEntityIds: aiRelatedIds } : {}),
        forceNew,
      });
      setGuideSession(result.session);
      if (result.session.proposal) {
        setAiCards(result.session.proposal);
        setSelectedCardIdx(0);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "启动一步步设定引导失败");
    } finally {
      setBusy(false);
    }
  };

  const answerElementGuide = async (input: { optionId?: string; custom?: string; skip?: boolean }) => {
    if (!guideSession || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.answerElementGuide(guideSession.sessionId, input);
      setGuideSession(result.session);
      setGuideCustomAnswer("");
      if (result.session.proposal) {
        setAiCards(result.session.proposal);
        setSelectedCardIdx(0);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交引导回答失败");
    } finally {
      setBusy(false);
    }
  };

  const backElementGuide = async () => {
    if (!guideSession || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.backElementGuide(guideSession.sessionId);
      setGuideSession(result.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "返回上一步失败");
    } finally {
      setBusy(false);
    }
  };

  const updateCurrentAiCard = (patch: Partial<ElementDesignCard>) => {
    setAiCards((prev) => prev.map((c, idx) => (idx === selectedCardIdx ? { ...c, ...patch } : c)));
  };

  const borrowSummaryFrom = (sourceCard: ElementDesignCard) => {
    const current = aiCards[selectedCardIdx];
    if (!current) return;
    updateCurrentAiCard({
      summary: `${current.summary}\n${sourceCard.summary}`.trim(),
      proposedFacts: [...current.proposedFacts, ...sourceCard.proposedFacts],
    });
    setNote(`已从「${sourceCard.name}」借用简介与属性提案`);
  };

  const applySelectedAiCard = async () => {
    const card = aiCards[selectedCardIdx];
    if (!card || busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      if (aiMode === "guided" && guideSession && guideSession.status === "ready") {
        const applied = await api.applyElementGuide(guideSession.sessionId, { proposalId: card.proposalId, card });
        setGuideSession(applied.session);
        await onChanged();
        onSelect(applied.entity.entityId);
        setNote(`已采用设定方案「${applied.entity.name}」`);
      } else {
        const applied = await api.applyElementDesign({
          projectId: snapshot.activeProject.projectId,
          card,
          // 每批生成产物唯一：同一 proposalId（如模板兜底的 elem-1）跨批次不会撞幂等键。
          acceptanceId: `elem_design_${aiArtifactId || `legacy_${card.proposalId}`}_${card.proposalId}`,
          ...(aiTargetEntityId ? { targetEntityId: aiTargetEntityId } : {}),
        });
        await onChanged();
        onSelect(applied.entity.entityId);
        setNote(`已采用设定方案「${applied.entity.name}」`);
      }
      setAiOpen(false);
      setAiCards([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "采用设定方案失败");
    } finally {
      setBusy(false);
    }
  };

  const addFactToSelected = async () => {
    if (!selected || busy || !factPredicate.trim() || (!factValue.trim() && !factEntityId)) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api.addElementFact(selected.entityId, {
        projectId: snapshot.activeProject.projectId,
        predicate: factPredicate.trim(),
        ...(factEntityId ? { valueEntityId: factEntityId } : { value: factValue.trim() }),
        semanticType: factSemantic,
      });
      await onChanged();
      setFactPredicate("");
      setFactValue("");
      setFactEntityId("");
      setNote("已添加属性/关系设定");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加属性/关系失败");
    } finally {
      setBusy(false);
    }
  };

  const addEventToSelected = async () => {
    if (!selected || busy || !eventTo.trim()) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api.addElementEvent(selected.entityId, {
        projectId: snapshot.activeProject.projectId,
        kind: eventKind,
        ...(eventSceneId ? { sceneId: eventSceneId } : {}),
        ...(eventTime.trim() ? { storyTime: eventTime.trim() } : {}),
        ...(eventFrom.trim() ? { fromValue: eventFrom.trim() } : {}),
        toValue: eventTo.trim(),
      });
      await onChanged();
      setEventFrom("");
      setEventTo("");
      setNote("已记录状态变化/知情区间事件");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记录事件失败");
    } finally {
      setBusy(false);
    }
  };

  const activeAiCard = aiCards[selectedCardIdx];

  return (
    <div className="elements-page">
      <header className="page-toolbar">
        <div>
          <p className="eyebrow">THE STORY REMEMBERS</p>
          <h1>元素账本</h1>
          <p>不只记住名字，也记住变化发生在什么时候、谁知道。</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="button primary small"
            disabled={busy}
            onClick={() => openAiCoCreate(undefined)}
          >
            <Sparkles size={14} />
            AI 协助设计角色/设定
          </button>
          <div className="world-time-select">
            <Clock3 size={16} />
            <label>
              查看到
              <select value={timeSceneId} onChange={(event) => setTimeSceneId(event.target.value)}>
                {snapshot.scenes.map((scene) => (
                  <option key={scene.sceneId} value={scene.sceneId}>
                    {scene.title} · {scene.storyTime ?? "时间未知"}
                  </option>
                ))}
              </select>
            </label>
            <ChevronDown size={13} />
          </div>
        </div>
      </header>

      {aiOpen && (
        <section className="note-composer" style={{ margin: "0 0 16px 0" }} aria-label="AI角色与世界观共创工作台">
          <div className="note-composer-heading">
            <Sparkles size={18} />
            <div>
              <strong>AI 角色与世界观设定共创</strong>
              <p>支持「快速卡片共创」直出 2–3 套差异化方案卡，或切换「一步步引导我」通过选择题收敛细节。</p>
            </div>
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <button
                className={`button small ${aiMode === "fast" ? "primary" : "ghost"}`}
                onClick={() => setAiMode("fast")}
              >
                <Sparkles size={13} />
                快速卡片共创
              </button>
              <button
                className={`button small ${aiMode === "guided" ? "primary" : "ghost"}`}
                onClick={() => {
                  setAiMode("guided");
                  if (!guideSession || guideSession.status === "cancelled" || guideSession.status === "applied") {
                    void startElementGuide(true);
                  }
                }}
              >
                <Compass size={13} />
                一步步引导我
              </button>
              <button className="button ghost small" onClick={() => setAiOpen(false)}>
                关闭
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <label className="field-label">
              <span>设定类型</span>
              <select
                aria-label="AI设定类型"
                value={aiType}
                disabled={busy}
                onChange={(e) => setAiType(e.target.value as Entity["type"])}
              >
                {creatableTypes.map((type) => (
                  <option key={type} value={type}>
                    {typeNames[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              <span>作用目标</span>
              <select
                aria-label="AI作用目标元素"
                value={aiTargetEntityId}
                disabled={busy}
                onChange={(e) => setAiTargetEntityId(e.target.value)}
              >
                <option value="">新建独立元素</option>
                {snapshot.elements.map((el) => (
                  <option key={el.entityId} value={el.entityId}>
                    深化已有：{el.name}（{typeNames[el.type]}）
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              <span>叙事定位 / 作用提示（可选）</span>
              <input
                aria-label="叙事定位提示"
                value={aiRoleHint}
                disabled={busy}
                onChange={(e) => setAiRoleHint(e.target.value)}
                placeholder="例如：主角的镜像对手 / 关键物证 / 打破禁忌的规则"
              />
            </label>
          </div>

          <label className="field-label">
            <span>一句话种子或灵感要求</span>
            <textarea
              aria-label="AI设定构思描述"
              rows={2}
              value={aiPrompt}
              disabled={busy}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="例如：一个在修鞋铺隔壁守了二十年的老修表匠，知道旧收据的秘密但不想轻易开口……"
            />
          </label>

          {snapshot.elements.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
              <span>关联已有元素：</span>
              {snapshot.elements.slice(0, 8).map((el) => {
                const checked = aiRelatedIds.includes(el.entityId);
                return (
                  <button
                    key={el.entityId}
                    type="button"
                    className={`button small ${checked ? "primary" : "ghost"}`}
                    onClick={() =>
                      setAiRelatedIds((prev) =>
                        checked ? prev.filter((id) => id !== el.entityId) : [...prev, el.entityId],
                      )
                    }
                  >
                    {el.name}
                  </button>
                );
              })}
            </div>
          )}

          {aiMode === "fast" && (
            <div className="note-composer-actions">
              <span>生成 2–3 张可混搭、可局部编辑的设定卡，经确认后写入元素账本</span>
              <button
                className="button primary"
                disabled={busy || !aiPrompt.trim()}
                onClick={() => void runFastElementDesign()}
              >
                {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                生成设定方案卡
              </button>
            </div>
          )}

          {aiMode === "guided" && (
            <div style={{ borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.08))", paddingTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong>
                  多轮问答设定向导
                  {guideSession ? ` · 第 ${guideSession.stepIndex + 1} 步（${guideSession.status}）` : ""}
                </strong>
                <div style={{ display: "flex", gap: 6 }}>
                  {guideSession && guideSession.stepIndex > 0 && (
                    <button className="button ghost small" disabled={busy} onClick={() => void backElementGuide()}>
                      <ArrowLeft size={13} />
                      上一步
                    </button>
                  )}
                  <button className="button ghost small" disabled={busy} onClick={() => void startElementGuide(true)}>
                    重新开始引导
                  </button>
                </div>
              </div>
              {guideSession?.pending && (
                <div className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <strong>{guideSession.pending.question}</strong>
                  <small>{guideSession.pending.why}</small>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
                    {guideSession.pending.options.map((opt) => (
                      <button
                        key={opt.id}
                        className="button ghost"
                        style={{ textAlign: "left", justifyContent: "flex-start", height: "auto", padding: 10 }}
                        disabled={busy}
                        onClick={() => void answerElementGuide({ optionId: opt.id })}
                      >
                        <div>
                          <strong>{opt.label}</strong>
                          <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.85 }}>{opt.detail}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      aria-label="设定引导自定义回答"
                      value={guideCustomAnswer}
                      onChange={(e) => setGuideCustomAnswer(e.target.value)}
                      placeholder="或者填写你自己的想法……"
                    />
                    <button
                      className="button primary small"
                      disabled={busy || !guideCustomAnswer.trim()}
                      onClick={() => void answerElementGuide({ custom: guideCustomAnswer })}
                    >
                      提交自答
                    </button>
                    {guideSession.pending.allowSkip && (
                      <button
                        className="button ghost small"
                        disabled={busy}
                        onClick={() => void answerElementGuide({ skip: true })}
                      >
                        暂时跳过
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {aiCards.length > 0 && activeAiCard && (
            <div style={{ borderTop: "1px solid var(--border-subtle, rgba(0,0,0,0.08))", paddingTop: 12 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                <strong>候选方案卡：</strong>
                {aiCards.map((card, idx) => (
                  <button
                    key={card.proposalId}
                    className={`button small ${idx === selectedCardIdx ? "primary" : "ghost"}`}
                    onClick={() => setSelectedCardIdx(idx)}
                  >
                    方案 {idx + 1}：{card.name}（{card.differenceNote}）
                  </button>
                ))}
              </div>
              <div className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label className="field-label">
                    <span>名称</span>
                    <input
                      aria-label="候选方案名称"
                      value={activeAiCard.name}
                      onChange={(e) => updateCurrentAiCard({ name: e.target.value })}
                    />
                  </label>
                  <label className="field-label">
                    <span>别名（逗号分隔）</span>
                    <input
                      aria-label="候选方案别名"
                      value={activeAiCard.aliases.join("、")}
                      onChange={(e) =>
                        updateCurrentAiCard({
                          aliases: e.target.value
                            .split(/[,，、]/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                </div>
                <label className="field-label">
                  <span>设定简介与细节</span>
                  <textarea
                    aria-label="候选方案简介"
                    rows={3}
                    value={activeAiCard.summary}
                    onChange={(e) => updateCurrentAiCard({ summary: e.target.value })}
                  />
                </label>
                {activeAiCard.proposedFacts.length > 0 && (
                  <div>
                    <small style={{ fontWeight: 600 }}>随卡附带的属性/关系提案（采用后同步入库）：</small>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                      {activeAiCard.proposedFacts.map((f, i) => (
                        <Badge key={i}>
                          {f.predicate}: {typeof f.value === "object" ? f.value.entityName : f.value}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {activeAiCard.arc && (
                  <small>
                    <b>附带人物弧线计划：</b>欲望「{activeAiCard.arc.motivation}」 · 目标「{activeAiCard.arc.goal}」 · 阻碍「{activeAiCard.arc.conflict}」 · 转变「{activeAiCard.arc.epiphany}」
                  </small>
                )}
                {activeAiCard.world && (
                  <small>
                    <b>世界规则细节：</b>限制「{activeAiCard.world.constraints.join("；")}」 · 感官「{activeAiCard.world.sensoryDetails.join("；")}」 · 钩子「{activeAiCard.world.storyHooks.join("；")}」
                  </small>
                )}
                {activeAiCard.secret && (
                  <small>
                    <b>秘密知情设定：</b>真相「{activeAiCard.secret.truth}」 · 假象「{activeAiCard.secret.falseBelief}」 · 初始知情人「{activeAiCard.secret.initialHolders.join("、")}」
                  </small>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {aiCards.map((other, idx) =>
                      idx !== selectedCardIdx ? (
                        <button
                          key={other.proposalId}
                          className="button ghost small"
                          onClick={() => borrowSummaryFrom(other)}
                        >
                          借用「{other.name}」的细节与属性
                        </button>
                      ) : null,
                    )}
                  </div>
                  <button className="button primary" disabled={busy} onClick={() => void applySelectedAiCard()}>
                    {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                    采用此方案并写入元素账本
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="elements-workspace">
        <aside className="elements-browser">
          <div className="element-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名字或别名" />
          </div>
          <button
            className="button primary full"
            disabled={busy}
            onClick={() => {
              setComposerOpen((open) => !open);
              setError("");
              setNote("");
            }}
          >
            {composerOpen ? <ChevronDown size={14} /> : <Plus size={14} />}
            {composerOpen ? "收起" : "新建元素"}
          </button>
          {composerOpen && (
            <section className="note-composer" aria-label="新建元素">
              <div className="note-composer-heading">
                <PenLine size={17} />
                <div>
                  <strong>记下一个元素</strong>
                  <p>角色、物品或地点。名字之外都可以留空。</p>
                </div>
              </div>
              <label className="field-label">
                <span>类型</span>
                <select
                  aria-label="元素类型"
                  value={newType}
                  disabled={busy}
                  onChange={(event) => setNewType(event.target.value as Entity["type"])}
                >
                  {creatableTypes.map((type) => (
                    <option key={type} value={type}>
                      {typeNames[type]}
                    </option>
                  ))}
                </select>
              </label>
              <input
                aria-label="元素名称"
                value={newName}
                disabled={busy}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="例如：沈砚"
              />
              <textarea
                aria-label="元素简介"
                value={newSummary}
                disabled={busy}
                onChange={(event) => setNewSummary(event.target.value)}
                rows={3}
                placeholder="例如：在码头等一封迟到的家书。"
              />
              <input
                aria-label="元素别名"
                value={newAliases}
                disabled={busy}
                onChange={(event) => setNewAliases(event.target.value)}
                placeholder="别名，用逗号分隔（可留空）"
              />
              <div className="note-composer-actions">
                <span>作者设定，写入后可直接被检索与检查使用</span>
                <button
                  className="button primary"
                  disabled={busy || !newName.trim()}
                  onClick={() => void createElement()}
                >
                  {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
                  记下元素
                </button>
              </div>
            </section>
          )}
          <div className="element-filters">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
              全部 <span>{snapshot.elements.length}</span>
            </button>
            {(["character", "item", "location", "rule", "secret"] as const).map((type) => (
              <button key={type} className={filter === type ? "active" : ""} onClick={() => setFilter(type)}>
                {typeNames[type]} <span>{snapshot.elements.filter((entity) => entity.type === type).length}</span>
              </button>
            ))}
          </div>
          {error && (
            <p className="inline-note error" role="alert">
              {error}
            </p>
          )}
          {note && (
            <p className="inline-note" role="status">
              <Check size={13} />
              {note}
            </p>
          )}
          <div className="element-list">
            {elements.map((entity) => (
              <button
                key={entity.entityId}
                className={selected?.entityId === entity.entityId ? "active" : ""}
                onClick={() => onSelect(entity.entityId)}
              >
                <EntityIcon entity={entity} />
                <span>
                  <strong>{entity.name}</strong>
                  <small>
                    {typeNames[entity.type]} · {entity.aliases.length ? entity.aliases.join(" / ") : entity.summary.slice(0, 18)}
                  </small>
                </span>
                {entity.reviewState === "confirmed" && <CheckCircle2 size={13} />}
              </button>
            ))}
          </div>
        </aside>
        <main className="element-detail">
          {selected ? (
            <>
              <header className="element-detail-header">
                <EntityIcon entity={selected} large />
                <div>
                  <p className="eyebrow">
                    {typeNames[selected.type]} · {selected.entityId.slice(0, 14)}
                  </p>
                  <h2>{selected.name}</h2>
                  <p>{selected.aliases.length ? `也称 ${selected.aliases.join("、")}` : selected.summary}</p>
                </div>
                <div className="element-review" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      className="button ghost small"
                      disabled={busy}
                      onClick={() => openAiCoCreate(selected)}
                    >
                      <Sparkles size={13} />
                      AI 展开此元素设定
                    </button>
                    <Badge tone={selected.reviewState === "confirmed" ? "green" : "amber"}>
                      {selected.reviewState === "confirmed" ? "作者已确认" : "待确认"}
                    </Badge>
                  </div>
                  <small>{selected.sourceKind === "author_setting" ? "作者设定" : "正文与事件"}</small>
                </div>
              </header>
              <nav className="detail-tabs">
                {(
                  [
                    { id: "overview", label: "概览" },
                    { id: "relations", label: "关系" },
                    { id: "timeline", label: "时间线与知情边界" },
                    { id: "evidence", label: `出场证据 ${evidence.length}` },
                    { id: "history", label: "修改历史" },
                  ] as const
                ).map((item) => (
                  <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </nav>
              <div className="element-tab-content">
                {tab === "overview" && (
                  <section className="scene-structure-editor" aria-label="编辑元素">
                    {!editOpen && (
                      <button className="button ghost small" disabled={busy} onClick={openEdit}>
                        <PenLine size={13} />
                        修改名称与简介
                      </button>
                    )}
                    {editOpen && (
                      <>
                        <label className="field-label">
                          <span>名称</span>
                          <input
                            aria-label="元素名称"
                            value={editName}
                            disabled={busy}
                            onChange={(event) => setEditName(event.target.value)}
                          />
                        </label>
                        <label className="field-label">
                          <span>简介</span>
                          <textarea
                            aria-label="元素简介"
                            value={editSummary}
                            disabled={busy}
                            onChange={(event) => setEditSummary(event.target.value)}
                            rows={3}
                          />
                        </label>
                        <label className="field-label">
                          <span>别名（顿号或逗号分隔，删掉的别名保存后移除）</span>
                          <input
                            aria-label="元素别名"
                            value={editAliases}
                            disabled={busy}
                            onChange={(event) => setEditAliases(event.target.value)}
                          />
                        </label>
                        {error && (
                          <p className="inline-note error" role="alert">
                            {error} · 编辑内容已保留，可再次保存。
                          </p>
                        )}
                        <div className="note-composer-actions">
                          <span>修改只影响这个元素的名称与简介</span>
                          <button
                            className="button ghost small"
                            disabled={busy}
                            onClick={() => {
                              setEditOpen(false);
                              setError("");
                            }}
                          >
                            取消
                          </button>
                          <button
                            className="button primary small"
                            disabled={busy || !editName.trim()}
                            onClick={() => void saveEdit()}
                          >
                            {busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
                            保存元素
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                )}
                {tab === "overview" && (
                  <Overview
                    entity={selected}
                    facts={facts}
                    events={events}
                    elements={snapshot.elements}
                    {...(timeScene?.storyTime ? { storyTime: timeScene.storyTime } : {})}
                  />
                )}
                {tab === "overview" && (
                  <section className="scene-structure-editor" style={{ marginTop: 14 }} aria-label="新增属性或关系设定">
                    <strong>录入属性或关系事实</strong>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
                      <input
                        aria-label="事实谓词"
                        value={factPredicate}
                        onChange={(e) => setFactPredicate(e.target.value)}
                        placeholder="属性/关系名（如：身份、亲属、持有物）"
                      />
                      <input
                        aria-label="事实文字值"
                        value={factValue}
                        disabled={Boolean(factEntityId)}
                        onChange={(e) => setFactValue(e.target.value)}
                        placeholder="属性描述（或右侧选择关联元素）"
                      />
                      <select
                        aria-label="关联实体值"
                        value={factEntityId}
                        onChange={(e) => setFactEntityId(e.target.value)}
                      >
                        <option value="">不指向其他元素（纯文本属性）</option>
                        {snapshot.elements
                          .filter((el) => el.entityId !== selected.entityId)
                          .map((el) => (
                            <option key={el.entityId} value={el.entityId}>
                              关联元素：{el.name}（{typeNames[el.type]}）
                            </option>
                          ))}
                      </select>
                      <select
                        aria-label="事实语义类型"
                        value={factSemantic}
                        onChange={(e) => setFactSemantic(e.target.value as FactAssertion["semanticType"])}
                      >
                        {Object.entries(semanticTypeLabels).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="note-composer-actions" style={{ marginTop: 8 }}>
                      <span>录入后作为已确认设定直接参与检索与一致性检查</span>
                      <button
                        className="button primary small"
                        disabled={busy || !factPredicate.trim() || (!factValue.trim() && !factEntityId)}
                        onClick={() => void addFactToSelected()}
                      >
                        <Plus size={13} />
                        添加事实
                      </button>
                    </div>
                  </section>
                )}
                {tab === "overview" && selected.type === "character" && (
                  <CharacterArcPanel
                    key={selected.entityId}
                    snapshot={snapshot}
                    entity={selected}
                    events={events}
                    onOpenScene={onOpenScene}
                    onChanged={onChanged}
                  />
                )}
                {tab === "relations" && (
                  <Relations entity={selected} facts={facts} elements={snapshot.elements} onSelect={onSelect} />
                )}
                {tab === "timeline" && (
                  <>
                    <section className="scene-structure-editor" style={{ marginBottom: 14 }} aria-label="记录状态事件或秘密知情区间">
                      <strong>
                        {selected.type === "secret"
                          ? "记录秘密知情者（known_by）与揭示时点（revealed）"
                          : "记录状态变化事件（WorldEvent）"}
                      </strong>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
                        <select
                          aria-label="事件类型"
                          value={eventKind}
                          onChange={(e) => setEventKind(e.target.value)}
                        >
                          {selected.type === "secret" ? (
                            <>
                              <option value="known_by">known_by（某角色获知此秘密）</option>
                              <option value="revealed">revealed（秘密公开揭示）</option>
                            </>
                          ) : (
                            <>
                              <option value="status.change">status.change（状态变化）</option>
                              <option value="item.transfer">item.transfer（物品转交）</option>
                              <option value="item.discover">item.discover（发现物品）</option>
                              <option value="known_by">known_by（获知信息）</option>
                              <option value="revealed">revealed（秘密揭示）</option>
                            </>
                          )}
                        </select>
                        <input
                          aria-label="此前状态"
                          value={eventFrom}
                          onChange={(e) => setEventFrom(e.target.value)}
                          placeholder="此前状态（可留空）"
                        />
                        <input
                          aria-label="变化后状态或知情人"
                          value={eventTo}
                          onChange={(e) => setEventTo(e.target.value)}
                          placeholder={selected.type === "secret" ? "知情角色名/ID 或揭示结果" : "变化后状态/持有者"}
                        />
                        <input
                          aria-label="事件故事时点"
                          value={eventTime}
                          onChange={(e) => setEventTime(e.target.value)}
                          placeholder="故事时点序号（如：1、2）"
                        />
                        <select
                          aria-label="事件来源场景"
                          value={eventSceneId}
                          onChange={(e) => setEventSceneId(e.target.value)}
                        >
                          <option value="">不绑定特定场景</option>
                          {snapshot.scenes.map((sc) => (
                            <option key={sc.sceneId} value={sc.sceneId}>
                              场景：{sc.title}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="note-composer-actions" style={{ marginTop: 8 }}>
                        <span>秘密知情边界按查询时点生效：未到获知时点不会进入对应视角上下文</span>
                        <button
                          className="button primary small"
                          disabled={busy || !eventTo.trim()}
                          onClick={() => void addEventToSelected()}
                        >
                          <Plus size={13} />
                          记录事件
                        </button>
                      </div>
                    </section>
                    <EntityTimeline events={events} scenes={snapshot.scenes} onOpenScene={onOpenScene} />
                  </>
                )}
                {tab === "evidence" && (
                  <EvidenceList evidence={evidence} scenes={snapshot.scenes} onOpenScene={onOpenScene} />
                )}
                {tab === "history" && (
                  <div className="history-panel">
                    <History size={22} />
                    <h3>来源与修改都有迹可循</h3>
                    <p>
                      当前元素来自 {selected.sourceKind}，最近更新于{" "}
                      {new Date(selected.updatedAt).toLocaleString("zh-CN")}。历史事实不会因新状态而被抹去。
                    </p>
                    <div className="history-record">
                      <span />
                      <div>
                        <strong>当前确认状态</strong>
                        <p>{selected.summary}</p>
                        <small>{selected.updatedAt}</small>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<Box size={25} />}
              title="还没有选中元素"
              detail="从左侧选择角色、物品或地点，查看它在故事中的状态与证据。"
            />
          )}
        </main>
      </div>
    </div>
  );
}

function EntityIcon({ entity, large = false }: { entity: Entity; large?: boolean }) {
  const Icon =
    entity.type === "character"
      ? UserRound
      : entity.type === "location"
        ? MapPin
        : entity.type === "rule"
          ? Shield
          : entity.type === "secret"
            ? KeyRound
            : Box;
  return (
    <span className={`element-icon ${entity.type} ${large ? "large" : ""}`}>
      <Icon size={large ? 26 : 17} strokeWidth={1.6} />
    </span>
  );
}

function Overview({
  entity,
  facts,
  events,
  elements,
  storyTime,
}: {
  entity: Entity;
  facts: FactAssertion[];
  events: WorldEvent[];
  elements: Entity[];
  storyTime?: string;
}) {
  const latest = events.at(-1);
  return (
    <div className="element-overview">
      <section className="current-state-card">
        <div className="state-card-heading">
          <span>在「{storyTime ?? "未知时点"}」的状态</span>
          <Badge tone="green">按时点投影</Badge>
        </div>
        <p>{latest ? describeEvent(latest.kind, latest.toValue, latest.location) : entity.summary}</p>
        {!latest && <small>没有额外状态事件；当前描述来自已确认元素资料。</small>}
      </section>
      <section>
        <h3 className="content-section-title">
          已知属性与事实 <Badge>{facts.length}</Badge>
        </h3>
        {facts.length ? (
          <div className="fact-grid">
            {facts.map((fact) => (
              <div key={fact.factId} className="fact-card">
                <span>{fact.predicate}</span>
                <strong>{formatValue(fact.value, elements)}</strong>
                <small>
                  {semanticTypeLabels[fact.semanticType] ?? fact.semanticType} ·{" "}
                  {fact.reviewState === "confirmed" ? "已确认" : "待确认"}
                </small>
              </div>
            ))}
          </div>
        ) : (
          <p className="quiet-empty">这个时点上没有更多已确认属性。未知不会被填成默认值。</p>
        )}
      </section>
      <section>
        <h3 className="content-section-title">最近变化</h3>
        {events
          .slice(-3)
          .reverse()
          .map((event) => (
            <div className="compact-event" key={event.eventId}>
              <Clock3 size={14} />
              <div>
                <strong>{event.kind}</strong>
                <p>
                  {event.fromValue ?? "未知"} → {event.toValue ?? event.location ?? "未知"}
                </p>
              </div>
              <small>{event.storyTime ?? `序 ${event.storyOrder}`}</small>
            </div>
          ))}
        {!events.length && <p className="quiet-empty">尚无变化事件。</p>}
      </section>
    </div>
  );
}

function Relations({
  entity,
  facts,
  elements,
  onSelect,
}: {
  entity: Entity;
  facts: FactAssertion[];
  elements: Entity[];
  onSelect: (id: string) => void;
}) {
  const relations = facts.filter((fact) => typeof fact.value === "object" && fact.value !== null && "entityId" in fact.value);
  return (
    <div>
      <h3 className="content-section-title">
        <Network size={16} />与 {entity.name} 有关的关系
      </h3>
      {relations.map((fact) => {
        const target = elements.find(
          (item) => typeof fact.value === "object" && fact.value !== null && "entityId" in fact.value && item.entityId === fact.value.entityId,
        );
        return target ? (
          <button className="relation-row" key={fact.factId} onClick={() => onSelect(target.entityId)}>
            <EntityIcon entity={target} />
            <span>
              <strong>{target.name}</strong>
              <small>
                {fact.predicate} · {semanticTypeLabels[fact.semanticType] ?? fact.semanticType}
              </small>
            </span>
            <ArrowRight size={15} />
          </button>
        ) : null;
      })}
      {!relations.length && <p className="quiet-empty">尚无已确认实体关系。可在「概览」标签页录入指向其他元素的关系事实。</p>}
    </div>
  );
}

function EntityTimeline({
  events,
  scenes,
  onOpenScene,
}: {
  events: WorldEvent[];
  scenes: Scene[];
  onOpenScene: (id: string) => void;
}) {
  return (
    <div className="entity-timeline">
      {events.map((event) => (
        <article key={event.eventId}>
          <div className="timeline-time">
            <span>{event.storyTime ?? `序 ${event.storyOrder}`}</span>
            <i />
          </div>
          <div>
            <Badge tone={event.reviewState === "confirmed" ? "green" : "amber"}>{event.kind}</Badge>
            <h3>{describeEvent(event.kind, event.toValue, event.location)}</h3>
            <p>{event.fromValue ? `此前：${event.fromValue}` : "此前状态未知，未按记录顺序猜测。"}</p>
            {event.sceneId && (
              <button className="text-button" onClick={() => onOpenScene(event.sceneId!)}>
                {scenes.find((scene) => scene.sceneId === event.sceneId)?.title ?? "打开来源场景"}
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </article>
      ))}
      {!events.length && <p className="quiet-empty">还没有状态变化记录。</p>}
    </div>
  );
}

function EvidenceList({
  evidence,
  scenes,
  onOpenScene,
}: {
  evidence: Evidence[];
  scenes: Scene[];
  onOpenScene: (id: string) => void;
}) {
  return (
    <div className="evidence-list">
      {evidence.map((item) => (
        <article key={item.evidenceId}>
          <FileText size={17} />
          <blockquote>{item.quote}</blockquote>
          <div>
            <Badge>{item.sourceKind}</Badge>
            <span>{item.sourceRevisionId.slice(0, 12)}</span>
            {item.sceneId && (
              <button className="text-button" onClick={() => onOpenScene(item.sceneId!)}>
                {scenes.find((scene) => scene.sceneId === item.sceneId)?.title ?? "查看原文"}
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </article>
      ))}
      {!evidence.length && <p className="quiet-empty">作者直接设定可以没有正文锚点；这里不会虚构引用。</p>}
    </div>
  );
}

function describeEvent(kind: string, toValue?: string, location?: string) {
  if (kind === "known_by") return `知情者：${toValue ?? "未知角色"}`;
  if (kind === "revealed") return `秘密揭示：${toValue ?? "已公开"}`;
  if (kind.includes("transfer")) return `物品转交给 ${toValue ?? "未知持有者"}`;
  if (kind.includes("lost")) return `物品遗失${location ? `，位置：${location}` : ""}`;
  if (kind.includes("learn")) return `获知：${toValue ?? "未知内容"}`;
  return toValue ?? location ?? kind;
}

function formatValue(value: unknown, elements?: Entity[]): string {
  if (value === null) return "未知";
  if (typeof value === "object" && "entityId" in value) {
    const id = String((value as { entityId: unknown }).entityId);
    const found = elements?.find((e) => e.entityId === id);
    return found ? `${found.name}（${typeNames[found.type]}）` : id;
  }
  return String(value);
}
