import { useMemo, useState } from "react";
import type { Entity, Evidence, FactAssertion, Scene, WorkspaceSnapshot, WorldEvent } from "@nova-novel/shared";
import { ArrowRight, Box, CheckCircle2, ChevronDown, CircleAlert, Clock3, FileText, History, Link2, MapPin, Network, Search, Shield, UserRound } from "lucide-react";
import { Badge, EmptyState } from "./UI";
import { CharacterArcPanel } from "./CharacterArcPanel";

const typeNames: Record<Entity["type"], string> = { character: "角色", item: "物品", location: "地点", organization: "组织", ability: "能力", rule: "规则", event: "事件", secret: "秘密", custom: "自定义" };

export function ElementsView({ snapshot, selectedElementId, onSelect, onOpenScene, onChanged }: { snapshot: WorkspaceSnapshot; selectedElementId: string; onSelect: (id: string) => void; onOpenScene: (id: string) => void; onChanged: () => Promise<unknown> }) {
  const [filter, setFilter] = useState<"all" | Entity["type"]>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"overview" | "relations" | "timeline" | "evidence" | "history">("overview");
  const [timeSceneId, setTimeSceneId] = useState(snapshot.scenes.at(-1)?.sceneId ?? "");
  const elements = useMemo(() => snapshot.elements.filter((entity) => (filter === "all" || entity.type === filter) && `${entity.name}${entity.aliases.join("")}`.toLowerCase().includes(query.toLowerCase())), [snapshot.elements, filter, query]);
  const selected = snapshot.elements.find((entity) => entity.entityId === selectedElementId) ?? elements[0];
  const facts = selected ? snapshot.facts.filter((fact) => fact.subjectId === selected.entityId || (typeof fact.value === "object" && fact.value !== null && fact.value.entityId === selected.entityId)) : [];
  const events = selected ? snapshot.events.filter((event) => event.subjectId === selected.entityId).sort((a, b) => a.storyOrder - b.storyOrder) : [];
  const evidenceIds = new Set([...facts.flatMap((fact) => fact.evidenceIds), ...events.flatMap((event) => event.evidenceIds)]);
  const evidence = snapshot.evidence.filter((item) => evidenceIds.has(item.evidenceId));
  const timeScene = snapshot.scenes.find((scene) => scene.sceneId === timeSceneId);

  return (
    <div className="elements-page">
      <header className="page-toolbar"><div><p className="eyebrow">THE STORY REMEMBERS</p><h1>元素账本</h1><p>不只记住名字，也记住变化发生在什么时候、谁知道。</p></div><div className="world-time-select"><Clock3 size={16} /><label>查看到<select value={timeSceneId} onChange={(event) => setTimeSceneId(event.target.value)}>{snapshot.scenes.map((scene) => <option key={scene.sceneId} value={scene.sceneId}>{scene.title} · {scene.storyTime ?? "时间未知"}</option>)}</select></label><ChevronDown size={13} /></div></header>
      <div className="elements-workspace">
        <aside className="elements-browser">
          <div className="element-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名字或别名" /></div>
          <div className="element-filters"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 <span>{snapshot.elements.length}</span></button>{(["character", "item", "location", "rule"] as const).map((type) => <button key={type} className={filter === type ? "active" : ""} onClick={() => setFilter(type)}>{typeNames[type]} <span>{snapshot.elements.filter((entity) => entity.type === type).length}</span></button>)}</div>
          <div className="element-list">{elements.map((entity) => <button key={entity.entityId} className={selected?.entityId === entity.entityId ? "active" : ""} onClick={() => onSelect(entity.entityId)}><EntityIcon entity={entity} /><span><strong>{entity.name}</strong><small>{typeNames[entity.type]} · {entity.aliases.length ? entity.aliases.join(" / ") : entity.summary.slice(0, 18)}</small></span>{entity.reviewState === "confirmed" && <CheckCircle2 size={13} />}</button>)}</div>
        </aside>
        <main className="element-detail">
          {selected ? <><header className="element-detail-header"><EntityIcon entity={selected} large /><div><p className="eyebrow">{typeNames[selected.type]} · {selected.entityId.slice(0, 14)}</p><h2>{selected.name}</h2><p>{selected.aliases.length ? `也称 ${selected.aliases.join("、")}` : selected.summary}</p></div><div className="element-review"><Badge tone={selected.reviewState === "confirmed" ? "green" : "amber"}>{selected.reviewState === "confirmed" ? "作者已确认" : "待确认"}</Badge><small>{selected.sourceKind === "author_setting" ? "作者设定" : "正文与事件"}</small></div></header><nav className="detail-tabs">{([{ id: "overview", label: "概览" }, { id: "relations", label: "关系" }, { id: "timeline", label: "时间线" }, { id: "evidence", label: `出场证据 ${evidence.length}` }, { id: "history", label: "修改历史" }] as const).map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
            <div className="element-tab-content">
              {tab === "overview" && <Overview entity={selected} facts={facts} events={events} {...(timeScene?.storyTime ? { storyTime: timeScene.storyTime } : {})} />}
              {tab === "overview" && selected.type === "character" && <CharacterArcPanel key={selected.entityId} snapshot={snapshot} entity={selected} events={events} onOpenScene={onOpenScene} onChanged={onChanged} />}
              {tab === "relations" && <Relations entity={selected} facts={facts} elements={snapshot.elements} onSelect={onSelect} />}
              {tab === "timeline" && <EntityTimeline events={events} scenes={snapshot.scenes} onOpenScene={onOpenScene} />}
              {tab === "evidence" && <EvidenceList evidence={evidence} scenes={snapshot.scenes} onOpenScene={onOpenScene} />}
              {tab === "history" && <div className="history-panel"><History size={22} /><h3>来源与修改都有迹可循</h3><p>当前元素来自 {selected.sourceKind}，最近更新于 {new Date(selected.updatedAt).toLocaleString("zh-CN")}。历史事实不会因新状态而被抹去。</p><div className="history-record"><span /><div><strong>当前确认状态</strong><p>{selected.summary}</p><small>{selected.updatedAt}</small></div></div></div>}
            </div></> : <EmptyState icon={<Box size={25} />} title="还没有选中元素" detail="从左侧选择角色、物品或地点，查看它在故事中的状态与证据。" />}
        </main>
      </div>
    </div>
  );
}

function EntityIcon({ entity, large = false }: { entity: Entity; large?: boolean }) {
  const Icon = entity.type === "character" ? UserRound : entity.type === "location" ? MapPin : entity.type === "rule" ? Shield : Box;
  return <span className={`element-icon ${entity.type} ${large ? "large" : ""}`}><Icon size={large ? 26 : 17} strokeWidth={1.6} /></span>;
}

function Overview({ entity, facts, events, storyTime }: { entity: Entity; facts: FactAssertion[]; events: WorldEvent[]; storyTime?: string }) {
  const latest = events.at(-1);
  return <div className="element-overview"><section className="current-state-card"><div className="state-card-heading"><span>在「{storyTime ?? "未知时点"}」的状态</span><Badge tone="green">按时点投影</Badge></div><p>{latest ? describeEvent(latest.kind, latest.toValue, latest.location) : entity.summary}</p>{!latest && <small>没有额外状态事件；当前描述来自已确认元素资料。</small>}</section><section><h3 className="content-section-title">已知属性与事实 <Badge>{facts.length}</Badge></h3>{facts.length ? <div className="fact-grid">{facts.map((fact) => <div key={fact.factId} className="fact-card"><span>{fact.predicate}</span><strong>{formatValue(fact.value)}</strong><small>{fact.semanticType === "belief" ? "角色信念，不等于世界事实" : fact.reviewState === "confirmed" ? "已确认事实" : "待确认"}</small></div>)}</div> : <p className="quiet-empty">这个时点上没有更多已确认属性。未知不会被填成默认值。</p>}</section><section><h3 className="content-section-title">最近变化</h3>{events.slice(-3).reverse().map((event) => <div className="compact-event" key={event.eventId}><Clock3 size={14} /><div><strong>{event.kind}</strong><p>{event.fromValue ?? "未知"} → {event.toValue ?? event.location ?? "未知"}</p></div><small>{event.storyTime ?? "顺序未知"}</small></div>)}{!events.length && <p className="quiet-empty">尚无变化事件。</p>}</section></div>;
}

function Relations({ entity, facts, elements, onSelect }: { entity: Entity; facts: FactAssertion[]; elements: Entity[]; onSelect: (id: string) => void }) {
  const relations = facts.filter((fact) => typeof fact.value === "object" && fact.value !== null && "entityId" in fact.value);
  return <div><h3 className="content-section-title"><Network size={16} />与 {entity.name} 有关的关系</h3>{relations.map((fact) => { const target = elements.find((item) => typeof fact.value === "object" && fact.value !== null && "entityId" in fact.value && item.entityId === fact.value.entityId); return target ? <button className="relation-row" key={fact.factId} onClick={() => onSelect(target.entityId)}><EntityIcon entity={target} /><span><strong>{target.name}</strong><small>{fact.predicate} · {fact.semanticType}</small></span><ArrowRight size={15} /></button> : null; })}{!relations.length && <p className="quiet-empty">尚无已确认实体关系。提及、出场与计划引入不会被混成一种关系。</p>}</div>;
}

function EntityTimeline({ events, scenes, onOpenScene }: { events: WorldEvent[]; scenes: Scene[]; onOpenScene: (id: string) => void }) {
  return <div className="entity-timeline">{events.map((event) => <article key={event.eventId}><div className="timeline-time"><span>{event.storyTime ?? "时间未知"}</span><i /></div><div><Badge tone={event.reviewState === "confirmed" ? "green" : "amber"}>{event.kind}</Badge><h3>{describeEvent(event.kind, event.toValue, event.location)}</h3><p>{event.fromValue ? `此前：${event.fromValue}` : "此前状态未知，未按记录顺序猜测。"}</p>{event.sceneId && <button className="text-button" onClick={() => onOpenScene(event.sceneId!)}>{scenes.find((scene) => scene.sceneId === event.sceneId)?.title ?? "打开来源场景"}<ArrowRight size={13} /></button>}</div></article>)}{!events.length && <p className="quiet-empty">还没有状态变化记录。</p>}</div>;
}

function EvidenceList({ evidence, scenes, onOpenScene }: { evidence: Evidence[]; scenes: Scene[]; onOpenScene: (id: string) => void }) {
  return <div className="evidence-list">{evidence.map((item) => <article key={item.evidenceId}><FileText size={17} /><blockquote>{item.quote}</blockquote><div><Badge>{item.sourceKind}</Badge><span>{item.sourceRevisionId.slice(0, 12)}</span>{item.sceneId && <button className="text-button" onClick={() => onOpenScene(item.sceneId!)}>{scenes.find((scene) => scene.sceneId === item.sceneId)?.title ?? "查看原文"}<ArrowRight size={13} /></button>}</div></article>)}{!evidence.length && <p className="quiet-empty">作者直接设定可以没有正文锚点；这里不会虚构引用。</p>}</div>;
}

function describeEvent(kind: string, toValue?: string, location?: string) {
  if (kind.includes("transfer")) return `物品转交给 ${toValue ?? "未知持有者"}`;
  if (kind.includes("lost")) return `物品遗失${location ? `，位置：${location}` : ""}`;
  if (kind.includes("learn")) return `获知：${toValue ?? "未知内容"}`;
  return toValue ?? location ?? kind;
}

function formatValue(value: unknown): string {
  if (value === null) return "未知";
  if (typeof value === "object" && "entityId" in value) return String(value.entityId);
  return String(value);
}
