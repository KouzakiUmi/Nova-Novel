import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthoringSelection,
  GenerationProgress,
  GenerationReceipt,
  GenerationRequest,
  Scene,
  SelectionAction,
  WorkspaceSnapshot,
} from "@nova-novel/shared";
import { api } from "./lib/api";
import { AppShell, type SaveStatus, type ViewId } from "./components/AppShell";
import { EditorView } from "./components/EditorView";
import { StartView } from "./components/StartView";
import { StoryCanvas } from "./components/StoryCanvas";
import { ElementsView } from "./components/ElementsView";
import { WorkflowView } from "./components/WorkflowView";
import { RevisionsView } from "./components/RevisionsView";
import { ContextView } from "./components/ContextView";
import { SettingsView } from "./components/SettingsView";
import { Toast } from "./components/UI";
import type { NewProjectInput } from "./components/NewProjectDialog";
import { GuidedOutlineDialog } from "./components/GuidedOutlineDialog";
import { GuidedWorkflowDialog } from "./components/GuidedWorkflowDialog";

export interface GenerationHandle {
  receipt: Promise<GenerationReceipt>;
  idempotencyKey: string;
}

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<ViewId>("start");
  const [selectedSceneId, setSelectedSceneId] = useState<string>("");
  const [selectedElementId, setSelectedElementId] = useState<string>("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [workflowGuideOpen, setWorkflowGuideOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  /** 当前分支头；自动保存串行执行并总以最新头为基准。 */
  const headRef = useRef<string>("");
  const saveSeq = useRef(0);
  const projectIdRef = useRef("");
  const projectSeq = useRef(0);

  useEffect(() => {
    const head = snapshot?.branches.find((branch) => branch.branchId === snapshot.activeProject.activeBranchId)?.headRevisionId;
    if (head) headRef.current = head;
  }, [snapshot]);

  const refresh = useCallback(async (projectId?: string) => {
    try {
      if (projectId) projectIdRef.current = projectId;
      const next = await api.bootstrap(projectIdRef.current || undefined);
      projectIdRef.current = next.activeProject.projectId;
      setSnapshot(next);
      setSelectedSceneId((current) => (current && next.scenes.some((scene) => scene.sceneId === current) ? current : next.scenes[0]?.sceneId || ""));
      setSelectedElementId((current) => (current && next.elements.some((element) => element.entityId === current) ? current : next.elements[0]?.entityId || ""));
      setError("");
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接本机项目服务");
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedScene = useMemo(
    () => snapshot?.scenes.find((scene) => scene.sceneId === selectedSceneId) ?? snapshot?.scenes[0],
    [snapshot, selectedSceneId],
  );

  const run = useCallback(async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) setToast(success);
      setError("");
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "操作未完成，请稍后重试");
    } finally {
      setBusy(false);
    }
  }, []);

  /** 写入类操作前等待在途自动保存，并以服务端最新作品头为基准。 */
  const latest = useCallback(async () => {
    await pendingSave.current.catch(() => undefined);
    const next = await api.bootstrap(projectIdRef.current || undefined);
    projectIdRef.current = next.activeProject.projectId;
    setSnapshot(next);
    return next;
  }, []);

  const activateProject = useCallback(async (projectId: string) => {
    await pendingSave.current.catch(() => undefined);
    const seq = ++projectSeq.current;
    saveSeq.current += 1;
    const next = await api.bootstrap(projectId);
    if (seq !== projectSeq.current) return;
    projectIdRef.current = projectId;
    headRef.current = next.branches.find((branch) => branch.branchId === next.activeProject.activeBranchId)?.headRevisionId ?? "";
    setSnapshot(next);
    setSelectedSceneId(next.scenes[0]?.sceneId ?? "");
    setSelectedElementId(next.elements[0]?.entityId ?? "");
    setGuideOpen(false);
    setWorkflowGuideOpen(false);
  }, []);

  const createProject = useCallback(async (input: NewProjectInput) => {
    await pendingSave.current.catch(() => undefined);
    const seq = ++projectSeq.current;
    saveSeq.current += 1;
    const next = await api.createProject({ title: input.title, premise: input.premise, ...(input.body ? { body: input.body } : {}) });
    if (seq !== projectSeq.current) return;
    const projectId = next.activeProject.projectId;
    projectIdRef.current = projectId;
    headRef.current = next.branches.find((branch) => branch.branchId === next.activeProject.activeBranchId)?.headRevisionId ?? "";
    setSnapshot(next);
    setSelectedSceneId(next.scenes[0]?.sceneId ?? "");
    setSelectedElementId("");
    setGuideOpen(false);
    setWorkflowGuideOpen(false);
    setView(input.destination);
  }, []);

  const handleSaveScene = useCallback(async (scene: Scene) => {
    setSaveStatus("saving");
    saveSeq.current += 1;
    const task = pendingSave.current.catch(() => undefined).then(() => api.saveScene({ ...scene, baseRevisionId: headRef.current || scene.baseRevisionId })).then((result) => {
      if (projectIdRef.current === scene.projectId) headRef.current = result.revisionId;
      setSnapshot((current) => {
        if (!current || current.activeProject.projectId !== scene.projectId) return current;
        const branchId = current.activeProject.activeBranchId;
        return {
          ...current,
          scenes: current.scenes.map((item) => item.sceneId === result.scene.sceneId ? result.scene : { ...item, baseRevisionId: result.revisionId }),
          branches: current.branches.map((branch) => branch.branchId === branchId ? { ...branch, headRevisionId: result.revisionId } : branch),
        };
      });
      setSaveStatus("saved");
      return result;
    }).catch((cause: unknown) => {
      setSaveStatus("error");
      throw cause;
    });
    pendingSave.current = task;
    await task;
    // 版本列表等派生信息后台刷新；期间若又有保存，丢弃这份较旧的快照。
    const seq = saveSeq.current;
    void api.bootstrap(scene.projectId).then((next) => { if (seq === saveSeq.current && projectIdRef.current === scene.projectId) setSnapshot(next); }).catch(() => undefined);
  }, []);

  const handleGenerate = useCallback((request: GenerationRequest): GenerationHandle => {
    const idempotencyKey = request.idempotencyKey;
    return { idempotencyKey, receipt: api.generate(request) };
  }, []);

  const pollProgress = useCallback((idempotencyKey: string): Promise<GenerationProgress> => api.progress(idempotencyKey), []);
  const cancelGeneration = useCallback(async (idempotencyKey: string) => { await api.cancelGeneration(idempotencyKey); }, []);

  if (!snapshot) {
    return (
      <main className="connection-screen">
        <div className="connection-mark" aria-hidden="true">N</div>
        <p className="eyebrow">NOVA NOVEL · LOCAL STUDIO</p>
        <h1>{error ? "作品还安好，只是暂时没连上。" : "正在打开你的编辑室…"}</h1>
        <p>{error || "正在读取本机作品、场景与创作记录。"}</p>
        {error && <button className="button primary" onClick={() => void refresh()}>重新连接</button>}
        <span className="connection-note">本机项目服务 · 127.0.0.1</span>
      </main>
    );
  }

  const updateDraft = (draft: AuthoringSelection) => {
    setSnapshot((current) => current ? { ...current, authoringDraft: draft } : current);
  };

  const ideasMode = snapshot.connection.state === "connected" ? "pi" as const : "example" as const;

  const handleIdeas = async (input: string, mode: "example" | "pi" = ideasMode) => {
    const result = await api.ideas(snapshot.activeProject.projectId, input, mode);
    updateDraft(result.draft);
  };

  const handleSelection = async (action: SelectionAction) => {
    const draft = snapshot.authoringDraft;
    const result = await api.selection(draft.draftId, draft.selectionVersion, action);
    updateDraft(result.draft);
  };

  const handleAdopt = async () => {
    const current = await latest();
    const draft = current.authoringDraft;
    const headRevisionId = current.branches.find((branch) => branch.branchId === draft.branchId)?.headRevisionId
      ?? draft.baseRevisionId;
    const next = await api.adopt(draft.draftId, draft.selectionVersion, headRevisionId);
    setSnapshot(next);
    setSelectedSceneId(next.scenes[0]?.sceneId ?? "");
    setView("write");
  };

  const openScene = (sceneId: string) => {
    setSelectedSceneId(sceneId);
    setView("write");
  };

  return (
    <AppShell
      snapshot={snapshot}
      view={view}
      onViewChange={setView}
      focusMode={focusMode}
      onFocusMode={() => setFocusMode((value) => !value)}
      onOpenStart={() => setView("start")}
      onOpenScene={openScene}
      onProjectChange={(projectId) => run(() => activateProject(projectId), "已打开作品")}
      saveStatus={saveStatus}
    >
      {view === "start" && (
        <StartView
          key={snapshot.activeProject.projectId}
          snapshot={snapshot}
          busy={busy}
          aiReady={snapshot.connection.state === "connected"}
          onGenerate={(input) => run(async () => {
            await handleIdeas(input);
          }, ideasMode === "pi" ? "新的点子已经放到卡片桌上" : "已放上示例卡片；接入模型后会按你的点子生成")}
          onGenerateExamples={() => run(async () => {
            await handleIdeas("", "example");
          }, "已放上三张示例卡，可以选择、改写或换成自己的点子")}
          onCreateProject={async (input) => {
            let created = false;
            await run(async () => { await createProject(input); created = true; }, input.destination === "start" ? "自己的作品已建好，继续选择方向" : "自己的第一场已建好");
            return created;
          }}
          onSelection={(action) => run(() => handleSelection(action))}
          onAdopt={() => run(handleAdopt, "选定计划已进入作品，正文仍由你决定")}
          onDirectWrite={() => setView("write")}
          onOpenGuide={() => setGuideOpen(true)}
          onOpenSettings={() => setView("settings")}
          onRehearse={async (request) => {
            const receipt = await handleGenerate(request).receipt;
            if (["failed", "cancelled", "interrupted"].includes(receipt.task.state)) {
              throw new Error(receipt.task.error ?? "试演未完成");
            }
            const result = receipt.task.result;
            if (typeof result === "string") return result;
            if (result && typeof result === "object" && "text" in result && typeof result.text === "string") return result.text;
            throw new Error("任务已结束，但没有可显示的试演文本");
          }}
        />
      )}
      {view === "write" && selectedScene && (
        <EditorView
          snapshot={snapshot}
          scene={selectedScene}
          focusMode={focusMode}
          onSelectScene={setSelectedSceneId}
          onDirty={() => setSaveStatus("dirty")}
          onSave={async (scene) => {
            try {
              await handleSaveScene(scene);
            } catch (cause) {
              setToast(cause instanceof Error ? `尚未保存：${cause.message}` : "尚未保存，请重试");
              throw cause;
            }
          }}
          onGenerate={handleGenerate}
          onProgress={pollProgress}
          onCancel={cancelGeneration}
          onOpenElement={(entityId) => {
            setSelectedElementId(entityId);
            setView("elements");
          }}
          onOpenReview={() => setView("revisions")}
          onOpenSettings={() => setView("settings")}
        />
      )}
      {view === "story" && (
        <StoryCanvas
          snapshot={snapshot}
          selectedSceneId={selectedScene?.sceneId ?? ""}
          onSelectScene={openScene}
          onOpenGuide={() => setGuideOpen(true)}
        />
      )}
      {view === "elements" && (
        <ElementsView
          snapshot={snapshot}
          selectedElementId={selectedElementId}
          onSelect={setSelectedElementId}
          onOpenScene={openScene}
        />
      )}
      {view === "context" && <ContextView snapshot={snapshot} {...(selectedScene ? { scene: selectedScene } : {})} onOpenScene={openScene} />}
      {view === "workflow" && (
        <WorkflowView
          snapshot={snapshot}
          {...(selectedScene ? { scene: selectedScene } : {})}
          onRun={(workflowVersionId) => run(async () => {
            if (!selectedScene) return;
            await latest();
            await api.runWorkflow(workflowVersionId, snapshot.activeProject.projectId, selectedScene.sceneId);
            await refresh();
          }, "工作流已开始，已完成的节点会自动保留")}
          onDecide={(runId, todoId, answer, inputHash) => run(async () => {
            await api.decideWorkflow(runId, todoId, answer, inputHash);
            await refresh();
          }, "审阅决定已记录")}
          onCancelRun={(runId) => run(async () => {
            await api.cancelWorkflow(runId);
            await refresh();
          }, "已取消运行，已完成的产物仍保留")}
          onRefresh={() => void refresh()}
          onOpenGuide={() => setWorkflowGuideOpen(true)}
        />
      )}
      {view === "revisions" && (
        <RevisionsView
          snapshot={snapshot}
          onCreateVersion={(name) => run(async () => {
            await latest();
            const next = await api.createRevision(snapshot.activeProject.projectId, name);
            setSnapshot(next);
          }, "命名版本已保存")}
          onRestore={(revisionId) => run(async () => {
            const current = await latest();
            const branch = current.branches.find((item) => item.branchId === current.activeProject.activeBranchId);
            if (!branch) throw new Error("当前分支不可用");
            const next = await api.restore(current.activeProject.projectId, revisionId, branch.headRevisionId);
            setSnapshot(next);
          }, "已创建恢复版本，恢复前的主稿仍保留")}
        />
      )}
      {view === "settings" && <SettingsView onChanged={() => void refresh()} onToast={setToast} />}
      {guideOpen && <GuidedOutlineDialog projectId={snapshot.activeProject.projectId} {...(snapshot.guide ? { session: snapshot.guide } : {})} aiReady={snapshot.connection.state === "connected"} onChanged={async () => { await refresh(); }} onClose={() => setGuideOpen(false)} onOpenSettings={() => { setGuideOpen(false); setView("settings"); }} />}
      {workflowGuideOpen && <GuidedWorkflowDialog projectId={snapshot.activeProject.projectId} {...(snapshot.workflowGuide ? { session: snapshot.workflowGuide } : {})} aiReady={snapshot.connection.state === "connected"} onChanged={async () => { await refresh(); }} onClose={() => setWorkflowGuideOpen(false)} onOpenSettings={() => { setWorkflowGuideOpen(false); setView("settings"); }} />}
      {toast && <Toast message={toast} onClose={() => setToast("")} />}
      {error && <button className="offline-banner" onClick={() => void refresh()}>{error} · 点击重连</button>}
    </AppShell>
  );
}
