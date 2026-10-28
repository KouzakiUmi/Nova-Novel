import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { ContextBundle, GenerationRequest } from "@nova-novel/shared";
import { DomainStore } from "../src/store.js";
import { GuidedOutlineService } from "../src/guide.js";
import type { KnowledgeService, PiHost } from "../src/contracts.js";

function context(): ContextBundle { return { snapshotId: "test", facts: [], evidence: [], selectedPlans: [], candidates: [], excluded: [], indexState: { keywordRevisionId: "test", semanticState: "unconfigured" } }; }
const knowledge: KnowledgeService = { listEntities: () => [], listFacts: () => [], listEvents: () => [], queryContext: query => ({ ...context(), snapshotId: query.revisionId }), checkConsistency: () => [], indexScene: () => {} };
function question(stepId: string): string {
  return JSON.stringify({ stepId, question: `${stepId} 问题`, why: `${stepId} 作用`, options: [{ id: "a", label: "选项 A", detail: "A 的说明" }, { id: "b", label: "选项 B", detail: "B 的说明" }], allowCustom: true, allowSkip: true });
}
const proposal = JSON.stringify({ scenes: [
  { proposalId: "scene-1", title: "第一场", goal: "完成一个行动", conflict: "遇到阻碍", summary: "形成一个决定" },
  { proposalId: "scene-2", title: "第二场", goal: "处理后果", conflict: "出现两难", summary: "选择下一步" },
  { proposalId: "scene-3", title: "第三场", goal: "尝试新行动", conflict: "付出代价", summary: "状态发生变化" },
] });
function piHost(): PiHost {
  return {
    getConnection: () => ({ state: "connected", mode: "example", detail: "test", sendsDataTo: "test" }),
    generate: async ({ request }: { request: GenerationRequest }) => {
      const input = JSON.parse(request.input) as { mode: string; stepId: string };
      return { text: input.mode === "proposal" ? proposal : question(input.stepId), completeness: "complete" };
    },
    cancel: async () => {},
  };
}

test("guided outline persists choices, resumes, goes back without regeneration and applies idempotently", async () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const service = new GuidedOutlineService(db, store, knowledge, piHost());
    const created = await service.create(project.projectId);
    assert.equal(created.pending?.stepId, "goal");
    const resumed = new GuidedOutlineService(db, store, knowledge, piHost()).current(project.projectId);
    assert.equal(resumed?.pending?.question, "goal 问题");

    const conflict = await service.answer(created.sessionId, { custom: "主角想自己查明真相" });
    assert.equal(conflict.answers[0]?.label, "作者自答");
    assert.equal(conflict.pending?.stepId, "conflict");
    const outcome = await service.answer(created.sessionId, { optionId: "a" });
    assert.equal(outcome.pending?.stepId, "outcome");
    const tasksBeforeBack = store.listTasks(project.projectId).length;
    const back = service.back(created.sessionId);
    assert.equal(back.pending?.stepId, "conflict");
    assert.equal(back.answers.length, 1);
    assert.equal(store.listTasks(project.projectId).length, tasksBeforeBack, "返回上一步不应重新生成");

    const cachedOutcome = await service.answer(created.sessionId, { optionId: "b" });
    assert.equal(cachedOutcome.pending?.stepId, "outcome");
    assert.equal(store.listTasks(project.projectId).length, tasksBeforeBack, "已生成的问题应复用");
    const ready = await service.answer(created.sessionId, { skip: true });
    assert.equal(ready.status, "ready");
    assert.equal(ready.proposal?.length, 3);
    assert.equal(ready.answers.at(-1)?.skipped, true);
    assert.equal(store.listTasks(project.projectId).length, tasksBeforeBack + 1);

    const edited = service.updateProposal(created.sessionId, ready.proposal!.map((scene, index) => index === 0 ? { ...scene, title: "作者修改后的第一场", goal: "由作者重新确定的目标" } : scene));
    assert.equal(edited.proposal?.[0]?.title, "作者修改后的第一场");
    assert.equal(service.current(project.projectId)?.proposal?.[0]?.goal, "由作者重新确定的目标");
    const adopted = service.apply(created.sessionId);
    assert.equal(adopted.scenes.length, 3);
    assert.equal(adopted.scenes[0]?.title, "作者修改后的第一场");
    assert.equal(store.listScenes(project.projectId).length, 4);
    assert.equal(store.listRevisions(project.projectId).length, 2);
    const again = service.apply(created.sessionId);
    assert.equal(again.revision.revisionId, adopted.revision.revisionId);
    assert.equal(store.listScenes(project.projectId).length, 4);
    assert.equal(again.session.status, "applied");
  } finally { db.close(); }
});

test("late generation cannot revive a cancelled guided session", async () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db); const project = store.getProject();
    let calls = 0;
    let finish!: () => void;
    const host: PiHost = { getConnection: () => ({ state: "connected", mode: "example", detail: "test", sendsDataTo: "test" }), generate: () => { calls += 1; return new Promise(resolve => { finish = () => resolve({ text: question("goal"), completeness: "complete" }); }); }, cancel: async () => {} };
    const service = new GuidedOutlineService(db, store, knowledge, host);
    const creating = service.create(project.projectId);
    while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const current = service.current(project.projectId)!;
    service.cancel(current.sessionId);
    finish();
    const settled = await creating;
    assert.equal(settled.status, "cancelled");
    assert.equal(service.get(current.sessionId).status, "cancelled");
    const task = store.listTasks(project.projectId).find(item => item.kind === "guide");
    assert.equal(task?.state, "succeeded", "迟到产物仍须终结归档");
    assert.equal((task?.result as { text?: string } | undefined)?.text, question("goal"));
  } finally { db.close(); }
});

test("scene additions share changeset idempotency and stale proposals cannot apply", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const branch = store.getBranch(project.activeBranchId);
    const input = { projectId: project.projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId, acceptanceId: "outline-once", scenes: [{ title: "新场景", goal: "目标", conflict: "阻碍", summary: "结果" }] };
    const first = store.addScenes(input);
    const second = store.addScenes(input);
    assert.equal(second.revision.revisionId, first.revision.revisionId);
    assert.equal(store.listScenes(project.projectId).length, 2);
    const current = store.getBranch(branch.branchId).headRevisionId;
    const originalScene = store.listScenes(project.projectId)[0]!;
    store.saveScene(originalScene.sceneId, { baseRevisionId: current, body: "作者已经继续写作" });
    assert.throws(() => store.addScenes({ ...input, baseRevisionId: branch.headRevisionId, acceptanceId: "stale-outline" }), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    assert.notEqual(store.getBranch(branch.branchId).headRevisionId, current);
  } finally { db.close(); }
});
