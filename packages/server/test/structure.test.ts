import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DomainStore } from "../src/store.js";

test("chapter and scene structure changes are versioned and respect revision CAS", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const firstScene = store.listScenes(project.projectId)[0]!;
    const added = store.addChapter(project.projectId, "第二章 · 寻找");
    assert.equal(added.chapter.title, "第二章 · 寻找");
    assert.equal(store.listChapters(project.projectId).length, 2);
    const renamed = store.renameChapter(added.chapter.chapterId, "第二章 · 寻找旧主人", store.getBranch(project.activeBranchId).headRevisionId);
    assert.equal(store.listChapters(project.projectId, renamed.revisionId).at(-1)?.title, "第二章 · 寻找旧主人");
    const created = store.createScene(project.projectId, added.chapter.chapterId, "门外的陌生人");
    assert.equal(created.scene.chapterId, added.chapter.chapterId);
    assert.equal(created.scene.status, "planned");
    const moved = store.moveScene(firstScene.sceneId, added.chapter.chapterId, 2, store.getBranch(project.activeBranchId).headRevisionId);
    const scenes = store.listScenes(project.projectId, moved.revisionId);
    assert.equal(scenes.find(scene => scene.sceneId === firstScene.sceneId)?.chapterId, added.chapter.chapterId);
    assert.equal(scenes.find(scene => scene.sceneId === firstScene.sceneId)?.narrationOrder, 2);
    assert.equal(scenes.find(scene => scene.sceneId === created.scene.sceneId)?.narrationOrder, 1);
    const staleBase = moved.parentRevisionIds[0]!;
    assert.throws(() => store.moveScene(created.scene.sceneId, added.chapter.chapterId, 3, staleBase), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
  } finally { db.close(); }
});
