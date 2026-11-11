import { useEffect, useRef, useState } from "react";
import type { ContextBundle, ContextQuery, KeywordIndexStatus, Scene, WorkspaceSnapshot } from "@nova-novel/shared";
import { api } from "../lib/api";
import { ArrowRight, BookOpenText, Check, ChevronDown, CircleAlert, Database, FileSearch, Filter, Link2, LoaderCircle, RotateCcw, Search, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "./UI";

export function ContextView({ snapshot, scene, onOpenScene }: { snapshot: WorkspaceSnapshot; scene?: Scene; onOpenScene: (sceneId: string) => void }) {
  const project = snapshot.activeProject;
  const [query, setQuery] = useState(scene?.title ?? "黄铜钥匙现在在哪里");
  const [purpose, setPurpose] = useState<ContextQuery["purpose"]>("scene_writing");
  const [result, setResult] = useState<ContextBundle | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "manuscript" | "author_setting">("all");
  const [indexStatus, setIndexStatus] = useState<KeywordIndexStatus | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const requestSeq = useRef(0);
  const searchingRef = useRef(false);
  const ownerRef = useRef("");
  const owner = `${project.projectId}:${scene?.sceneId ?? ""}`;
  const revisionId = snapshot.branches.find(item => item.branchId === project.activeBranchId)?.headRevisionId ?? scene?.baseRevisionId ?? "";
  ownerRef.current = owner;
  useEffect(() => {
    requestSeq.current += 1;
    searchingRef.current = false;
    setResult(null); setError(""); setSearching(false);
    return () => { requestSeq.current += 1; searchingRef.current = false; };
  }, [owner]);

  useEffect(() => {
    let active = true;
    setIndexStatus(null);
    if (revisionId) void api.knowledgeIndexStatus(project.projectId, revisionId).then(status => { if (active) setIndexStatus(status); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "索引状态读取失败"); });
    return () => { active = false; };
  }, [owner, revisionId, project.projectId]);

  const rebuildIndex = async () => {
    if (!revisionId || indexBusy) return;
    setIndexBusy(true);
    setError("");
    try {
      const status = await api.rebuildKnowledgeIndex(project.projectId, revisionId);
      setIndexStatus(status);
      setResult(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "索引重建失败");
    } finally {
      setIndexBusy(false);
    }
  };

  const search = async () => {
    if (!scene || searchingRef.current) return;
    const seq = ++requestSeq.current;
    const requestOwner = owner;
    searchingRef.current = true;
    setSearching(true);
    setError("");
    try {
      const bundle = await api.queryContext({
        projectId: project.projectId,
        branchId: project.activeBranchId,
        routeId: project.activeRouteId,
        revisionId,
        sceneId: scene.sceneId,
        query,
        purpose,
        limit: 12,
      });
      if (seq === requestSeq.current && ownerRef.current === requestOwner) setResult(bundle);
    } catch (cause) {
      if (seq === requestSeq.current && ownerRef.current === requestOwner) setError(cause instanceof Error ? cause.message : "检索未完成");
    } finally {
      if (seq === requestSeq.current && ownerRef.current === requestOwner) { searchingRef.current = false; setSearching(false); }
    }
  };

  const allEvidence = result?.evidence ?? snapshot.evidence;
  const evidence = sourceFilter === "all" ? allEvidence : allEvidence.filter((item) => item.sourceKind === sourceFilter);
  return <div className="context-page page-scroll"><header className="page-toolbar"><div><p className="eyebrow">EVIDENCE, NOT GUESSWORK</p><h1>资料与检索</h1><p>每一条上下文都能回到原文、设定与具体修订。</p></div><div className="index-health"><Database size={16} /><div><strong>{indexStatus?.state === "ready" ? "关键词索引已就绪" : indexStatus?.state === "error" ? "关键词索引有失败项" : indexStatus?.state === "pending" ? "关键词索引待完善" : "正在读取索引状态"}</strong><small>{indexStatus ? `当前修订 ${revisionId.slice(0, 12)} · 语义索引未配置` : "语义索引 · 未配置"}</small></div><Badge tone={indexStatus?.state === "ready" ? "green" : "amber"}>{indexStatus?.state ?? "读取中"}</Badge><button className="button ghost small" disabled={!revisionId || indexBusy} onClick={() => void rebuildIndex()}>{indexBusy ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}从正文重建</button></div></header><section className="research-search"><div className="research-query"><FileSearch size={22} /><div><label htmlFor="context-query">在这场戏里，你想确认什么？</label><input id="context-query" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void search(); }} /></div><button className="button primary" disabled={searching || !scene} onClick={() => void search()}>{searching ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}检索证据</button></div><div className="research-options"><label>用途<select value={purpose} onChange={(event) => setPurpose(event.target.value as ContextQuery["purpose"])}><option value="scene_writing">场景写作</option><option value="planning">总体规划</option><option value="fact_check">事实核对</option><option value="reader_check">读者视角</option></select><ChevronDown size={12} /></label><span><BookOpenText size={13} />{scene?.title ?? "未选择场景"}</span><span><ShieldCheck size={13} />{scene?.pov ?? "作者视角"} · 仅主稿路线</span></div></section>{error && <p className="inline-error"><CircleAlert size={14} />{error}</p>}<div className="context-results-layout"><main><div className="results-heading"><div><p className="eyebrow">{result ? `SNAPSHOT ${result.snapshotId.slice(0, 12)}` : "CURRENT MANUSCRIPT"}</p><h2>{result ? `找到 ${evidence.length} 条可用证据` : "当前作品的证据"}</h2></div><label className="filter-select"><Filter size={14} /><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)} aria-label="按来源筛选"><option value="all">全部来源</option><option value="manuscript">已采用正文</option><option value="author_setting">作者设定</option></select></label></div>{evidence.map((item, index) => <article className="research-result" key={item.evidenceId}><span className="result-index">{String(index + 1).padStart(2, "0")}</span><div className="result-main"><div className="result-meta"><Badge tone={item.sourceKind === "author_setting" ? "green" : "neutral"}>{item.sourceKind === "manuscript" ? "已采用正文" : item.sourceKind === "author_setting" ? "作者设定" : item.sourceKind}</Badge><span>{snapshot.scenes.find((entry) => entry.sceneId === item.sceneId)?.title ?? "作品设定"}</span><span>·</span><span>{item.sourceRevisionId.slice(0, 10)}</span></div><blockquote>{item.quote}</blockquote><div className="result-footer"><span><Link2 size={12} />{item.blockId ?? "作品级证据"}</span><span><Check size={12} />内容哈希已登记</span>{item.sceneId && <button className="text-button" onClick={() => onOpenScene(item.sceneId!)}>查看原文<ArrowRight size={13} /></button>}</div></div></article>)}{!evidence.length && <div className="research-empty"><Search size={25} /><h3>没有找到可确认的证据</h3><p>不会为了凑足结果引入无关内容。你可以改用作者输入和选定计划继续创作。</p></div>}</main><aside className="retrieval-explainer"><p className="eyebrow">HOW IT WAS FOUND</p><h3>这份上下文怎样形成</h3><ol><li><span>1</span><div><strong>先限定可见范围</strong><p>主稿、当前路线、{scene?.storyTime ?? "当前故事时点"}与人物知识边界。</p></div></li><li><span>2</span><div><strong>再查状态与关键词</strong><p>正文按场景和段落切分，中文按字建立关键词索引，二字人名与别名与普通词同样可查。</p></div></li><li><span>3</span><div><strong>最后回查权威原文</strong><p>废弃稿与其他路线即使留有旧索引，也不能进入结果。</p></div></li></ol><div className="source-kind-guide"><h4>四类材料，分开使用</h4><p><i className="source-dot candidate" />候选<span>仅显式比较或试演</span></p><p><i className="source-dot plan" />选定计划<span>拟发生，不是事实</span></p><p><i className="source-dot manuscript" />采用正文<span>可定位的原文证据</span></p><p><i className="source-dot setting" />作者设定<span>明确确认的世界约束</span></p></div><div className="privacy-note"><ShieldCheck size={15} /><p>当前检索在本机完成。远程模型与远程嵌入的发送范围分别显示，不混称为全离线。</p></div></aside></div></div>;
}
