import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { FactAssertion } from "@nova-novel/shared";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";

/**
 * ChangeSet 提交的事实必须同时进入知识库（kw_facts）。
 * 修复前它只写进修订清单 manifest.facts，检索、世界状态与一致性检查都看不到，
 * 导致「补上元素库界面后事实仍然不生效」。
 */
function fixture() {
  const db = new Database(":memory:");
  const store = new DomainStore(db);
  const knowledge = new SqliteKnowledgeService(db);
  const project = store.getProject();
  const branch = store.getBranch(project.activeBranchId);
  const scene = store.listScenes(project.projectId, branch.headRevisionId)[0]!;
  knowledge.indexScene(scene, branch.headRevisionId);
  const routeId = scene.routeId;
  return { db, store, knowledge, project, branch, scene, routeId };
}

function kwFactCount(db: Database.Database, projectId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM kw_facts WHERE project_id = ?").get(projectId) as { count: number };
  return row.count;
}

function makeFact(projectId: string, routeId: string, factId: string, overrides: Partial<FactAssertion> = {}): FactAssertion {
  return {
    factId, projectId, subjectId: "ent_brass_key", predicate: "owner",
    value: { entityId: "ent_ahe" }, semanticType: "world_fact", reviewState: "confirmed",
    sourceKind: "author_setting", routeId, evidenceIds: [],
    ...overrides,
  };
}

test("ChangeSet 提交的已确认事实写入知识库并进入检索上下文", () => {
  const f = fixture();
  const fact = makeFact(f.project.projectId, f.routeId, "fact_owner_ahe");
  const changeSet = f.store.createChangeSet({
    projectId: f.project.projectId,
    baseRevisionId: f.branch.headRevisionId,
    acceptanceId: "accept_fact_1",
    factChanges: [fact],
  });
  assert.equal(kwFactCount(f.db, f.project.projectId), 0, "提交前知识库不应有该事实");
  f.store.commitChangeSet(changeSet.changeSetId, "记录设定");

  assert.equal(kwFactCount(f.db, f.project.projectId), 1, "提交后事实必须进入知识库");
  const row = f.db.prepare("SELECT subject_id, predicate, semantic_type, review_state, value_entity_id FROM kw_facts WHERE fact_id = ?").get(fact.factId) as { subject_id: string; predicate: string; semantic_type: string; review_state: string; value_entity_id: string };
  assert.deepEqual({ ...row }, {
    subject_id: "ent_brass_key", predicate: "owner", semantic_type: "world_fact", review_state: "confirmed", value_entity_id: "ent_ahe",
  }, "知识库行应保留事实的主体、谓词、语义类型与实体取值");

  // 检索上下文用提交后的修订，事实应出现。
  const head = f.store.getBranch(f.project.activeBranchId).headRevisionId;
  const bundle = f.knowledge.queryContext({
    projectId: f.project.projectId, branchId: f.project.activeBranchId, routeId: f.routeId,
    revisionId: head, query: "钥匙", purpose: "scene_writing",
  });
  assert.ok(bundle.facts.some((item) => item.factId === fact.factId), "提交的事实必须能被检索上下文读到");
});

test("ChangeSet 事实同步保持值类型：布尔、数字、文本与空值", () => {
  const f = fixture();
  const facts: FactAssertion[] = [
    makeFact(f.project.projectId, f.routeId, "fact_unique", { subjectId: "ent_brass_key", predicate: "unique", value: true }),
    makeFact(f.project.projectId, f.routeId, "fact_quantity", { subjectId: "ent_brass_key", predicate: "quantity", value: 1 }),
    makeFact(f.project.projectId, f.routeId, "fact_note", { subjectId: "ent_brass_key", predicate: "note", value: "父亲留下的旧钥匙" }),
    makeFact(f.project.projectId, f.routeId, "fact_unknown", { subjectId: "ent_brass_key", predicate: "weight", value: null }),
  ];
  const changeSet = f.store.createChangeSet({
    projectId: f.project.projectId, baseRevisionId: f.branch.headRevisionId,
    acceptanceId: "accept_fact_types", factChanges: facts,
  });
  f.store.commitChangeSet(changeSet.changeSetId, "记录多种取值");

  const kinds = f.db.prepare("SELECT predicate, value_kind FROM kw_facts WHERE project_id = ? ORDER BY predicate").all(f.project.projectId) as Array<{ predicate: string; value_kind: string }>;
  const byPredicate = Object.fromEntries(kinds.map((row) => [row.predicate, row.value_kind]));
  assert.equal(byPredicate.quantity, "number");
  assert.equal(byPredicate.unique, "boolean");
  assert.equal(byPredicate.note, "text");
  assert.equal(byPredicate.weight, "null");
});

test("重复提交同一事实是幂等的，不产生重复行也不丢其他事实", () => {
  const f = fixture();
  const first = makeFact(f.project.projectId, f.routeId, "fact_owner_ahe");
  const second = makeFact(f.project.projectId, f.routeId, "fact_unique", { predicate: "unique", value: true });
  const changeSet = f.store.createChangeSet({
    projectId: f.project.projectId, baseRevisionId: f.branch.headRevisionId,
    acceptanceId: "accept_fact_idem", factChanges: [first],
  });
  f.store.commitChangeSet(changeSet.changeSetId, "第一次");
  // 同 factId 再次提交（例如恢复历史版本），应更新而不是新增。
  const branch = f.store.getBranch(f.project.activeBranchId);
  const again = f.store.createChangeSet({
    projectId: f.project.projectId, baseRevisionId: branch.headRevisionId,
    acceptanceId: "accept_fact_idem_2", factChanges: [first, second],
  });
  f.store.commitChangeSet(again.changeSetId, "第二次");

  assert.equal(kwFactCount(f.db, f.project.projectId), 2, "同一 factId 不应重复插入，且第二条事实应写入");
});
