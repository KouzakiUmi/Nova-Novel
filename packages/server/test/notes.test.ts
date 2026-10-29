import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { once } from "node:events";
import { DomainStore } from "../src/store.js";
import { createApp } from "../src/app.js";
import type { KnowledgeService, PiHost, WorkflowService } from "../src/contracts.js";

const knowledge: KnowledgeService = { listEntities: () => [], listFacts: () => [], listEvents: () => [], queryContext: () => { throw new Error("unused"); }, checkConsistency: () => [], indexScene: () => {} };
const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("unused"); }, decide: () => { throw new Error("unused"); }, cancel: () => { throw new Error("unused"); } };
const pi: PiHost = { getConnection: () => ({ state: "unconfigured", mode: "test", detail: "test", sendsDataTo: "test" }), generate: async () => { throw new Error("unused"); }, cancel: async () => {} };

test("author notes stay outside revisions until explicitly promoted to a scene", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const project = store.getProject();
    const initialScene = store.listScenes(project.projectId)[0]!;
    const revisions = store.listRevisions(project.projectId).length;
    const note = store.createNote({ projectId: project.projectId, title: "父亲早已知道收据来历", body: "但他为什么一直不说？", tags: ["父亲", "收据"] });
    assert.equal(note.status, "inbox");
    assert.equal(store.listRevisions(project.projectId).length, revisions);
    const linked = store.updateNote(note.noteId, { sceneId: initialScene.sceneId, tags: ["父亲", "待定"] });
    assert.equal(linked.sceneId, initialScene.sceneId);
    assert.deepEqual(linked.tags, ["父亲", "待定"]);
    assert.equal(store.listRevisions(project.projectId).length, revisions);
    const cleared = store.updateNote(note.noteId, { sceneId: null });
    assert.equal(cleared.sceneId, undefined);
    const promoted = store.promoteNote(note.noteId);
    assert.equal(promoted.note.status, "linked");
    assert.equal(promoted.scene.title, note.title);
    assert.equal(promoted.scene.summary, note.body);
    assert.equal(promoted.scene.body, "");
    assert.equal(store.listScenes(project.projectId).length, 2);
    assert.equal(store.listRevisions(project.projectId).length, revisions + 1);
    const again = store.promoteNote(note.noteId);
    assert.equal(again.scene.sceneId, promoted.scene.sceneId);
    assert.equal(store.listScenes(project.projectId).length, 2);
    assert.equal(store.listRevisions(project.projectId).length, revisions + 1);
    const archived = store.updateNote(note.noteId, { status: "archived" });
    assert.equal(archived.status, "archived");
    assert.throws(() => store.promoteNote(note.noteId), /已归档/);
  } finally { db.close(); }
});

test("notes HTTP API creates, edits and promotes notes into the workspace snapshot", async () => {
  const db = new Database(":memory:");
  const app = createApp({ store: new DomainStore(db), knowledge, workflow, pi });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const root = `http://127.0.0.1:${address.port}`;
  async function call(path: string, method = "GET", input?: unknown) {
    const response = await fetch(`${root}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) });
    return { status: response.status, value: await response.json() };
  }
  try {
    const bootstrap = await call("/api/bootstrap");
    const projectId = bootstrap.value.activeProject.projectId;
    const created = await call("/api/notes", "POST", { projectId, title: "收据其实属于谁", body: "先别急着确定" });
    assert.equal(created.status, 201);
    const noteId = created.value.note.noteId;
    const edited = await call(`/api/notes/${noteId}`, "PATCH", { title: "先保留这个疑问", tags: ["收据", "待定"] });
    assert.equal(edited.value.note.title, "先保留这个疑问");
    const promoted = await call(`/api/notes/${noteId}/promote`, "POST", {});
    assert.equal(promoted.status, 200);
    assert.equal(promoted.value.note.status, "linked");
    assert.equal(promoted.value.snapshot.notes[0].noteId, noteId);
    assert.equal(promoted.value.snapshot.scenes.length, 2);
  } finally {
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    db.close();
  }
});
