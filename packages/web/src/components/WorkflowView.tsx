import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Scene, WorkflowDefinition, WorkflowNode, WorkflowRun, WorkspaceSnapshot } from "@nova-novel/shared";
import { ArrowRight, Check, CheckCircle2, CircleAlert, CircleDashed, Clock3, FileInput, GitCompareArrows, UserRound, LibraryBig, ListChecks, LoaderCircle, Play, Search, ShieldCheck, Square, Workflow, WandSparkles, X } from "lucide-react";
import { Badge } from "./UI";
import { IconOrbit } from "./icons";
import { api } from "../lib/api";

interface WorkflowViewProps {
  snapshot: WorkspaceSnapshot;
  scene?: Scene;
  onRun: (workflowVersionId: string) => Promise<void>;
  onDecide: (runId: string, todoId: string, answer: string, inputHash: string, reviewNote?: string) => Promise<void>;
  onCancelRun: (runId: string) => Promise<void>;
  onRefresh: () => void;
  onOpenGuide: () => void;
}

const ACTIVE_STATES = new Set<string>(["queued", "running", "waiting_human", "cancelling"]);

export function WorkflowView({ snapshot, scene, onRun, onDecide, onCancelRun, onRefresh, onOpenGuide }: WorkflowViewProps) {
  const [selectedId, setSelectedId] = useState(snapshot.workflows[0]?.workflowVersionId ?? "");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [mode, setMode] = useState<"canvas" | "list">("canvas");
  const [nodeQuery, setNodeQuery] = useState("");
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [reviewRunId, setReviewRunId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(false);
  const definition = snapshot.workflows.find((workflow) => workflow.workflowVersionId === selectedId) ?? snapshot.workflows[0];
  const runs = snapshot.workflowRuns.filter((run) => run.workflowVersionId === definition?.workflowVersionId);
  const selectedNode = definition?.nodes.find((node) => node.id === selectedNodeId) ?? definition?.nodes[0];
  const reviewRun = runs.find((item) => item.runId === reviewRunId);
  const hasActive = runs.some((item) => ACTIVE_STATES.has(item.state) && item.state !== "waiting_human");

  // 运行中的工作流定时刷新，直到进入人工节点或结束。
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(onRefresh, 2000);
    return () => window.clearInterval(timer);
  }, [hasActive, onRefresh]);

  if (!definition) return <div className="empty-state"><IconOrbit size={28} /><h3>尚未登记工作流</h3><p>本机服务启动后，场景创作与逻辑巡检模板会出现在这里。</p></div>;

  const checkConnections = () => {
    const ids = new Set(definition.nodes.map((node) => node.id));
    const broken = definition.edges.filter((edge) => !ids.has(edge.source.node) || !ids.has(edge.target.node));
    const missing = definition.nodes.filter((node) => Object.values(node.inputs).some((input) => "node" in input && !ids.has(input.node)));
    setChecked(broken.length || missing.length
      ? `发现 ${broken.length} 条断开的连线、${missing.length} 个节点的输入来源缺失。`
      : `${definition.nodes.length} 个节点、${definition.edges.length} 条连线均已对上；运行前服务端还会校验类型与环路。`);
  };
  const visibleNodes = definition.nodes.filter((node) => !nodeQuery || `${node.name}${node.type}`.includes(nodeQuery));
  const visibleRuns = showAllRuns ? runs : runs.slice(0, 3);

  return (
    <div className="workflow-page">
      <header className="page-toolbar workflow-toolbar">
        <div className="workflow-name">
          <span className="workflow-mark"><IconOrbit size={22} /></span>
          <div>
            <p className="eyebrow">AUTHORING METHOD</p>
            <select value={definition.workflowVersionId} onChange={(event) => setSelectedId(event.target.value)}>{snapshot.workflows.map((workflow) => <option key={workflow.workflowVersionId} value={workflow.workflowVersionId}>{workflow.name}</option>)}</select>
            <p>{definition.description}</p>
          </div>
        </div>
        <div className="toolbar-actions">
          <button className="button secondary" onClick={onOpenGuide}><WandSparkles size={14} />交互编排</button>
          <button className="button ghost" onClick={checkConnections}><GitCompareArrows size={14} />检查连接</button>
          <button className="button ghost" onClick={() => setNodeInspectorOpen(open => !open)}><ListChecks size={14} />{nodeInspectorOpen ? "收起节点详情" : "节点详情"}</button>
          <button className="button primary" disabled={!scene} onClick={() => void onRun(definition.workflowVersionId)}><Play size={15} />运行到审阅</button>
        </div>
      </header>
      <div className="workflow-meta-bar">
        <span>不可变版本 · {definition.workflowVersionId.slice(0, 18)}</span>
        <span>目标 · {scene?.title ?? "请选择场景"}</span>
        <span>并发上限 {definition.policy.maxParallelNodes}</span>
        <span>返修上限 {definition.policy.maxIterations}</span>
        <div className="segmented-control compact"><button className={mode === "canvas" ? "active" : ""} onClick={() => setMode("canvas")}>画布</button><button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>列表模式</button></div>
      </div>
      {checked && <p className="workflow-check-note"><ShieldCheck size={13} />{checked}<button className="icon-button" onClick={() => setChecked(null)} aria-label="关闭"><X size={13} /></button></p>}
      <div className="workflow-workspace">
        <aside className="node-library">
          <div className="pane-heading"><span>节点与产物</span><Badge>{definition.nodes.length}</Badge></div>
          <div className="element-search"><Search size={14} /><input placeholder="查找节点" value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} aria-label="查找节点" /></div>
          <p className="nav-section-label">本流程使用</p>
          {visibleNodes.map((node) => <button key={node.id} className={selectedNode?.id === node.id ? "active" : ""} onClick={() => setSelectedNodeId(node.id)}><NodeIcon type={node.type} /><span><strong>{node.name}</strong><small>{node.type}</small></span></button>)}
          {!visibleNodes.length && <p className="quiet-empty">没有匹配的节点。</p>}
          <div className="node-library-note"><ShieldCheck size={14} /><p>模型只形成候选与提案。正文提交必须经过人工决定。</p></div>
        </aside>
        <main className="workflow-canvas">
          {mode === "canvas" ? <FlowCanvas definition={definition} onSelect={setSelectedNodeId} selectedNodeId={selectedNode?.id ?? ""} /> : <WorkflowList definition={definition} selectedNodeId={selectedNode?.id ?? ""} onSelect={setSelectedNodeId} />}
          <section className="run-drawer">
            <div className="run-drawer-heading">
              <div><Clock3 size={15} /><strong>运行记录</strong><Badge>{runs.length}</Badge></div>
              {runs.length > 3 && <button className="text-button" onClick={() => setShowAllRuns((value) => !value)}>{showAllRuns ? "收起" : `查看全部 ${runs.length}`}<ArrowRight size={13} /></button>}
            </div>
            {runs.length ? visibleRuns.map((run) => (
              <div className="run-row" key={run.runId}>
                <RunStateIcon state={run.state} />
                <div><strong>{runStateLabel(run.state)}</strong><p>{run.nodeRuns.filter((node) => node.state === "succeeded").length} / {run.nodeRuns.length} 个节点完成 · {run.runId.slice(0, 16)}</p></div>
                <span>{new Date(run.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                <div className="run-row-actions">
                  {run.pendingDecision && <button className="button primary small" onClick={() => setReviewRunId(run.runId)}>打开审阅</button>}
                  {ACTIVE_STATES.has(run.state) && run.state !== "cancelling" && <button className="button ghost small" onClick={() => void onCancelRun(run.runId)}><Square size={11} />取消</button>}
                </div>
              </div>
            )) : <div className="run-empty"><CircleDashed size={18} /><p>还没有运行。执行前会冻结当前作品与场景版本，不会暗中重跑整部作品。</p></div>}
          </section>
        </main>
        <aside className={`node-inspector ${nodeInspectorOpen ? "inspector-open" : ""}`}>
          <button className="icon-button node-inspector-close" aria-label="收起节点详情" onClick={() => setNodeInspectorOpen(false)}><X size={14} /></button>
          {selectedNode && <>
            <p className="eyebrow">NODE SETTINGS</p>
            <div className="node-inspector-title"><NodeIcon type={selectedNode.type} /><div><h3>{selectedNode.name}</h3><p>{selectedNode.type} · v{selectedNode.typeVersion}</p></div></div>
            <label className="field-label">作用对象<input value={selectedNode.type.includes("scene") || selectedNode.type.includes("world") ? scene?.title ?? "运行时选择" : "上游节点产物"} readOnly /></label>
            <div className="inspector-group"><h4>输入映射</h4>{Object.keys(selectedNode.inputs).length ? Object.entries(selectedNode.inputs).map(([key, input]) => <div className="mapping-row" key={key}><span>{key}</span><strong>{"runInput" in input ? `运行输入 · ${input.runInput}` : `${input.node}.${input.port}`}</strong></div>) : <p className="quiet-empty">此节点从作者选择的场景开始。</p>}</div>
            <div className="inspector-group"><h4>输出类型</h4>{Object.entries(selectedNode.outputs).map(([port, type]) => <div className="mapping-row" key={port}><span>{port}</span><Badge tone="violet">{type}</Badge></div>)}</div>
            <div className="node-policy"><ListChecks size={14} /><p>最多尝试 {definition.policy.maxNodeAttempts} 次。结果未知时先对账，不自动重放外部调用。</p></div>
          </>}
        </aside>
      </div>
      {reviewRun?.pendingDecision && (
        <ReviewDialog
          run={reviewRun}
          definition={definition}
          onClose={() => setReviewRunId(null)}
          onDecide={async (answer, reviewNote) => {
            const pending = reviewRun.pendingDecision!;
            await onDecide(reviewRun.runId, pending.todoId, answer, pending.inputHash, reviewNote);
            setReviewRunId(null);
          }}
        />
      )}
    </div>
  );
}

function runStateLabel(state: WorkflowRun["state"]): string {
  return ({ queued: "排队中", running: "正在执行", waiting_human: "等待作者审阅", cancelling: "正在取消", cancelled: "已取消", succeeded: "运行完成", failed: "运行失败", interrupted: "已中断" } as Record<string, string>)[state] ?? state;
}

const ANSWER_LABEL: Record<string, string> = { accept: "接受并提交", reject: "不接受", revise: "退回修改", skip: "跳过" };

function previewOf(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (depth > 3 || !value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "body", "draft", "summary"]) if (typeof record[key] === "string") return record[key] as string;
  for (const nested of Object.values(record)) {
    const text = previewOf(nested, depth + 1);
    if (text) return text;
  }
  return "";
}

function pendingInputOf(run: WorkflowRun, node: WorkflowNode, port: string): unknown {
  const binding = node.inputs[port];
  if (!binding || "runInput" in binding) return undefined;
  const source = run.nodeRuns.find(item => item.nodeId === binding.node);
  if (!source?.output || typeof source.output !== "object") return undefined;
  return (source.output as Record<string, unknown>)[binding.port];
}

interface IssueLike { title?: string; detail?: string; severity?: string }

function issuesOf(value: unknown): IssueLike[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const report = record.report && typeof record.report === "object" ? record.report as Record<string, unknown> : record;
  return Array.isArray(report.issues) ? report.issues as IssueLike[] : [];
}

function ReviewDialog({ run, definition, onClose, onDecide }: { run: WorkflowRun; definition: WorkflowDefinition; onClose: () => void; onDecide: (answer: string, reviewNote?: string) => Promise<void> }) {
  const pending = run.pendingDecision!;
  const [deciding, setDeciding] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const node = run.nodeRuns.find((item) => item.nodeRunId === pending.nodeRunId);
  const nodeName = definition.nodes.find((item) => item.id === node?.nodeId)?.name ?? "人工审阅";
  const finished = run.nodeRuns.filter((item) => item.state === "succeeded" && item.output !== undefined);
  const pendingNode = definition.nodes.find(item => item.id === node?.nodeId);
  useEffect(() => { void api.recordInteraction({ projectId: run.projectId, kind: "review-open" }).catch(() => undefined); }, [run.runId]);
  // 只展示当前待办实际绑定的候选，避免作者看到 A 却提交 B。
  const candidateInput = pendingNode ? pendingInputOf(run, pendingNode, "candidate") : undefined;
  const candidate = previewOf(candidateInput);
  const issues = finished.flatMap((item) => issuesOf(item.output));
  const decide = (option: string) => {
    if (option === "revise" && !reviewNote.trim()) { setFailed("退回修改前，请写一句希望保留什么、需要调整什么。"); return; }
    setDeciding(option);
    setFailed("");
    void onDecide(option, reviewNote.trim() || undefined).catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : "决定未提交")).finally(() => setDeciding(null));
  };
  const close = () => { void api.recordInteraction({ projectId: run.projectId, kind: "review-dismiss" }).catch(() => undefined); onClose(); };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section className="review-dialog" role="dialog" aria-modal="true" aria-label="审阅工作流产物" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">AUTHOR REVIEW · {nodeName}</p><h3>{pending.question}</h3></div><button className="icon-button" onClick={close} aria-label="关闭"><X size={16} /></button></header>
        <div className="review-body">
          <div className="review-summary"><Badge tone="green">{nodeName}</Badge><span>基础修订 · {run.baseRevisionId.slice(0, 12)}</span><span>{issues.filter(issue => issue.severity === "conflict").length} 个冲突 · {issues.filter(issue => issue.severity === "unknown").length} 个未知</span></div>
          {issues.length > 0 && <>
            <span className="review-label">先核对这些问题</span>
            <ul className="review-issues">{issues.slice(0, 8).map((issue, index) => <li key={index}><Badge tone={issue.severity === "conflict" ? "red" : issue.severity === "unknown" ? "amber" : "violet"}>{issue.severity === "conflict" ? "冲突" : issue.severity === "unknown" ? "未知" : "建议"}</Badge><span>{issue.title ?? issue.detail}</span></li>)}</ul>
          </>}
          <details className="review-candidate-details" open={issues.length === 0}><summary>查看完整候选{candidate ? `（${candidate.length} 字）` : ""}</summary>{candidate ? <p className="review-candidate">{candidate}</p> : <p className="quiet-empty">该节点没有可预览的文字产物。</p>}</details>
          {pending.options.includes("revise") && <label className="field-label review-note">退回修改说明<textarea value={reviewNote} rows={2} onChange={event => setReviewNote(event.target.value)} placeholder="例如：保留当前结果，只减少解释性对白；不要改变人物决定。" /><small>仅在选择“退回修改”时必填，会随人工决定保存并供后续返修使用。</small></label>}
          {failed && <p className="inline-note error" role="alert"><CircleAlert size={13} />{failed}</p>}
        </div>
        <footer>
          <p><ShieldCheck size={13} />接受后才会生成新的修订；原稿始终保留。</p>
          <div>{pending.options.map((option) => <button key={option} className={`button ${option === "accept" ? "primary" : "ghost"}`} disabled={Boolean(deciding)} onClick={() => decide(option)}>{deciding === option ? <LoaderCircle size={14} className="spin" /> : option === "accept" ? <Check size={14} /> : null}{ANSWER_LABEL[option] ?? option}</button>)}</div>
        </footer>
      </section>
    </div>
  );
}

function FlowCanvas({ definition, onSelect, selectedNodeId }: { definition: WorkflowDefinition; onSelect: (id: string) => void; selectedNodeId: string }) {
  const nodes = useMemo(() => definition.nodes.map((node, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const visualColumn = row % 2 === 0 ? column : 2 - column;
    return {
      id: node.id,
      position: { x: visualColumn * 225 + 35, y: row * 145 + 45 },
      data: { label: <div className="workflow-node-label"><NodeIcon type={node.type} /><span><strong>{node.name}</strong><small>{Object.values(node.outputs)[0] ?? "输入"}</small></span></div> },
      className: `workflow-flow-node ${selectedNodeId === node.id ? "selected" : ""}`,
      style: { width: 190 },
    };
  }), [definition.nodes, selectedNodeId]);
  const edges = useMemo(() => definition.edges.map((edge) => ({ id: edge.id, source: edge.source.node, target: edge.target.node, type: "smoothstep", label: edge.condition, className: "workflow-flow-edge" })), [definition.edges]);
  return <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.4} maxZoom={1.5} onNodeClick={(_, node) => onSelect(node.id)} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} aria-label="工作流画布"><Background gap={22} size={1} color="#dedbd2" /><Controls showInteractive={false} /></ReactFlow>;
}

function WorkflowList({ definition, selectedNodeId, onSelect }: { definition: WorkflowDefinition; selectedNodeId: string; onSelect: (id: string) => void }) {
  return <div className="workflow-list-view"><div className="view-caption"><ListChecks size={15} />无需拖拽，也能检查节点、输入映射与运行顺序</div>{definition.nodes.map((node, index) => <button key={node.id} className={selectedNodeId === node.id ? "active" : ""} onClick={() => onSelect(node.id)}><span>{String(index + 1).padStart(2, "0")}</span><NodeIcon type={node.type} /><div><strong>{node.name}</strong><small>{node.type} · 输出 {Object.values(node.outputs).join("、") || "无"}</small></div><ArrowRight size={15} /></button>)}</div>;
}

function NodeIcon({ type }: { type: string }) {
  const Icon = type.includes("retrieve") || type.includes("context") ? LibraryBig : type.includes("generate") || type.includes("idea") ? WandSparkles : type.includes("human") || type.includes("review") ? UserRound : type.includes("check") ? ShieldCheck : type.includes("commit") ? CheckCircle2 : FileInput;
  return <span className="node-type-icon"><Icon size={16} /></span>;
}

function RunStateIcon({ state }: { state: string }) {
  if (state === "succeeded") return <CheckCircle2 size={18} className="run-success" />;
  if (state === "running" || state === "queued") return <LoaderCircle size={18} className="spin run-active" />;
  if (state === "failed") return <CircleAlert size={18} className="run-failed" />;
  return <Clock3 size={18} className="run-waiting" />;
}
