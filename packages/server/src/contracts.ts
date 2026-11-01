import type {
  AgentTask,
  ContextBundle,
  ContextQuery,
  Entity,
  FactAssertion,
  GenerationRequest,
  GenerationResultPayload,
  GenerationProgress,
  AgentSettingsView,
  OAuthStatusView,
  ProviderUpsert,
  ProviderTestResult,
  ProviderModelInput,
  UsageReportView,
  UsageWindowView,
  TaskRoute,
  PiConnection,
  Scene,
  WorldEvent,
  WorkflowDefinition,
  WorkflowRun,
} from "@nova-novel/shared";

export interface ConsistencyIssue {
  issueId: string;
  severity: "conflict" | "unknown" | "aesthetic";
  title: string;
  detail: string;
  evidence: string[];
  certainty: "confirmed" | "possible";
}

export interface KnowledgeService {
  listEntities(projectId: string): Entity[];
  listFacts(projectId: string): FactAssertion[];
  listEvents(projectId: string): WorldEvent[];
  queryContext(query: ContextQuery): ContextBundle;
  checkConsistency(scene: Scene, candidateText: string): ConsistencyIssue[];
  indexScene(scene: Scene, revisionId: string): void;
  /** 由宿主声明某修订的完整场景清单，只有全部索引成功该修订才算可检索。 */
  beginRevisionIndex?(projectId: string, revisionId: string, sceneIds: readonly string[]): void;
  getIndexStatus?(projectId: string, revisionId: string): { state: "pending" | "error" | "ready"; keywordRevisionId: string };
  /** 从权威修订正文重建派生证据与 FTS，用于索引损坏后的恢复。 */
  rebuildRevisionIndex?(projectId: string, revisionId: string, scenes: readonly Scene[]): { state: "pending" | "error" | "ready"; keywordRevisionId: string };
  /** 作者录入元素与别名；entityId 已存在时按 upsert 更新。 */
  addEntity?(args: { entityId?: string; projectId: string; type: Entity["type"]; name: string; summary?: string; routeId: string; sourceKind: Entity["sourceKind"]; reviewState: Entity["reviewState"]; unique?: boolean }): string;
  addAlias?(projectId: string, entityId: string, alias: string, kind?: "name" | "alias"): void;
  /** 删除元素的别名记录（不影响实体名本身）。 */
  removeAlias?(projectId: string, entityId: string, alias: string): void;
  /** 作者或审阅确认录入属性/关系事实；factId 已存在时按 upsert 更新。 */
  addFact?(args: {
    factId?: string;
    projectId: string;
    subjectId: string;
    predicate: string;
    value: FactAssertion["value"];
    semanticType: FactAssertion["semanticType"];
    reviewState: FactAssertion["reviewState"];
    sourceKind: FactAssertion["sourceKind"];
    routeId: string;
    validFromOrder?: number;
    validToOrder?: number;
    holderId?: string;
    evidenceIds?: string[];
  }): string;
  /** 作者或审阅确认录入状态变化与秘密知情/揭示事件；eventId 已存在时按 upsert 更新。 */
  addEvent?(args: {
    eventId?: string;
    projectId: string;
    kind: string;
    sceneId?: string;
    routeId: string;
    storyTime?: string;
    storyOrder?: number;
    subjectId: string;
    fromValue?: string;
    toValue?: string;
    location?: string;
    reviewState: WorldEvent["reviewState"];
    evidenceIds?: string[];
  }): string;
}

export interface WorkflowService {
  listDefinitions(): WorkflowDefinition[];
  listRuns(projectId: string): WorkflowRun[];
  startRun(projectId: string, workflowVersionId: string, input: Record<string, unknown>): WorkflowRun;
  decide(runId: string, todoId: string, answer: string, inputHash: string, reviewNote?: string): WorkflowRun;
  cancel(runId: string): WorkflowRun;
}

export interface PiGenerationInput {
  task: AgentTask;
  request: GenerationRequest;
  systemContext: string;
}

export interface PiGenerationResult {
  text: string;
  completeness: "complete" | "partial";
  failureReason?: "timeout" | "provider_error" | "tool_error" | "cancelled" | "truncated" | "empty_output" | "incomplete_response" | "context_overflow" | "invalid_output";
  error?: string;
  sessionId?: string;
  leafId?: string;
  output?: GenerationResultPayload["output"];
  proposals?: string[];
  report?: GenerationResultPayload["report"];
  cards?: import("@nova-novel/shared").IdeaCardFields[];
}

export interface PiHost {
  getConnection(): PiConnection;
  generate(input: PiGenerationInput): Promise<PiGenerationResult>;
  cancel(taskId: string): Promise<void>;
  progress?(key: string): GenerationProgress;
  assistImport?(text: string): Promise<import("@nova-novel/shared").ImportedChapterDraft[] | null>;
  planIngest?(text: string, chapters: import("@nova-novel/shared").ImportedChapterDraft[]): Promise<import("@nova-novel/shared").IngestPlan | null>;
  usage?: { list(force?: boolean): Promise<UsageReportView[]> };
  volcengine?: {
    loginStatus(): OAuthStatusView;
    startLogin(): OAuthStatusView;
    cancelLogin(): void;
    hasBinding(providerId: string): boolean;
    usageFor(providerId: string): Promise<UsageWindowView[] | undefined>;
  };
  settings?: {
    view(): AgentSettingsView;
    upsert(id: string, input: ProviderUpsert, patch?: boolean): Promise<AgentSettingsView>;
    delete(id: string): Promise<AgentSettingsView>;
    routes(routes: TaskRoute[]): Promise<AgentSettingsView>;
    oauthStatus(id: string): OAuthStatusView;
    startOAuth(id: string): OAuthStatusView;
    oauthCode(id: string, code: string): void;
    oauthCancel(id: string): void;
  };
  testProvider?(id: string, modelId?: string): Promise<ProviderTestResult>;
  discoverProvider?(id: string, input: Record<string, unknown>): Promise<{ models: ProviderModelInput[] }>;
}
