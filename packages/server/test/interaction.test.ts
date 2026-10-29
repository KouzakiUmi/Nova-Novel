import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DomainStore } from "../src/store.js";

test("interaction replay filters before pagination and exports beyond 500 domain events", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const scene = store.listScenes(project.projectId)[0]!;
    for (let index = 0; index < 600; index++) db.prepare("INSERT INTO domain_events(kind,json,created_at) VALUES(?,?,?)").run("system.noise", JSON.stringify({ projectId: project.projectId }), new Date().toISOString());
    for (let index = 0; index < 501; index++) store.recordInteraction({ projectId: project.projectId, sceneId: scene.sceneId, kind: "suggestion-open" });
    const all = store.listAllInteractionEvents(project.projectId);
    assert.equal(all.length, 501);
    assert.equal(all.at(-1)?.kind, "suggestion-open");
    assert.equal(store.listInteractionEvents(project.projectId, 0, 500).length, 500);
    assert.equal(store.listInteractionEvents(project.projectId, all[499]!.seq, 500).length, 1);
  } finally { db.close(); }
});

test("interaction replay records only scoped events and ordered metadata", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const scene = store.listScenes(project.projectId)[0]!;
    const first = store.recordInteraction({ projectId: project.projectId, sceneId: scene.sceneId, kind: "suggestion-open" });
    const second = store.recordInteraction({ projectId: project.projectId, sceneId: scene.sceneId, kind: "candidate-accept", actor: "author", meta: { answer: "accept" } });
    assert.ok(second > first);
    assert.throws(() => store.recordInteraction({ projectId: project.projectId, kind: "prompt-content" }), /类型无效/);
    const events = store.listInteractionEvents(project.projectId);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "suggestion-open");
    assert.equal(events[1]?.kind, "candidate-accept");
    assert.equal(events[1]?.sceneId, scene.sceneId);
    assert.ok(!JSON.stringify(events).includes("正文甲"));
  } finally { db.close(); }
});
