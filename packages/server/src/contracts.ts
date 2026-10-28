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
  ProviderUpsert,
  ProviderTestResult,
  ProviderModelInput,
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
}

export interface WorkflowService {
  listDefinitions(): WorkflowDefinition[];
  listRuns(projectId: string): WorkflowRun[];
  startRun(projectId: string, workflowVersionId: string, input: Record<string, unknown>): WorkflowRun;
  decide(runId: string, todoId: string, answer: string, inputHash: string): WorkflowRun;
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
  settings?: {
    view(): AgentSettingsView;
    upsert(id: string, input: ProviderUpsert, patch?: boolean): Promise<AgentSettingsView>;
    delete(id: string): Promise<AgentSettingsView>;
    routes(routes: TaskRoute[]): Promise<AgentSettingsView>;
  };
  testProvider?(id: string, modelId?: string): Promise<ProviderTestResult>;
  discoverProvider?(id: string, input: Record<string, unknown>): Promise<{ models: ProviderModelInput[] }>;
}
