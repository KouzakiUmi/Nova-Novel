import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import type { StoryGraph, WorkspaceSnapshot } from "@nova-novel/shared";
import { ArrowRight, Circle, Clock3, GitBranch, LayoutList, Network, Route, Scan, Sparkles } from "lucide-react";
import { Badge } from "./UI";

interface StoryCanvasProps {
  snapshot: WorkspaceSnapshot;
  selectedSceneId: string;
  onSelectScene: (sceneId: string) => void;
  onOpenGuide: () => void;
}

type StoryNode = Node<{ label: string; subtitle: string; status: string; kind: string }>;

export function StoryCanvas({ snapshot, selectedSceneId, onSelectScene, onOpenGuide }: StoryCanvasProps) {
  const [mode, setMode] = useState<"graph" | "outline" | "timeline">("graph");
  const [activeSceneId, setActiveSceneId] = useState(selectedSceneId);
  const [layoutNote, setLayoutNote] = useState(false);
  const graph = snapshot.storyGraph;

  const initialNodes = useMemo<StoryNode[]>(() => graph.nodes.map((node, index) => {
    const scene = snapshot.scenes.find((item) => item.sceneId === node.sceneId);
    return {
      id: node.id,
      position: node.position,
      data: { label: node.title, subtitle: node.summary || scene?.goal || "轻量场景卡", status: scene?.status ?? "planned", kind: node.kind },
      style: { width: 190 },
      className: `story-flow-node ${node.sceneId === activeSceneId ? "selected" : ""}`,
    };
  }), [graph.nodes, snapshot.scenes, activeSceneId]);
  const [nodes, setNodes] = useState<StoryNode[]>(initialNodes);

  useEffect(() => setNodes(initialNodes), [initialNodes]);

  const edges = useMemo(() => graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.kind === "causes" ? "导致" : edge.kind === "sets_up" ? "铺垫" : edge.kind === "pays_off" ? "回收" : edge.kind === "alternative" ? "备选" : "随后",
    type: "smoothstep",
    animated: false,
    className: `story-flow-edge ${edge.kind}`,
  })), [graph.edges]);

  const activeScene = snapshot.scenes.find((scene) => scene.sceneId === activeSceneId) ?? snapshot.scenes[0];
  const onNodesChange = (changes: NodeChange<StoryNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    if (changes.some((change) => change.type === "position" && change.dragging)) setLayoutNote(true);
  };

  return (
    <div className="canvas-page">
      <header className="page-toolbar">
        <div><p className="eyebrow">STORY MAP · {graph.revisionId.slice(0, 10)}</p><h1>故事画布</h1><p>看清故事如何发生，也保留尚未选择的岔路。</p></div>
        <div className="toolbar-actions"><button className="button secondary" onClick={onOpenGuide}><Sparkles size={14} />交互式大纲</button><div className="segmented-control"><button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}><Network size={14} />情节图</button><button className={mode === "outline" ? "active" : ""} onClick={() => setMode("outline")}><LayoutList size={14} />大纲</button><button className={mode === "timeline" ? "active" : ""} onClick={() => setMode("timeline")}><Clock3 size={14} />时间轴</button></div><span className="branch-chip"><GitBranch size={15} />{snapshot.branches.find((branch) => branch.branchId === snapshot.activeProject.activeBranchId)?.name ?? "主稿"}</span></div>
      </header>
      <div className="canvas-workspace">
        <aside className="canvas-outline">
          <div className="pane-heading"><span>故事结构</span><Badge>{snapshot.scenes.length}</Badge></div>
          <div className="outline-volume"><span>当前作品</span><strong>{snapshot.activeProject.title}</strong></div>
          {snapshot.chapters.map((chapter) => <section key={chapter.chapterId}><p className="outline-chapter">{chapter.title}</p>{snapshot.scenes.filter((scene) => scene.chapterId === chapter.chapterId).map((scene) => <button key={scene.sceneId} className={scene.sceneId === activeSceneId ? "active" : ""} onClick={() => setActiveSceneId(scene.sceneId)}><span>{String(scene.narrationOrder).padStart(2, "0")}</span>{scene.title}<i className={`scene-status-mark ${scene.status}`} /></button>)}</section>)}
          <div className="route-card"><Route size={16} /><div><strong>故事路线</strong><p>{snapshot.routes.map((route) => route.name).join(" · ")}</p></div></div>
        </aside>

        <main className="story-canvas-main">
          {mode === "graph" && (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onNodeClick={(_, node) => {
                const graphNode = graph.nodes.find((item) => item.id === node.id);
                if (graphNode?.sceneId) setActiveSceneId(graphNode.sceneId);
              }}
              fitView
              minZoom={0.35}
              maxZoom={1.7}
              colorMode="light"
              deleteKeyCode={null}
              nodesConnectable={false}
              elementsSelectable
              aria-label="剧情关系画布"
            >
              <Background gap={24} size={1} color="#dedbd2" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="story-minimap" />
              <div className="canvas-legend"><span><i className="legend-line cause" />因果</span><span><i className="legend-line next" />先后</span><span><i className="legend-line setup" />铺垫 / 回收</span></div>
              {layoutNote && <div className="layout-note"><Scan size={13} />仅调整视图布局，不改变章节顺序或故事事实<button onClick={() => setLayoutNote(false)}>知道了</button></div>}
            </ReactFlow>
          )}
          {mode === "outline" && <OutlineView snapshot={snapshot} activeSceneId={activeSceneId} onSelect={setActiveSceneId} />}
          {mode === "timeline" && <TimelineView snapshot={snapshot} activeSceneId={activeSceneId} onSelect={setActiveSceneId} />}
        </main>

        <aside className="canvas-inspector">
          {activeScene ? <><p className="eyebrow">SCENE {String(activeScene.narrationOrder).padStart(2, "0")}</p><h2>{activeScene.title}</h2><div className="inspector-tags"><Badge tone="green">{activeScene.status === "review" ? "待审阅" : "写作中"}</Badge><Badge>{activeScene.pov ?? "视角待定"}</Badge></div><p className="inspector-summary">{activeScene.summary || "这张场景卡还很轻，只留下真正确定的内容即可。"}</p><dl className="scene-metadata"><div><dt>场景目标</dt><dd>{activeScene.goal || "尚未确定"}</dd></div><div><dt>阻碍</dt><dd>{activeScene.conflict || "尚未确定"}</dd></div><div><dt>故事时间</dt><dd>{activeScene.storyTime ?? "未知"}</dd></div><div><dt>叙述顺序</dt><dd>第 {activeScene.narrationOrder} 位</dd></div></dl><div className="plan-notice"><Sparkles size={14} /><p>选定计划是“拟发生”的创作方向，不会自动写成已发生事实。</p></div><button className="button primary full" onClick={() => onSelectScene(activeScene.sceneId)}>打开这个场景<ArrowRight size={15} /></button></> : <p>选择一张场景卡查看详情。</p>}
        </aside>
      </div>
    </div>
  );
}

function OutlineView({ snapshot, activeSceneId, onSelect }: { snapshot: WorkspaceSnapshot; activeSceneId: string; onSelect: (id: string) => void }) {
  return <div className="alternative-canvas-view"><div className="view-caption"><LayoutList size={16} /><span>大纲列表与画布共享同一场景对象</span></div>{snapshot.chapters.map((chapter) => <section className="outline-list-chapter" key={chapter.chapterId}><h2>{chapter.title}</h2>{snapshot.scenes.filter((scene) => scene.chapterId === chapter.chapterId).map((scene) => <button key={scene.sceneId} className={scene.sceneId === activeSceneId ? "active" : ""} onClick={() => onSelect(scene.sceneId)}><span>{String(scene.narrationOrder).padStart(2, "0")}</span><div><strong>{scene.title}</strong><p>{scene.summary}</p></div><Badge>{scene.status}</Badge></button>)}</section>)}</div>;
}

function TimelineView({ snapshot, activeSceneId, onSelect }: { snapshot: WorkspaceSnapshot; activeSceneId: string; onSelect: (id: string) => void }) {
  return <div className="alternative-canvas-view"><div className="view-caption"><Clock3 size={16} /><span>故事时间不等于阅读顺序；未知时间保留在原位</span></div><div className="timeline-axis">{[...snapshot.scenes].sort((a, b) => (a.storyTime ?? "未知").localeCompare(b.storyTime ?? "未知", "zh-CN")).map((scene) => <button key={scene.sceneId} className={scene.sceneId === activeSceneId ? "active" : ""} onClick={() => onSelect(scene.sceneId)}><span className="timeline-dot"><Circle size={11} /></span><div><small>{scene.storyTime ?? "时间未知"} · 阅读位置 {scene.narrationOrder}</small><strong>{scene.title}</strong><p>{scene.summary}</p></div></button>)}</div></div>;
}
