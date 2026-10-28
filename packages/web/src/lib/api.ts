import type {
  AgentSettingsView,
  AgentTask,
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
} from "@nova-novel/shared";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
  bootstrap: (projectId?: string) => request<WorkspaceSnapshot>(`/api/bootstrap${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createProject: (input: { title: string; premise: string; body?: string }) =>
    request<WorkspaceSnapshot>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
  saveScene: (scene: Scene) =>
    request<{ scene: Scene; revisionId: string }>(`/api/scenes/${scene.sceneId}`, {
      method: "PATCH",
      body: JSON.stringify({
        baseRevisionId: scene.baseRevisionId,
        body: scene.body,
        title: scene.title,
        summary: scene.summary,
        status: scene.status,
        ...(scene.goal !== undefined ? { goal: scene.goal } : {}),
        ...(scene.conflict !== undefined ? { conflict: scene.conflict } : {}),
      }),
    }),
  queryContext: (query: ContextQuery) =>
    request<ContextBundle>("/api/context/query", {
      method: "POST",
      body: JSON.stringify(query),
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
  decideWorkflow: (runId: string, todoId: string, answer: string, inputHash: string) =>
    request<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/decision`, {
      method: "POST",
      body: JSON.stringify({ todoId, answer, inputHash }),
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
  discoverModels: (providerId: string, input: { baseUrl?: string; api?: string; apiKey?: string }) =>
    request<{ models: ProviderModelInput[] }>(`/api/agent/providers/${encodeURIComponent(providerId)}/discover`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveRoutes: (routes: TaskRoute[]) =>
    request<AgentSettingsView>("/api/agent/routes", {
      method: "PUT",
      body: JSON.stringify({ routes }),
    }),
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
  applyGuide: (sessionId: string) =>
    request<{ snapshot: WorkspaceSnapshot }>(`/api/guide/sessions/${sessionId}/apply`, { method: "POST", body: "{}" }),
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
};
