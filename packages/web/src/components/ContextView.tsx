import { useState } from "react";
import type { ContextBundle, ContextQuery, Scene, WorkspaceSnapshot } from "@nova-novel/shared";
import { api } from "../lib/api";
import { ArrowRight, BookOpenText, Check, ChevronDown, CircleAlert, Database, FileSearch, Filter, Link2, LoaderCircle, Search, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "./UI";

export function ContextView({ snapshot, scene, onOpenScene }: { snapshot: WorkspaceSnapshot; scene?: Scene; onOpenScene: (sceneId: string) => void }) {
  const project = snapshot.activeProject;
  const [query, setQuery] = useState(scene?.title ?? "黄铜钥匙现在在哪里");
  const [purpose, setPurpose] = useState<ContextQuery["purpose"]>("scene_writing");
  const [result, setResult] = useState<ContextBundle | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "manuscript" | "author_setting">("all");

  const search = async () => {
    if (!scene) return;
    setSearching(true);
    setError("");
    try {
      const branch = snapshot.branches.find((item) => item.branchId === project.activeBranchId);
      const bundle = await api.queryContext({
        projectId: project.projectId,
        branchId: project.activeBranchId,
        routeId: project.activeRouteId,
        revisionId: branch?.headRevisionId ?? scene.baseRevisionId,
        query,
        purpose,
        ...(scene.pov ? {} : {}),
        storyOrder: scene.narrationOrder,
        narrationOrder: scene.narrationOrder,
        limit: 12,
      });
      setResult(bundle);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检索未完成");
    } finally {
      setSearching(false);
    }
  };

  const allEvidence = result?.evidence ?? snapshot.evidence;
  const evidence = sourceFilter === "all" ? allEvidence : allEvidence.filter((item) => item.sourceKind === sourceFilter);
  return <div className="context-page page-scroll"><header className="page-toolbar"><div><p className="eyebrow">EVIDENCE, NOT GUESSWORK</p><h1>资料与检索</h1><p>每一条上下文都能回到原文、设定与具体修订。</p></div><div className="index-health"><Database size={16} /><div><strong>关键词索引可用</strong><small>语义索引 · 未配置，不以相似度冒充结果</small></div><Badge tone="green">本机</Badge></div></header><section className="research-search"><div className="research-query"><FileSearch size={22} /><div><label htmlFor="context-query">在这场戏里，你想确认什么？</label><input id="context-query" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /></div><button className="button primary" disabled={searching || !scene} onClick={() => void search()}>{searching ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}检索证据</button></div><div className="research-options"><label>用途<select value={purpose} onChange={(event) => setPurpose(event.target.value as ContextQuery["purpose"])}><option value="scene_writing">场景写作</option><option value="planning">总体规划</option><option value="fact_check">事实核对</option><option value="reader_check">读者视角</option></select><ChevronDown size={12} /></label><span><BookOpenText size={13} />{scene?.title ?? "未选择场景"}</span><span><ShieldCheck size={13} />{scene?.pov ?? "作者视角"} · 仅主稿路线</span></div></section>{error && <p className="inline-error"><CircleAlert size={14} />{error}</p>}<div className="context-results-layout"><main><div className="results-heading"><div><p className="eyebrow">{result ? `SNAPSHOT ${result.snapshotId.slice(0, 12)}` : "CURRENT MANUSCRIPT"}</p><h2>{result ? `找到 ${evidence.length} 条可用证据` : "当前作品的证据"}</h2></div><label className="filter-select"><Filter size={14} /><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)} aria-label="按来源筛选"><option value="all">全部来源</option><option value="manuscript">已采用正文</option><option value="author_setting">作者设定</option></select></label></div>{evidence.map((item, index) => <article className="research-result" key={item.evidenceId}><span className="result-index">{String(index + 1).padStart(2, "0")}</span><div className="result-main"><div className="result-meta"><Badge tone={item.sourceKind === "author_setting" ? "green" : "neutral"}>{item.sourceKind === "manuscript" ? "已采用正文" : item.sourceKind === "author_setting" ? "作者设定" : item.sourceKind}</Badge><span>{snapshot.scenes.find((entry) => entry.sceneId === item.sceneId)?.title ?? "作品设定"}</span><span>·</span><span>{item.sourceRevisionId.slice(0, 10)}</span></div><blockquote>{item.quote}</blockquote><div className="result-footer"><span><Link2 size={12} />{item.blockId ?? "作品级证据"}</span><span><Check size={12} />内容哈希已登记</span>{item.sceneId && <button className="text-button" onClick={() => onOpenScene(item.sceneId!)}>查看原文<ArrowRight size={13} /></button>}</div></div></article>)}{!evidence.length && <div className="research-empty"><Search size={25} /><h3>没有找到可确认的证据</h3><p>不会为了凑足结果引入无关内容。你可以改用作者输入和选定计划继续创作。</p></div>}</main><aside className="retrieval-explainer"><p className="eyebrow">HOW IT WAS FOUND</p><h3>这份上下文怎样形成</h3><ol><li><span>1</span><div><strong>先限定可见范围</strong><p>主稿、当前路线、{scene?.storyTime ?? "当前故事时点"}与人物知识边界。</p></div></li><li><span>2</span><div><strong>再查状态与关键词</strong><p>精确别名与二字人名走独立索引；正文按场景和段落切分。</p></div></li><li><span>3</span><div><strong>最后回查权威原文</strong><p>废弃稿与其他路线即使留有旧索引，也不能进入结果。</p></div></li></ol><div className="source-kind-guide"><h4>四类材料，分开使用</h4><p><i className="source-dot candidate" />候选<span>仅显式比较或试演</span></p><p><i className="source-dot plan" />选定计划<span>拟发生，不是事实</span></p><p><i className="source-dot manuscript" />采用正文<span>可定位的原文证据</span></p><p><i className="source-dot setting" />作者设定<span>明确确认的世界约束</span></p></div><div className="privacy-note"><ShieldCheck size={15} /><p>当前检索在本机完成。远程模型与远程嵌入的发送范围分别显示，不混称为全离线。</p></div></aside></div></div>;
}
