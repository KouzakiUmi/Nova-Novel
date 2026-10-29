import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DomainStore } from "../src/store.js";
import { sha256 } from "../src/utils.js";

test("annotations preserve their range anchor and never rewrite manuscript revisions", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const scene = store.listScenes(project.projectId)[0]!;
    const revisions = store.listRevisions(project.projectId).length;
    const baseText = scene.body.slice(0, 12);
    const annotation = store.createAnnotation({ projectId: project.projectId, sceneId: scene.sceneId, kind: "question", body: "这里为什么突然决定？", range: { from: 0, to: 12, baseText, textHash: sha256(baseText) } });
    assert.equal(annotation.status, "open");
    assert.equal(store.isAnnotationStale(annotation), false);
    assert.equal(store.listRevisions(project.projectId).length, revisions);
    const resolved = store.updateAnnotation(annotation.annotationId, { status: "resolved" });
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolvedAt);
    const reopened = store.updateAnnotation(annotation.annotationId, { status: "open" });
    assert.equal(reopened.status, "open");
    assert.equal(reopened.resolvedAt, undefined);
    store.saveScene(scene.sceneId, { baseRevisionId: scene.baseRevisionId, body: `已经发生变化${scene.body.slice(12)}` });
    assert.equal(store.isAnnotationStale(annotation), true);
    assert.equal(store.getAnnotation(annotation.annotationId).body, "这里为什么突然决定？");
  } finally { db.close(); }
});
