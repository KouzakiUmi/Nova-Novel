import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSettingsView,
  AuthoringSelection,
  GenerationProgress,
  GenerationReceipt,
  GenerationRequest,
  Scene,
  SelectionAction,
  TaskKind,
  WorkspaceSnapshot,
} from "@nova-novel/shared";
import { api, ApiError } from "./lib/api";
import { applyAppearance, readAppearance } from "./lib/appearance";
import { AppShell, type SaveStatus, type ViewId } from "./components/AppShell";
import { EditorView } from "./components/EditorView";
import { StartView } from "./components/StartView";
import { StoryCanvas } from "./components/StoryCanvas";
import { ElementsView } from "./components/ElementsView";
import { WorkflowView } from "./components/WorkflowView";
import { RevisionsView } from "./components/RevisionsView";
import { ContextView } from "./components/ContextView";
import { NotesView } from "./components/NotesView";
import { SettingsView } from "./components/SettingsView";
import { Toast } from "./components/UI";
import type { NewProjectInput } from "./components/NewProjectDialog";
import { GuidedOutlineDialog } from "./components/GuidedOutlineDialog";
import { GuidedWorkflowDialog } from "./components/GuidedWorkflowDialog";
import { ProjectManagerDialog } from "./components/ProjectManagerDialog";

export interface GenerationHandle {
  receipt: Promise<GenerationReceipt>;
  idempotencyKey: string;
}

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<ViewId>("start");
  const [selectedSceneId, setSelectedSceneId] = useState<string>("");
  const [selectedElementId, setSelectedElementId] = useState<string>("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [toastTone, setToastTone] = useState<"success" | "error">("success");
  const [agentSettings, setAgentSettings] = useState<AgentSettingsView | null>(null);
  const agentSettingsRef = useRef<AgentSettingsView | null>(null);
  const routeSave = useRef<Promise<unknown>>(Promise.resolve());
  const [busy, setBusy] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [workflowGuideOpen, setWorkflowGuideOpen] = useState(false);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const draftsRef = useRef(new Map<string, { scene: Scene; state: SaveStatus; message: string }>());
  const [drafts, setDrafts] = useState([...draftsRef.current.entries()]);
  const [retryPreview, setRetryPreview] = useState<{ key: string; draft: Scene; latest: Scene; head: string } | null>(null);
  const notify = useCallback((message: string, tone: "success" | "error" = "success") => {
    setToastTone(tone);
    setToast(message);
  }, []);
  const draftKey = (scene: Scene) => `${scene.projectId}:${scene.sceneId}`;
  const publishDrafts = useCallback(() => {
    const entries = [...draftsRef.current.entries()];
    setDrafts(entries);
    setSaveStatus(entries.some(([, draft]) => draft.state === "error") ? "error" : entries.some(([, draft]) => draft.state === "saving") ? "saving" : entries.length ? "dirty" : "saved");
  }, []);
  const retainDraft = useCallback((scene: Scene) => {
    const key = draftKey(scene);
    const previous = draftsRef.current.get(key);
    draftsRef.current.set(key, { scene, state: previous?.state === "error" ? "error" : "dirty", message: previous?.message ?? "" });
    publishDrafts();
  }, [publishDrafts]);
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  /** 当前分支头；自动保存串行执行并总以最新头为基准。 */
  const headRef = useRef<string>("");
  const headsRef = useRef(new Map<string, string>());
  const flushEditorRef = useRef<(() => Promise<void>) | null>(null);
  const saveSeq = useRef(0);
  const projectIdRef = useRef("");
  const projectSeq = useRef(0);
  const refreshSeq = useRef(0);
  const beginSnapshot = useCallback((projectId = projectIdRef.current) => ({ projectId, activation: projectSeq.current, request: ++refreshSeq.current }), []);
  const commitSnapshot = useCallback((next: WorkspaceSnapshot, token: { projectId: string; activation: number; request: number }) => {
    if (token.activation !== projectSeq.current || token.request !== refreshSeq.current || (token.projectId && (projectIdRef.current !== token.projectId || next.activeProject.projectId !== token.projectId))) return false;
    projectIdRef.current = next.activeProject.projectId;
    const head = next.branches.find(branch => branch.branchId === next.activeProject.activeBranchId)?.headRevisionId ?? "";
    headsRef.current.set(next.activeProject.projectId, head);
    headRef.current = head;
    snapshotRef.current = next;
    setSnapshot(next);
    return true;
  }, []);

  const refresh = useCallback(async (projectId?: string) => {
    const targetProjectId = projectId ?? projectIdRef.current;
    if (targetProjectId && targetProjectId !== projectIdRef.current) return null;
    const token = beginSnapshot(targetProjectId);
    try {
      const next = await api.bootstrap(targetProjectId || undefined);
      if (!commitSnapshot(next, token)) return null;
      setSelectedSceneId((current) => (current && next.scenes.some((scene) => scene.sceneId === current) ? current : next.scenes[0]?.sceneId || ""));
      setSelectedElementId((current) => (current && next.elements.some((element) => element.entityId === current) ? current : next.elements[0]?.entityId || ""));
      setError("");
      return next;
    } catch (cause) {
      if (token.activation !== projectSeq.current || token.request !== refreshSeq.current) return null;
      setError(cause instanceof Error ? cause.message : "无法连接本机项目服务");
      return null;
    }
  }, [beginSnapshot, commitSnapshot]);

  useEffect(() => {
    const initial = JSON.stringify(readAppearance());
    void api.appearance().then(saved => { if (JSON.stringify(readAppearance()) === initial) applyAppearance(saved); }).catch(() => applyAppearance(readAppearance()));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshAgentSettings = useCallback(async () => {
    await routeSave.current.catch(() => undefined);
    const next = await api.agentSettings();
    agentSettingsRef.current = next;
    setAgentSettings(next);
    routeSave.current = Promise.resolve();
    return next;
  }, []);

  useEffect(() => { void refreshAgentSettings().catch(() => undefined); }, [refreshAgentSettings]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedScene = useMemo(
    () => snapshot?.scenes.find((scene) => scene.sceneId === selectedSceneId) ?? snapshot?.scenes[0],
    [snapshot, selectedSceneId],
  );

  const run = useCallback(async (action: () => Promise<void>, success?: string, propagate = false) => {
    setBusy(true);
    try {
      await action();
      if (success) notify(success);
      setError("");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "操作未完成，请稍后重试", "error");
      if (propagate) throw cause;
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const flushPending = useCallback(async () => {
    if (flushEditorRef.current) await flushEditorRef.current();
    await pendingSave.current;
    if ([...draftsRef.current.values()].some(draft => draft.scene.projectId === projectIdRef.current)) throw new Error("还有正文尚未保存，请先处理本地草稿。");
  }, []);
  const registerEditorFlush = useCallback((flush: (() => Promise<void>) | null) => { flushEditorRef.current = flush; }, []);

  /** 写入类操作前先刷新编辑器并等待在途自动保存。 */
  const latest = useCallback(async () => {
    const projectId = projectIdRef.current;
    const activation = projectSeq.current;
    if (snapshotRef.current?.activeProject.projectId !== projectId) throw new Error("正在切换作品，请稍后重试。");
    await flushPending();
    if (activation !== projectSeq.current || projectId !== projectIdRef.current) throw new Error("作品已切换，请在当前作品中重试。");
    const token = beginSnapshot(projectId);
    const next = await api.bootstrap(projectId || undefined);
    if (!commitSnapshot(next, token)) throw new Error("作品已更新，请重新操作。");
    return next;
  }, [beginSnapshot, commitSnapshot, flushPending]);

  const activateProject = useCallback(async (projectId: string) => {
    const seq = ++projectSeq.current;
    refreshSeq.current += 1;
    try { await flushPending(); } catch (cause) { notify(cause instanceof Error ? `本地草稿已保留：${cause.message}` : "未保存的正文已保留为本地草稿", "error"); }
    if (seq !== projectSeq.current) return;
    projectIdRef.current = projectId;
    const token = beginSnapshot(projectId);
    saveSeq.current += 1;
    let next: WorkspaceSnapshot;
    try { next = await api.bootstrap(projectId); }
    catch (cause) {
      if (seq === projectSeq.current) projectIdRef.current = snapshotRef.current?.activeProject.projectId ?? "";
      throw cause;
    }
    if (!commitSnapshot(next, token)) return;
    setSelectedSceneId(next.scenes[0]?.sceneId ?? "");
    setSelectedElementId(next.elements[0]?.entityId ?? "");
    setGuideOpen(false);
    setWorkflowGuideOpen(false);
  }, [beginSnapshot, commitSnapshot, flushPending, notify]);

  const createProject = useCallback(async (input: NewProjectInput) => {
    await flushPending();
    const seq = ++projectSeq.current;
    const token = beginSnapshot("");
    saveSeq.current += 1;
    const next = await api.createProject({ title: input.title, premise: input.premise, ...(input.body ? { body: input.body } : {}) });
    if (seq !== projectSeq.current || !commitSnapshot(next, token)) return;
    const projectId = next.activeProject.projectId;
    projectIdRef.current = projectId;
    headRef.current = next.branches.find((branch) => branch.branchId === next.activeProject.activeBranchId)?.headRevisionId ?? "";
    setSelectedSceneId(next.scenes[0]?.sceneId ?? "");
    setSelectedElementId("");
    setGuideOpen(false);
    setWorkflowGuideOpen(false);
    setView(input.destination);
  }, [beginSnapshot, commitSnapshot, flushPending]);

  const handleSaveScene = useCallback(async (scene: Scene, explicitRetry = false) => {
    const key = draftKey(scene);
    const previous = draftsRef.current.get(key);
    if (previous?.state === "error" && !explicitRetry) throw new Error(previous.message);
    draftsRef.current.set(key, { scene, state: "saving", message: "" });
    publishDrafts();
    saveSeq.current += 1;
    const activation = projectSeq.current;
    const token = scene.projectId === projectIdRef.current ? beginSnapshot(scene.projectId) : { projectId: scene.projectId, activation, request: refreshSeq.current };
    const task = pendingSave.current.then(() => undefined, () => undefined).then(async () => {
      const blocked = draftsRef.current.get(key);
      if (blocked?.state === "error") throw new Error(blocked.message);
      for (let attempt = 0; ; attempt += 1) {
        try { return await api.saveScene({ ...scene, baseRevisionId: headsRef.current.get(scene.projectId) || scene.baseRevisionId }); }
        catch (cause) {
          if (!(cause instanceof TypeError || cause instanceof ApiError && cause.status >= 500) || attempt >= 2) throw cause;
          await new Promise(resolve => window.setTimeout(resolve, 700 * 2 ** attempt));
        }
      }
    }).then((result) => {
      headsRef.current.set(scene.projectId, result.revisionId);
      if (projectIdRef.current === scene.projectId) headRef.current = result.revisionId;
      const current = snapshotRef.current;
      if (activation === projectSeq.current && current?.activeProject.projectId === scene.projectId && projectIdRef.current === scene.projectId) {
        const branchId = current.activeProject.activeBranchId;
        commitSnapshot({
          ...current,
          scenes: current.scenes.map((item) => item.sceneId === result.scene.sceneId ? result.scene : { ...item, baseRevisionId: result.revisionId }),
          branches: current.branches.map((branch) => branch.branchId === branchId ? { ...branch, headRevisionId: result.revisionId } : branch),
        }, token);
      }
      if (draftsRef.current.get(key)?.scene === scene) draftsRef.current.delete(key);
      publishDrafts();
      return result;
    }).catch((cause: unknown) => {
      const conflict = cause instanceof ApiError && cause.status === 409;
      const message = conflict ? "作品已被其他操作更新。正文草稿已保留，请读取最新版本后重试，或复制草稿。" : cause instanceof Error ? cause.message : "正文尚未保存，请重试";
      const draft = draftsRef.current.get(key);
      draftsRef.current.set(key, { scene: draft?.scene ?? scene, state: "error", message });
      publishDrafts();
      throw cause;
    });
    pendingSave.current = task;
    await task;
    // 版本列表等派生信息后台刷新；期间若又有保存，丢弃这份较旧的快照。
    const seq = saveSeq.current;
    if (activation === projectSeq.current && projectIdRef.current === scene.projectId) {
      const token = beginSnapshot(scene.projectId);
      void api.bootstrap(scene.projectId).then((next) => { if (seq === saveSeq.current) commitSnapshot(next, token); }).catch(cause => notify(cause instanceof Error ? `正文已保存，作品信息暂未刷新：${cause.message}` : "正文已保存，作品信息暂未刷新", "error"));
    }
  }, [beginSnapshot, commitSnapshot, publishDrafts, notify]);

  const retryDraft = async (key: string) => {
    const draft = draftsRef.current.get(key);
    if (!draft || draft.state === "saving") return;
    const next = await api.bootstrap(draft.scene.projectId);
    const current = next.scenes.find(scene => scene.sceneId === draft.scene.sceneId);
    if (!current) throw new Error("最新作品中没有这场正文，请先复制本地草稿。");
    if (draftsRef.current.get(key) !== draft) throw new Error("草稿已变化，请重新重试。");
    const head = next.branches.find(branch => branch.branchId === next.activeProject.activeBranchId)?.headRevisionId;
    if (!head) throw new Error("当前作品版本不可用，请重试。");
    setRetryPreview({ key, draft: draft.scene, latest: current, head });
  };

  const confirmRetry = async () => {
    if (!retryPreview) return;
    const draft = draftsRef.current.get(retryPreview.key);
    if (draft?.scene !== retryPreview.draft || draft.state === "saving") throw new Error("草稿已变化，请重新读取最新版本。");
    headsRef.current.set(draft.scene.projectId, retryPreview.head);
    setRetryPreview(null);
    await handleSaveScene({ ...draft.scene, baseRevisionId: retryPreview.head }, true);
  };

  const handleGenerate = useCallback((request: GenerationRequest): GenerationHandle => {
    const idempotencyKey = request.idempotencyKey;
    return { idempotencyKey, receipt: (async () => { await flushPending(); await routeSave.current; return api.generate(request); })() };
  }, [flushPending]);

  const selectTaskModel = useCallback((kind: TaskKind, provider?: string, modelId?: string) => {
    const current = agentSettingsRef.current;
    if (!current) return Promise.reject(new Error("模型设置尚未读取完成，请稍后重试。"));
    const routes = current.routes.map(route => {
      if (route.kind !== kind) return route;
      const { provider: _provider, modelId: _modelId, ...rest } = route;
      return provider && modelId ? { ...rest, provider, modelId } : rest;
    });
    const task = routeSave.current.then(() => api.saveRoutes(routes), () => api.saveRoutes(routes));
    routeSave.current = task;
    return task.then(next => {
      agentSettingsRef.current = next;
      setAgentSettings(next);
      return next;
    });
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

  const updateDraft = (draft: AuthoringSelection, token: ReturnType<typeof beginSnapshot>) => {
    const current = snapshotRef.current;
    if (current?.activeProject.projectId === draft.projectId) commitSnapshot({ ...current, authoringDraft: draft }, token);
  };

  const ideasMode = snapshot.connection.state === "connected" ? "pi" as const : "example" as const;

  const handleIdeas = async (input: string, mode: "example" | "pi" = ideasMode) => {
    if (snapshot.activeProject.projectId !== projectIdRef.current) throw new Error("正在切换作品，请稍后重试。");
    const token = beginSnapshot(snapshot.activeProject.projectId);
    const result = await api.ideas(snapshot.activeProject.projectId, input, mode);
    updateDraft(result.draft, token);
  };

  const handleSelection = async (action: SelectionAction) => {
    if (snapshot.activeProject.projectId !== projectIdRef.current) throw new Error("正在切换作品，请稍后重试。");
    const token = beginSnapshot(snapshot.activeProject.projectId);
    const draft = snapshot.authoringDraft;
    const result = await api.selection(draft.draftId, draft.selectionVersion, action);
    updateDraft(result.draft, token);
  };

  const handleAdopt = async () => {
    const current = await latest();
    const token = beginSnapshot(current.activeProject.projectId);
    const draft = current.authoringDraft;
    const headRevisionId = current.branches.find((branch) => branch.branchId === draft.branchId)?.headRevisionId
      ?? draft.baseRevisionId;
    const next = await api.adopt(draft.draftId, draft.selectionVersion, headRevisionId);
    if (!commitSnapshot(next, token)) throw new Error("作品已切换或更新；采用结果已保留，请重新打开作品查看。");
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
      onOpenElement={(entityId) => { setSelectedElementId(entityId); setView("elements"); }}
      onProjectChange={(projectId) => run(() => activateProject(projectId), "已打开作品")}
      onManageProjects={() => setProjectManagerOpen(true)}
      saveStatus={saveStatus}
    >
      {drafts.some(([, draft]) => draft.state === "error") && (
        <aside className="offline-banner" aria-label="未保存的本地草稿">
          {drafts.filter(([, draft]) => draft.state === "error").map(([key, draft]) => (
            <section key={key} className="inline-note error" role="alert">
              <strong>《{snapshot.projects.find(project => project.projectId === draft.scene.projectId)?.title ?? "其他作品"}》 · “{draft.scene.title}”有未保存的本地草稿</strong>
              <p>{draft.message}</p>
              <button className="button ghost small" disabled={busy} onClick={() => void run(() => retryDraft(key))}>读取最新版本后重试</button>
              <button className="button ghost small" onClick={() => void run(async () => { await navigator.clipboard.writeText(draft.scene.body); }, "草稿已复制")}>复制草稿</button>
              <details><summary>查看本地草稿</summary><textarea readOnly aria-label={`${draft.scene.title}的本地草稿`} value={draft.scene.body} /></details>
              {retryPreview?.key === key && retryPreview.draft === draft.scene && (
                <div>
                  <p>将本地草稿保存到“{retryPreview.latest.title}”，替代这场的最新正文与场景卡字段。当前版本仍可在历史版本中查看。</p>
                  <details><summary>比较最新正文</summary><textarea readOnly aria-label="待比较的最新正文" value={retryPreview.latest.body} /></details>
                  <button className="button secondary small" disabled={busy} onClick={() => void run(confirmRetry)}>确认保存本地草稿</button>
                  <button className="button ghost small" onClick={() => setRetryPreview(null)}>取消</button>
                </div>
              )}
            </section>
          ))}
        </aside>
      )}
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
          key={`${snapshot.activeProject.projectId}:${selectedScene.sceneId}`}
          snapshot={snapshot}
          scene={selectedScene}
          {...(draftsRef.current.get(draftKey(selectedScene)) ? { localDraft: draftsRef.current.get(draftKey(selectedScene))!.scene.body } : {})}
          focusMode={focusMode}
          onSelectScene={setSelectedSceneId}
          onDirty={retainDraft}
          onSave={async (scene) => {
            try {
              await handleSaveScene(scene);
            } catch (cause) {
              notify(cause instanceof Error ? `尚未保存：${cause.message}` : "尚未保存，请重试", "error");
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
          onChanged={refresh}
          onRegisterFlush={registerEditorFlush}
          agentSettings={agentSettings}
          onSelectTaskModel={selectTaskModel}
        />
      )}
      {view === "story" && (
        <StoryCanvas
          key={snapshot.activeProject.projectId}
          snapshot={snapshot}
          selectedSceneId={selectedScene?.sceneId ?? ""}
          onSelectScene={openScene}
          onOpenGuide={() => setGuideOpen(true)}
          onChanged={refresh}
          onBeforeWrite={latest}
        />
      )}
      {view === "elements" && (
        <ElementsView
          snapshot={snapshot}
          selectedElementId={selectedElementId}
          onSelect={setSelectedElementId}
          onOpenScene={openScene}
          onChanged={refresh}
        />
      )}
      {view === "context" && <ContextView key={`${snapshot.activeProject.projectId}:${selectedScene?.sceneId ?? ""}`} snapshot={snapshot} {...(selectedScene ? { scene: selectedScene } : {})} onOpenScene={openScene} />}
      {view === "notes" && <NotesView key={snapshot.activeProject.projectId} snapshot={snapshot} onChanged={refresh} onOpenScene={openScene} />}
      {view === "workflow" && (
        <WorkflowView
          key={snapshot.activeProject.projectId}
          snapshot={snapshot}
          {...(selectedScene ? { scene: selectedScene } : {})}
          onRun={(workflowVersionId) => run(async () => {
            if (!selectedScene) return;
            const current = await latest();
            if (!current.scenes.some(scene => scene.sceneId === selectedScene.sceneId)) throw new Error("场景已变化，请重新选择。");
            await api.runWorkflow(workflowVersionId, current.activeProject.projectId, selectedScene.sceneId);
            await refresh(current.activeProject.projectId);
          }, "工作流已开始，已完成的节点会自动保留")}
          onDecide={(runId, todoId, answer, inputHash, reviewNote) => run(async () => {
            await api.decideWorkflow(runId, todoId, answer, inputHash, reviewNote);
            void api.recordInteraction({ projectId: snapshot.activeProject.projectId, ...(selectedScene ? { sceneId: selectedScene.sceneId } : {}), kind: "review-decided", actor: "author", meta: { answer } }).catch(() => undefined);
            await refresh();
          }, "审阅决定已记录", true)}
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
          key={snapshot.activeProject.projectId}
          snapshot={snapshot}
          onCreateVersion={(name) => run(async () => {
            const current = await latest();
            const token = beginSnapshot(current.activeProject.projectId);
            const next = await api.createRevision(current.activeProject.projectId, name);
            if (!commitSnapshot(next, token)) throw new Error("作品已切换或更新；请重新打开作品查看命名版本。");
          }, "命名版本已保存", true)}
          onRestore={(revisionId) => run(async () => {
            const current = await latest();
            const branch = current.branches.find((item) => item.branchId === current.activeProject.activeBranchId);
            if (!branch) throw new Error("当前分支不可用");
            const token = beginSnapshot(current.activeProject.projectId);
            const next = await api.restore(current.activeProject.projectId, revisionId, branch.headRevisionId);
            if (!commitSnapshot(next, token)) throw new Error("作品已切换或更新；请重新打开作品查看恢复版本。");
          }, "已创建恢复版本，恢复前的主稿仍保留")}
          onActivate={activateProject}
          onBeforeWrite={flushPending}
          onOpenScene={openScene}
        />
      )}
      {view === "settings" && <SettingsView onChanged={() => { void refresh(); void refreshAgentSettings().catch(() => undefined); }} onToast={notify} />}
      {projectManagerOpen && <ProjectManagerDialog snapshot={snapshot} onClose={() => setProjectManagerOpen(false)} onActivate={activateProject} onBeforeWrite={flushPending} />}
      {guideOpen && <GuidedOutlineDialog projectId={snapshot.activeProject.projectId} {...(snapshot.guide ? { session: snapshot.guide } : {})} aiReady={snapshot.connection.state === "connected"} onChanged={async () => { await refresh(); }} onClose={() => setGuideOpen(false)} onOpenSettings={() => { setGuideOpen(false); setView("settings"); }} />}
      {workflowGuideOpen && <GuidedWorkflowDialog projectId={snapshot.activeProject.projectId} {...(snapshot.workflowGuide ? { session: snapshot.workflowGuide } : {})} aiReady={snapshot.connection.state === "connected"} onChanged={async () => { await refresh(); }} onClose={() => setWorkflowGuideOpen(false)} onOpenSettings={() => { setWorkflowGuideOpen(false); setView("settings"); }} />}
      {toast && <Toast message={toast} tone={toastTone} onClose={() => setToast("")} />}
      {error && <button className="offline-banner" onClick={() => void refresh()}>{error} · 点击重连</button>}
    </AppShell>
  );
}
