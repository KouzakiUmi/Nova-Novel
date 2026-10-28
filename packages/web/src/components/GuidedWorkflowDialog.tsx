import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { WorkflowDefinition, WorkflowGuideSession } from "@nova-novel/shared";
import { ArrowLeft, ArrowRight, Check, CircleAlert, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

interface GuidedWorkflowDialogProps {
  projectId: string;
  session?: WorkflowGuideSession;
  aiReady: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}

const STEPS = ["写作意图", "人工审阅", "发布版本"];

export function GuidedWorkflowDialog({ projectId, session, aiReady, onChanged, onClose, onOpenSettings }: GuidedWorkflowDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [custom, setCustom] = useState("");
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const dirtyProposal = useRef(false);
  const pending = session?.pending;
  useEffect(() => { setSelected(""); setCustom(""); setError(""); dirtyProposal.current = false; }, [session?.sessionId, pending?.stepId]);
  useEffect(() => {
    if (!session?.proposal || dirtyProposal.current) return;
    const next = structuredClone(session.proposal);
    setDraft(next);
    setSelectedNodeId(current => next.nodes.some(node => node.id === current) ? current : next.nodes.some(node => node.id === "generate") ? "generate" : next.nodes[0]?.id ?? "");
  }, [session?.proposal]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "这一步尚未完成，请重试"); await onChanged().catch(() => undefined); }
    finally { setBusy(false); }
  };
  const answer = (skip = false) => {
    if (!session) return;
    if (!skip && !selected && !custom.trim()) { setError("请先选择一个选项，或填写自己的回答。"); return; }
    const input = skip ? { skip: true } : custom.trim() ? { custom: custom.trim() } : { optionId: selected };
    void run(() => api.answerWorkflowGuide(session.sessionId, input));
  };
  const selectedNode = draft?.nodes.find(node => node.id === selectedNodeId) ?? draft?.nodes[0];
  const updateNode = (name: string) => {
    if (!selectedNode) return;
    dirtyProposal.current = true;
    setDraft(current => current ? { ...current, nodes: current.nodes.map(node => node.id === selectedNode.id ? { ...node, name } : node) } : current);
  };
  const updateNodeConfig = (key: string, value: string) => {
    if (!selectedNode) return;
    dirtyProposal.current = true;
    setDraft(current => current ? { ...current, nodes: current.nodes.map(node => node.id === selectedNode.id ? { ...node, config: { ...node.config, [key]: value } } : node) } : current);
  };
  const saveProposal = () => { if (session && draft) void run(async () => { await api.updateWorkflowGuideProposal(session.sessionId, draft); dirtyProposal.current = false; }); };
  const publishProposal = () => {
    if (!session || !draft) return;
    void run(async () => { await api.updateWorkflowGuideProposal(session.sessionId, draft); dirtyProposal.current = false; await api.publishWorkflowGuide(session.sessionId, projectId); });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="guided-workflow-dialog" role="dialog" aria-modal="true" aria-label="交互式工作流编排" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">GUIDED WORKFLOW · 节点与连线由你确认</p><h2>把写作方法编排成一个工作流</h2><p>Agent 提议步骤，应用校验节点、连线和人工关卡。只有点击发布后才会登记新版本，不会自动运行。</p></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭并保留进度"><X size={17} /></button></header>
        <div className="guide-progress">{STEPS.map((label, index) => <span key={label} className={session && index < session.stepIndex ? "done" : session && index === session.stepIndex ? "current" : ""}>{index + 1}. {label}</span>)}</div>
        <div className="guided-workflow-body">
          {!session && !aiReady && <div className="guide-empty"><Sparkles size={25} /><h3>交互式编排需要模型</h3><p>先接入模型服务。已有工作流、写作和版本功能不受影响。</p><button className="button primary" onClick={onOpenSettings}>去接入模型<ArrowRight size={14} /></button></div>}
          {!session && aiReady && <div className="guide-empty"><Sparkles size={25} /><h3>先确定意图，再确定人工关卡</h3><p>Agent 会建议一个场景工作流程。你可以修改回答、预览节点和连线，最后独立发布为不可变版本。</p><button className="button primary" disabled={busy} onClick={() => void run(() => api.createWorkflowGuide(projectId))}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}开始交互式编排</button></div>}

          {session?.status === "active" && pending && <div className="guide-question">
            <div className="guide-question-heading"><Badge tone="green">第 {session.stepIndex + 1} 步 · {STEPS[session.stepIndex]}</Badge><h3>{pending.question}</h3><p>{pending.why}</p></div>
            <div className="guide-options" role="group" aria-label="工作流意图选项">{pending.options.map(option => <button key={option.id} className={selected === option.id && !custom.trim() ? "selected" : ""} disabled={busy || Boolean(custom.trim())} onClick={() => setSelected(option.id)}><span>{selected === option.id && !custom.trim() ? <Check size={14} /> : null}</span><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>
            {pending.allowCustom && <label className="field-label">或者，我自己描述<textarea value={custom} disabled={busy} onChange={event => setCustom(event.target.value)} rows={3} placeholder="例如：先让人物处理刚发生的事，再决定是否继续追问……" /></label>}
            <div className="guide-answer-actions"><button className="button ghost" disabled={busy || session.stepIndex === 0} onClick={() => void run(() => api.backWorkflowGuide(session.sessionId))}><ArrowLeft size={14} />上一步</button>{pending.allowSkip && <button className="button ghost" disabled={busy} onClick={() => answer(true)}>暂时跳过</button>}<button className="button primary" disabled={busy || (!selected && !custom.trim())} onClick={() => answer(false)}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}保存回答，继续</button></div>
          </div>}
          {session?.status === "active" && !pending && <div className="guide-empty"><RotateCcw size={24} /><h3>当前步骤还没有生成</h3><p>回答已经保存，可以重新请求，不会丢失之前的答案。</p><button className="button primary" disabled={busy} onClick={() => void run(() => api.nextWorkflowGuide(session.sessionId))}>{busy ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}继续当前步骤</button></div>}

          {session?.status === "ready" && draft && <div className="workflow-proposal">
            <div className="guide-proposal-heading"><Badge tone="green">节点与连线已通过应用校验</Badge><h3>{draft.name}</h3><p>{draft.description}</p></div>
            <div className="workflow-proposal-meta"><span>{draft.nodes.length} 个节点</span><span>{draft.edges.length} 条连线</span><span>并发 {draft.policy.maxParallelNodes}</span><span>返修上限 {draft.policy.maxIterations}</span></div>
            <WorkflowProposalGraph definition={draft} selectedNodeId={selectedNode?.id ?? ""} onSelect={setSelectedNodeId} />
            {selectedNode && <section className="workflow-node-editor" aria-label="编辑提案节点"><header><div><strong>编辑节点 · {selectedNode.name}</strong><span>{selectedNode.type} · v{selectedNode.typeVersion}</span></div><button className="button secondary small" disabled={busy} onClick={saveProposal}>保存节点修改</button></header><div className="workflow-node-editor-fields"><label className="field-label">节点名称<input value={selectedNode.name} disabled={busy} onChange={event => updateNode(event.target.value)} /></label>{selectedNode.type === "agent.generate" && <><label className="field-label">任务类型<select value={typeof selectedNode.config.kind === "string" ? selectedNode.config.kind : "scene"} disabled={busy} onChange={event => updateNodeConfig("kind", event.target.value)}><option value="scene">续写场景</option><option value="rehearsal">片段试写</option><option value="consistency">一致性检查</option></select></label><label className="field-label">生成要求<textarea value={typeof selectedNode.config.prompt === "string" ? selectedNode.config.prompt : ""} disabled={busy} onChange={event => updateNodeConfig("prompt", event.target.value)} rows={3} /></label></>}{selectedNode.type === "human.review" && <label className="field-label">审阅问题<textarea value={typeof selectedNode.config.question === "string" ? selectedNode.config.question : ""} disabled={busy} onChange={event => updateNodeConfig("question", event.target.value)} rows={2} /></label>}{selectedNode.type === "context.retrieve" && <label className="field-label">检索提示<textarea value={typeof selectedNode.config.query === "string" ? selectedNode.config.query : ""} disabled={busy} onChange={event => updateNodeConfig("query", event.target.value)} rows={2} placeholder="留空时使用场景标题" /></label>}</div></section>}
            <div className="guide-answer-actions"><button className="button ghost" disabled={busy} onClick={() => void run(() => api.backWorkflowGuide(session.sessionId))}><ArrowLeft size={14} />修改上一个回答</button><button className="button primary" disabled={busy} onClick={publishProposal}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}发布为不可变版本</button></div>
          </div>}
          {session?.status === "published" && <div className="guide-empty"><Check size={26} /><h3>工作流版本已发布</h3><p>{session.publishedVersionId} 已加入版本列表。既有运行仍使用各自冻结的定义；你可以返回工作流页选择并显式运行。</p><div className="guide-complete-actions"><button className="button ghost" disabled={busy} onClick={() => void run(() => api.createWorkflowGuide(projectId))}>再编排一个</button><button className="button primary" onClick={onClose}>返回工作流<ArrowRight size={14} /></button></div></div>}
          {error && <p className="inline-note error" role="alert"><CircleAlert size={14} />{error}</p>}
        </div>
        <footer><p><ShieldCheck size={13} />Agent 只提出定义，应用负责校验与注册；发布和运行是两个独立动作。</p>{session && session.status !== "published" && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm("放弃这次工作流编排？提案不会注册。")) void run(async () => { await api.cancelWorkflowGuide(session.sessionId); onClose(); }); }}>放弃本次</button>}</footer>
      </section>
    </div>
  );
}

function WorkflowProposalGraph({ definition, selectedNodeId, onSelect }: { definition: WorkflowDefinition; selectedNodeId: string; onSelect: (id: string) => void }) {
  const nodes = useMemo(() => definition.nodes.map((node, index) => ({ id: node.id, position: node.ui ?? { x: (index % 4) * 210, y: Math.floor(index / 4) * 130 }, data: { label: <div className="workflow-node-label"><strong>{node.name}</strong><small>{node.type}</small></div> }, className: `workflow-flow-node ${selectedNodeId === node.id ? "selected" : ""}`, style: { width: 180 } })), [definition.nodes, selectedNodeId]);
  const edges = useMemo(() => definition.edges.map(edge => ({ id: edge.id, source: edge.source.node, target: edge.target.node, type: "smoothstep", label: edge.condition, className: "workflow-flow-edge" })), [definition.edges]);
  return <div className="workflow-proposal-graph"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.35} maxZoom={1.4} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} onNodeClick={(_, node) => onSelect(node.id)} aria-label="工作流提案节点与连线预览"><Background gap={22} size={1} color="#dedbd2" /><Controls showInteractive={false} /></ReactFlow></div>;
}
