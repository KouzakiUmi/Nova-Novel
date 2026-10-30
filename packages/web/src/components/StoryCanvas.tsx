import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import type { PlotIdeateMode, PlotIdeateResult, Scene, SceneProposalCard, WorkspaceSnapshot } from "@nova-novel/shared";
import { ArrowRight, Check, Circle, Clock3, GitBranch, LayoutList, LoaderCircle, Network, Plus, Route, Scan, Sparkles, Wand2 } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

interface StoryCanvasProps {
  snapshot: WorkspaceSnapshot;
  selectedSceneId: string;
  onSelectScene: (sceneId: string) => void;
  onOpenGuide: () => void;
  onChanged: () => Promise<unknown>;
  onBeforeWrite: () => Promise<WorkspaceSnapshot>;
}

type StoryNode = Node<{ label: string; subtitle: string; status: string; kind: string }>;

export function StoryCanvas({
  snapshot,
  selectedSceneId,
  onSelectScene,
  onOpenGuide,
  onChanged,
  onBeforeWrite,
}: StoryCanvasProps) {
  const [mode, setMode] = useState<"graph" | "outline" | "timeline">("graph");
  const [activeSceneId, setActiveSceneId] = useState(selectedSceneId);
  const [layoutNote, setLayoutNote] = useState(false);
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [newSceneTitle, setNewSceneTitle] = useState("");
  const [newSceneChapterId, setNewSceneChapterId] = useState(snapshot.chapters[0]?.chapterId ?? "");
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editingChapterTitle, setEditingChapterTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(() => window.matchMedia("(min-width: 1051px)").matches);
  const [outlineOpen, setOutlineOpen] = useState(false);

  // AI 局部情节推演状态
  const [ideateOpen, setIdeateOpen] = useState(false);
  const [ideateMode, setIdeateMode] = useState<PlotIdeateMode>("next_scene");
  const [ideateToSceneId, setIdeateToSceneId] = useState<string>("");
  const [ideateChapterId, setIdeateChapterId] = useState<string>(snapshot.chapters[0]?.chapterId ?? "");
  const [ideateFieldTarget, setIdeateFieldTarget] = useState<"goal" | "conflict" | "summary">("conflict");
  const [ideatePrompt, setIdeatePrompt] = useState("");
  const [ideateResult, setIdeateResult] = useState<PlotIdeateResult | null>(null);
  const [editableScenes, setEditableScenes] = useState<SceneProposalCard[]>([]);
  const [selectedProposalIds, setSelectedProposalIds] = useState<string[]>([]);

  useEffect(() => {
    setActiveSceneId(
      snapshot.scenes.some((scene) => scene.sceneId === selectedSceneId)
        ? selectedSceneId
        : snapshot.scenes[0]?.sceneId ?? "",
    );
    setNewSceneChapterId(snapshot.chapters[0]?.chapterId ?? "");
    setIdeateChapterId(snapshot.chapters[0]?.chapterId ?? "");
    setEditingChapterId(null);
    setError("");
    setNote("");
  }, [snapshot.activeProject.projectId]);

  useEffect(() => {
    if (snapshot.scenes.some((scene) => scene.sceneId === selectedSceneId)) setActiveSceneId(selectedSceneId);
  }, [selectedSceneId]);

  const graph = snapshot.storyGraph;

  const initialNodes = useMemo<StoryNode[]>(
    () =>
      graph.nodes.map((node) => {
        const scene = snapshot.scenes.find((item) => item.sceneId === node.sceneId);
        return {
          id: node.id,
          position: node.position,
          data: {
            label: node.title,
            subtitle: node.summary || scene?.goal || "轻量场景卡",
            status: scene?.status ?? "planned",
            kind: node.kind,
          },
          style: { width: 190 },
          className: `story-flow-node ${node.sceneId === activeSceneId ? "selected" : ""}`,
        };
      }),
    [graph.nodes, snapshot.scenes, activeSceneId],
  );
  const [nodes, setNodes] = useState<StoryNode[]>(initialNodes);

  useEffect(() => setNodes(initialNodes), [initialNodes]);

  const edges = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label:
          edge.kind === "causes"
            ? "导致"
            : edge.kind === "sets_up"
              ? "铺垫"
              : edge.kind === "pays_off"
                ? "回收"
                : edge.kind === "alternative"
                  ? "备选"
                  : "随后",
        type: "smoothstep",
        animated: false,
        className: `story-flow-edge ${edge.kind}`,
      })),
    [graph.edges],
  );

  const activeScene = snapshot.scenes.find((scene) => scene.sceneId === activeSceneId) ?? snapshot.scenes[0];

  const run = async (action: (current: WorkspaceSnapshot) => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const current = await onBeforeWrite();
      if (current.activeProject.projectId !== snapshot.activeProject.projectId) {
        throw new Error("作品已切换，请在当前作品重试。");
      }
      await action(current);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "结构操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const addChapter = () => {
    if (!newChapterTitle.trim()) return;
    void run(async () => {
      await api.createChapter(snapshot.activeProject.projectId, newChapterTitle.trim());
      setNewChapterTitle("");
    });
  };

  const addScene = () => {
    if (!newSceneTitle.trim() || !newSceneChapterId) return;
    void run(async () => {
      const result = await api.createScene(snapshot.activeProject.projectId, newSceneChapterId, newSceneTitle.trim());
      setNewSceneTitle("");
      onSelectScene(result.scene.sceneId);
    });
  };

  const renameChapter = (chapterId: string) => {
    if (!editingChapterTitle.trim()) return;
    void run(async (current) => {
      const head = current.branches.find((branch) => branch.branchId === current.activeProject.activeBranchId)?.headRevisionId;
      if (!head) throw new Error("当前作品版本不可用，请重试。");
      await api.renameChapter(chapterId, editingChapterTitle.trim(), head);
      setEditingChapterId(null);
    });
  };

  const onNodesChange = (changes: NodeChange<StoryNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    if (changes.some((change) => change.type === "position" && change.dragging)) setLayoutNote(true);
  };

  const runPlotIdeate = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const targetToSceneId =
        ideateToSceneId ||
        snapshot.scenes.find((s) => s.sceneId !== activeScene?.sceneId)?.sceneId ||
        activeScene?.sceneId;
      const result = await api.plotIdeate({
        projectId: snapshot.activeProject.projectId,
        mode: ideateMode,
        ...(activeScene ? { sceneId: activeScene.sceneId } : {}),
        ...(ideateMode === "bridge_scenes" && targetToSceneId ? { toSceneId: targetToSceneId } : {}),
        ...(ideateMode === "chapter_breakdown" && ideateChapterId ? { chapterId: ideateChapterId } : {}),
        ...(ideateMode === "scene_brainstorm" ? { fieldTarget: ideateFieldTarget } : {}),
        ...(ideatePrompt.trim() ? { prompt: ideatePrompt.trim() } : {}),
      });
      setIdeateResult(result);
      if (result.scenes) {
        setEditableScenes(result.scenes);
        setSelectedProposalIds(result.scenes.map((s) => s.proposalId));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 情节推演生成失败");
    } finally {
      setBusy(false);
    }
  };

  const applyProposedScenes = () => {
    const selected = editableScenes.filter((s) => selectedProposalIds.includes(s.proposalId));
    if (!selected.length) {
      setError("请至少勾选一张要加入大纲的场景卡");
      return;
    }
    void run(async (current) => {
      const head = current.branches.find((branch) => branch.branchId === current.activeProject.activeBranchId)?.headRevisionId;
      if (!head) throw new Error("当前作品版本不可用");
      const adopted = await api.applyPlotIdeation({
        projectId: snapshot.activeProject.projectId,
        baseRevisionId: head,
        // 掺入本批生成产物 ID：proposalId（scene-1 等）跨批次重复不会撞幂等键。
        acceptanceId: `plot_${ideateMode}_${ideateResult?.artifactId ?? "legacy"}_${selected.map((s) => s.proposalId).sort().join("_")}`,
        mode: ideateMode,
        ...(activeScene && (ideateMode === "next_scene" || ideateMode === "bridge_scenes") ? { sceneId: activeScene.sceneId } : {}),
        ...(ideateMode === "chapter_breakdown" && ideateChapterId ? { chapterId: ideateChapterId } : {}),
        scenes: selected,
      });
      setIdeateResult(null);
      setEditableScenes([]);
      setNote(`已将 ${adopted.scenes.length} 张场景卡加入大纲`);
    });
  };

  const applyFieldOption = (value: string) => {
    if (!activeScene) return;
    void run(async (current) => {
      const head = current.branches.find((branch) => branch.branchId === current.activeProject.activeBranchId)?.headRevisionId;
      if (!head) throw new Error("当前作品版本不可用");
      await api.applyPlotIdeation({
        projectId: snapshot.activeProject.projectId,
        baseRevisionId: head,
        // 同一字段可反复推敲：掺入所选项值使不同内容互不冲突，相同内容重试幂等。
        acceptanceId: `plot_field_${activeScene.sceneId}_${ideateFieldTarget}_${value.slice(0, 40)}`,
        mode: "scene_brainstorm",
        sceneId: activeScene.sceneId,
        fieldTarget: ideateFieldTarget,
        fieldValue: value,
      });
      setIdeateResult(null);
      setNote(`已更新「${activeScene.title}」的${ideateFieldTarget === "goal" ? "目标" : ideateFieldTarget === "conflict" ? "阻碍" : "摘要"}`);
    });
  };

  return (
    <div className="canvas-page">
      <header className="page-toolbar">
        <div>
          <p className="eyebrow">STORY MAP · {graph.revisionId.slice(0, 10)}</p>
          <h1>故事画布</h1>
          <p>看清故事如何发生，也保留尚未选择的岔路。</p>
        </div>
        <div className="toolbar-actions">
          <button className="button primary small" onClick={() => setIdeateOpen((o) => !o)}>
            <Wand2 size={14} />
            {ideateOpen ? "收起情节推演" : "AI 局部情节推演"}
          </button>
          <button className="button secondary" onClick={onOpenGuide}>
            <Sparkles size={14} />
            交互式大纲
          </button>
          <div className="segmented-control">
            <button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
              <Network size={14} />
              情节图
            </button>
            <button className={mode === "outline" ? "active" : ""} onClick={() => setMode("outline")}>
              <LayoutList size={14} />
              大纲
            </button>
            <button className={mode === "timeline" ? "active" : ""} onClick={() => setMode("timeline")}>
              <Clock3 size={14} />
              时间轴
            </button>
          </div>
          <button className="button ghost small outline-toggle" onClick={() => setOutlineOpen(open => !open)}>
            <LayoutList size={14} />
            {outlineOpen ? "收起故事结构" : "故事结构"}
          </button>
          <button className="button ghost small" onClick={() => setInspectorOpen((open) => !open)}>
            <Scan size={14} />
            {inspectorOpen ? "收起检查器" : "场景检查器"}
          </button>
          <span className="branch-chip">
            <GitBranch size={15} />
            {snapshot.branches.find((branch) => branch.branchId === snapshot.activeProject.activeBranchId)?.name ?? "主稿"}
          </span>
        </div>
      </header>

      {error && <p className="inline-note error">{error}</p>}
      {note && (
        <p className="inline-note" role="status">
          <Check size={13} />
          {note}
        </p>
      )}

      {ideateOpen && (
        <section className="note-composer" style={{ margin: "0 0 14px 0" }} aria-label="AI局部情节推演工作台">
          <div className="note-composer-heading">
            <Wand2 size={18} />
            <div>
              <strong>AI 局部情节推演（基于当前场景：{activeScene?.title ?? "未选"}）</strong>
              <p>支持承接前场生成下一场、两场之间过渡桥接、单场冲突/目标急救，以及单章拆细纲。</p>
            </div>
            <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
              {(
                [
                  { id: "next_scene", label: "承接下一场" },
                  { id: "bridge_scenes", label: "补全中间过渡" },
                  { id: "scene_brainstorm", label: "单场字段急救" },
                  { id: "chapter_breakdown", label: "单章拆细纲" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  className={`button small ${ideateMode === item.id ? "primary" : "ghost"}`}
                  onClick={() => {
                    setIdeateMode(item.id);
                    setIdeateResult(null);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            {ideateMode === "bridge_scenes" && (
              <label className="field-label">
                <span>桥接目标场景（终点）</span>
                <select
                  aria-label="桥接终点场景"
                  value={ideateToSceneId}
                  onChange={(e) => setIdeateToSceneId(e.target.value)}
                >
                  {snapshot.scenes.map((sc) => (
                    <option key={sc.sceneId} value={sc.sceneId}>
                      {sc.title}（第 {sc.narrationOrder} 场）
                    </option>
                  ))}
                </select>
              </label>
            )}
            {ideateMode === "chapter_breakdown" && (
              <label className="field-label">
                <span>目标拆解章节</span>
                <select
                  aria-label="拆细纲目标章节"
                  value={ideateChapterId}
                  onChange={(e) => setIdeateChapterId(e.target.value)}
                >
                  {snapshot.chapters.map((ch) => (
                    <option key={ch.chapterId} value={ch.chapterId}>
                      {ch.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {ideateMode === "scene_brainstorm" && (
              <label className="field-label">
                <span>要急救的字段</span>
                <select
                  aria-label="单场急救目标字段"
                  value={ideateFieldTarget}
                  onChange={(e) => setIdeateFieldTarget(e.target.value as "goal" | "conflict" | "summary")}
                >
                  <option value="conflict">阻碍（conflict）</option>
                  <option value="goal">场景目标（goal）</option>
                  <option value="summary">预期结果/摘要（summary）</option>
                </select>
              </label>
            )}
            <label className="field-label">
              <span>补充推演意图（可选）</span>
              <input
                aria-label="情节推演补充要求"
                value={ideatePrompt}
                onChange={(e) => setIdeatePrompt(e.target.value)}
                placeholder="例如：希望引入邻铺修表匠作为知情人 / 节奏紧凑一些"
              />
            </label>
          </div>

          <div className="note-composer-actions">
            <span>所有生成结果先作为提案展示，由你勾选或编辑后经 ChangeSet 写入修订</span>
            <button className="button primary" disabled={busy} onClick={() => void runPlotIdeate()}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
              生成情节提案
            </button>
          </div>

          {ideateResult?.fieldOptions && (
            <div className="fact-grid" style={{ marginTop: 10 }}>
              {ideateResult.fieldOptions.map((opt) => (
                <div key={opt.optionId} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <strong>{opt.label}</strong>
                    <Badge tone="amber">{ideateResult.fieldTarget}</Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: 13 }}>{opt.value}</p>
                  <small>{opt.rationale}</small>
                  <button
                    className="button primary small"
                    disabled={busy}
                    onClick={() => applyFieldOption(opt.value)}
                  >
                    <Check size={12} />
                    填入并保存此项
                  </button>
                </div>
              ))}
            </div>
          )}

          {editableScenes.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="fact-grid">
                {editableScenes.map((sc, idx) => {
                  const checked = selectedProposalIds.includes(sc.proposalId);
                  return (
                    <div key={sc.proposalId} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setSelectedProposalIds((prev) =>
                                e.target.checked ? [...prev, sc.proposalId] : prev.filter((id) => id !== sc.proposalId),
                              )
                            }
                          />
                          提案场景 {idx + 1}
                        </label>
                        {sc.differenceNote && <Badge tone="amber">{sc.differenceNote}</Badge>}
                      </div>
                      <input
                        aria-label={`提案场景标题 ${idx + 1}`}
                        value={sc.title}
                        onChange={(e) =>
                          setEditableScenes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, title: e.target.value } : item)),
                          )
                        }
                      />
                      <input
                        aria-label={`提案场景目标 ${idx + 1}`}
                        value={sc.goal}
                        placeholder="场景目标"
                        onChange={(e) =>
                          setEditableScenes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, goal: e.target.value } : item)),
                          )
                        }
                      />
                      <input
                        aria-label={`提案场景阻碍 ${idx + 1}`}
                        value={sc.conflict}
                        placeholder="场景阻碍"
                        onChange={(e) =>
                          setEditableScenes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, conflict: e.target.value } : item)),
                          )
                        }
                      />
                      <textarea
                        aria-label={`提案场景摘要 ${idx + 1}`}
                        rows={2}
                        value={sc.summary}
                        placeholder="预期结果/摘要"
                        onChange={(e) =>
                          setEditableScenes((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, summary: e.target.value } : item)),
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="button ghost small" onClick={() => setEditableScenes([])}>
                  取消
                </button>
                <button
                  className="button primary"
                  disabled={busy || selectedProposalIds.length === 0}
                  onClick={applyProposedScenes}
                >
                  <Check size={14} />
                  将勾选的 {selectedProposalIds.length} 场加入大纲
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <div className={`canvas-workspace ${inspectorOpen ? "" : "inspector-closed"}`}>
        <aside className={`canvas-outline ${outlineOpen ? "outline-open" : ""}`}>
          <div className="pane-heading">
            <span>故事结构</span>
            <Badge>{snapshot.scenes.length}</Badge>
          </div>
          <div className="outline-volume">
            <span>当前作品</span>
            <strong>{snapshot.activeProject.title}</strong>
          </div>
          <div className="structure-create">
            <input
              aria-label="新章节标题"
              value={newChapterTitle}
              onChange={(event) => setNewChapterTitle(event.target.value)}
              placeholder="新章节标题"
            />
            <button
              className="button ghost small"
              disabled={busy || !newChapterTitle.trim()}
              onClick={addChapter}
            >
              <Plus size={13} />
              新建章节
            </button>
          </div>
          {snapshot.chapters.map((chapter) => (
            <section key={chapter.chapterId}>
              <div className="outline-chapter-row">
                {editingChapterId === chapter.chapterId ? (
                  <>
                    <input
                      aria-label="章节标题"
                      value={editingChapterTitle}
                      onChange={(event) => setEditingChapterTitle(event.target.value)}
                    />
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => renameChapter(chapter.chapterId)}
                    >
                      保存
                    </button>
                    <button className="text-button" onClick={() => setEditingChapterId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <p className="outline-chapter">{chapter.title}</p>
                    <button
                      className="icon-button"
                      aria-label={`编辑章节 ${chapter.title}`}
                      onClick={() => {
                        setEditingChapterId(chapter.chapterId);
                        setEditingChapterTitle(chapter.title);
                      }}
                    >
                      ✎
                    </button>
                  </>
                )}
              </div>
              {snapshot.scenes
                .filter((scene) => scene.chapterId === chapter.chapterId)
                .map((scene) => (
                  <button
                    key={scene.sceneId}
                    className={scene.sceneId === activeSceneId ? "active" : ""}
                    onClick={() => { setActiveSceneId(scene.sceneId); setOutlineOpen(false); }}
                  >
                    <span>{String(scene.narrationOrder).padStart(2, "0")}</span>
                    {scene.title}
                    <i className={`scene-status-mark ${scene.status}`} />
                  </button>
                ))}
            </section>
          ))}
          <div className="structure-create scene-create">
            <input
              aria-label="新场景标题"
              value={newSceneTitle}
              onChange={(event) => setNewSceneTitle(event.target.value)}
              placeholder="新场景标题"
            />
            <select
              aria-label="新场景所属章节"
              value={newSceneChapterId}
              onChange={(event) => setNewSceneChapterId(event.target.value)}
            >
              {snapshot.chapters.map((chapter) => (
                <option key={chapter.chapterId} value={chapter.chapterId}>
                  {chapter.title}
                </option>
              ))}
            </select>
            <button
              className="button secondary small"
              disabled={busy || !newSceneTitle.trim() || !newSceneChapterId}
              onClick={addScene}
            >
              <Plus size={13} />
              新建场景
            </button>
          </div>
          <div className="route-card">
            <Route size={16} />
            <div>
              <strong>故事路线</strong>
              <p>{snapshot.routes.map((route) => route.name).join(" · ")}</p>
            </div>
          </div>
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
              <div className="canvas-legend">
                <span>
                  <i className="legend-line cause" />
                  因果
                </span>
                <span>
                  <i className="legend-line next" />
                  先后
                </span>
                <span>
                  <i className="legend-line setup" />
                  铺垫 / 回收
                </span>
              </div>
              {layoutNote && (
                <div className="layout-note">
                  <Scan size={13} />
                  仅调整视图布局，不改变章节顺序或故事事实
                  <button onClick={() => setLayoutNote(false)}>知道了</button>
                </div>
              )}
            </ReactFlow>
          )}
          {mode === "outline" && (
            <OutlineView snapshot={snapshot} activeSceneId={activeSceneId} onSelect={setActiveSceneId} />
          )}
          {mode === "timeline" && (
            <TimelineView snapshot={snapshot} activeSceneId={activeSceneId} onSelect={setActiveSceneId} />
          )}
        </main>

        <aside className={`canvas-inspector ${inspectorOpen ? "inspector-open" : ""}`}>
          {activeScene ? (
            <>
              <p className="eyebrow">SCENE {String(activeScene.narrationOrder).padStart(2, "0")}</p>
              <h2>{activeScene.title}</h2>
              <div className="inspector-tags">
                <Badge tone="green">{activeScene.status === "final" ? "已定稿" : activeScene.status === "review" ? "待审阅" : activeScene.status === "planned" ? "已有计划" : activeScene.status === "draft" ? "草稿" : "写作中"}</Badge>
                <Badge>{activeScene.pov ?? "视角待定"}</Badge>
              </div>
              <p className="inspector-summary">
                {activeScene.summary || "这张场景卡还很轻，只留下真正确定的内容即可。"}
              </p>
              <dl className="scene-metadata">
                <div>
                  <dt>场景目标</dt>
                  <dd>{activeScene.goal || "尚未确定"}</dd>
                </div>
                <div>
                  <dt>阻碍</dt>
                  <dd>{activeScene.conflict || "尚未确定"}</dd>
                </div>
                <div>
                  <dt>故事时间</dt>
                  <dd>{activeScene.storyTime ?? "未知"}</dd>
                </div>
                <div>
                  <dt>叙述顺序</dt>
                  <dd>第 {activeScene.narrationOrder} 位</dd>
                </div>
              </dl>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                <button
                  className="button ghost small"
                  onClick={() => {
                    setIdeateOpen(true);
                    setIdeateMode("next_scene");
                  }}
                >
                  <Sparkles size={13} />
                  AI 构思下一场
                </button>
                <button
                  className="button ghost small"
                  onClick={() => {
                    setIdeateOpen(true);
                    setIdeateMode("scene_brainstorm");
                  }}
                >
                  <Wand2 size={13} />
                  AI 急救阻碍/目标
                </button>
              </div>
              <div className="plan-notice">
                <Sparkles size={14} />
                <p>选定计划是“拟发生”的创作方向，不会自动写成已发生事实。</p>
              </div>
              <button className="button primary full" onClick={() => onSelectScene(activeScene.sceneId)}>
                打开这个场景
                <ArrowRight size={15} />
              </button>
              <SceneStructureEditor
                key={activeScene.sceneId}
                scene={activeScene}
                snapshot={snapshot}
                onBeforeWrite={onBeforeWrite}
                onChanged={onChanged}
              />
            </>
          ) : (
            <p>选择一张场景卡查看详情。</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function SceneStructureEditor({
  scene,
  snapshot,
  onChanged,
  onBeforeWrite,
}: {
  scene: Scene;
  snapshot: WorkspaceSnapshot;
  onChanged: () => Promise<unknown>;
  onBeforeWrite: () => Promise<WorkspaceSnapshot>;
}) {
  const [title, setTitle] = useState(scene.title);
  const [pov, setPov] = useState(scene.pov ?? "");
  const [storyTime, setStoryTime] = useState(scene.storyTime ?? "");
  const [chapterId, setChapterId] = useState(scene.chapterId);
  const [order, setOrder] = useState(scene.narrationOrder);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const write = async (action: (current: Scene, head: string) => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const latest = await onBeforeWrite();
      const current = latest.scenes.find((item) => item.sceneId === scene.sceneId && item.projectId === scene.projectId);
      const head = latest.branches.find((branch) => branch.branchId === latest.activeProject.activeBranchId)?.headRevisionId;
      if (!current || !head) throw new Error("场景已变化，请重新打开后重试。");
      await action(current, head);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "结构尚未保存，请重试");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const saveMetadata = () =>
    write((current) =>
      api.saveSceneStructure(current, {
        title: title.trim(),
        pov: pov.trim(),
        storyTime: storyTime.trim(),
      }),
    );
  const move = () => write((current, head) => api.moveScene(current.sceneId, chapterId, order, head));
  const characterOptions = snapshot.elements.filter((el) => el.type === "character");
  return (
    <section className="scene-structure-editor">
      <h3>场景结构与时空视角</h3>
      {error && (
        <p className="inline-note error" role="alert">
          {error} · 编辑内容已保留，可再次保存。
        </p>
      )}
      <label>
        场景标题
        <input
          aria-label="场景标题"
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className="structure-move-grid">
        <label>
          视角人物（POV）
          <input
            aria-label="场景视角人物"
            list={`pov-options-${scene.sceneId}`}
            value={pov}
            disabled={busy}
            placeholder="例如：阿禾"
            onChange={(event) => setPov(event.target.value)}
          />
          <datalist id={`pov-options-${scene.sceneId}`}>
            {characterOptions.map((ch) => (
              <option key={ch.entityId} value={ch.name} />
            ))}
          </datalist>
        </label>
        <label>
          故事时间（storyTime）
          <input
            aria-label="场景故事时间"
            value={storyTime}
            disabled={busy}
            placeholder="如：1 或 第一夜"
            onChange={(event) => setStoryTime(event.target.value)}
          />
        </label>
      </div>
      <button className="button ghost small" disabled={busy || !title.trim()} onClick={() => void saveMetadata()}>
        保存标题与视角/时间
      </button>
      <div className="structure-move-grid">
        <label>
          所属章节
          <select
            aria-label="场景所属章节"
            value={chapterId}
            disabled={busy}
            onChange={(event) => setChapterId(event.target.value)}
          >
            {snapshot.chapters.map((chapter) => (
              <option key={chapter.chapterId} value={chapter.chapterId}>
                {chapter.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          叙述顺序
          <input
            aria-label="场景叙述顺序"
            type="number"
            min={1}
            value={order}
            disabled={busy}
            onChange={(event) => setOrder(Math.max(1, Number(event.target.value)))}
          />
        </label>
      </div>
      <button className="button secondary small" disabled={busy || order < 1} onClick={() => void move()}>
        保存结构
      </button>
    </section>
  );
}

function OutlineView({
  snapshot,
  activeSceneId,
  onSelect,
}: {
  snapshot: WorkspaceSnapshot;
  activeSceneId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="alternative-canvas-view">
      <div className="view-caption">
        <LayoutList size={16} />
        <span>大纲列表与画布共享同一场景对象</span>
      </div>
      {snapshot.chapters.map((chapter) => (
        <section className="outline-list-chapter" key={chapter.chapterId}>
          <h2>{chapter.title}</h2>
          {snapshot.scenes
            .filter((scene) => scene.chapterId === chapter.chapterId)
            .map((scene) => (
              <button
                key={scene.sceneId}
                className={scene.sceneId === activeSceneId ? "active" : ""}
                onClick={() => onSelect(scene.sceneId)}
              >
                <span>{String(scene.narrationOrder).padStart(2, "0")}</span>
                <div>
                  <strong>{scene.title}</strong>
                  <p>{scene.summary}</p>
                </div>
                <Badge>{scene.status}</Badge>
              </button>
            ))}
        </section>
      ))}
    </div>
  );
}

function TimelineView({
  snapshot,
  activeSceneId,
  onSelect,
}: {
  snapshot: WorkspaceSnapshot;
  activeSceneId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="alternative-canvas-view">
      <div className="view-caption">
        <Clock3 size={16} />
        <span>故事时间不等于阅读顺序；未知时间保留在原位</span>
      </div>
      <div className="timeline-axis">
        {[...snapshot.scenes]
          .sort((a, b) => (a.storyTime ?? "未知").localeCompare(b.storyTime ?? "未知", "zh-CN"))
          .map((scene) => (
            <button
              key={scene.sceneId}
              className={scene.sceneId === activeSceneId ? "active" : ""}
              onClick={() => onSelect(scene.sceneId)}
            >
              <span className="timeline-dot">
                <Circle size={11} />
              </span>
              <div>
                <small>
                  {scene.storyTime ?? "时间未知"} · 阅读位置 {scene.narrationOrder}
                </small>
                <strong>{scene.title}</strong>
                <p>{scene.summary}</p>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}
