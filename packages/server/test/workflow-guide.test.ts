import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { ContextBundle, GenerationRequest } from "@nova-novel/shared";
import { DomainStore } from "../src/store.js";
import { GuidedWorkflowService } from "../src/workflow-guide.js";
import { PersistentWorkflowService } from "../src/workflow/service.js";
import { sceneCreationDefinition } from "../src/workflow/definitions.js";
import type { WorkflowHooks } from "../src/workflow/types.js";
import type { KnowledgeService, PiHost } from "../src/contracts.js";
import { composePrompt } from "../src/agent/prompts.js";

const context = (): ContextBundle => ({ snapshotId: "test", facts: [], evidence: [], selectedPlans: [], candidates: [], excluded: [], indexState: { keywordRevisionId: "test", semanticState: "unconfigured" } });
const knowledge: KnowledgeService = { listEntities: () => [], listFacts: () => [], listEvents: () => [], queryContext: query => ({ ...context(), snapshotId: query.revisionId }), checkConsistency: () => [], indexScene: () => {} };
const hooks: WorkflowHooks = { getRevisionId: () => "revision", getScene: () => undefined, retrieve: () => context(), generate: async () => ({ text: "候选", taskId: "task" }), commit: () => {} };
function question(stepId: string): string { return JSON.stringify({ stepId, question: `${stepId} 问题`, why: `${stepId} 作用`, options: [{ id: "a", label: "选项 A", detail: "A 的说明" }, { id: "b", label: "选项 B", detail: "B 的说明" }], allowCustom: true, allowSkip: true }); }
function host(invalid = false): PiHost {
  return { getConnection: () => ({ state: "connected", mode: "example", detail: "test", sendsDataTo: "test" }), generate: async ({ request }: { request: GenerationRequest }) => {
    const input = JSON.parse(request.input) as { mode: string; stepId: string };
    if (input.mode === "question") return { text: question(input.stepId), completeness: "complete" };
    const definition = sceneCreationDefinition();
    if (invalid) { definition.nodes = definition.nodes.filter(node => node.type !== "human.review"); }
    return { text: JSON.stringify(definition), completeness: "complete" };
  }, cancel: async () => {} };
}

test("workflow guide prompt does not use the outline-only output contract", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db); const project = store.getProject();
    const request: GenerationRequest = { projectId: project.projectId, kind: "guide", input: JSON.stringify({ schema: "nova-novel.workflow-guide/1", mode: "proposal", stepId: "proposal", answers: [] }), idempotencyKey: "workflow-prompt-contract" };
    const receipt = store.beginGeneration(request, knowledge.queryContext({ projectId: project.projectId, branchId: project.activeBranchId, routeId: project.activeRouteId, revisionId: store.getBranch(project.activeBranchId).headRevisionId, query: "工作流", purpose: "planning" }));
    const prompt = composePrompt(request, store.generationContext(receipt.task.taskId));
    assert.match(prompt, /nova-novel.workflow-guide\/1/);
    assert.match(prompt, /nova-novel.workflow\/1/);
    assert.match(prompt, /human\.review/);
    assert.match(prompt, /intent\|review/);
    assert.match(prompt, /不得返回大纲 scenes 字段/);
  } finally { db.close(); }
});

test("guided workflow persists answers, previews, publishes immutable definitions and never auto-runs", async () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db); const project = store.getProject();
    const workflow = new PersistentWorkflowService(db, hooks);
    const service = new GuidedWorkflowService(db, store, knowledge, host(), workflow);
    const first = await service.create(project.projectId);
    assert.equal(first.pending?.stepId, "intent");
    const second = await service.answer(first.sessionId, { custom: "先写反应，再让人物决定" });
    assert.equal(second.pending?.stepId, "review");
    const ready = await service.answer(first.sessionId, { optionId: "a" });
    assert.equal(ready.status, "ready");
    assert.equal(ready.proposal?.nodes.length, 7);
    const resumed = new GuidedWorkflowService(db, store, knowledge, host(), workflow).current(project.projectId);
    assert.equal(resumed?.status, "ready");
    const edited = service.updateProposal(first.sessionId, { ...ready.proposal!, name: "作者调整后的流程", nodes: ready.proposal!.nodes.map(node => node.id === "generate" ? { ...node, config: { ...node.config, prompt: "按反应与决定生成候选" } } : node) });
    assert.equal(edited.proposal?.name, "作者调整后的流程");
    assert.equal(service.current(project.projectId)?.proposal?.nodes.find(node => node.id === "generate")?.config.prompt, "按反应与决定生成候选");
    const published = service.publish(first.sessionId);
    assert.equal(published.definition.workflowVersionId, `wfv_guided_${first.sessionId}_1`);
    assert.equal(published.definition.name, "作者调整后的流程");
    assert.equal(workflow.listDefinitions().length, 3);
    assert.equal(workflow.listRuns(project.projectId).length, 0, "发布不应自动运行");
    const again = service.publish(first.sessionId);
    assert.equal(again.definition.workflowVersionId, published.definition.workflowVersionId);
    assert.equal(workflow.listDefinitions().length, 3);
    const old = workflow.getDefinition(published.definition.workflowVersionId)!;
    assert.throws(() => workflow.registerDefinition({ ...old, name: "试图覆盖不可变版本" }), /不可变/);
  } finally { db.close(); }
});

test("concurrent next shares one generation and late results respect the latest session", async () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db); const project = store.getProject();
    const workflow = new PersistentWorkflowService(db, hooks);
    let delayed = false; let calls = 0; let finish!: () => void;
    const host: PiHost = { getConnection: () => ({ state: "connected", mode: "example", detail: "test", sendsDataTo: "test" }), generate: async ({ request }: { request: GenerationRequest }) => {
      const input = JSON.parse(request.input) as { mode: string; stepId: string };
      if (!delayed) return { text: question(input.stepId), completeness: "complete" };
      calls += 1;
      return new Promise(resolve => { finish = () => resolve({ text: question(input.stepId), completeness: "complete" }); });
    }, cancel: async () => {} };
    const service = new GuidedWorkflowService(db, store, knowledge, host, workflow);
    const first = await service.create(project.projectId);
    delayed = true;
    const answering = service.answer(first.sessionId, { optionId: "a" });
    while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const other = service.next(first.sessionId);
    finish();
    const [answered, resumed] = await Promise.all([answering, other]);
    assert.equal(calls, 1);
    assert.equal(answered.pending?.stepId, "review");
    assert.equal(resumed.pending?.question, answered.pending?.question);
  } finally { db.close(); }
});

test("workflow proposals without human review are rejected before registration", async () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db); const project = store.getProject();
    const workflow = new PersistentWorkflowService(db, hooks);
    const service = new GuidedWorkflowService(db, store, knowledge, host(true), workflow);
    const first = await service.create(project.projectId);
    await service.answer(first.sessionId, { optionId: "a" });
    await assert.rejects(() => service.answer(first.sessionId, { optionId: "a" }), /人工审阅/);
    assert.equal(workflow.listDefinitions().length, 2);
    assert.equal(service.get(first.sessionId).status, "active");
  } finally { db.close(); }
});
