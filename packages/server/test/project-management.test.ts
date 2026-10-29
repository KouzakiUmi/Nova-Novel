import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DomainStore } from "../src/store.js";

test("project rename, archive and duplicate keep manuscript copies independent", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const source = store.getProject();
    const sourceScene = store.listScenes(source.projectId)[0]!;
    const duplicated = store.duplicateProject(source.projectId);
    assert.notEqual(duplicated.project.projectId, source.projectId);
    assert.equal(duplicated.project.title, `${source.title}（副本）`);
    assert.equal(store.listRevisions(duplicated.project.projectId).length, 1);
    const copiedScene = store.listScenes(duplicated.project.projectId)[0]!;
    assert.equal(copiedScene.body, sourceScene.body);
    assert.notEqual(copiedScene.sceneId, sourceScene.sceneId);
    assert.notEqual(copiedScene.chapterId, sourceScene.chapterId);
    store.saveScene(copiedScene.sceneId, { baseRevisionId: copiedScene.baseRevisionId, body: "只修改副本的正文" });
    assert.equal(store.getScene(sourceScene.sceneId).body, sourceScene.body);
    const renamed = store.updateProject(source.projectId, { title: "原稿已重命名" });
    assert.equal(renamed.title, "原稿已重命名");
    assert.equal(store.listRevisions(source.projectId).length, 1);
    const archived = store.updateProject(source.projectId, { archived: true });
    assert.ok(archived.archivedAt);
    assert.ok(!store.listProjects().some(project => project.projectId === source.projectId));
    assert.equal(store.getProject().projectId, duplicated.project.projectId);
    const restored = store.updateProject(source.projectId, { archived: false });
    assert.equal(restored.archivedAt, undefined);
    assert.ok(store.listProjects().some(project => project.projectId === source.projectId));
  } finally { db.close(); }
});

test("the last active project cannot be archived", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    assert.throws(() => store.updateProject(project.projectId, { archived: true }), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    assert.equal(store.getProject().archivedAt, undefined);
  } finally { db.close(); }
});
