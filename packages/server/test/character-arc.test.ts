import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";

test("character arc profiles remain editable plans outside manuscript revisions", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    new SqliteKnowledgeService(db);
    const project = store.getProject();
    db.prepare("INSERT INTO kw_entities(entity_id,project_id,type,name,summary,route_id,source_kind,review_state,unique_flag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("char_ah", project.projectId, "character", "阿禾", "", "main", "author_setting", "confirmed", 0, new Date().toISOString(), new Date().toISOString());
    const revisions = store.listRevisions(project.projectId).length;
    const saved = store.saveCharacterArc("char_ah", { motivation: "想被父亲认可", goal: "结清最后一笔旧账", conflict: "害怕面对父亲的遗憾", epiphany: "接受不必替父亲承担", notes: "暂定" });
    assert.equal(saved.motivation, "想被父亲认可");
    assert.equal(saved.goal, "结清最后一笔旧账");
    assert.equal(store.listRevisions(project.projectId).length, revisions);
    assert.equal(store.getCharacterArc("char_ah").epiphany, "接受不必替父亲承担");
    assert.equal(store.listCharacterArcs(project.projectId).length, 1);
    const updated = store.saveCharacterArc("char_ah", { motivation: "想被父亲认可", goal: "先修鞋", conflict: "不愿谈论关店", epiphany: "学会告别", notes: "仍不决定结局" });
    assert.equal(updated.goal, "先修鞋");
    assert.equal(store.listRevisions(project.projectId).length, revisions);
  } finally { db.close(); }
});
