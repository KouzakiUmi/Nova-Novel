import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ContextBundle,
  ContextQuery,
  Scene,
  WorkflowDefinition,
  WorkflowNode,
} from "@nova-novel/shared";
import {
  PersistentWorkflowService,
  semanticHash,
  sceneCreationDefinition,
} from "../src/workflow/index.js";
import type { WorkflowHooks } from "../src/workflow/types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

async function createDatabase(): Promise<any> {
  // 优先使用项目声明的 better-sqlite3；未安装时回退到 Node 内置的 node:sqlite。
  const specifier = "better-sqlite3";
  try {
    const loaded: any = await import(specifier);
    const DatabaseCtor = loaded.default ?? loaded;
    return new DatabaseCtor(":memory:");
  } catch {
    const sqliteSpecifier = "node:sqlite";
    const sqlite: any = await import(sqliteSpecifier);
    return new sqlite.DatabaseSync(":memory:");
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneId: "scene_1",
    projectId: "proj_1",
    chapterId: "chapter_1",
    title: "旧鞋铺",
    summary: "父亲留下的修鞋铺",
    body: "初稿正文",
    status: "writing",
    narrationOrder: 1,
    routeId: "route_1",
    entityIds: ["entity_1"],
    baseRevisionId: "rev_1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBundle(snapshotId = "snapshot_1"): ContextBundle {
  return {
    snapshotId,
    facts: [],
    evidence: [],
    selectedPlans: [],
    candidates: [],
    excluded: [],
    indexState: {
      keywordRevisionId: "rev_1",
      semanticState: "ready",
    },
  };
}

class TestHooks implements WorkflowHooks {
  revisionId = "rev_1";
  readonly scenes = new Map<string, Scene>();
  readonly generateCalls: Array<{ kind: string; input: string; sceneId?: string }> = [];
  readonly commitCalls: Array<{
    projectId: string;
    sceneId: string;
    body: string;
    expectedRevisionId: string;
  }> = [];
  readonly retrieveCalls: ContextQuery[] = [];
  generateHandler: (input: {
    projectId: string;
    sceneId?: string;
    kind: string;
    input: string;
  }) => Promise<{ text: string; taskId: string }> = async (input) => ({
    text: `候选正文：${input.kind}`,
    taskId: `task_${this.generateCalls.length + 1}`,
  });
  retrieveHandler: (query: ContextQuery) => ContextBundle = () => makeBundle();

  getRevisionId(_projectId: string): string {
    return this.revisionId;
  }

  getScene(_projectId: string, sceneId: string): Scene | undefined {
    return this.scenes.get(sceneId);
  }

  retrieve(query: ContextQuery): ContextBundle {
    this.retrieveCalls.push(query);
    return this.retrieveHandler(query);
  }

  async generate(input: {
    projectId: string;
    sceneId?: string;
    kind: string;
    input: string;
  }): Promise<{ text: string; taskId: string }> {
    this.generateCalls.push({
      kind: input.kind,
      input: input.input,
      ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    });
    return this.generateHandler(input);
  }

  commit(input: {
    projectId: string;
    sceneId: string;
    body: string;
    expectedRevisionId: string;
  }): void {
    this.commitCalls.push({ ...input });
  }
}

async function waitFor(
  predicate: () => boolean,
  label = "条件",
  timeoutMs = 4000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function nodeRunsOf(
  service: PersistentWorkflowService,
  runId: string,
): Map<string, string> {
  const run = service.getRun(runId);
  const map = new Map<string, string>();
  for (const nodeRun of run?.nodeRuns ?? []) {
    map.set(nodeRun.nodeId, nodeRun.state);
  }
  return map;
}

/** 条件分流流程：条件节点只选中一个出口，三条分支共享同一份候选稿。 */
function conditionDefinition(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    {
      id: "scene",
      type: "run.scene",
      typeVersion: 1,
      name: "选择场景",
      config: {},
      inputs: { scene: { runInput: "sceneId" } },
      outputs: { scene: "SceneRef" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "state",
      type: "world.readState",
      typeVersion: 1,
      name: "读取状态",
      config: {},
      inputs: { scene: { node: "scene", port: "scene" } },
      outputs: { state: "WorldState" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "retrieve",
      type: "context.retrieve",
      typeVersion: 1,
      name: "检索上下文",
      config: {},
      inputs: {
        scene: { node: "scene", port: "scene" },
        state: { node: "state", port: "state" },
      },
      outputs: { context: "ContextBundle" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "generate",
      type: "agent.generate",
      typeVersion: 1,
      name: "生成候选",
      config: { kind: "scene" },
      inputs: { context: { node: "retrieve", port: "context" } },
      outputs: { draft: "DraftArtifact" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "cond",
      type: "flow.condition",
      typeVersion: 1,
      name: "条件分流",
      config: {},
      inputs: { value: { runInput: "conditionValue" } },
      outputs: { true: "DecisionRecord", false: "DecisionRecord", unknown: "DecisionRecord" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "onTrue",
      type: "quality.checkConsistency",
      typeVersion: 1,
      name: "通过分支",
      config: {},
      inputs: { draft: { node: "generate", port: "draft" } },
      outputs: { report: "IssueReport" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "onFalse",
      type: "quality.checkConsistency",
      typeVersion: 1,
      name: "不通过分支",
      config: {},
      inputs: { draft: { node: "generate", port: "draft" } },
      outputs: { report: "IssueReport" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "onUnknown",
      type: "quality.checkConsistency",
      typeVersion: 1,
      name: "未知分支",
      config: {},
      inputs: { draft: { node: "generate", port: "draft" } },
      outputs: { report: "IssueReport" },
      ui: { x: 0, y: 0 },
    },
    {
      id: "join",
      type: "human.review",
      typeVersion: 1,
      name: "合流人工关卡",
      config: { question: "接受哪一版？" },
      inputs: {
        candidate: { node: "onTrue", port: "report" },
        report: { node: "onFalse", port: "report" },
      },
      outputs: { decision: "DecisionRecord" },
      ui: { x: 0, y: 0 },
    },
  ];
  return {
    schemaVersion: "nova-novel.workflow/1",
    workflowId: "wf_condition_test",
    workflowVersionId: "wfv_condition_test_1",
    name: "条件分流验证",
    description: "用于验证条件单出口与合流跳过",
    nodes,
    edges: [
      {
        id: "e_scene_state",
        source: { node: "scene", port: "scene", type: "SceneRef" },
        target: { node: "state", port: "scene", type: "SceneRef" },
      },
      {
        id: "e_scene_retrieve",
        source: { node: "scene", port: "scene", type: "SceneRef" },
        target: { node: "retrieve", port: "scene", type: "SceneRef" },
      },
      {
        id: "e_state_retrieve",
        source: { node: "state", port: "state", type: "WorldState" },
        target: { node: "retrieve", port: "state", type: "WorldState" },
      },
      {
        id: "e_retrieve_generate",
        source: { node: "retrieve", port: "context", type: "ContextBundle" },
        target: { node: "generate", port: "context", type: "ContextBundle" },
      },
      {
        id: "e_generate_true",
        source: { node: "generate", port: "draft", type: "DraftArtifact" },
        target: { node: "onTrue", port: "draft", type: "DraftArtifact" },
      },
      {
        id: "e_generate_false",
        source: { node: "generate", port: "draft", type: "DraftArtifact" },
        target: { node: "onFalse", port: "draft", type: "DraftArtifact" },
      },
      {
        id: "e_generate_unknown",
        source: { node: "generate", port: "draft", type: "DraftArtifact" },
        target: { node: "onUnknown", port: "draft", type: "DraftArtifact" },
      },
      {
        id: "e_cond_true",
        source: { node: "cond", port: "true", type: "DecisionRecord" },
        target: { node: "onTrue", port: "control", type: "DecisionRecord" },
        condition: "true",
      },
      {
        id: "e_cond_false",
        source: { node: "cond", port: "false", type: "DecisionRecord" },
        target: { node: "onFalse", port: "control", type: "DecisionRecord" },
        condition: "false",
      },
      {
        id: "e_cond_unknown",
        source: { node: "cond", port: "unknown", type: "DecisionRecord" },
        target: { node: "onUnknown", port: "control", type: "DecisionRecord" },
        condition: "unknown",
      },
      {
        id: "e_true_join",
        source: { node: "onTrue", port: "report", type: "IssueReport" },
        target: { node: "join", port: "candidate", type: "IssueReport" },
      },
      {
        id: "e_false_join",
        source: { node: "onFalse", port: "report", type: "IssueReport" },
        target: { node: "join", port: "report", type: "IssueReport" },
      },
    ],
    policy: { maxParallelNodes: 2, maxNodeAttempts: 2, maxIterations: 2 },
  };
}

test("构造时幂等建表并登记两套不可变模板", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  const service = new PersistentWorkflowService(db, hooks);
  const definitions = service.listDefinitions();
  assert.equal(definitions.length, 2);
  assert.deepEqual(
    definitions.map((definition) => definition.workflowId).sort(),
    ["wf_scene_create", "wf_volume_audit"],
  );
  const again = new PersistentWorkflowService(db, hooks);
  assert.equal(again.listDefinitions().length, 2);
  assert.ok(service.getDefinition("wfv_scene_create_1"));
  assert.ok(service.getDefinition("wfv_volume_audit_1"));
});

test("端口类型不匹配时拒绝运行", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  const service = new PersistentWorkflowService(db, hooks);
  const broken = clone(service.getDefinition("wfv_scene_create_1")!);
  broken.workflowVersionId = "wfv_broken_port";
  broken.nodes = broken.nodes.map((node) =>
    node.id === "state"
      ? { ...node, inputs: { scene: { node: "check", port: "report" } } }
      : node,
  );
  broken.edges = broken.edges.map((edge) =>
    edge.id === "edge_scene_state"
      ? {
          ...edge,
          source: { node: "check", port: "report", type: "IssueReport" },
          target: { node: "state", port: "scene", type: "SceneRef" },
        }
      : edge,
  );
  service.registerDefinition(broken);
  assert.throws(
    () => service.startRun("proj_1", "wfv_broken_port", { sceneId: "scene_1" }),
    /端口类型不匹配/,
  );
});

test("顶层存在环时拒绝运行", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  const service = new PersistentWorkflowService(db, hooks);
  const cyclic: WorkflowDefinition = {
    schemaVersion: "nova-novel.workflow/1",
    workflowId: "wf_cycle",
    workflowVersionId: "wfv_cycle_1",
    name: "环",
    description: "制造拓扑环",
    nodes: [
      {
        id: "a",
        type: "human.review",
        typeVersion: 1,
        name: "A",
        config: {},
        inputs: { candidate: { node: "b", port: "decision" } },
        outputs: { decision: "DecisionRecord" },
        ui: { x: 0, y: 0 },
      },
      {
        id: "b",
        type: "human.review",
        typeVersion: 1,
        name: "B",
        config: {},
        inputs: { candidate: { node: "a", port: "decision" } },
        outputs: { decision: "DecisionRecord" },
        ui: { x: 0, y: 0 },
      },
    ],
    edges: [
      {
        id: "e_a_b",
        source: { node: "a", port: "decision", type: "DecisionRecord" },
        target: { node: "b", port: "candidate", type: "DecisionRecord" },
      },
      {
        id: "e_b_a",
        source: { node: "b", port: "decision", type: "DecisionRecord" },
        target: { node: "a", port: "candidate", type: "DecisionRecord" },
      },
    ],
    policy: { maxParallelNodes: 1, maxNodeAttempts: 1, maxIterations: 1 },
  };
  service.registerDefinition(cyclic);
  assert.throws(
    () => service.startRun("proj_1", "wfv_cycle_1", {}),
    /存在环/,
  );
});

test("未知节点类型时拒绝运行", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  const service = new PersistentWorkflowService(db, hooks);
  const broken = clone(service.getDefinition("wfv_scene_create_1")!);
  broken.workflowVersionId = "wfv_broken_type";
  broken.nodes = broken.nodes.map((node) =>
    node.id === "generate" ? { ...node, type: "ai.unknown", typeVersion: 3 } : node,
  );
  service.registerDefinition(broken);
  assert.throws(
    () => service.startRun("proj_1", "wfv_broken_type", { sceneId: "scene_1" }),
    /未知节点类型/,
  );
});

test("缺少必填输入时拒绝运行", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  const service = new PersistentWorkflowService(db, hooks);
  const broken = clone(service.getDefinition("wfv_scene_create_1")!);
  broken.workflowVersionId = "wfv_broken_input";
  broken.nodes = broken.nodes.map((node) =>
    node.id === "commit"
      ? { ...node, inputs: { decision: { node: "review", port: "decision" } } }
      : node,
  );
  broken.edges = broken.edges.filter((edge) => edge.id !== "edge_generate_commit");
  service.registerDefinition(broken);
  assert.throws(
    () => service.startRun("proj_1", "wfv_broken_input", { sceneId: "scene_1" }),
    /缺少必填输入/,
  );
});

test("画布布局不影响语义哈希，也不改变既有版本", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  const service = new PersistentWorkflowService(db, hooks);
  const base = sceneCreationDefinition();
  const moved = clone(base);
  moved.nodes = moved.nodes.map((node) => ({
    ...node,
    ui: { x: node.ui.x + 240, y: node.ui.y + 90 },
  }));
  assert.equal(semanticHash(base), semanticHash(moved));

  const changed = clone(base);
  changed.nodes = changed.nodes.map((node) =>
    node.id === "generate" ? { ...node, config: { ...node.config, prompt: "改写" } } : node,
  );
  assert.notEqual(semanticHash(base), semanticHash(changed));

  // 相同版本 ID 下仅布局不同的定义视为同一版本。
  const stored = service.registerDefinition(moved);
  assert.equal(service.listDefinitions().length, 2);
  assert.equal(stored.workflowVersionId, "wfv_scene_create_1");
  assert.equal(
    service.getDefinition("wfv_scene_create_1")!.nodes[0]!.ui.x,
    base.nodes[0]!.ui.x,
  );
});

test("人工关卡跨重启恢复：成功节点不重跑、待办不丢", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "运行进入等待人工",
  );
  const callsBefore = hooks.generateCalls.length;
  assert.ok(callsBefore >= 2, "生成与一致性检查都应已执行");

  // 模拟进程重启：同一数据库上新建执行器并恢复未完成的运行。
  const restarted = new PersistentWorkflowService(db, hooks);
  const resumed = restarted.resumeIncompleteRuns();
  assert.equal(resumed.length, 1);
  const resumedRun = restarted.getRun(run.runId)!;
  assert.equal(resumedRun.state, "waiting_human");
  assert.ok(resumedRun.pendingDecision, "人工待办应持久化");
  assert.equal(hooks.generateCalls.length, callsBefore, "成功节点不应重跑");

  const nodeStates = nodeRunsOf(restarted, run.runId);
  assert.equal(nodeStates.get("generate"), "succeeded");
  assert.equal(nodeStates.get("review"), "waiting_human");

  // 人工接受后恢复运行并提交修订。
  restarted.decide(
    run.runId,
    resumedRun.pendingDecision!.todoId,
    "accept",
    resumedRun.pendingDecision!.inputHash,
  );
  await waitFor(
    () => restarted.getRun(run.runId)?.state === "succeeded",
    "运行完成",
  );
  assert.equal(hooks.commitCalls.length, 1);
  assert.equal(hooks.commitCalls[0]!.expectedRevisionId, "rev_1");
  assert.equal(hooks.commitCalls[0]!.sceneId, "scene_1");
});

test("等待期间输入变化时旧答案被拒绝", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "运行进入等待人工",
  );
  const pending = service.getRun(run.runId)!.pendingDecision!;

  // 作者在等待期间改了场景正文，输入哈希随之变化。
  hooks.scenes.set("scene_1", makeScene({ body: "改写后的正文" }));
  assert.throws(
    () => service.decide(run.runId, pending.todoId, "accept", pending.inputHash),
    /输入已变化/,
  );
  assert.throws(
    () => service.decide(run.runId, pending.todoId, "accept", "hash_not_matching"),
    /输入哈希不匹配/,
  );
  assert.equal(hooks.commitCalls.length, 0);
  assert.equal(service.getRun(run.runId)!.state, "waiting_human");
});

test("取消后保留部分产物，迟到结果不改变终态", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  let release: ((value: { text: string; taskId: string }) => void) | undefined;
  hooks.generateHandler = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => nodeRunsOf(service, run.runId).get("generate") === "running",
    "生成节点进入运行",
  );
  const cancelled = service.cancel(run.runId);
  assert.equal(cancelled.state, "cancelled");

  release?.({ text: "迟到的正文", taskId: "task_late" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const after = service.getRun(run.runId)!;
  assert.equal(after.state, "cancelled", "迟到结果不得把终态改回成功");
  assert.equal(hooks.commitCalls.length, 0, "取消后不得提交修订");
  const states = nodeRunsOf(service, run.runId);
  assert.equal(states.get("generate"), "cancelled");
  assert.equal(states.get("scene"), "succeeded", "已成功的节点产物保留");
});

test("条件为未知时只走未知出口，未选中分支跳过且合流不死等", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  service.registerDefinition(conditionDefinition());
  const run = service.startRun("proj_1", "wfv_condition_test_1", {
    sceneId: "scene_1",
    conditionValue: "unknown",
  });
  await waitFor(
    () => {
      const state = service.getRun(run.runId)?.state;
      return state === "succeeded" || state === "failed" || state === "cancelled";
    },
    "条件流程结束",
  );
  const run2 = service.getRun(run.runId)!;
  assert.equal(run2.state, "succeeded");
  const states = nodeRunsOf(service, run.runId);
  assert.equal(states.get("onTrue"), "skipped");
  assert.equal(states.get("onFalse"), "skipped");
  assert.equal(states.get("onUnknown"), "succeeded");
  assert.equal(states.get("join"), "skipped", "合流不死等");
});

test("条件为真时只走真出口，合流等待人工", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  service.registerDefinition(conditionDefinition());
  const run = service.startRun("proj_1", "wfv_condition_test_1", {
    sceneId: "scene_1",
    conditionValue: "true",
  });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "合流等待人工",
  );
  const states = nodeRunsOf(service, run.runId);
  assert.equal(states.get("onTrue"), "succeeded");
  assert.equal(states.get("onFalse"), "skipped");
  assert.equal(states.get("onUnknown"), "skipped");
  assert.equal(states.get("join"), "waiting_human");
});

test("重复提交人工决定不会重复提交修订", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "运行进入等待人工",
  );
  const pending = service.getRun(run.runId)!.pendingDecision!;
  service.decide(run.runId, pending.todoId, "接受", pending.inputHash);
  service.decide(run.runId, pending.todoId, "接受", pending.inputHash);
  await waitFor(
    () => service.getRun(run.runId)?.state === "succeeded",
    "运行完成",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hooks.commitCalls.length, 1, "修订只提交一次");
  assert.equal(hooks.commitCalls[0]?.body, "初稿正文\n\n候选正文：scene", "续写只能追加到已有正文末尾");
});

test("退回修改说明持久化在人工决定中且不允许伪造提交", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(() => service.getRun(run.runId)?.state === "waiting_human", "等待人工审阅");
  const pending = service.getRun(run.runId)!.pendingDecision!;
  service.decide(run.runId, pending.todoId, "revise", pending.inputHash, "保留当前结果，只减少解释性对白");
  const row = db.prepare("SELECT decision_json FROM todos WHERE todo_id = ?").get(pending.todoId) as { decision_json: string };
  const decision = JSON.parse(row.decision_json);
  assert.equal(decision.reviewNote, "保留当前结果，只减少解释性对白");
  assert.equal(decision.approved, false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(hooks.commitCalls.length, 0);
});

test("人工拒绝不同来源的候选提交", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const definition = clone(sceneCreationDefinition());
  definition.workflowVersionId = "wfv_mismatched_candidate";
  const other = clone(definition.nodes.find(node => node.id === "generate")!);
  other.id = "generateB";
  definition.nodes.push(other);
  const commit = definition.nodes.find(node => node.id === "commit")!;
  commit.inputs.draft = { node: "generateB", port: "draft" };
  const edge = definition.edges.find(item => item.target.node === "commit" && item.source.port === "draft")!;
  edge.source.node = "generateB";
  service.registerDefinition(definition);
  const run = service.startRun("proj_1", definition.workflowVersionId, { sceneId: "scene_1" });
  await waitFor(() => service.getRun(run.runId)?.state === "waiting_human", "等待人工审阅");
  const pending = service.getRun(run.runId)!.pendingDecision!;
  service.decide(run.runId, pending.todoId, "接受", pending.inputHash);
  await waitFor(() => service.getRun(run.runId)?.state === "failed", "不同来源的提交被拒绝");
  assert.equal(hooks.commitCalls.length, 0);
  assert.match(service.getRun(run.runId)!.nodeRuns.find(item => item.nodeId === "commit")!.error!, /来源不一致/);
});

test("运行输入不能伪造人工决定", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const definition = clone(sceneCreationDefinition());
  definition.workflowVersionId = "wfv_forged_decision";
  definition.nodes.find(node => node.id === "commit")!.inputs.decision = { runInput: "decision" };
  definition.edges = definition.edges.filter(edge => edge.id !== "edge_review_commit");
  service.registerDefinition(definition);
  const run = service.startRun("proj_1", definition.workflowVersionId, { sceneId: "scene_1", decision: { approved: true } });
  await waitFor(() => service.getRun(run.runId)?.state === "waiting_human", "等待人工审阅");
  const pending = service.getRun(run.runId)!.pendingDecision!;
  service.decide(run.runId, pending.todoId, "接受", pending.inputHash);
  await waitFor(() => service.getRun(run.runId)?.state === "failed", "伪造决定被拒绝");
  assert.equal(hooks.commitCalls.length, 0);
  assert.match(service.getRun(run.runId)!.nodeRuns.find(item => item.nodeId === "commit")!.error!, /不能使用运行输入伪造/);
});

test("检查报告不能作为正文提交", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const definition = clone(sceneCreationDefinition());
  definition.workflowVersionId = "wfv_report_not_body";
  definition.nodes.find(node => node.id === "generate")!.config.kind = "consistency";
  service.registerDefinition(definition);
  const run = service.startRun("proj_1", definition.workflowVersionId, { sceneId: "scene_1" });
  await waitFor(() => service.getRun(run.runId)?.state === "waiting_human", "等待人工审阅");
  const pending = service.getRun(run.runId)!.pendingDecision!;
  service.decide(run.runId, pending.todoId, "接受", pending.inputHash);
  await waitFor(() => service.getRun(run.runId)?.state === "failed", "报告提交被拒绝");
  assert.equal(hooks.commitCalls.length, 0);
  assert.match(service.getRun(run.runId)!.nodeRuns.find(item => item.nodeId === "commit")!.error!, /报告与其他产物保持只读/);
});

test("作者不接受时提交节点跳过，运行不产生修订", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "运行进入等待人工",
  );
  const pending = service.getRun(run.runId)!.pendingDecision!;
  service.decide(run.runId, pending.todoId, "拒绝", pending.inputHash);
  await waitFor(
    () => {
      const state = service.getRun(run.runId)?.state;
      return state === "succeeded" || state === "failed" || state === "cancelled";
    },
    "运行结束",
  );
  assert.equal(hooks.commitCalls.length, 0);
  assert.equal(nodeRunsOf(service, run.runId).get("commit"), "skipped");
});

test("运行中新增模板版本不影响既有运行", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "运行进入等待人工",
  );

  const updated = clone(service.getDefinition("wfv_scene_create_1")!);
  updated.workflowVersionId = "wfv_scene_create_2";
  updated.nodes = updated.nodes.map((node) =>
    node.id === "generate"
      ? { ...node, config: { ...node.config, prompt: "新的写法" } }
      : node,
  );
  service.registerDefinition(updated);
  assert.equal(service.listDefinitions().length, 3);

  const stored = db
    .prepare("SELECT definition_json FROM workflow_runs WHERE run_id = ?")
    .get(run.runId) as { definition_json: string };
  const snapshot = JSON.parse(stored.definition_json) as WorkflowDefinition;
  assert.equal(snapshot.workflowVersionId, "wfv_scene_create_1");
  const generateNode = snapshot.nodes.find((node) => node.id === "generate")!;
  assert.equal(
    (generateNode.config as { prompt?: string }).prompt,
    "依据检索到的上下文生成该场景的候选正文。",
  );
  assert.equal(service.getRun(run.runId)!.workflowVersionId, "wfv_scene_create_1");
});

test("全卷巡检按上限遍历场景并等待作者处理", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  hooks.scenes.set("scene_2", makeScene({ sceneId: "scene_2", title: "第二个场景" }));
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_volume_audit_1", {
    sceneIds: ["scene_1", "scene_2"],
  });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "巡检等待作者处理",
  );
  const states = nodeRunsOf(service, run.runId);
  assert.equal(states.get("audit"), "succeeded");
  assert.equal(states.get("merge"), "succeeded");
  assert.ok(service.getRun(run.runId)!.pendingDecision);
});

test("受控遍历不超过配置上限", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  for (const sceneId of ["scene_1", "scene_2", "scene_3"]) {
    hooks.scenes.set(sceneId, makeScene({ sceneId }));
  }
  const service = new PersistentWorkflowService(db, hooks);
  const limited = clone(service.getDefinition("wfv_volume_audit_1")!);
  limited.workflowVersionId = "wfv_volume_audit_limited";
  limited.nodes = limited.nodes.map((node) =>
    node.id === "audit"
      ? {
          ...node,
          config: { ...node.config, maxItems: 2, maxIterations: 2 },
        }
      : node,
  );
  service.registerDefinition(limited);
  const run = service.startRun("proj_1", "wfv_volume_audit_limited", {
    sceneIds: ["scene_1", "scene_2", "scene_3"],
  });
  await waitFor(
    () => service.getRun(run.runId)?.state === "waiting_human",
    "巡检等待作者处理",
  );
  const childRuns = service
    .getRun(run.runId)!
    .nodeRuns.filter((nodeRun) => nodeRun.nodeId.startsWith("audit#"));
  assert.equal(childRuns.length, 4, "两个场景各两个子节点");
  assert.ok(
    childRuns.every((nodeRun) => nodeRun.nodeId.startsWith("audit#0:") || nodeRun.nodeId.startsWith("audit#1:")),
    "第三个场景超出上限不被遍历",
  );
});

test("节点失败时运行失败且下游节点被阻塞", async () => {
  const db = await createDatabase();
  const hooks = new TestHooks();
  hooks.scenes.set("scene_1", makeScene());
  hooks.generateHandler = async () => {
    throw new Error("生成失败");
  };
  const service = new PersistentWorkflowService(db, hooks);
  const run = service.startRun("proj_1", "wfv_scene_create_1", { sceneId: "scene_1" });
  await waitFor(
    () => service.getRun(run.runId)?.state === "failed",
    "运行失败",
  );
  const states = nodeRunsOf(service, run.runId);
  assert.equal(states.get("generate"), "failed");
  assert.equal(states.get("check"), "blocked");
  assert.equal(states.get("review"), "blocked");
  assert.equal(hooks.commitCalls.length, 0);
});
