import type {
  AgentSettingsView,
  AgentTask,
  ApplyExtractedLedgerInput,
  GenerationProgress,
  ProviderModelInput,
  ProviderTestResult,
  ProviderUpsert,
  TaskRoute,
  AuthoringSelection,
  ContextBundle,
  ContextQuery,
  GenerationReceipt,
  GenerationRequest,
  GuidedSession,
  Scene,
  SelectionAction,
  WorkspaceSnapshot,
  WorkflowRun,
  WorkflowGuideSession,
  WorkflowDefinition,
  OAuthStatusView,
  UsageReportView,
  AuthorNote,
  Chapter,
  Entity,
  Revision,
  SceneAnnotation,
  CharacterArcProfile,
  AuthoringEvent,
  ElementDesignCard,
  ElementGuideSession,
  ArcAssistProposal,
  ArcDiagnosisReport,
  PlotIdeateMode,
  PlotIdeateResult,
  SceneProposalCard,
  NoteIncubateTarget,
  NoteIncubateResult,
  ExtractedLedgerBundle,
  FactAssertion,
  WorldEvent,
  ImportedChapterDraft,
  IngestPlan,
  KeywordIndexStatus,
} from "@nova-novel/shared";

export interface IngestRunView {
  runId: string;
  projectId: string;
  title: string;
  status: "running" | "paused" | "review" | "done" | "discarded";
  queue: string[];
  done: string[];
  failed: { sceneId: string; error: string }[];
  bundles: (ExtractedLedgerBundle & { sceneTitle?: string })[];
  cancelRequested?: boolean;
}
import type { AppearanceSettings } from "./appearance";

export interface SceneSaveResponse {
  scene: Scene;
  revisionId: string;
  revision: Revision;
  evidence: WorkspaceSnapshot["evidence"];
  storyGraph: WorkspaceSnapshot["storyGraph"];
  project: WorkspaceSnapshot["activeProject"];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function pairingHeaders(): Record<string, string> {
  const pairToken = new URLSearchParams(window.location.hash.slice(1)).get("pair");
  return pairToken ? { "X-Nova-Novel-Token": pairToken } : {};
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...pairingHeaders(),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | T
    | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? body.error?.message
      : undefined;
    throw new ApiError(message ?? `请求失败（${response.status}）`, response.status, body);
  }
  return body as T;
}

export const api = {
  download: async (path: string, filename: string) => {
    const response = await fetch(path, { headers: pairingHeaders() });
    if (!response.ok) {
      const details = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new ApiError(details?.error?.message ?? `下载失败（${response.status}）`, response.status, details);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    URL.revokeObjectURL(url);
  },
  appearance: () => request<AppearanceSettings>("/api/appearance"),
  saveAppearance: (input: AppearanceSettings) => request<AppearanceSettings>("/api/appearance", { method: "PUT", body: JSON.stringify(input) }),
  bootstrap: (projectId?: string) => request<WorkspaceSnapshot>(`/api/bootstrap${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  listNotes: (projectId: string) => request<{ notes: AuthorNote[] }>(`/api/notes?projectId=${encodeURIComponent(projectId)}`),
  createNote: (input: { projectId: string; title: string; body?: string; sceneId?: string; elementId?: string; tags?: string[] }) =>
    request<{ note: AuthorNote }>("/api/notes", { method: "POST", body: JSON.stringify(input) }),
  updateNote: (noteId: string, patch: { title?: string; body?: string; status?: AuthorNote["status"]; sceneId?: string | null; elementId?: string | null; tags?: string[] }) =>
    request<{ note: AuthorNote }>(`/api/notes/${noteId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  archiveNote: (noteId: string) => request<{ note: AuthorNote }>(`/api/notes/${noteId}`, { method: "DELETE" }),
  createElement: (input: { projectId: string; type: string; name: string; summary?: string; aliases?: string[]; unique?: boolean }) =>
    request<{ entity: Entity }>("/api/elements", { method: "POST", body: JSON.stringify(input) }),
  updateElement: (entityId: string, input: { projectId: string; name?: string; summary?: string; aliases?: string[] }) =>
    request<{ entity: Entity }>(`/api/elements/${encodeURIComponent(entityId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  promoteNote: (noteId: string) => request<{ note: AuthorNote; scene: Scene; revision: Revision; snapshot: WorkspaceSnapshot }>(`/api/notes/${noteId}/promote`, { method: "POST", body: "{}" }),
  listAnnotations: (projectId: string, sceneId?: string) => request<{ annotations: SceneAnnotation[] }>(`/api/annotations?projectId=${encodeURIComponent(projectId)}${sceneId ? `&sceneId=${encodeURIComponent(sceneId)}` : ""}`),
  createAnnotation: (input: { projectId: string; sceneId: string; kind: SceneAnnotation["kind"]; body: string; range?: SceneAnnotation["range"] }) =>
    request<{ annotation: SceneAnnotation }>("/api/annotations", { method: "POST", body: JSON.stringify(input) }),
  updateAnnotation: (annotationId: string, patch: { body?: string; status?: SceneAnnotation["status"] }) =>
    request<{ annotation: SceneAnnotation }>(`/api/annotations/${annotationId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  characterArc: (entityId: string) => request<{ arcs: CharacterArcProfile[] }>(`/api/character-arcs?entityId=${encodeURIComponent(entityId)}`),
  saveCharacterArc: (entityId: string, input: Pick<CharacterArcProfile, "motivation" | "goal" | "conflict" | "epiphany" | "notes">) =>
    request<{ arc: CharacterArcProfile }>(`/api/character-arcs/${entityId}`, { method: "PUT", body: JSON.stringify(input) }),
  listInteractions: async (projectId: string, cursor = 0) => {
    const events: AuthoringEvent[] = [];
    let nextCursor = cursor;
    while (true) {
      const result = await request<{ events: AuthoringEvent[] }>(`/api/events?projectId=${encodeURIComponent(projectId)}&cursor=${nextCursor}&limit=500`);
      events.push(...result.events);
      if (result.events.length < 500) return { events };
      nextCursor = result.events.at(-1)!.seq;
    }
  },
  recordInteraction: (input: { projectId: string; kind: string; sceneId?: string; actor?: AuthoringEvent["actor"]; meta?: AuthoringEvent["meta"] }) =>
    request<{ seq: number }>("/api/events", { method: "POST", body: JSON.stringify(input) }),
  createProject: (input: { title: string; premise: string; body?: string }) =>
    request<WorkspaceSnapshot>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  importProject: (input: { title: string; premise?: string; chapters?: ImportedChapterDraft[] }) =>
    request<{ project: WorkspaceSnapshot["activeProject"]; revision: Revision; snapshot: WorkspaceSnapshot }>("/api/import", { method: "POST", body: JSON.stringify(input) }),
  importAppend: (input: { projectId: string; baseRevisionId: string; chapters: ImportedChapterDraft[] }) =>
    request<{ revision: Revision; snapshot: WorkspaceSnapshot }>("/api/import/append", { method: "POST", body: JSON.stringify(input) }),
  ingestPlan: (input: { digest: { chapterCount: number; sceneCount: number; wordCount: number; titles: string[]; head: string; middle: string; tail: string; opening: string }; useAi?: boolean }) =>
    request<{ plan: IngestPlan | null; warnings: string[] }>("/api/ingest/plan", { method: "POST", body: JSON.stringify(input) }),
  ingestStart: (input: { projectId: string }) =>
    request<{ runId: string; project: WorkspaceSnapshot["activeProject"]; snapshot: WorkspaceSnapshot }>("/api/ingest/start", { method: "POST", body: JSON.stringify(input) }),
  ingestRun: (runId: string) => request<IngestRunView>(`/api/ingest/${runId}`),
  ingestAction: (runId: string, action: "cancel" | "resume" | "discard") =>
    request<IngestRunView>(`/api/ingest/${runId}/${action}`, { method: "POST", body: "{}" }),
  ingestCommit: (runId: string, acceptanceId: string) =>
    request<{ elements: number; facts: number; events: number; snapshot: WorkspaceSnapshot }>(`/api/ingest/${runId}/commit`, { method: "POST", body: JSON.stringify({ acceptanceId }) }),
  restoreBackup: (backup: unknown) =>
    request<{ project: WorkspaceSnapshot["activeProject"]; revision: Revision; warnings: string[]; snapshot: WorkspaceSnapshot }>("/api/import/backup", { method: "POST", body: JSON.stringify({ backup }) }),
  updateProject: (projectId: string, patch: { title?: string; archived?: boolean }) =>
    request<{ project: WorkspaceSnapshot["activeProject"]; snapshot: WorkspaceSnapshot }>(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  duplicateProject: (projectId: string) =>
    request<{ project: WorkspaceSnapshot["activeProject"]; revision: Revision; snapshot: WorkspaceSnapshot }>(`/api/projects/${projectId}/duplicate`, { method: "POST", body: "{}" }),
  ideas: (projectId: string, input: string, mode: "example" | "pi" = "example", idempotencyKey: string = crypto.randomUUID()) =>
    request<{ draft: AuthoringSelection }>(`/api/projects/${projectId}/ideas`, {
      method: "POST",
      body: JSON.stringify({ input, mode, idempotencyKey }),
    }),
  selection: (draftId: string, expectedVersion: number, action: SelectionAction) =>
    request<{ draft: AuthoringSelection }>(`/api/drafts/${draftId}/selection`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, action }),
    }),
  adopt: (draftId: string, expectedVersion: number, baseRevisionId: string) =>
    request<WorkspaceSnapshot>(`/api/drafts/${draftId}/adopt`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, baseRevisionId }),
    }),
  createChapter: (projectId: string, title: string) =>
    request<{ chapter: Chapter; revision: Revision; snapshot: WorkspaceSnapshot }>("/api/chapters", { method: "POST", body: JSON.stringify({ projectId, title }) }),
  renameChapter: (chapterId: string, title: string, baseRevisionId: string) =>
    request<{ revision: Revision; snapshot: WorkspaceSnapshot }>(`/api/chapters/${chapterId}`, { method: "PATCH", body: JSON.stringify({ title, baseRevisionId }) }),
  createScene: (projectId: string, chapterId: string | undefined, title: string) =>
    request<{ scene: Scene; revision: Revision; snapshot: WorkspaceSnapshot }>("/api/scenes", { method: "POST", body: JSON.stringify({ projectId, chapterId, title }) }),
  moveScene: (sceneId: string, chapterId: string, narrationOrder: number, baseRevisionId: string) =>
    request<{ revision: Revision; snapshot: WorkspaceSnapshot }>(`/api/scenes/${sceneId}/move`, { method: "POST", body: JSON.stringify({ chapterId, narrationOrder, baseRevisionId }) }),
  saveScene: (scene: Scene) =>
    request<SceneSaveResponse>(`/api/scenes/${scene.sceneId}`, {
      method: "PATCH",
      body: JSON.stringify({
        baseRevisionId: scene.baseRevisionId,
        body: scene.body,
        title: scene.title,
        summary: scene.summary,
        status: scene.status,
        ...(scene.goal !== undefined ? { goal: scene.goal } : {}),
        ...(scene.conflict !== undefined ? { conflict: scene.conflict } : {}),
        ...(scene.pov !== undefined ? { pov: scene.pov } : {}),
        ...(scene.storyTime !== undefined ? { storyTime: scene.storyTime } : {}),
      }),
    }),
  /** 只改结构字段（标题、章节、叙述顺序等），不发送正文与摘要，避免结构操作覆盖正文。 */
  saveSceneStructure: (scene: Scene, patch: { title?: string; storyTime?: string; pov?: string }) =>
    request<SceneSaveResponse>(`/api/scenes/${scene.sceneId}`, {
      method: "PATCH",
      body: JSON.stringify({ baseRevisionId: scene.baseRevisionId, ...patch }),
    }),
  queryContext: (query: ContextQuery) =>
    request<ContextBundle>("/api/context/query", {
      method: "POST",
      body: JSON.stringify(query),
    }),
  knowledgeIndexStatus: (projectId: string, revisionId: string) =>
    request<KeywordIndexStatus>(`/api/knowledge/index-status?projectId=${encodeURIComponent(projectId)}&revisionId=${encodeURIComponent(revisionId)}`),
  rebuildKnowledgeIndex: (projectId: string, revisionId: string) =>
    request<KeywordIndexStatus & { revisionId: string }>("/api/knowledge/rebuild", {
      method: "POST",
      body: JSON.stringify({ projectId, revisionId }),
    }),
  generate: (input: GenerationRequest) =>
    request<GenerationReceipt>("/api/generate", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runWorkflow: (workflowVersionId: string, projectId: string, sceneId: string) =>
    request<{ run: WorkflowRun }>(`/api/workflows/${workflowVersionId}/runs`, {
      method: "POST",
      body: JSON.stringify({ projectId, input: { sceneId } }),
    }),
  revision: (revisionId: string) =>
    request<{ revision: Revision; chapters: Chapter[]; scenes: Scene[]; facts: WorkspaceSnapshot["facts"] }>(`/api/revisions/${revisionId}`),
  createRevision: (projectId: string, name: string) =>
    request<WorkspaceSnapshot>(`/api/projects/${projectId}/revisions`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  restore: (projectId: string, revisionId: string, baseRevisionId: string) =>
    request<WorkspaceSnapshot>(`/api/projects/${projectId}/restore`, {
      method: "POST",
      body: JSON.stringify({ revisionId, baseRevisionId }),
    }),
  progress: (idempotencyKey: string) =>
    request<GenerationProgress>(`/api/generate/progress?key=${encodeURIComponent(idempotencyKey)}`),
  cancelGeneration: (idempotencyKey: string) =>
    request<{ task?: AgentTask }>("/api/generate/cancel", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey }),
    }),
  decideWorkflow: (runId: string, todoId: string, answer: string, inputHash: string, reviewNote?: string) =>
    request<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/decision`, {
      method: "POST",
      body: JSON.stringify({ todoId, answer, inputHash, ...(reviewNote ? { reviewNote } : {}) }),
    }),
  cancelWorkflow: (runId: string) =>
    request<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/cancel`, { method: "POST", body: "{}" }),
  agentSettings: () => request<AgentSettingsView>("/api/agent/settings"),
  createProvider: (providerId: string, input: ProviderUpsert) =>
    request<AgentSettingsView>("/api/agent/providers", {
      method: "POST",
      body: JSON.stringify({ providerId, ...input }),
    }),
  updateProvider: (providerId: string, input: Partial<ProviderUpsert>) =>
    request<AgentSettingsView>(`/api/agent/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteProvider: (providerId: string) =>
    request<AgentSettingsView>(`/api/agent/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }),
  testProvider: (providerId: string, modelId?: string) =>
    request<ProviderTestResult>(`/api/agent/providers/${encodeURIComponent(providerId)}/test`, {
      method: "POST",
      body: JSON.stringify(modelId ? { modelId } : {}),
    }),
  discoverModels: (providerId: string, input: { baseUrl?: string; api?: string; apiKey?: string; proxyEnabled?: boolean; proxyUrl?: string }) =>
    request<{ models: ProviderModelInput[] }>(`/api/agent/providers/${encodeURIComponent(providerId)}/discover`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveRoutes: (routes: TaskRoute[]) =>
    request<AgentSettingsView>("/api/agent/routes", {
      method: "PUT",
      body: JSON.stringify({ routes }),
    }),
  startOAuth: (providerId: string) =>
    request<OAuthStatusView>(`/api/agent/oauth/${encodeURIComponent(providerId)}`, { method: "POST", body: "{}" }),
  oauthStatus: (providerId: string) =>
    request<OAuthStatusView>(`/api/agent/oauth/${encodeURIComponent(providerId)}`),
  submitOAuthCode: (providerId: string, code: string) =>
    request<{ ok: boolean }>(`/api/agent/oauth/${encodeURIComponent(providerId)}/code`, { method: "POST", body: JSON.stringify({ code }) }),
  cancelOAuth: (providerId: string) =>
    request<{ ok: boolean }>(`/api/agent/oauth/${encodeURIComponent(providerId)}`, { method: "DELETE" }),
  usageReports: (refresh = false) =>
    request<{ reports: UsageReportView[] }>(`/api/agent/usage${refresh ? "?refresh=true" : ""}`),
  createGuide: (projectId: string) =>
    request<{ session: GuidedSession }>("/api/guide/sessions", { method: "POST", body: JSON.stringify({ projectId }) }),
  nextGuide: (sessionId: string) =>
    request<{ session: GuidedSession }>(`/api/guide/sessions/${sessionId}/next`, { method: "POST", body: "{}" }),
  answerGuide: (sessionId: string, input: { optionId?: string; custom?: string; skip?: boolean }) =>
    request<{ session: GuidedSession }>(`/api/guide/sessions/${sessionId}/answer`, { method: "POST", body: JSON.stringify(input) }),
  backGuide: (sessionId: string) =>
    request<{ session: GuidedSession }>(`/api/guide/sessions/${sessionId}/back`, { method: "POST", body: "{}" }),
  cancelGuide: (sessionId: string) =>
    request<{ session: GuidedSession }>(`/api/guide/sessions/${sessionId}/cancel`, { method: "POST", body: "{}" }),
  applyGuide: (sessionId: string, proposalIds?: string[]) =>
    request<{ snapshot: WorkspaceSnapshot }>(`/api/guide/sessions/${sessionId}/apply`, { method: "POST", body: JSON.stringify(proposalIds ? { proposalIds } : {}) }),
  updateGuideProposal: (sessionId: string, scenes: GuidedSession["proposal"]) =>
    request<{ session: GuidedSession }>(`/api/guide/sessions/${sessionId}/proposal`, { method: "PATCH", body: JSON.stringify({ scenes }) }),
  createWorkflowGuide: (projectId: string) =>
    request<{ session: WorkflowGuideSession }>("/api/workflow-guide/sessions", { method: "POST", body: JSON.stringify({ projectId }) }),
  nextWorkflowGuide: (sessionId: string) =>
    request<{ session: WorkflowGuideSession }>(`/api/workflow-guide/sessions/${sessionId}/next`, { method: "POST", body: "{}" }),
  answerWorkflowGuide: (sessionId: string, input: { optionId?: string; custom?: string; skip?: boolean }) =>
    request<{ session: WorkflowGuideSession }>(`/api/workflow-guide/sessions/${sessionId}/answer`, { method: "POST", body: JSON.stringify(input) }),
  backWorkflowGuide: (sessionId: string) =>
    request<{ session: WorkflowGuideSession }>(`/api/workflow-guide/sessions/${sessionId}/back`, { method: "POST", body: "{}" }),
  cancelWorkflowGuide: (sessionId: string) =>
    request<{ session: WorkflowGuideSession }>(`/api/workflow-guide/sessions/${sessionId}/cancel`, { method: "POST", body: "{}" }),
  publishWorkflowGuide: (sessionId: string, projectId: string) =>
    request<{ snapshot: WorkspaceSnapshot }>(`/api/workflow-guide/sessions/${sessionId}/publish`, { method: "POST", body: JSON.stringify({ projectId }) }),
  updateWorkflowGuideProposal: (sessionId: string, definition: WorkflowDefinition) =>
    request<{ session: WorkflowGuideSession }>(`/api/workflow-guide/sessions/${sessionId}/proposal`, { method: "PATCH", body: JSON.stringify({ definition }) }),
  addElementFact: (
    entityId: string,
    input: {
      projectId: string;
      predicate: string;
      value?: string;
      valueEntityId?: string;
      semanticType?: FactAssertion["semanticType"];
      validFromOrder?: number;
      validToOrder?: number;
      holderId?: string;
    },
  ) =>
    request<{ fact: FactAssertion; snapshot: WorkspaceSnapshot }>(`/api/elements/${encodeURIComponent(entityId)}/facts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateElementFact: (
    entityId: string,
    factId: string,
    input: {
      projectId: string;
      predicate?: string;
      value?: string;
      valueEntityId?: string;
      semanticType?: FactAssertion["semanticType"];
      validFromOrder?: number | null;
      validToOrder?: number | null;
      reviewState?: "confirmed" | "rejected";
    },
  ) =>
    request<{ fact: FactAssertion; snapshot: WorkspaceSnapshot }>(`/api/elements/${encodeURIComponent(entityId)}/facts/${encodeURIComponent(factId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  addElementEvent: (
    entityId: string,
    input: {
      projectId: string;
      kind: string;
      sceneId?: string;
      storyTime?: string;
      storyOrder?: number;
      fromValue?: string;
      toValue: string;
      location?: string;
    },
  ) =>
    request<{ event: WorldEvent; snapshot: WorkspaceSnapshot }>(`/api/elements/${encodeURIComponent(entityId)}/events`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateElementEvent: (
    entityId: string,
    eventId: string,
    input: {
      projectId: string;
      kind?: string;
      sceneId?: string | null;
      storyTime?: string;
      storyOrder?: number;
      fromValue?: string;
      toValue?: string;
      location?: string;
      reviewState?: "confirmed" | "rejected";
    },
  ) =>
    request<{ event: WorldEvent; snapshot: WorkspaceSnapshot }>(`/api/elements/${encodeURIComponent(entityId)}/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  elementDesign: (input: {
    projectId: string;
    type?: Entity["type"];
    targetEntityId?: string;
    prompt: string;
    roleHint?: string;
    relatedEntityIds?: string[];
  }) =>
    request<{ artifactId: string; taskId: string; cards: ElementDesignCard[] }>("/api/assist/element-design", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyElementDesign: (input: {
    projectId: string;
    card: ElementDesignCard;
    targetEntityId?: string;
    acceptanceId?: string;
  }) =>
    request<{ entity: Entity; arc?: CharacterArcProfile; snapshot: WorkspaceSnapshot }>("/api/assist/element-design/apply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createElementGuide: (input: {
    projectId: string;
    type?: Entity["type"];
    targetEntityId?: string;
    prompt?: string;
    roleHint?: string;
    relatedEntityIds?: string[];
    forceNew?: boolean;
  }) =>
    request<{ session: ElementGuideSession }>("/api/element-guide/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  nextElementGuide: (sessionId: string) =>
    request<{ session: ElementGuideSession }>(`/api/element-guide/sessions/${sessionId}/next`, { method: "POST", body: "{}" }),
  answerElementGuide: (sessionId: string, input: { optionId?: string; custom?: string; skip?: boolean }) =>
    request<{ session: ElementGuideSession }>(`/api/element-guide/sessions/${sessionId}/answer`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  backElementGuide: (sessionId: string) =>
    request<{ session: ElementGuideSession }>(`/api/element-guide/sessions/${sessionId}/back`, { method: "POST", body: "{}" }),
  cancelElementGuide: (sessionId: string) =>
    request<{ session: ElementGuideSession }>(`/api/element-guide/sessions/${sessionId}/cancel`, { method: "POST", body: "{}" }),
  updateElementGuideProposal: (sessionId: string, cards: ElementDesignCard[]) =>
    request<{ session: ElementGuideSession }>(`/api/element-guide/sessions/${sessionId}/proposal`, {
      method: "PATCH",
      body: JSON.stringify({ cards }),
    }),
  applyElementGuide: (sessionId: string, input: { proposalId?: string; card?: ElementDesignCard }) =>
    request<{ session: ElementGuideSession; entity: Entity; snapshot: WorkspaceSnapshot }>(`/api/element-guide/sessions/${sessionId}/apply`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  assistArc: (input: { projectId: string; entityId: string; mode: "propose" | "diagnose"; prompt?: string }) =>
    request<{ taskId: string; mode: "propose" | "diagnose"; proposals?: ArcAssistProposal[]; diagnosis?: ArcDiagnosisReport }>("/api/assist/arc", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  plotIdeate: (input: {
    projectId: string;
    mode: PlotIdeateMode;
    sceneId?: string;
    toSceneId?: string;
    chapterId?: string;
    fieldTarget?: "goal" | "conflict" | "summary";
    prompt?: string;
    reviewSummary?: string;
  }) =>
    request<PlotIdeateResult>("/api/assist/plot-ideate", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyPlotIdeation: (input: {
    projectId: string;
    baseRevisionId: string;
    acceptanceId?: string;
    mode: PlotIdeateMode;
    sceneId?: string;
    chapterId?: string;
    scenes?: SceneProposalCard[];
    fieldTarget?: "goal" | "conflict" | "summary";
    fieldValue?: string;
  }) =>
    request<{ revision: Revision; scenes: Scene[]; snapshot: WorkspaceSnapshot }>("/api/assist/plot-ideate/apply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  incubateNotes: (input: { projectId: string; noteIds: string[]; targetKind: NoteIncubateTarget; prompt?: string }) =>
    request<NoteIncubateResult>("/api/notes/incubate", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyNoteIncubation: (input: {
    projectId: string;
    noteIds: string[];
    targetKind: NoteIncubateTarget;
    baseRevisionId: string;
    acceptanceId?: string;
    elementCard?: ElementDesignCard;
    sceneCards?: SceneProposalCard[];
    chapterId?: string;
  }) =>
    request<{ notes: AuthorNote[]; entity?: Entity; scenes?: Scene[]; snapshot: WorkspaceSnapshot }>("/api/notes/incubate/apply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  extractLedger: (input: { projectId: string; sceneId: string }) =>
    request<ExtractedLedgerBundle>("/api/assist/extract-ledger", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyExtractedLedger: (input: ApplyExtractedLedgerInput) =>
    request<{ entities: Entity[]; facts: FactAssertion[]; events: WorldEvent[]; snapshot: WorkspaceSnapshot }>("/api/assist/extract-ledger/apply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
