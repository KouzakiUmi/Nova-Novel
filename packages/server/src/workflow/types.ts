import type BetterSqlite3 from "better-sqlite3";
import type {
  AgentTask,
  ContextBundle,
  ContextQuery,
  NodePortType,
  NodeRunState,
  RunState,
  Scene,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
} from "@nova-novel/shared";
import type { ConsistencyIssue, WorkflowService } from "../contracts.js";

/** 执行器使用的数据库句柄（better-sqlite3）。 */
export type WorkflowDatabase = BetterSqlite3.Database;

/**
 * 领域服务向执行器开放的边界。执行器只通过这些方法访问作品、上下文、
 * 生成任务与版本提交，不感知 DomainStore 的具体实现。
 */
export interface WorkflowHooks {
  getRevisionId(projectId: string): string;
  getScene(projectId: string, sceneId: string): Scene | undefined;
  retrieve(query: ContextQuery): ContextBundle;
  generate(input: {
    projectId: string;
    sceneId?: string;
    kind: AgentTask["kind"];
    input: string;
  }): Promise<{ text: string; taskId: string }>;
  commit(input: {
    projectId: string;
    sceneId: string;
    body: string;
    expectedRevisionId: string;
    decisionId?: string;
  }): void;
}

/**
 * 端口类型：定义文件对外仍使用共享的 NodePortType，
 * 执行器内部额外支持通配类型 "any" 与批量端口标记。
 */
export type WorkflowPortType = NodePortType | "any";

export interface NodeInputSpec {
  type: WorkflowPortType;
  required: boolean;
  /** 批量端口：实际承载同类型值的列表，类型名保持共享端口类型。 */
  batch?: boolean;
}

export interface NodeOutputSpec {
  type: NodePortType;
  batch?: boolean;
}

export interface SceneRefValue {
  sceneId: string;
  projectId: string;
  projectRevisionId: string;
  routeId: string | undefined;
  title: string | undefined;
}

export interface WorldStateValue {
  sceneId: string;
  projectId: string;
  projectRevisionId: string;
  status: string;
  storyTime: string | undefined;
  routeId: string | undefined;
  knownEntityIds: string[];
  bodyHash: string;
}

export interface DraftArtifactValue {
  artifactId: string;
  taskId: string;
  kind: AgentTask["kind"];
  sceneId: string | undefined;
  text: string;
  createdAt: string;
}

export interface IssueReportValue {
  reportId: string;
  issues: ConsistencyIssue[];
  summary: string;
  sourceTaskId: string | undefined;
}

export interface DecisionRecordValue {
  decisionId: string;
  answer: string;
  approved: boolean;
  inputHash: string;
  decidedAt: string;
  candidate?: { taskId?: string; artifactId?: string; textHash: string };
}

export interface RevisionRefValue {
  revisionId: string;
  projectId: string;
}

/** 受控遍历容器内部使用的子流程片段。 */
export interface WorkflowGraphFragment {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface NodeGuardResult {
  skip: true;
  reason?: string;
}

export interface NodeExecContext {
  projectId: string;
  baseRevisionId: string;
  runInput: Record<string, unknown>;
  node: WorkflowNode;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  hooks: WorkflowHooks;
  item: unknown;
}

/** 登记的节点类型。执行器只接受已登记的 type + typeVersion 组合。 */
export interface NodeTypeSpec {
  type: string;
  typeVersion: number;
  kind: "normal" | "human" | "foreach";
  inputs: Record<string, NodeInputSpec>;
  outputs:
    | Record<string, NodeOutputSpec>
    | ((config: Record<string, unknown>) => Record<string, NodeOutputSpec>);
  execute?: (
    ctx: NodeExecContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  guard?: (ctx: NodeExecContext) => NodeGuardResult | undefined;
}

/** 工作流服务对外能力：在契约接口之上补充定义查询与恢复能力。 */
export interface WorkflowExecutorService extends WorkflowService {
  getDefinition(workflowVersionId: string): WorkflowDefinition | undefined;
  getRun(runId: string): WorkflowRun | undefined;
  resumeIncompleteRuns(): WorkflowRun[];
  registerDefinition(definition: WorkflowDefinition): WorkflowDefinition;
}

export interface RunRow {
  run_id: string;
  project_id: string;
  workflow_version_id: string;
  definition_json: string;
  semantic_hash: string;
  base_revision_id: string;
  state: RunState;
  input_json: string;
  result_json: string | null;
  error: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface NodeRunRow {
  node_run_id: string;
  run_id: string;
  node_id: string;
  parent_node_run_id: string | null;
  iteration: number | null;
  state: NodeRunState;
  attempt_id: string;
  attempts: number;
  input_hash: string;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TodoRow {
  todo_id: string;
  run_id: string;
  node_run_id: string;
  question: string;
  options_json: string;
  input_hash: string;
  state: "open" | "decided" | "cancelled";
  answer: string | null;
  decision_json: string | null;
  created_at: string;
  updated_at: string;
}

/** 一次作用域（顶层运行或受控遍历的子流程）的执行上下文。 */
export interface WorkflowScope {
  runId: string;
  projectId: string;
  baseRevisionId: string;
  runInput: Record<string, unknown>;
  definition: WorkflowDefinition;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  nodeRuns: Map<string, NodeRunRow>;
  item: unknown;
  parentNodeRunId: string | null;
  iteration: number | null;
  isChild: boolean;
  /** 子流程节点 ID 在数据库中的前缀，用于把持久化行映射回局部节点 ID。 */
  prefix: string;
}
