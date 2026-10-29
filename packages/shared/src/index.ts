export * from "./next-action.js";
export * from "./revision-insights.js";
export type Id = string;
export type ISODateTime = string;
export type SourceKind = "candidate" | "selected_plan" | "manuscript" | "author_setting";
export type ReviewState = "candidate" | "confirmed" | "rejected";
export type SceneStatus = "draft" | "planned" | "writing" | "review" | "final";
export type RouteId = Id;

export interface Project {
  projectId: Id;
  title: string;
  premise: string;
  genre?: string;
  targetWords?: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  activeBranchId: Id;
  activeRouteId: RouteId;
  archivedAt?: ISODateTime;
}

export interface Branch {
  branchId: Id;
  projectId: Id;
  name: string;
  headRevisionId: Id;
  parentRevisionId?: Id;
}

export interface StoryRoute {
  routeId: RouteId;
  projectId: Id;
  name: string;
  parentRouteId?: RouteId;
}

export interface Scene {
  sceneId: Id;
  projectId: Id;
  chapterId: Id;
  title: string;
  summary: string;
  body: string;
  status: SceneStatus;
  pov?: string;
  goal?: string;
  conflict?: string;
  storyTime?: string;
  narrationOrder: number;
  routeId: RouteId;
  entityIds: Id[];
  baseRevisionId: Id;
  updatedAt: ISODateTime;
}

export interface Chapter {
  chapterId: Id;
  projectId: Id;
  title: string;
  order: number;
}

export interface IdeaCardFields {
  action: string;
  motivation?: string;
  obstacle?: string;
  outcome?: string;
  focus: string;
  tradeoff: string;
}

export interface IdeaCard {
  cardId: Id;
  cardRevision: number;
  proposalBatchId: Id;
  sourceRef: { taskId?: Id; origin: "author" | "pi" | "example" };
  proposedFields: IdeaCardFields;
  relatedEntityIds: Id[];
  dependencyRefs: Array<{ cardId: Id; cardRevision: number }>;
  differenceNote: string;
  rehearsalArtifactId?: Id;
}

export interface ProposalBatch {
  proposalBatchId: Id;
  parentBatchId?: Id;
  generationRequestId: Id;
  attemptId: Id;
  sourceTaskId: Id;
  baseRevisionId: Id;
  basePlanHash: string;
  cardRefs: Array<{ cardId: Id; cardRevision: number }>;
  cards: IdeaCard[];
  createdAt: ISODateTime;
}

export interface CardRef {
  cardId: Id;
  cardRevision: number;
}

export interface CompositionSource {
  targetCard: CardRef;
  fieldPath: keyof IdeaCardFields;
  sourceCard: CardRef;
  base: string;
  current: string;
  candidate: string;
}

export interface AuthoringSelection {
  draftId: Id;
  projectId: Id;
  branchId: Id;
  baseRevisionId: Id;
  selectionVersion: number;
  selectionArtifactId: Id;
  selectedCardRefs: CardRef[];
  lockedDecisions: Array<{ id: Id; card: CardRef; field: keyof IdeaCardFields; text: string }>;
  protectedSpans: Array<{ id: Id; blockId: string; textHash: string; from: number; to: number }>;
  compositionSources: CompositionSource[];
  cards: IdeaCard[];
  batches: ProposalBatch[];
  undoDepth: number;
}

export type SelectionAction =
  | { type: "select"; card: CardRef }
  | { type: "lock"; card: CardRef; field: keyof IdeaCardFields }
  | { type: "unlock"; lockId: Id }
  | { type: "borrow"; targetCard: CardRef; sourceCard: CardRef; field: keyof IdeaCardFields }
  | { type: "edit"; card: CardRef; fields: Partial<IdeaCardFields> }
  | { type: "reject"; card: CardRef }
  | { type: "undo" };

export interface Entity {
  entityId: Id;
  projectId: Id;
  type: "character" | "item" | "location" | "organization" | "ability" | "rule" | "event" | "secret" | "custom";
  name: string;
  aliases: string[];
  summary: string;
  routeId: RouteId;
  sourceKind: SourceKind;
  reviewState: ReviewState;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FactAssertion {
  factId: Id;
  projectId: Id;
  subjectId: Id;
  predicate: string;
  value: string | number | boolean | null | { entityId: Id };
  semanticType: "world_fact" | "belief" | "rumor" | "deception" | "plan" | "hypothesis";
  reviewState: ReviewState;
  sourceKind: SourceKind;
  routeId: RouteId;
  validFrom?: string;
  validTo?: string;
  holderId?: Id;
  evidenceIds: Id[];
}

export interface WorldEvent {
  eventId: Id;
  projectId: Id;
  kind: string;
  sceneId?: Id;
  routeId: RouteId;
  storyTime?: string;
  storyOrder: number;
  subjectId: Id;
  fromValue?: string;
  toValue?: string;
  location?: string;
  reviewState: ReviewState;
  evidenceIds: Id[];
}

export interface Evidence {
  evidenceId: Id;
  projectId: Id;
  sourceRevisionId: Id;
  sceneId?: Id;
  blockId?: string;
  quote: string;
  contentHash: string;
  sourceKind: SourceKind;
  routeId: RouteId;
  narrationOrder?: number;
  storyOrder?: number;
}

export interface ContextQuery {
  projectId: Id;
  branchId: Id;
  routeId: RouteId;
  revisionId: Id;
  query: string;
  purpose: "planning" | "scene_writing" | "fact_check" | "reader_check";
  povEntityId?: Id;
  storyOrder?: number;
  narrationOrder?: number;
  explicitCandidateIds?: Id[];
  limit?: number;
}

export interface ContextBundle {
  snapshotId: Id;
  facts: FactAssertion[];
  evidence: Evidence[];
  selectedPlans: Array<{ sceneId: Id; text: string; sourceKind: "selected_plan" }>;
  candidates: Array<{ artifactId: Id; text: string; sourceKind: "candidate" }>;
  excluded: Array<{ reason: string; count: number }>;
  indexState: { keywordRevisionId: Id; semanticState: "unconfigured" | "ready" | "stale" };
}

export interface StoryGraph {
  projectId: Id;
  revisionId: Id;
  nodes: Array<{
    id: Id;
    kind: "scene" | "event" | "setup" | "payoff" | "route" | "note";
    sceneId?: Id;
    title: string;
    summary: string;
    position: { x: number; y: number };
  }>;
  edges: Array<{
    id: Id;
    source: Id;
    target: Id;
    kind: "narrative_next" | "happens_before" | "causes" | "sets_up" | "pays_off" | "requires_state" | "changes_state" | "alternative" | "references";
  }>;
}

export type NodePortType = "SceneRef" | "WorldState" | "ContextBundle" | "DraftArtifact" | "IssueReport" | "ChangeSet" | "RevisionRef" | "ProposalBatch" | "DecisionRecord";

export interface WorkflowNode {
  id: Id;
  type: string;
  typeVersion: number;
  name: string;
  config: Record<string, unknown>;
  inputs: Record<string, { node: Id; port: string } | { runInput: string }>;
  outputs: Record<string, NodePortType>;
  ui: { x: number; y: number };
}

export interface WorkflowEdge {
  id: Id;
  source: { node: Id; port: string; type: NodePortType };
  target: { node: Id; port: string; type: NodePortType };
  condition?: "true" | "false" | "unknown";
}

export interface WorkflowDefinition {
  schemaVersion: "nova-novel.workflow/1";
  workflowId: Id;
  workflowVersionId: Id;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  policy: { maxParallelNodes: number; maxNodeAttempts: number; maxIterations: number };
}

export type RunState = "queued" | "running" | "waiting_human" | "paused" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type NodeRunState = "pending" | "ready" | "running" | "waiting_human" | "succeeded" | "failed" | "skipped" | "cancelled" | "interrupted" | "blocked";

export interface NodeRun {
  nodeRunId: Id;
  runId: Id;
  nodeId: Id;
  state: NodeRunState;
  attemptId: Id;
  inputHash: string;
  output?: unknown;
  error?: string;
}

export interface WorkflowRun {
  runId: Id;
  projectId: Id;
  workflowVersionId: Id;
  baseRevisionId: Id;
  state: RunState;
  nodeRuns: NodeRun[];
  pendingDecision?: { todoId: Id; nodeRunId: Id; question: string; options: string[]; inputHash: string };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Revision {
  revisionId: Id;
  projectId: Id;
  branchId: Id;
  parentRevisionIds: Id[];
  name: string;
  kind: "autosave" | "named" | "changeset" | "restored";
  createdAt: ISODateTime;
  wordCount: number;
}

export type StructureChange =
  | { kind: "chapter.add"; chapter: Chapter }
  | { kind: "chapter.rename"; chapterId: Id; title: string }
  | { kind: "scene.move"; sceneId: Id; chapterId: Id; narrationOrder: number };

export interface ChangeSet {
  changeSetId: Id;
  projectId: Id;
  branchId: Id;
  baseRevisionId: Id;
  acceptanceId: Id;
  sceneChanges: Array<{ sceneId: Id; body: string; baseTextHash: string }>;
  factChanges: FactAssertion[];
  graphChanges: Array<{ sceneId: Id; patch: Partial<Scene> }>;
  sceneAdditions?: Scene[];
  structureChanges?: StructureChange[];
  status: "pending" | "committed" | "rejected" | "stale";
  sourceTaskId?: Id;
}

export type TaskState = "queued" | "running" | "waiting_extension_ui" | "waiting_human" | "cancelling" | "cancelled" | "succeeded" | "failed" | "interrupted";

export interface AgentTask {
  taskId: Id;
  projectId: Id;
  idempotencyKey: Id;
  generationRequestId: Id;
  attemptId: Id;
  reuseOfArtifactId?: Id;
  state: TaskState;
  kind: "ideas" | "scene" | "rehearsal" | "consistency" | "polish" | "guide";
  label: string;
  completeness: "complete" | "partial";
  contextSnapshotId?: Id;
  result?: unknown;
  error?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface GenerationRequest {
  projectId: Id;
  sceneId?: Id;
  draftId?: Id;
  kind: AgentTask["kind"];
  input: string;
  idempotencyKey: Id;
  reuseOfArtifactId?: Id;
  range?: { from: number; to: number; baseText: string };
}

export interface GenerationReceipt {
  task: AgentTask;
  freeze: {
    baseRevisionId: Id;
    basePlanHash: string;
    draftId?: Id;
    selectionVersion?: number;
    selectionHash?: string;
    intentHash: string;
    contextSnapshotId: Id;
  };
  freshness: "current" | "stale";
}

export interface PiConnection {
  /** connected：至少一个任务路由解析到可用模型；unconfigured：尚未添加可用 provider。 */
  state: "connected" | "unconfigured" | "unavailable" | "incompatible";
  version?: string;
  mode: "embedded" | "example";
  detail: string;
  sendsDataTo: string;
}

/* ---- 内置 Agent 引擎：provider、模型与任务路由 ---------------------------- */

export type TaskKind = AgentTask["kind"];
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const TASK_KINDS: readonly TaskKind[] = ["ideas", "rehearsal", "scene", "polish", "consistency", "guide"];
export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai" | "openai-codex-responses" | "mistral-conversations" | "bedrock-converse-stream" | "google-vertex" | "azure-openai-responses" | "pi-messages";

export interface ProviderCompat {
  allowEmptySignature?: boolean;
  forceAdaptiveThinking?: boolean;
  supportsTemperature?: boolean;
}

export interface ProviderModelInput {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  compat?: ProviderCompat;
}

/** 对外视图永不包含 API Key 原文。 */
export interface ProviderConfigView {
  providerId: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  compat?: ProviderCompat;
  hasApiKey: boolean;
  keySource?: "manual" | "environment";
  apiKeyEnv?: string;
  quotaAccessKeyEnv?: string;
  quotaSecretKeyEnv?: string;
  models: ProviderModelInput[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ProviderUpsert {
  name: string;
  api: ProviderApi;
  baseUrl: string;
  compat?: ProviderCompat;
  keySource?: "manual" | "environment";
  apiKeyEnv?: string;
  quotaAccessKeyEnv?: string;
  quotaSecretKeyEnv?: string;
  /** 省略：保留已存密钥；空字符串：清除密钥。 */
  apiKey?: string;
  models: ProviderModelInput[];
}

export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
  /** 美元 / 百万 token；未知时省略。 */
  costInput?: number;
  costOutput?: number;
  available: boolean;
  source: "custom" | "builtin";
}

export interface TaskRoute {
  kind: TaskKind;
  provider?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
}

export interface AgentSettingsView {
  providers: ProviderConfigView[];
  models: ModelOption[];
  routes: TaskRoute[];
  builtinProviders: BuiltinProviderPreset[];
  engine: { name: string; version: string; mode: "embedded" };
  dataDir: string;
}

export interface BuiltinProviderPreset {
  providerId: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  compat?: ProviderCompat;
  models: ProviderModelInput[];
  oauth: boolean;
  source?: "pi" | "plugin";
}

export interface OAuthEventView { type: string; message?: string; url?: string; userCode?: string }
export interface OAuthStatusView { providerId: string; status: "pending" | "success" | "error" | "cancelled"; events: OAuthEventView[]; error?: string }

export interface UsageWindowView { kind: string; percentUsed: number; resetAt?: ISODateTime; used?: number; limit?: number; unit?: string }
export interface UsageReportView {
  providerId: string;
  label: string;
  state: "ok" | "no-key" | "error" | "disabled";
  windows: UsageWindowView[];
  balance?: { value: number; currency: string };
  coverage: "complete" | "partial";
  error?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
  sample?: string;
}

export interface GenerationProgress {
  taskId?: Id;
  state: TaskState | "unknown";
  /** 已流式收到的可见文本（纯文本任务），JSON 任务可能为空。 */
  text: string;
  tools: string[];
}

export interface ConsistencyIssueView {
  severity: "conflict" | "unknown" | "aesthetic";
  title: string;
  detail: string;
  evidence: string[];
}

export interface ConsistencyReport {
  summary: string;
  issues: ConsistencyIssueView[];
}

/**
 * AgentTask.result 的结构。
 * - scene：continuation 为接在正文末尾的新段落；
 * - polish：replacement 只替换 request.range 指定的纯文本区间；
 * - rehearsal：试演片段；consistency：分级报告；ideas：点子卡；guide：选择题或大纲提案。
 */
export interface GenerationResultPayload {
  output: "continuation" | "replacement" | "rehearsal" | "report" | "ideas" | "guide";
  text: string;
  proposals?: string[];
  report?: ConsistencyReport;
  artifactId?: Id;
}

export interface AuthorNote {
  noteId: Id;
  projectId: Id;
  title: string;
  body: string;
  status: "inbox" | "linked" | "archived";
  sceneId?: Id;
  elementId?: Id;
  tags: string[];
  source: "author" | "candidate";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface SceneAnnotation {
  annotationId: Id;
  projectId: Id;
  sceneId: Id;
  kind: "comment" | "question" | "todo";
  body: string;
  status: "open" | "resolved";
  range?: { from: number; to: number; baseText: string; textHash: string };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  resolvedAt?: ISODateTime;
}

export interface CharacterArcProfile {
  entityId: Id;
  projectId: Id;
  motivation: string;
  goal: string;
  conflict: string;
  epiphany: string;
  notes: string;
  updatedAt: ISODateTime;
}

export interface AuthoringEvent {
  seq: number;
  kind: string;
  projectId: Id;
  sceneId?: Id;
  actor: "author" | "system";
  createdAt: ISODateTime;
  meta?: Record<string, string | number | boolean>;
}

export interface WorkspaceSnapshot {
  projects: Project[];
  archivedProjects: Project[];
  activeProject: Project;
  branches: Branch[];
  routes: StoryRoute[];
  chapters: Chapter[];
  scenes: Scene[];
  notes: AuthorNote[];
  annotations: SceneAnnotation[];
  characterArcs: CharacterArcProfile[];
  elements: Entity[];
  facts: FactAssertion[];
  events: WorldEvent[];
  evidence: Evidence[];
  authoringDraft: AuthoringSelection;
  revisions: Revision[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRun[];
  storyGraph: StoryGraph;
  tasks: AgentTask[];
  guide?: GuidedSession;
  workflowGuide?: WorkflowGuideSession;
  connection: PiConnection;
}

export interface WorkflowGuideSession {
  sessionId: Id;
  projectId: Id;
  branchId: Id;
  baseRevisionId: Id;
  status: "active" | "ready" | "published" | "cancelled";
  revision?: number;
  stepIndex: number;
  answers: GuidedAnswer[];
  questions: Record<string, GuidedQuestion>;
  pending?: GuidedQuestion;
  proposal?: WorkflowDefinition;
  publishedVersionId?: Id;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface GuidedOption { id: Id; label: string; detail: string }
export interface GuidedQuestion { stepId: string; question: string; why: string; options: GuidedOption[]; allowCustom: boolean; allowSkip: boolean }
export interface GuidedAnswer { stepId: string; label: string; value: string; skipped: boolean }
export interface OutlineProposalScene { proposalId: Id; title: string; goal: string; conflict: string; summary: string }
export interface GuidedSession {
  sessionId: Id;
  projectId: Id;
  branchId: Id;
  baseRevisionId: Id;
  status: "active" | "ready" | "applied" | "cancelled";
  revision?: number;
  stepIndex: number;
  answers: GuidedAnswer[];
  questions: Record<string, GuidedQuestion>;
  pending?: GuidedQuestion;
  proposal?: OutlineProposalScene[];
  appliedRevisionId?: Id;
  appliedProposalIds?: Id[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ApiErrorBody {
  error: { code: string; message: string; currentRevisionId?: Id; selectionVersion?: number };
}

export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = text.replace(/[\u3400-\u9fff]/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return cjk + latin;
}
