import type {
  NodeRun,
  NodeRunState,
  RunState,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
} from "@nova-novel/shared";
import { newId, now, sha256, stableHash } from "../utils.js";
import { buildBuiltinDefinitions } from "./definitions.js";
import { NodeTypeRegistry, isApproval, registerBuiltinNodeTypes } from "./registry.js";
import { WorkflowValidationError, semanticHash, validateDefinition } from "./validation.js";
import type {
  DecisionRecordValue,
  DraftArtifactValue,
  NodeExecContext,
  NodeRunRow,
  RunRow,
  TodoRow,
  WorkflowDatabase,
  WorkflowExecutorService,
  WorkflowGraphFragment,
  WorkflowHooks,
  WorkflowScope,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_version_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  state TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_runs (
  node_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_node_run_id TEXT,
  iteration INTEGER,
  state TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL DEFAULT '',
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  todo_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  answer TEXT,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_project ON workflow_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_node_runs_run ON node_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_todos_run ON todos(run_id);
`;

const TERMINAL_RUN_STATES = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

interface DefinitionRow {
  workflow_version_id: string;
  workflow_id: string;
  name: string;
  description: string;
  schema_version: string;
  definition_json: string;
  semantic_hash: string;
  source: string;
  created_at: string;
}

class CancelledRunError extends Error {}

/**
 * 持久化的工作流执行器：把定义、运行、节点运行与人工待办落到 SQLite，
 * 并按工作流画布的语义执行（严格 DAG、类型化端口、条件单出口、人工关卡、
 * 受控遍历、取消与重启恢复）。
 */
export class PersistentWorkflowService implements WorkflowExecutorService {
  private readonly db: SqliteDatabase;
  private readonly hooks: WorkflowHooks;
  private readonly registry = new NodeTypeRegistry();
  private readonly prepared = new Map<string, SqliteStatement>();

  constructor(db: WorkflowDatabase, hooks: WorkflowHooks) {
    this.db = db as unknown as SqliteDatabase;
    this.hooks = hooks;
    this.db.exec(SCHEMA_SQL);
    registerBuiltinNodeTypes(this.registry);
    for (const definition of buildBuiltinDefinitions()) {
      this.installDefinition(definition, "builtin");
    }
  }

  // ---------------------------------------------------------------- 定义

  listDefinitions(): WorkflowDefinition[] {
    const rows = this.statement(
      "SELECT definition_json FROM workflow_versions ORDER BY created_at, workflow_version_id",
    ).all() as Array<{ definition_json: string }>;
    return rows.map((row) => JSON.parse(row.definition_json) as WorkflowDefinition);
  }

  getDefinition(workflowVersionId: string): WorkflowDefinition | undefined {
    const row = this.getDefinitionRow(workflowVersionId);
    if (!row) return undefined;
    return JSON.parse(row.definition_json) as WorkflowDefinition;
  }

  /** 登记一份新的不可变定义。相同版本 ID 只能登记一次。 */
  registerDefinition(definition: WorkflowDefinition): WorkflowDefinition {
    const hash = semanticHash(definition);
    const existing = this.getDefinitionRow(definition.workflowVersionId);
    if (existing) {
      if (existing.semantic_hash !== hash) {
        throw new Error(
          `工作流版本已存在且不可变：${definition.workflowVersionId}；请使用新的版本 ID`,
        );
      }
      return JSON.parse(existing.definition_json) as WorkflowDefinition;
    }
    this.insertDefinition(definition, hash, "authored");
    return definition;
  }

  // ---------------------------------------------------------------- 运行

  listRuns(projectId: string): WorkflowRun[] {
    const rows = this.statement(
      "SELECT run_id FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC, run_id DESC",
    ).all(projectId) as Array<{ run_id: string }>;
    return rows.map((row) => this.getRun(row.run_id)).filter((run): run is WorkflowRun => run !== undefined);
  }

  getRun(runId: string): WorkflowRun | undefined {
    const row = this.getRunRow(runId);
    if (!row) return undefined;
    const nodeRuns = this.listNodeRuns(runId).map((nodeRow) =>
      this.toNodeRun(nodeRow),
    );
    const todo = this.listTodos(runId).find((item) => item.state === "open");
    const run: WorkflowRun = {
      runId: row.run_id,
      projectId: row.project_id,
      workflowVersionId: row.workflow_version_id,
      baseRevisionId: row.base_revision_id,
      state: row.state,
      nodeRuns,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (todo) {
      run.pendingDecision = {
        todoId: todo.todo_id,
        nodeRunId: todo.node_run_id,
        question: todo.question,
        options: JSON.parse(todo.options_json) as string[],
        inputHash: todo.input_hash,
      };
    }
    return run;
  }

  /** 创建一次运行：同步落库并返回，随后异步执行，前端轮询可见进度。 */
  startRun(
    projectId: string,
    workflowVersionId: string,
    input: Record<string, unknown>,
  ): WorkflowRun {
    const definition = this.getDefinition(workflowVersionId);
    if (!definition) {
      throw new Error(`未登记的工作流版本：${workflowVersionId}`);
    }
    const issues = validateDefinition(definition, this.registry);
    if (issues.length > 0) {
      throw new WorkflowValidationError(issues);
    }
    const baseRevisionId = this.hooks.getRevisionId(projectId);
    const runId = newId("run");
    const timestamp = now();
    this.statement(
      `INSERT INTO workflow_runs (
        run_id, project_id, workflow_version_id, definition_json, semantic_hash,
        base_revision_id, state, input_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      runId,
      projectId,
      workflowVersionId,
      JSON.stringify(definition),
      semanticHash(definition),
      baseRevisionId,
      JSON.stringify(input ?? {}),
      timestamp,
      timestamp,
    );
    for (const node of definition.nodes) {
      this.insertNodeRun(runId, node.id, null, null);
    }
    queueMicrotask(() => {
      void this.executeRun(runId);
    });
    return this.getRun(runId)!;
  }

  /** 提交人工决定：校验输入哈希后恢复运行；重复提交不产生第二次提交。 */
  decide(runId: string, todoId: string, answer: string, inputHash: string): WorkflowRun {
    const todo = this.getTodoRow(todoId);
    if (!todo) throw new Error(`待办不存在：${todoId}`);
    if (todo.run_id !== runId) throw new Error("待办不属于该运行");
    if (todo.state === "decided") {
      return this.getRun(runId)!;
    }
    if (todo.state !== "open") {
      throw new Error("待办已关闭，无法提交决定");
    }
    if (inputHash !== todo.input_hash) {
      throw new Error("输入哈希不匹配：请重新读取待办的输入哈希后再确认");
    }
    const scope = this.buildScope(runId, null, null, undefined, undefined, "");
    if (!scope) throw new Error(`运行不存在：${runId}`);
    const nodeRow = this.getNodeRunRow(todo.node_run_id);
    const node = scope.definition.nodes.find((item) => item.id === nodeRow?.node_id);
    if (!node) throw new Error("待办对应的节点不存在");
    const inputs = this.resolveInputs(scope, node);
    const currentHash = this.computeHumanInputHash(scope, node, inputs);
    if (currentHash !== todo.input_hash) {
      throw new Error("输入已变化：原答案不适用于当前候选，请重新计算后再确认");
    }
    const candidate = inputs.candidate as DraftArtifactValue | undefined;
    const decision: DecisionRecordValue = {
      decisionId: newId("dec"),
      answer,
      approved: isApproval(answer),
      inputHash: todo.input_hash,
      decidedAt: now(),
      ...(candidate && typeof candidate.text === "string" ? { candidate: { ...(candidate.taskId ? { taskId: candidate.taskId } : {}), ...(candidate.artifactId ? { artifactId: candidate.artifactId } : {}), textHash: sha256(candidate.text) } } : {}),
    };
    this.statement(
      "UPDATE todos SET state = 'decided', answer = ?, decision_json = ?, updated_at = ? WHERE todo_id = ?",
    ).run(answer, JSON.stringify(decision), now(), todoId);
    this.persistNodeOutput(todo.node_run_id, { decision });
    this.updateNodeRun(todo.node_run_id, { state: "succeeded" });
    queueMicrotask(() => {
      void this.executeRun(runId);
    });
    return this.getRun(runId)!;
  }

  /** 取消运行：先停下游调度并保留部分产物，迟到结果不改变终态。 */
  cancel(runId: string): WorkflowRun {
    const row = this.getRunRow(runId);
    if (!row) throw new Error(`运行不存在：${runId}`);
    if (TERMINAL_RUN_STATES.has(row.state)) {
      return this.getRun(runId)!;
    }
    this.setRunState(runId, "cancelling");
    for (const nodeRow of this.listNodeRuns(runId)) {
      if (
        nodeRow.state === "pending" ||
        nodeRow.state === "ready" ||
        nodeRow.state === "running" ||
        nodeRow.state === "waiting_human"
      ) {
        this.updateNodeRun(nodeRow.node_run_id, { state: "cancelled" });
      }
    }
    for (const todo of this.listTodos(runId)) {
      if (todo.state === "open") {
        this.statement("UPDATE todos SET state = 'cancelled', updated_at = ? WHERE todo_id = ?").run(
          now(),
          todo.todo_id,
        );
      }
    }
    this.setRunState(runId, "cancelled", { cancel_reason: "author_cancelled" });
    return this.getRun(runId)!;
  }

  /**
   * 恢复未完成的运行：已成功节点不重跑，人工待办保留，
   * 结果未知的在途节点标记为中断而不自动重放。
   */
  resumeIncompleteRuns(): WorkflowRun[] {
    const rows = this.statement(
      `SELECT * FROM workflow_runs WHERE state IN ('queued', 'running', 'waiting_human', 'cancelling', 'interrupted') ORDER BY created_at`,
    ).all() as RunRow[];
    const resumed: WorkflowRun[] = [];
    for (const row of rows) {
      if (row.state === "cancelling") {
        this.setRunState(row.run_id, "cancelled", { cancel_reason: "interrupted" });
        const run = this.getRun(row.run_id);
        if (run) resumed.push(run);
        continue;
      }
      if (row.state === "waiting_human") {
        const run = this.getRun(row.run_id);
        if (run) resumed.push(run);
        continue;
      }
      for (const nodeRow of this.listNodeRuns(row.run_id)) {
        if (nodeRow.state === "running") {
          this.updateNodeRun(nodeRow.node_run_id, {
            state: "interrupted",
            error: "进程重启时该节点结果未知，未自动重放",
          });
        }
      }
      this.setRunState(row.run_id, "queued");
      queueMicrotask(() => {
        void this.executeRun(row.run_id);
      });
      const run = this.getRun(row.run_id);
      if (run) resumed.push(run);
    }
    return resumed;
  }

  // ---------------------------------------------------------------- 执行引擎

  private async executeRun(runId: string): Promise<void> {
    const scope = this.buildScope(runId, null, null, undefined, undefined, "");
    if (!scope) return;
    const runRow = this.getRunRow(runId);
    if (!runRow) return;
    if (TERMINAL_RUN_STATES.has(runRow.state)) return;
    if (runRow.state === "queued") this.setRunState(runId, "running");
    await this.executeScope(scope);
  }

  private async executeScope(scope: WorkflowScope): Promise<void> {
    for (;;) {
      const runRow = this.getRunRow(scope.runId);
      if (!runRow) return;
      if (TERMINAL_RUN_STATES.has(runRow.state)) return;
      this.refreshScope(scope);
      const ready = this.computeReady(scope);
      if (ready.length > 0) {
        const limit = Math.max(1, scope.definition.policy?.maxParallelNodes ?? 1);
        const batch = ready.slice(0, limit);
        await Promise.all(batch.map((node) => this.executeNode(scope, node)));
        continue;
      }
      const rows = [...scope.nodeRuns.values()];
      if (rows.some((row) => row.state === "running")) {
        await this.delay(5);
        continue;
      }
      if (rows.some((row) => row.state === "waiting_human")) {
        this.setRunState(scope.runId, "waiting_human");
        return;
      }
      this.finalizeScope(scope);
      return;
    }
  }

  private computeReady(scope: WorkflowScope): WorkflowNode[] {
    const ready: WorkflowNode[] = [];
    for (const node of scope.nodes) {
      const row = scope.nodeRuns.get(node.id);
      if (!row) continue;
      if (row.state !== "pending" && row.state !== "ready") continue;
      const spec = this.registry.get(node.type, node.typeVersion);
      if (!spec) continue;
      // 控制边：条件节点只选中一个出口，未选中的分支整体跳过。
      const controlEdges = scope.edges.filter(
        (edge) => edge.condition !== undefined && edge.target.node === node.id,
      );
      if (controlEdges.length > 0) {
        let waiting = false;
        let active = false;
        for (const edge of controlEdges) {
          const source = scope.nodeRuns.get(edge.source.node);
          if (!source) {
            waiting = true;
            continue;
          }
          if (
            source.state === "pending" ||
            source.state === "ready" ||
            source.state === "running"
          ) {
            waiting = true;
            continue;
          }
          if (source.state === "succeeded" && this.outcomeOf(source) === edge.condition) {
            active = true;
          }
        }
        if (waiting) continue;
        if (!active) {
          this.updateNodeRun(row.node_run_id, { state: "skipped" });
          continue;
        }
      }
      let blocked = false;
      let waiting = false;
      let available = 0;
      let requiredCount = 0;
      // 节点必须等齐所有已绑定的输入（含可选输入）后才可执行：
      // 可选只表示来源支路被跳过时可以缺席，不表示可以抢跑。
      for (const binding of Object.values(node.inputs ?? {})) {
        if ("runInput" in binding) continue;
        const source = scope.nodeRuns.get(binding.node);
        if (!source) {
          waiting = true;
          continue;
        }
        if (
          source.state === "pending" ||
          source.state === "ready" ||
          source.state === "running" ||
          source.state === "waiting_human"
        ) {
          waiting = true;
          continue;
        }
        if (
          source.state === "failed" ||
          source.state === "interrupted" ||
          source.state === "blocked"
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        this.updateNodeRun(row.node_run_id, { state: "blocked" });
        continue;
      }
      if (waiting) continue;
      for (const [port, inputSpec] of Object.entries(spec.inputs)) {
        if (!inputSpec.required) continue;
        requiredCount += 1;
        const binding = node.inputs?.[port];
        if (!binding) {
          blocked = true;
          break;
        }
        if ("runInput" in binding) {
          available += 1;
          continue;
        }
        const source = scope.nodeRuns.get(binding.node);
        if (!source) {
          waiting = true;
          continue;
        }
        if (source.state === "succeeded") {
          available += 1;
          continue;
        }
        if (source.state === "skipped" || source.state === "cancelled") {
          // 未选中的支路：该输入缺席，不阻塞也不参与判定。
          continue;
        }
        if (
          source.state === "failed" ||
          source.state === "interrupted" ||
          source.state === "blocked"
        ) {
          blocked = true;
          break;
        }
        waiting = true;
      }
      if (blocked) {
        this.updateNodeRun(row.node_run_id, { state: "blocked" });
        continue;
      }
      if (waiting) continue;
      if (requiredCount > 0 && available === 0) {
        this.updateNodeRun(row.node_run_id, { state: "skipped" });
        continue;
      }
      ready.push(node);
    }
    return ready;
  }

  private outcomeOf(row: NodeRunRow): string | undefined {
    if (!row.output_json) return undefined;
    try {
      const output = JSON.parse(row.output_json) as { outcome?: unknown };
      return typeof output.outcome === "string" ? output.outcome : undefined;
    } catch {
      return undefined;
    }
  }

  private async executeNode(scope: WorkflowScope, node: WorkflowNode): Promise<void> {
    const row = scope.nodeRuns.get(node.id);
    if (!row) return;
    const spec = this.registry.get(node.type, node.typeVersion);
    if (!spec) return;
    this.updateNodeRun(row.node_run_id, {
      state: "running",
      attempt_id: newId("att"),
      attempts: row.attempts + 1,
      error: null,
    });
    let inputs: Record<string, unknown>;
    try {
      inputs = this.resolveInputs(scope, node);
    } catch (error) {
      this.failNode(row.node_run_id, error);
      return;
    }
    const inputHash =
      spec.kind === "human"
        ? this.computeHumanInputHash(scope, node, inputs)
        : stableHash({
            nodeId: node.id,
            type: node.type,
            typeVersion: node.typeVersion,
            config: node.config ?? {},
            inputs,
          });
    this.updateNodeRun(row.node_run_id, { input_hash: inputHash });

    if (spec.kind === "human") {
      this.createTodo(scope, node, row.node_run_id, inputHash);
      this.updateNodeRun(row.node_run_id, { state: "waiting_human" });
      return;
    }

    const ctx: NodeExecContext = {
      projectId: scope.projectId,
      baseRevisionId: scope.baseRevisionId,
      runInput: scope.runInput,
      node,
      config: node.config ?? {},
      inputs,
      hooks: this.hooks,
      item: scope.item,
    };

    if (node.type === "revision.commit") {
      try { this.assertCommitDecision(scope, node, inputs); }
      catch (error) { this.failNode(row.node_run_id, error); return; }
    }
    const guard = spec.guard?.(ctx);
    if (guard?.skip) {
      this.updateNodeRun(row.node_run_id, { state: "skipped" });
      if (guard.reason) this.setRunCancelReason(scope.runId, guard.reason);
      return;
    }

    try {
      let output: Record<string, unknown>;
      if (spec.kind === "foreach") {
        output = await this.runForeach(scope, node, inputs, row);
      } else if (spec.execute) {
        output = await spec.execute(ctx);
      } else {
        output = {};
      }
      const current = this.getNodeRunRow(row.node_run_id);
      if (!current) return;
      if (current.state !== "running") {
        // 迟到结果：保留产物，但不改写终态。
        if (current.state === "cancelled") {
          this.persistNodeOutput(row.node_run_id, output);
        }
        return;
      }
      this.persistNodeOutput(row.node_run_id, output);
      this.updateNodeRun(row.node_run_id, { state: "succeeded" });
    } catch (error) {
      if (error instanceof CancelledRunError) {
        const current = this.getNodeRunRow(row.node_run_id);
        if (current && current.state === "running") {
          this.updateNodeRun(row.node_run_id, { state: "cancelled" });
        }
        return;
      }
      this.failNode(row.node_run_id, error);
    }
  }

  private async runForeach(
    scope: WorkflowScope,
    node: WorkflowNode,
    inputs: Record<string, unknown>,
    parentRow: NodeRunRow,
  ): Promise<Record<string, unknown>> {
    const config = node.config ?? {};
    const maxItems = Number(config.maxItems ?? 10);
    const maxIterations = Number(
      config.maxIterations ?? scope.definition.policy?.maxIterations ?? maxItems,
    );
    const items = Array.isArray(inputs.items) ? (inputs.items as unknown[]) : [];
    const limit = Math.max(0, Math.min(items.length, maxItems, maxIterations));
    const child = config.child as WorkflowGraphFragment | undefined;
    if (!child) throw new Error("遍历容器缺少子流程定义");
    const resultPort = String(config.resultPort ?? "report");
    const results: unknown[] = [];
    for (let index = 0; index < limit; index += 1) {
      const runRow = this.getRunRow(scope.runId);
      if (!runRow || TERMINAL_RUN_STATES.has(runRow.state)) {
        throw new CancelledRunError();
      }
      const item = items[index];
      const prefix = `${parentRow.node_id}#${index}:`;
      for (const childNode of child.nodes) {
        this.insertNodeRun(scope.runId, `${prefix}${childNode.id}`, parentRow.node_run_id, index);
      }
      const childScope = this.buildScope(
        scope.runId,
        parentRow.node_run_id,
        index,
        item,
        child,
        prefix,
      );
      if (!childScope) throw new Error("无法建立遍历子流程");
      await this.executeScope(childScope);
      const childRows = [...childScope.nodeRuns.values()];
      if (childRows.some((row) => row.state === "failed")) {
        throw new Error(`遍历子流程在第 ${index + 1} 项失败`);
      }
      results.push(this.readChildResult(childScope, resultPort));
    }
    return { results };
  }

  private readChildResult(scope: WorkflowScope, resultPort: string): unknown {
    for (const node of scope.nodes) {
      if (!node.outputs || !(resultPort in node.outputs)) continue;
      const row = scope.nodeRuns.get(node.id);
      if (!row || !row.output_json) continue;
      try {
        const output = JSON.parse(row.output_json) as Record<string, unknown>;
        return output[resultPort];
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private finalizeScope(scope: WorkflowScope): void {
    if (scope.isChild) return;
    this.refreshScope(scope);
    const rows = [...scope.nodeRuns.values()];
    const runRow = this.getRunRow(scope.runId);
    if (!runRow) return;
    let state: RunState;
    let error: string | null = null;
    if (runRow.cancel_reason) {
      state = "cancelled";
    } else if (rows.some((row) => row.state === "failed")) {
      state = "failed";
      error = rows.find((row) => row.state === "failed")?.error ?? "节点执行失败";
    } else if (rows.some((row) => row.state === "interrupted")) {
      state = "interrupted";
    } else if (rows.some((row) => row.state === "blocked")) {
      state = "failed";
      error = "依赖节点未成功";
    } else if (rows.some((row) => row.state === "cancelled")) {
      state = "cancelled";
    } else {
      state = "succeeded";
    }
    const committed = rows.some((row) => {
      if (row.state !== "succeeded" || !row.output_json) return false;
      try {
        const output = JSON.parse(row.output_json) as { revision?: unknown };
        return output.revision !== undefined;
      } catch {
        return false;
      }
    });
    this.setRunState(scope.runId, state, {
      error,
      result: JSON.stringify({
        committed,
        nodes: rows.map((row) => ({ nodeId: row.node_id, state: row.state })),
      }),
    });
  }

  // ---------------------------------------------------------------- 输入与哈希

  private resolveInputs(
    scope: WorkflowScope,
    node: WorkflowNode,
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const [port, binding] of Object.entries(node.inputs ?? {})) {
      if ("runInput" in binding) {
        inputs[port] = this.resolveRunInput(scope, binding.runInput);
        continue;
      }
      const source = scope.nodeRuns.get(binding.node);
      if (!source || !source.output_json) {
        inputs[port] = undefined;
        continue;
      }
      try {
        const output = JSON.parse(source.output_json) as Record<string, unknown>;
        inputs[port] = output[binding.port];
      } catch {
        inputs[port] = undefined;
      }
    }
    return inputs;
  }

  private resolveRunInput(scope: WorkflowScope, key: string): unknown {
    if (key === "item") return scope.item;
    const raw = scope.runInput[key];
    if (key === "sceneId" && typeof raw === "string") {
      return this.makeSceneRef(scope.projectId, raw);
    }
    if (key === "sceneIds" && Array.isArray(raw)) {
      return raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => this.makeSceneRef(scope.projectId, value));
    }
    return raw;
  }

  private makeSceneRef(projectId: string, sceneId: string): unknown {
    const scene = this.hooks.getScene(projectId, sceneId);
    return {
      sceneId,
      projectId,
      projectRevisionId: this.hooks.getRevisionId(projectId),
      routeId: scene?.routeId,
      title: scene?.title,
    };
  }

  private assertCommitDecision(scope: WorkflowScope, node: WorkflowNode, inputs: Record<string, unknown>): void {
    const decisionBinding = node.inputs.decision;
    const draftBinding = node.inputs.draft;
    if (!decisionBinding || "runInput" in decisionBinding || !draftBinding || "runInput" in draftBinding) throw new Error("提交必须引用真实人工决定与同源候选，不能使用运行输入伪造");
    const human = scope.definition.nodes.find(item => item.id === decisionBinding.node && item.type === "human.review");
    if (!human) throw new Error("提交决定不是来自人工审阅节点");
    const candidateBinding = human.inputs.candidate;
    if (!candidateBinding || "runInput" in candidateBinding || candidateBinding.node !== draftBinding.node || candidateBinding.port !== draftBinding.port) throw new Error("提交候选与人工审阅来源不一致");
    const humanRun = scope.nodeRuns.get(human.id);
    const draft = inputs.draft as DraftArtifactValue | undefined;
    if (!humanRun || !draft || typeof draft.text !== "string") throw new Error("人工审阅或提交候选缺失");
    const todo = this.listTodos(scope.runId).find(item => item.node_run_id === humanRun.node_run_id && item.state === "decided" && item.decision_json);
    if (!todo?.decision_json) throw new Error("人工决定尚未持久化");
    const decision = JSON.parse(todo.decision_json) as DecisionRecordValue;
    if (decision.approved !== true) return;
    if (!decision.candidate) throw new Error("人工决定未批准或缺少候选绑定");
    if (decision.candidate.textHash !== sha256(draft.text)) throw new Error("提交候选与人工审阅内容不一致");
    if (decision.candidate.taskId && decision.candidate.taskId !== draft.taskId) throw new Error("提交候选与人工审阅任务不一致");
    if (decision.candidate.artifactId && decision.candidate.artifactId !== draft.artifactId) throw new Error("提交候选与人工审阅产物不一致");
  }

  /**
   * 人工关卡的输入哈希：除候选内容外还冻结当前作品版本与场景状态，
   * 等待期间输入发生变化时旧答案不再适用。
   */
  private computeHumanInputHash(
    scope: WorkflowScope,
    node: WorkflowNode,
    inputs: Record<string, unknown>,
  ): string {
    const revisionId = this.hooks.getRevisionId(scope.projectId);
    const sceneId =
      typeof scope.runInput.sceneId === "string" ? scope.runInput.sceneId : undefined;
    const scene = sceneId
      ? this.hooks.getScene(scope.projectId, sceneId)
      : undefined;
    return stableHash({
      nodeId: node.id,
      inputs,
      baseRevisionId: revisionId,
      scene:
        scene === undefined
          ? null
          : {
              bodyHash: sha256(scene.body),
              status: scene.status,
              updatedAt: scene.updatedAt,
            },
    });
  }

  private createTodo(
    scope: WorkflowScope,
    node: WorkflowNode,
    nodeRunId: string,
    inputHash: string,
  ): void {
    const question =
      typeof node.config?.question === "string" && node.config.question.length > 0
        ? node.config.question
        : "作者是否接受该结果？";
    const options = Array.isArray(node.config?.options)
      ? (node.config.options as string[])
      : ["accept", "reject"];
    this.statement(
      `INSERT INTO todos (
        todo_id, run_id, node_run_id, question, options_json, input_hash, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      newId("todo"),
      scope.runId,
      nodeRunId,
      question,
      JSON.stringify(options),
      inputHash,
      now(),
      now(),
    );
  }

  // ---------------------------------------------------------------- 持久化

  private statement(sql: string): SqliteStatement {
    const cached = this.prepared.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    this.prepared.set(sql, statement);
    return statement;
  }

  private installDefinition(definition: WorkflowDefinition, source: string): void {
    const hash = semanticHash(definition);
    const existing = this.getDefinitionRow(definition.workflowVersionId);
    if (!existing) {
      this.insertDefinition(definition, hash, source);
      return;
    }
    if (existing.semantic_hash === hash) return;
    const referenced = this.statement(
      "SELECT COUNT(*) AS total FROM workflow_runs WHERE workflow_version_id = ?",
    ).get(definition.workflowVersionId) as { total: number };
    if (referenced.total > 0) return; // 已被运行引用的版本保持不可变
    this.statement(
      `UPDATE workflow_versions SET definition_json = ?, semantic_hash = ? WHERE workflow_version_id = ?`,
    ).run(JSON.stringify(definition), hash, definition.workflowVersionId);
  }

  private insertDefinition(
    definition: WorkflowDefinition,
    hash: string,
    source: string,
  ): void {
    this.statement(
      `INSERT INTO workflow_versions (
        workflow_version_id, workflow_id, name, description, schema_version,
        definition_json, semantic_hash, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      definition.workflowVersionId,
      definition.workflowId,
      definition.name,
      definition.description ?? "",
      definition.schemaVersion,
      JSON.stringify(definition),
      hash,
      source,
      now(),
    );
  }

  private getDefinitionRow(workflowVersionId: string): DefinitionRow | undefined {
    return this.statement(
      "SELECT * FROM workflow_versions WHERE workflow_version_id = ?",
    ).get(workflowVersionId) as DefinitionRow | undefined;
  }

  private getRunRow(runId: string): RunRow | undefined {
    return this.statement("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as
      | RunRow
      | undefined;
  }

  private getNodeRunRow(nodeRunId: string): NodeRunRow | undefined {
    return this.statement(
      "SELECT * FROM node_runs WHERE node_run_id = ?",
    ).get(nodeRunId) as NodeRunRow | undefined;
  }

  private getTodoRow(todoId: string): TodoRow | undefined {
    return this.statement("SELECT * FROM todos WHERE todo_id = ?").get(todoId) as
      | TodoRow
      | undefined;
  }

  private listNodeRuns(runId: string): NodeRunRow[] {
    return this.statement(
      "SELECT * FROM node_runs WHERE run_id = ? ORDER BY created_at, node_id",
    ).all(runId) as NodeRunRow[];
  }

  private listTodos(runId: string): TodoRow[] {
    return this.statement(
      "SELECT * FROM todos WHERE run_id = ? ORDER BY created_at, todo_id",
    ).all(runId) as TodoRow[];
  }

  private insertNodeRun(
    runId: string,
    nodeId: string,
    parentNodeRunId: string | null,
    iteration: number | null,
  ): void {
    const timestamp = now();
    this.statement(
      `INSERT INTO node_runs (
        node_run_id, run_id, node_id, parent_node_run_id, iteration, state,
        attempt_id, attempts, input_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', '', 0, '', ?, ?)`,
    ).run(
      newId("nrun"),
      runId,
      nodeId,
      parentNodeRunId,
      iteration,
      timestamp,
      timestamp,
    );
  }

  private updateNodeRun(
    nodeRunId: string,
    patch: {
      state?: NodeRunState;
      attempt_id?: string;
      attempts?: number;
      input_hash?: string;
      error?: string | null;
    },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now()];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      params.push(patch.state);
    }
    if (patch.attempt_id !== undefined) {
      sets.push("attempt_id = ?");
      params.push(patch.attempt_id);
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?");
      params.push(patch.attempts);
    }
    if (patch.input_hash !== undefined) {
      sets.push("input_hash = ?");
      params.push(patch.input_hash);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      params.push(patch.error);
    }
    params.push(nodeRunId);
    this.statement(`UPDATE node_runs SET ${sets.join(", ")} WHERE node_run_id = ?`).run(
      ...params,
    );
  }

  /** 节点产物先落库，随后才做状态转移。 */
  private persistNodeOutput(nodeRunId: string, output: unknown): void {
    this.statement(
      "UPDATE node_runs SET output_json = ?, updated_at = ? WHERE node_run_id = ?",
    ).run(JSON.stringify(output ?? null), now(), nodeRunId);
  }

  private failNode(nodeRunId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateNodeRun(nodeRunId, { state: "failed", error: message });
  }

  private setRunState(
    runId: string,
    state: RunState,
    extra?: { error?: string | null; result?: string; cancel_reason?: string },
  ): void {
    const sets = ["state = ?", "updated_at = ?"];
    const params: unknown[] = [state, now()];
    if (extra?.error !== undefined) {
      sets.push("error = ?");
      params.push(extra.error);
    }
    if (extra?.result !== undefined) {
      sets.push("result_json = ?");
      params.push(extra.result);
    }
    if (extra?.cancel_reason !== undefined) {
      sets.push("cancel_reason = ?");
      params.push(extra.cancel_reason);
    }
    params.push(runId);
    this.statement(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE run_id = ?`).run(
      ...params,
    );
  }

  private setRunCancelReason(runId: string, reason: string): void {
    this.statement(
      "UPDATE workflow_runs SET cancel_reason = ?, updated_at = ? WHERE run_id = ?",
    ).run(reason, now(), runId);
  }

  private toNodeRun(row: NodeRunRow): NodeRun {
    const nodeRun: NodeRun = {
      nodeRunId: row.node_run_id,
      runId: row.run_id,
      nodeId: row.node_id,
      state: row.state,
      attemptId: row.attempt_id,
      inputHash: row.input_hash,
    };
    if (row.output_json) {
      try {
        nodeRun.output = JSON.parse(row.output_json) as unknown;
      } catch {
        nodeRun.output = undefined;
      }
    }
    if (row.error) nodeRun.error = row.error;
    return nodeRun;
  }

  // ---------------------------------------------------------------- 作用域

  private buildScope(
    runId: string,
    parentNodeRunId: string | null,
    iteration: number | null,
    item: unknown,
    fragment: WorkflowGraphFragment | undefined,
    prefix: string,
  ): WorkflowScope | undefined {
    const runRow = this.getRunRow(runId);
    if (!runRow) return undefined;
    const definition = JSON.parse(runRow.definition_json) as WorkflowDefinition;
    const nodes = fragment ? fragment.nodes : definition.nodes;
    const edges = fragment ? fragment.edges : (definition.edges ?? []);
    const nodeRuns = new Map<string, NodeRunRow>();
    const rows = this.listNodeRuns(runId);
    for (const row of rows) {
      if (parentNodeRunId === null) {
        if (row.parent_node_run_id === null) nodeRuns.set(row.node_id, row);
        continue;
      }
      if (row.parent_node_run_id !== parentNodeRunId) continue;
      if (iteration !== null && row.iteration !== iteration) continue;
      if (!row.node_id.startsWith(prefix)) continue;
      nodeRuns.set(row.node_id.slice(prefix.length), row);
    }
    let runInput: Record<string, unknown> = {};
    try {
      runInput = JSON.parse(runRow.input_json) as Record<string, unknown>;
    } catch {
      runInput = {};
    }
    return {
      runId,
      projectId: runRow.project_id,
      baseRevisionId: runRow.base_revision_id,
      runInput,
      definition,
      nodes,
      edges,
      nodeRuns,
      item,
      parentNodeRunId,
      iteration,
      isChild: parentNodeRunId !== null,
      prefix,
    };
  }

  private refreshScope(scope: WorkflowScope): void {
    const rows = this.listNodeRuns(scope.runId);
    scope.nodeRuns = new Map<string, NodeRunRow>();
    for (const row of rows) {
      if (scope.parentNodeRunId === null) {
        if (row.parent_node_run_id === null) scope.nodeRuns.set(row.node_id, row);
        continue;
      }
      if (row.parent_node_run_id !== scope.parentNodeRunId) continue;
      if (scope.iteration !== null && row.iteration !== scope.iteration) continue;
      if (!row.node_id.startsWith(scope.prefix)) continue;
      scope.nodeRuns.set(row.node_id.slice(scope.prefix.length), row);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { WorkflowValidationError } from "./validation.js";
