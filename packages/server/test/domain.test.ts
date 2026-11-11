import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import Database from "better-sqlite3";
import type { AuthoringSelection, ContextBundle, GenerationRequest, WorkspaceSnapshot } from "@nova-novel/shared";
import type { KnowledgeService, PiHost, WorkflowService } from "../src/contracts.js";
import { createApp } from "../src/app.js";
import { DomainError, EXAMPLE_IDEAS } from "../src/domain.js";
import { DomainStore } from "../src/store.js";
import { sha256 } from "../src/utils.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nova-novel-domain-"));
  const filename = join(directory, "story.sqlite");
  const db = new Database(filename);
  const store = new DomainStore(db);
  const project = store.getProject();
  const branch = store.getBranch(project.activeBranchId);
  const selection = store.getAuthoringDraft(project.projectId);
  return { directory, filename, db, store, project, branch, selection, close() { db.close(); assert.ok(directory.startsWith(join(tmpdir(), "nova-novel-domain-"))); rmSync(directory, { recursive: true, force: true }); } };
}
function emptyContext(): ContextBundle { return { snapshotId: "initial", facts: [], evidence: [], selectedPlans: [], candidates: [], excluded: [], indexState: { keywordRevisionId: "initial", semanticState: "unconfigured" } }; }
function rowCount(db: Database.Database, table: "revisions" | "artifacts" | "blobs" | "domain_outbox"): number { return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count; }
function expectConflict(action: () => unknown, revisionId: string, selectionVersion?: number): void {
  assert.throws(action, (error: unknown) => error instanceof DomainError && error.status === 409 && error.currentRevisionId === revisionId && (selectionVersion === undefined || error.selectionVersion === selectionVersion));
}

test("first launch creates an original usable project and survives reopening", () => {
  const f = fixture();
  try {
    assert.equal(f.db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(f.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(f.project.title, "修鞋铺收据");
    assert.equal(f.store.listChapters(f.project.projectId).length, 1);
    assert.match(f.store.listScenes(f.project.projectId)[0]!.body, /阿禾/);
    assert.equal(f.selection.cards.length, 3);
    assert.equal(f.store.getStoryGraph(f.project.projectId).nodes.length, 2);
    const second = new Database(f.filename, { readonly: true });
    try { assert.equal((second.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count, 1); }
    finally { second.close(); }
  } finally { f.close(); }
});

test("autosave CAS rejects a stale editor without writing a revision or replacing text", () => {
  const f = fixture();
  try {
    const scene = f.store.listScenes(f.project.projectId)[0]!;
    const saved = f.store.saveScene(scene.sceneId, { baseRevisionId: f.branch.headRevisionId, body: "第一份已经确认的正文。" });
    const count = rowCount(f.db, "revisions");
    expectConflict(() => f.store.saveScene(scene.sceneId, { baseRevisionId: f.branch.headRevisionId, body: "过时页面的覆盖。" }), saved.revision.revisionId);
    assert.equal(rowCount(f.db, "revisions"), count);
    assert.equal(f.store.getScene(scene.sceneId).body, "第一份已经确认的正文。");
    assert.equal(f.store.getScene(scene.sceneId, f.branch.headRevisionId).body, scene.body);
  } finally { f.close(); }
});

test("selection CAS and branch CAS roll back the entire acceptance transaction", () => {
  const f = fixture();
  try {
    const selected = f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "select", card: f.selection.cards[0]! });
    const scene = f.store.listScenes(f.project.projectId)[0]!;
    const changeSet = f.store.createChangeSet({ projectId: f.project.projectId, branchId: f.branch.branchId, baseRevisionId: f.branch.headRevisionId, acceptanceId: "selection-cas", draftId: selected.draftId, selectionVersion: selected.selectionVersion, sceneChanges: [{ sceneId: scene.sceneId, body: "不应进入作品", baseTextHash: sha256(scene.body) }] });
    const newer = f.store.updateSelection(selected.draftId, selected.selectionVersion, { type: "lock", card: selected.cards[0]!, field: "outcome" });
    const before = { revisions: rowCount(f.db, "revisions"), artifacts: rowCount(f.db, "artifacts"), blobs: rowCount(f.db, "blobs"), outbox: rowCount(f.db, "domain_outbox") };
    expectConflict(() => f.store.commitChangeSet(changeSet.changeSetId), f.branch.headRevisionId, newer.selectionVersion);
    assert.deepEqual({ revisions: rowCount(f.db, "revisions"), artifacts: rowCount(f.db, "artifacts"), blobs: rowCount(f.db, "blobs"), outbox: rowCount(f.db, "domain_outbox") }, before);
    assert.equal(f.store.getBranch(f.branch.branchId).headRevisionId, f.branch.headRevisionId);
    assert.equal(f.store.getScene(scene.sceneId).body, scene.body);
    assert.equal(f.store.getChangeSet(changeSet.changeSetId).status, "pending");
    expectConflict(() => f.store.updateSelection(selected.draftId, selected.selectionVersion, { type: "undo" }), f.branch.headRevisionId, newer.selectionVersion);
  } finally { f.close(); }
});

test("a failed conditional branch update rolls back immutable rows", () => {
  const f = fixture();
  try {
    const changeSet = f.store.createChangeSet({ projectId: f.project.projectId, baseRevisionId: f.branch.headRevisionId, acceptanceId: "forced-cas" });
    const before = rowCount(f.db, "revisions");
    f.db.exec("CREATE TRIGGER decline_branch_head BEFORE UPDATE OF head_revision_id ON branches BEGIN SELECT RAISE(IGNORE); END");
    expectConflict(() => f.store.commitChangeSet(changeSet.changeSetId), f.branch.headRevisionId);
    assert.equal(rowCount(f.db, "revisions"), before);
    assert.equal(f.store.getBranch(f.branch.branchId).headRevisionId, f.branch.headRevisionId);
  } finally { f.close(); }
});

test("a failed conditional selection update rolls back a previously advanced branch head", () => {
  const f = fixture();
  try {
    const selected = f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "select", card: f.selection.cards[0]! });
    const changeSet = f.store.createChangeSet({ projectId: f.project.projectId, baseRevisionId: f.branch.headRevisionId, acceptanceId: "forced-selection-cas", draftId: selected.draftId, selectionVersion: selected.selectionVersion });
    const before = { revisions: rowCount(f.db, "revisions"), artifacts: rowCount(f.db, "artifacts") };
    f.db.exec("CREATE TRIGGER decline_selection BEFORE UPDATE ON authoring_drafts BEGIN SELECT RAISE(IGNORE); END");
    expectConflict(() => f.store.commitChangeSet(changeSet.changeSetId), f.branch.headRevisionId, selected.selectionVersion);
    assert.equal(rowCount(f.db, "revisions"), before.revisions);
    assert.equal(rowCount(f.db, "artifacts"), before.artifacts);
    assert.equal(f.store.getBranch(f.branch.branchId).headRevisionId, f.branch.headRevisionId);
  } finally { f.close(); }
});

test("duplicate acceptance commits exactly one revision and rejects a changed payload", () => {
  const f = fixture();
  try {
    const selected = f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "select", card: f.selection.cards[0]! });
    const input = { selectionVersion: selected.selectionVersion, baseRevisionId: f.branch.headRevisionId, acceptanceId: "one-click" };
    const before = rowCount(f.db, "revisions");
    const first = f.store.adopt(selected.draftId, input);
    const again = f.store.adopt(selected.draftId, input);
    assert.equal(first.revision.revisionId, again.revision.revisionId);
    assert.equal(rowCount(f.db, "revisions"), before + 1);
    assert.equal(again.selection.selectionVersion, selected.selectionVersion + 1);
    assert.equal(f.store.listScenes(f.project.projectId)[0]!.status, "planned");
    assert.equal(f.store.getManifest(first.revision.revisionId).facts.length, 0);
    expectConflict(() => f.store.adopt(selected.draftId, { ...input, selectionVersion: input.selectionVersion + 1 }), first.revision.revisionId, again.selection.selectionVersion);
  } finally { f.close(); }
});

test("select, lock, borrow, edit, reject and undo create monotonic immutable selection snapshots", () => {
  const f = fixture();
  try {
    let draft = f.selection;
    const originalArtifactId = draft.selectionArtifactId;
    const first = draft.cards[0]!;
    const second = draft.cards[1]!;
    const versions: number[] = [draft.selectionVersion];
    const update = (action: Parameters<DomainStore["updateSelection"]>[2]) => { draft = f.store.updateSelection(draft.draftId, draft.selectionVersion, action); versions.push(draft.selectionVersion); };
    update({ type: "select", card: first });
    update({ type: "lock", card: first, field: "outcome" });
    update({ type: "borrow", targetCard: first, sourceCard: second, field: "obstacle" });
    const borrowed = draft.selectedCardRefs[0]!;
    assert.equal(draft.compositionSources[0]!.candidate, second.proposedFields.obstacle);
    update({ type: "edit", card: borrowed, fields: { focus: "让动作推动对话" } });
    const edited = draft.selectedCardRefs[0]!;
    assert.equal(edited.cardRevision, 3);
    update({ type: "reject", card: edited });
    assert.equal(draft.selectedCardRefs.length, 0);
    update({ type: "undo" });
    assert.deepEqual(draft.selectedCardRefs, [edited]);
    assert.deepEqual(versions, Array.from({ length: versions.length }, (_, index) => f.selection.selectionVersion + index));
    assert.deepEqual(f.store.getArtifact<AuthoringSelection>(originalArtifactId).value.selectedCardRefs, []);
    assert.throws(() => f.db.prepare("UPDATE artifacts SET completeness='partial' WHERE artifact_id=?").run(originalArtifactId), /immutable artifact/);
    assert.throws(() => f.db.prepare("UPDATE revisions SET json='{}' WHERE revision_id=?").run(f.branch.headRevisionId), /immutable revision/);
  } finally { f.close(); }
});

test("undoing a batch restores the original cards without deleting newer artifacts", () => {
  const f = fixture();
  try {
    const oldIds = f.selection.cards.map(card => card.cardId);
    const result = f.store.addProposalBatch(f.selection.draftId, EXAMPLE_IDEAS, "example");
    const artifacts = rowCount(f.db, "artifacts");
    const undone = f.store.updateSelection(f.selection.draftId, result.selection.selectionVersion, { type: "undo" });
    assert.deepEqual(undone.cards.map(card => card.cardId), oldIds);
    assert.ok(undone.selectionVersion > result.selection.selectionVersion);
    assert.equal(rowCount(f.db, "artifacts"), artifacts + 1);
  } finally { f.close(); }
});

test("editing after undo never reuses a previous card revision number", () => {
  const f = fixture();
  try {
    const original = f.selection.cards[0]!;
    const edited = f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "edit", card: original, fields: { focus: "第一种细节" } });
    assert.equal(edited.cards[0]!.cardRevision, 2);
    const undone = f.store.updateSelection(edited.draftId, edited.selectionVersion, { type: "undo" });
    const again = f.store.updateSelection(undone.draftId, undone.selectionVersion, { type: "edit", card: original, fields: { focus: "另一个细节" } });
    assert.equal(again.cards[0]!.cardRevision, 3);
  } finally { f.close(); }
});

test("ideas completion and selection attachment are one transaction", () => {
  const f = fixture();
  try {
    const receipt = f.store.beginGeneration({ projectId: f.project.projectId, draftId: f.selection.draftId, kind: "ideas", input: "", idempotencyKey: "atomic-ideas" }, emptyContext());
    const artifacts = rowCount(f.db, "artifacts");
    f.db.exec("CREATE TRIGGER fail_task_result BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'task write failed'); END");
    assert.throws(() => f.store.completeIdeas(receipt.task.taskId, f.selection.draftId, EXAMPLE_IDEAS, "example"), /task write failed/);
    assert.equal(f.store.getSelection(f.selection.draftId).selectionArtifactId, f.selection.selectionArtifactId);
    assert.equal(rowCount(f.db, "artifacts"), artifacts);
  } finally { f.close(); }
});

test("generation freezes all inputs, deduplicates network delivery and archives stale results", () => {
  const f = fixture();
  try {
    const request: GenerationRequest = { projectId: f.project.projectId, draftId: f.selection.draftId, kind: "rehearsal", input: "保持关店的决定", idempotencyKey: "generation-network-retry" };
    const first = f.store.beginGeneration(request, emptyContext());
    const repeated = f.store.beginGeneration(request, emptyContext());
    assert.equal(first.task.taskId, repeated.task.taskId);
    assert.equal(first.task.attemptId, repeated.task.attemptId);
    assert.ok(first.freeze.basePlanHash && first.freeze.intentHash && first.freeze.selectionHash && first.freeze.contextSnapshotId);
    f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "select", card: f.selection.cards[1]! });
    const finished = f.store.finishGeneration(first.task.taskId, { text: "这段迟到的候选仍然保存。" });
    assert.equal(finished.freshness, "stale");
    const result = finished.task.result as { artifactId: string; text: string };
    assert.equal(f.store.getArtifact<{ text: string }>(result.artifactId).value.text, result.text);
    const newer = f.store.beginGeneration({ ...request, idempotencyKey: "new-attempt" }, emptyContext());
    assert.notEqual(newer.task.attemptId, first.task.attemptId);
    assert.notEqual(newer.task.generationRequestId, first.task.generationRequestId);
    assert.equal(f.store.findGeneration(request.idempotencyKey, request)!.task.taskId, first.task.taskId);
    assert.ok(f.store.listEvidence(f.project.projectId).every(item => !item.quote.includes("迟到的候选")));
  } finally { f.close(); }
});

test("late ideas and cancelled generation retain output without changing current selection", () => {
  const f = fixture();
  try {
    const request: GenerationRequest = { projectId: f.project.projectId, draftId: f.selection.draftId, kind: "ideas", input: "", idempotencyKey: "late-ideas" };
    const receipt = f.store.beginGeneration(request, emptyContext());
    const selected = f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "select", card: f.selection.cards[0]! });
    const late = f.store.addProposalBatch(selected.draftId, EXAMPLE_IDEAS, "pi", receipt.task.taskId);
    assert.equal(late.selection.selectionArtifactId, selected.selectionArtifactId);
    f.store.requestCancellation(receipt.task.taskId);
    f.store.confirmCancellation(receipt.task.taskId);
    const cancelled = f.store.finishGeneration(receipt.task.taskId, { text: "取消时已经到达的文本" });
    assert.equal(cancelled.task.state, "cancelled");
    assert.equal(cancelled.task.completeness, "partial");
    assert.ok((cancelled.task.result as { artifactId: string }).artifactId);
  } finally { f.close(); }
});

test("body saving, named revisions and restore preserve both sides of history", () => {
  const f = fixture();
  try {
    const scene = f.store.listScenes(f.project.projectId)[0]!;
    const saved = f.store.saveScene(scene.sceneId, { baseRevisionId: f.branch.headRevisionId, body: "柜台上的收据被雨水浸透了。" });
    const named = f.store.nameRevision(f.project.projectId, { baseRevisionId: saved.revision.revisionId, name: "雨夜初稿" });
    const later = f.store.saveScene(scene.sceneId, { baseRevisionId: named.revisionId, body: "第二版，阿禾把收据夹进了账本。" });
    const restored = f.store.restore(f.project.projectId, { revisionId: named.revisionId, baseRevisionId: later.revision.revisionId, acceptanceId: "restore-once" });
    assert.equal(restored.kind, "restored");
    assert.deepEqual(restored.parentRevisionIds, [later.revision.revisionId]);
    assert.equal(f.store.getScene(scene.sceneId).body, "柜台上的收据被雨水浸透了。");
    assert.equal(f.store.getScene(scene.sceneId, later.revision.revisionId).body, "第二版，阿禾把收据夹进了账本。");
    assert.equal(f.store.restore(f.project.projectId, { revisionId: named.revisionId, baseRevisionId: later.revision.revisionId, acceptanceId: "restore-once" }).revisionId, restored.revisionId);
    assert.notEqual(restored.revisionId, named.revisionId);
    const branch = f.store.createBranch(f.project.projectId, { name: "另一条路", revisionId: named.revisionId });
    assert.equal(branch.headRevisionId, named.revisionId);
    assert.equal(f.store.getBranch(f.branch.branchId).headRevisionId, restored.revisionId);
    const other = f.store.createProject({ title: "另一部作品" });
    assert.throws(() => f.store.createBranch(other.projectId, { name: "错误引用", revisionId: named.revisionId }), (error: unknown) => error instanceof DomainError && error.code === "SCOPE_MISMATCH");
  } finally { f.close(); }
});

function services(store: DomainStore, piOverride?: Partial<PiHost>) {
  const knowledge: KnowledgeService = {
    listEntities: () => [], listFacts: () => [], listEvents: () => [],
    queryContext: query => ({ ...emptyContext(), indexState: { keywordRevisionId: query.revisionId, semanticState: "unconfigured" } }),
    checkConsistency: () => [], indexScene: () => {},
  };
  const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("no workflow"); }, decide: () => { throw new Error("no workflow"); }, cancel: () => { throw new Error("no workflow"); } };
  const pi: PiHost = { getConnection: () => ({ state: "connected", mode: "rpc", detail: "test", sendsDataTo: "test" }), generate: async () => ({ text: "仅作为候选的正文。", completeness: "complete" }), cancel: async () => {}, ...piOverride };
  return { store, knowledge, workflow, pi };
}
async function start(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

test("HTTP revision preview returns the selected immutable scene content", async () => {
  const f = fixture();
  const scene = f.store.listScenes(f.project.projectId)[0]!;
  f.store.saveScene(scene.sceneId, { baseRevisionId: scene.baseRevisionId, body: "现稿已经改变" });
  const server = createApp(services(f.store));
  try {
    const base = await start(server);
    const response = await fetch(`${base}/api/revisions/${scene.baseRevisionId}`);
    assert.equal(response.status, 200);
    const preview = await response.json() as { scenes: Array<{ body: string }> };
    assert.equal(preview.scenes[0]?.body, scene.body);
    assert.notEqual(preview.scenes[0]?.body, "现稿已经改变");
  } finally { await stop(server); f.close(); }
});

test("HTTP bootstrap, empty example ideas, saving, JSON errors and same-origin protection", async () => {
  const f = fixture();
  const server = createApp(services(f.store));
  try {
    const base = await start(server);
    const boot = await fetch(`${base}/api/bootstrap`);
    assert.equal(boot.status, 200);
    const snapshot = await boot.json() as WorkspaceSnapshot;
    for (const key of ["projects", "activeProject", "branches", "routes", "chapters", "scenes", "elements", "facts", "events", "evidence", "authoringDraft", "revisions", "workflows", "workflowRuns", "storyGraph", "tasks", "connection"]) assert.ok(key in snapshot, key);
    const response = await fetch(`${base}/api/projects/${f.project.projectId}/ideas`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ input: "", mode: "example", idempotencyKey: "empty-example" }) });
    assert.equal(response.status, 200);
    const generated = await response.json() as { draft: AuthoringSelection };
    assert.ok(generated.draft.cards.length >= 3);
    const patch = await fetch(`${base}/api/scenes/${snapshot.scenes[0]!.sceneId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ baseRevisionId: f.branch.headRevisionId, body: "浏览器确认保存的正文。" }) });
    assert.equal(patch.status, 200);
    const saved = await patch.json() as { scene: { body: string }; revisionId: string; revision: { revisionId: string }; evidence: unknown[]; storyGraph: { revisionId: string }; project: { projectId: string } };
    assert.equal(saved.scene.body, "浏览器确认保存的正文。");
    assert.ok(saved.revisionId);
    assert.equal(saved.revision.revisionId, saved.revisionId);
    assert.equal(saved.storyGraph.revisionId, saved.revisionId);
    assert.equal(saved.project.projectId, f.project.projectId);
    assert.ok(Array.isArray(saved.evidence));
    const stale = await fetch(`${base}/api/scenes/${snapshot.scenes[0]!.sceneId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseRevisionId: f.branch.headRevisionId, body: "过时的文本" }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: { currentRevisionId: string } }).error.currentRevisionId, saved.revisionId);
    const origin = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://untrusted.example" }, body: "{}" });
    assert.equal(origin.status, 403);
    const badJson = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(badJson.status, 400);
    const oversized = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "大".repeat(400_000) }) });
    assert.equal(oversized.status, 413);
    const badHost = await new Promise<number>(resolve => {
      const request = httpRequest(`${base}/api/health`, { headers: { Host: "attacker.example" } }, response => { response.resume(); resolve(response.statusCode ?? 0); }); request.end();
    });
    assert.equal(badHost, 403);
  } finally { await stop(server); f.close(); }
});

test("HTTP project creation stores premise and pasted first-scene body together", async () => {
  const f = fixture();
  const server = createApp(services(f.store));
  try {
    const base = await start(server);
    const response = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ title: "我的第一部小说", premise: "", body: "这是已经写好的一小段。\n\n它应直接成为第一场正文。" }) });
    assert.equal(response.status, 201);
    const created = await response.json() as WorkspaceSnapshot;
    assert.equal(created.activeProject.title, "我的第一部小说");
    assert.equal(created.scenes.length, 1);
    assert.equal(created.scenes[0]!.body, "这是已经写好的一小段。\n\n它应直接成为第一场正文。");
    assert.equal(created.scenes[0]!.status, "writing");
    assert.equal(created.revisions.length, 1, "创建作品和片段应属于同一个初始修订");
    const reopened = await fetch(`${base}/api/bootstrap?projectId=${encodeURIComponent(created.activeProject.projectId)}`);
    assert.equal((await reopened.json() as WorkspaceSnapshot).scenes[0]!.body, created.scenes[0]!.body);
    const invalid = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ title: "不应创建", body: 42 }) });
    assert.equal(invalid.status, 400);
    assert.equal(f.store.listProjects().some(project => project.title === "不应创建"), false);
  } finally { await stop(server); f.close(); }
});

test("HTTP generation stays running until Pi returns output, deduplicates and recomputes freshness", async () => {
  const f = fixture();
  let resolveOutput!: (value: { text: string; completeness: "complete" }) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const output = new Promise<{ text: string; completeness: "complete" }>(resolve => { resolveOutput = resolve; });
  let calls = 0;
  const server = createApp(services(f.store, { generate: async () => { calls++; markStarted(); return output; } }));
  try {
    const base = await start(server);
    const request = { projectId: f.project.projectId, draftId: f.selection.draftId, kind: "scene", input: "接着写一小段", idempotencyKey: "running-request" };
    const send = () => fetch(`${base}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const pending = send();
    await started;
    const duplicate = await send();
    const queued = await duplicate.json() as { task: { taskId: string; state: string; attemptId: string } };
    assert.equal(queued.task.state, "running");
    assert.equal(calls, 1);
    f.store.updateSelection(f.selection.draftId, f.selection.selectionVersion, { type: "select", card: f.selection.cards[0]! });
    resolveOutput({ text: "真正完成并归档的候选。", completeness: "complete" });
    const completed = await (await pending).json() as { task: { taskId: string; state: string; attemptId: string; result: { text: string } }; freshness: string };
    assert.equal(completed.task.state, "succeeded");
    assert.equal(completed.task.taskId, queued.task.taskId);
    assert.equal(completed.task.attemptId, queued.task.attemptId);
    assert.equal(completed.task.result.text, "真正完成并归档的候选。");
    assert.equal(completed.freshness, "stale");
  } finally { resolveOutput({ text: "结束测试", completeness: "complete" }); await stop(server); f.close(); }
});

test("SSE reconnect explicitly sends a complete snapshot", async () => {
  const f = fixture();
  const server = createApp(services(f.store));
  const controller = new AbortController();
  try {
    const base = await start(server);
    const response = await fetch(`${base}/api/events?cursor=999999`, { signal: controller.signal, headers: { "Last-Event-ID": "999999" } });
    assert.equal(response.headers.get("x-nova-novel-reconnect"), "snapshot");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: snapshot/);
    assert.match(text, /authoringDraft/);
    await reader.cancel();
  } finally { controller.abort(); await stop(server); f.close(); }
});

test("Pi ideas only expose validated complete output and a failed call leaves selection untouched", async () => {
  const f = fixture();
  let calls = 0;
  const server = createApp(services(f.store, { generate: async () => { calls++; if (calls === 1) throw new Error("model unavailable"); return { text: JSON.stringify({ cards: EXAMPLE_IDEAS }), completeness: "complete" }; } }));
  try {
    const base = await start(server);
    const ideas = (key: string) => fetch(`${base}/api/projects/${f.project.projectId}/ideas`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "pi", input: "", idempotencyKey: key }) });
    const first = await ideas("fail");
    assert.equal(first.status, 502);
    assert.equal(f.store.getSelection(f.selection.draftId).selectionArtifactId, f.selection.selectionArtifactId);
    const again = await ideas("fail");
    assert.equal(again.status, 502);
    assert.equal(calls, 1);
    const success = await ideas("succeed");
    assert.equal(success.status, 200);
    const draft = (await success.json() as { draft: AuthoringSelection }).draft;
    assert.ok(draft.cards.some(card => card.sourceRef.origin === "pi"));
    assert.ok(draft.selectionVersion > f.selection.selectionVersion);
    assert.equal((await ideas("succeed")).status, 200);
    assert.equal(calls, 2);
  } finally { await stop(server); f.close(); }
});
