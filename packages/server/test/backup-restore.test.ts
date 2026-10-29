import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";
import type { NovaBackup } from "../src/transfer.js";

function backupFixture(): NovaBackup {
  const project = { projectId: "project_old", title: "备份作品", premise: "验证恢复", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", activeBranchId: "branch_old", activeRouteId: "route_old" };
  const scene = { sceneId: "scene_old", projectId: project.projectId, chapterId: "chapter_old", title: "第一场", summary: "摘要", goal: "目标", conflict: "阻碍", body: "阿禾把钥匙放在桌上。", pov: "char_a", status: "writing", narrationOrder: 1, routeId: "route_old", entityIds: ["char_a", "char_b"], baseRevisionId: "revision_old", updatedAt: "2026-01-01T00:00:00.000Z" };
  return {
    format: "nova-novel-backup/1", exportedAt: "2026-01-01T00:00:00.000Z", project,
    branches: [{ branchId: "branch_old", projectId: project.projectId, name: "主稿", headRevisionId: "revision_old" }],
    routes: [{ routeId: "route_old", projectId: project.projectId, name: "主线" }],
    chapters: [{ chapterId: "chapter_old", projectId: project.projectId, title: "第一章", order: 1 }], scenes: [scene],
    elements: [
      { entityId: "char_a", projectId: project.projectId, type: "character", name: "阿禾", aliases: ["小禾"], summary: "修鞋的人", routeId: "route_old", sourceKind: "author_setting", reviewState: "confirmed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { entityId: "char_b", projectId: project.projectId, type: "character", name: "父亲", aliases: [], summary: "父亲", routeId: "route_old", sourceKind: "author_setting", reviewState: "confirmed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    facts: [{ factId: "fact_old", projectId: project.projectId, subjectId: "char_a", predicate: "parent", value: { entityId: "char_b" }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: "route_old", evidenceIds: ["evidence_old", "evidence_history"] }],
    events: [{ eventId: "event_old", projectId: project.projectId, kind: "item.move", sceneId: "scene_old", routeId: "route_old", storyOrder: 1, subjectId: "char_a", toValue: "桌上", reviewState: "confirmed", evidenceIds: ["evidence_old", "evidence_history"] }],
    evidence: [
      { evidenceId: "evidence_old", projectId: project.projectId, sourceRevisionId: "revision_old", sceneId: "scene_old", blockId: "scene_old_b1", quote: scene.body, contentHash: "old_hash", sourceKind: "manuscript", routeId: "route_old", narrationOrder: 1 },
      { evidenceId: "evidence_history", projectId: project.projectId, sourceRevisionId: "revision_previous", sceneId: "scene_old", blockId: "scene_old_b1", quote: scene.body, contentHash: "old_history_hash", sourceKind: "manuscript", routeId: "route_old", narrationOrder: 1 },
    ],
    notes: [{ noteId: "note_old", projectId: project.projectId, title: "便签", body: "保留这条便签", tags: ["恢复"], status: "linked", sceneId: "scene_old", elementId: "char_a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    annotations: [{ annotationId: "annotation_old", projectId: project.projectId, sceneId: "scene_old", kind: "question", body: "保留这条批注", status: "open", range: { from: 0, to: 2, baseText: "阿禾", textHash: "old_range_hash" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    characterArcs: [{ entityId: "char_a", projectId: project.projectId, motivation: "被认可", goal: "修鞋", conflict: "害怕", epiphany: "告别", notes: "暂定", updatedAt: "2026-01-01T00:00:00.000Z" }],
    storyGraph: { projectId: project.projectId, revisionId: "revision_old", nodes: [{ id: "scene_old", kind: "scene", sceneId: "scene_old", title: "第一场", summary: "摘要", position: { x: 80, y: 120 } }], edges: [] },
    authoringDraft: {}, workflows: [{}],
  } as unknown as NovaBackup;
}

test("JSON backup restores a new project with remapped manuscript and knowledge references", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const knowledge = new SqliteKnowledgeService(db);
    const originalProject = store.getProject();
    const restored = store.restoreBackup(backupFixture());
    assert.notEqual(restored.project.projectId, originalProject.projectId);
    assert.equal(restored.project.title, "备份作品（恢复）");
    assert.equal(restored.revision.kind, "restored");
    const scenes = store.listScenes(restored.project.projectId);
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0]?.body, "阿禾把钥匙放在桌上。");
    assert.notEqual(scenes[0]?.sceneId, "scene_old");
    const elements = knowledge.listEntities(restored.project.projectId);
    assert.equal(elements.length, 2);
    const ah = elements.find(entity => entity.name === "阿禾")!;
    const father = elements.find(entity => entity.name === "父亲")!;
    assert.equal(scenes[0]?.pov, ah.entityId);
    const facts = knowledge.listFacts(restored.project.projectId);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.subjectId, ah.entityId);
    assert.deepEqual(facts[0]?.value, { entityId: father.entityId });
    const events = knowledge.listEvents(restored.project.projectId);
    assert.equal(events[0]?.subjectId, ah.entityId);
    assert.equal(events[0]?.sceneId, scenes[0]?.sceneId);
    const evidenceId = facts[0]?.evidenceIds[0];
    assert.ok(evidenceId && evidenceId !== "evidence_old");
    assert.equal(events[0]?.evidenceIds[0], evidenceId);
    const evidenceRow = db.prepare("SELECT source_revision_id,scene_id,content_hash FROM kw_evidence WHERE evidence_id=?").get(evidenceId) as { source_revision_id: string; scene_id: string; content_hash: string };
    assert.equal(evidenceRow.source_revision_id, restored.revision.revisionId);
    assert.equal(evidenceRow.scene_id, scenes[0]?.sceneId);
    assert.notEqual(evidenceRow.content_hash, "old_hash");
    const historyEvidenceId = facts[0]?.evidenceIds[1];
    const historyRow = db.prepare("SELECT source_revision_id,scene_id,block_id FROM kw_evidence WHERE evidence_id=?").get(historyEvidenceId) as { source_revision_id: string; scene_id: string; block_id: string };
    assert.equal(historyRow.source_revision_id, "revision_previous");
    assert.equal(historyRow.scene_id, scenes[0]?.sceneId);
    assert.equal(historyRow.block_id, `${scenes[0]?.sceneId}_b1`);
    assert.ok(historyEvidenceId && historyEvidenceId !== evidenceId);
    for (const restoredScene of scenes) knowledge.indexScene(restoredScene, restored.revision.revisionId);
    const reindexedFacts = knowledge.listFacts(restored.project.projectId);
    assert.equal(reindexedFacts[0]?.evidenceIds[0], evidenceId);
    const reindexedEvidence = db.prepare("SELECT quote FROM kw_evidence WHERE evidence_id=?").get(evidenceId) as { quote: string };
    assert.equal(reindexedEvidence.quote, "阿禾把钥匙放在桌上。");
    assert.ok(db.prepare("SELECT evidence_id FROM kw_evidence WHERE evidence_id=?").get(historyEvidenceId));
    const note = store.listNotes(restored.project.projectId)[0]!;
    assert.equal(note.sceneId, scenes[0]?.sceneId);
    assert.equal(note.elementId, ah.entityId);
    const annotation = store.listAnnotations(restored.project.projectId)[0]!;
    assert.equal(annotation.sceneId, scenes[0]?.sceneId);
    assert.equal(annotation.body, "保留这条批注");
    assert.equal(store.listCharacterArcs(restored.project.projectId)[0]?.entityId, ah.entityId);
    assert.equal(store.getStoryGraph(restored.project.projectId).nodes[0]?.sceneId, scenes[0]?.sceneId);
    assert.ok(restored.warnings.some(warning => warning.includes("工作流")));
    assert.equal(store.listScenes(originalProject.projectId)[0]?.title, "关门前的收据");
    const second = store.restoreBackup(backupFixture());
    assert.notEqual(second.project.projectId, restored.project.projectId);
  } finally { db.close(); }
});
