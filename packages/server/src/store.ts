import type Database from "better-sqlite3";
import {
  countWords, type AgentTask, type AuthoringSelection, type Branch, type CardRef, type ChangeSet,
  type ContextBundle, type Evidence, type GenerationReceipt, type GenerationRequest, type IdeaCard,
  type IdeaCardFields, type Project, type ProposalBatch, type Revision, type Scene, type SelectionAction,
  type StoryRoute,
} from "@nova-novel/shared";
import { DomainError, EXAMPLE_IDEAS, cardKey, initialManifest, planHash, requiredString, versionNumber, type RevisionManifest } from "./domain.js";
import { newId, now, sha256, stableHash } from "./utils.js";

type JsonRow = { json: string };
type StoredSelection = AuthoringSelection & { previousArtifactId?: string; undoTargetArtifactId?: string };
interface StoredChangeSet extends ChangeSet {
  payloadHash: string;
  restoreRevisionId?: string;
  draftId?: string;
  selectionVersion?: number;
  committedRevisionId?: string;
}
interface TaskRecord {
  task: AgentTask;
  request: GenerationRequest;
  requestHash: string;
  branchId: string;
  freeze: GenerationReceipt["freeze"];
  context: ContextBundle;
  novel?: { project: Project; scene?: Scene; selection?: AuthoringSelection; branchId: string; routeId: string; writingIntent: Record<string, unknown> };
}
export interface ChangeSetInput {
  projectId: string;
  branchId?: string;
  baseRevisionId: string;
  acceptanceId: string;
  restoreRevisionId?: string;
  sceneChanges?: ChangeSet["sceneChanges"];
  factChanges?: ChangeSet["factChanges"];
  graphChanges?: ChangeSet["graphChanges"];
  sceneAdditions?: ChangeSet["sceneAdditions"];
  sourceTaskId?: string;
  draftId?: string;
  selectionVersion?: number;
}
export interface ArtifactRecord<T = unknown> {
  artifactId: string;
  kind: string;
  value: T;
  taskId?: string;
  createdAt: string;
  completeness: "complete" | "partial";
}

/** Owns the single writable connection; callers must not open competing writers. */
export class DomainStore {
  constructor(public readonly db: Database.Database) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (blob_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (revision_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), branch_id TEXT NOT NULL REFERENCES branches(branch_id) DEFERRABLE INITIALLY DEFERRED, manifest_blob_id TEXT NOT NULL REFERENCES blobs(blob_id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branches (branch_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), head_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS story_routes (route_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenes (scene_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id));
      CREATE TABLE IF NOT EXISTS scene_revisions (scene_id TEXT NOT NULL REFERENCES scenes(scene_id), revision_id TEXT NOT NULL REFERENCES revisions(revision_id), blob_id TEXT NOT NULL REFERENCES blobs(blob_id), PRIMARY KEY(scene_id,revision_id));
      CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY, artifact_kind TEXT NOT NULL, blob_id TEXT NOT NULL REFERENCES blobs(blob_id), task_id TEXT REFERENCES tasks(task_id), completeness TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authoring_drafts (draft_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), branch_id TEXT NOT NULL REFERENCES branches(branch_id), base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), selection_version INTEGER NOT NULL CHECK(selection_version>=0), selection_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id));
      CREATE TABLE IF NOT EXISTS changesets (changeset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), branch_id TEXT NOT NULL REFERENCES branches(branch_id), base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), acceptance_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), idempotency_key TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_snapshots (snapshot_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id), revision_id TEXT NOT NULL REFERENCES revisions(revision_id), blob_id TEXT NOT NULL REFERENCES blobs(blob_id));
      CREATE TABLE IF NOT EXISTS domain_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(project_id), revision_id TEXT NOT NULL REFERENCES revisions(revision_id), created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_blob_update BEFORE UPDATE ON blobs BEGIN SELECT RAISE(ABORT,'immutable blob'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_blob_delete BEFORE DELETE ON blobs BEGIN SELECT RAISE(ABORT,'immutable blob'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_revision_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_revision_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_artifact_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'immutable artifact'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_artifact_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'immutable artifact'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_scene_revision_update BEFORE UPDATE ON scene_revisions BEGIN SELECT RAISE(ABORT,'immutable scene revision'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_scene_revision_delete BEFORE DELETE ON scene_revisions BEGIN SELECT RAISE(ABORT,'immutable scene revision'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_context_update BEFORE UPDATE ON context_snapshots BEGIN SELECT RAISE(ABORT,'immutable context'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_context_delete BEFORE DELETE ON context_snapshots BEGIN SELECT RAISE(ABORT,'immutable context'); END;
    `);
    if (this.listProjects().length === 0) this.createProject({ title: "修鞋铺收据", premise: "关门前，一张旧收据让最后一桩活留下了一个问题。", example: true });
    // Unknown external outcomes are never automatically re-executed after restart.
    const records = db.prepare("SELECT json FROM tasks").all() as JsonRow[];
    for (const row of records) {
      const record = JSON.parse(row.json) as TaskRecord;
      if (["queued", "running", "cancelling", "waiting_extension_ui"].includes(record.task.state)) {
        record.task.state = "interrupted";
        record.task.completeness = "partial";
        record.task.error = "宿主已重启；请核对已有产物后显式重试";
        record.task.updatedAt = now();
        db.prepare("UPDATE tasks SET json=? WHERE task_id=?").run(JSON.stringify(record), record.task.taskId);
      }
    }
  }

  private json<T>(sql: string, ...params: string[]): T | undefined {
    const row = this.db.prepare(sql).get(...params) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  private jsonList<T>(sql: string, ...params: string[]): T[] {
    return (this.db.prepare(sql).all(...params) as JsonRow[]).map(row => JSON.parse(row.json) as T);
  }
  private blob(value: unknown): string {
    const json = JSON.stringify(value);
    const hash = sha256(json);
    const blobId = `blob_${hash}`;
    this.db.prepare("INSERT OR IGNORE INTO blobs(blob_id,sha256,json) VALUES(?,?,?)").run(blobId, hash, json);
    return blobId;
  }
  private emit(kind: string, value: unknown): void {
    this.db.prepare("INSERT INTO domain_events(kind,json,created_at) VALUES(?,?,?)").run(kind, JSON.stringify(value), now());
  }
  listEventsAfter(cursor = 0): Array<{ seq: number; kind: string; value: unknown }> {
    const rows = this.db.prepare("SELECT seq,kind,json FROM domain_events WHERE seq>? ORDER BY seq LIMIT 1000").all(cursor) as Array<{ seq: number; kind: string; json: string }>;
    return rows.map(row => ({ seq: row.seq, kind: row.kind, value: JSON.parse(row.json) as unknown }));
  }
  eventCursor(): number { return (this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM domain_events").get() as { seq: number }).seq; }
  listProjects(): Project[] { return this.jsonList("SELECT json FROM projects ORDER BY rowid"); }
  getProject(projectId?: string): Project {
    const project = projectId ? this.json<Project>("SELECT json FROM projects WHERE project_id=?", projectId) : this.listProjects()[0];
    if (!project) throw new DomainError(404, "NOT_FOUND", "作品不存在");
    return project;
  }
  listBranches(projectId: string): Branch[] {
    const rows = this.db.prepare("SELECT json,head_revision_id FROM branches WHERE project_id=? ORDER BY rowid").all(projectId) as Array<JsonRow & { head_revision_id: string }>;
    return rows.map(row => ({ ...JSON.parse(row.json) as Branch, headRevisionId: row.head_revision_id }));
  }
  getBranch(branchId: string): Branch {
    const row = this.db.prepare("SELECT json,head_revision_id FROM branches WHERE branch_id=?").get(branchId) as (JsonRow & { head_revision_id: string }) | undefined;
    if (!row) throw new DomainError(404, "NOT_FOUND", "分支不存在");
    return { ...JSON.parse(row.json) as Branch, headRevisionId: row.head_revision_id };
  }
  listRoutes(projectId: string): StoryRoute[] { return this.jsonList("SELECT json FROM story_routes WHERE project_id=? ORDER BY rowid", projectId); }
  private projectBranch(projectId: string, branchId?: string): Branch {
    const project = this.getProject(projectId);
    const branch = this.getBranch(branchId ?? project.activeBranchId);
    if (branch.projectId !== projectId) throw new DomainError(400, "SCOPE_MISMATCH", "分支不属于此作品");
    return branch;
  }
  getRevision(revisionId: string): Revision {
    const revision = this.json<Revision>("SELECT json FROM revisions WHERE revision_id=?", revisionId);
    if (!revision) throw new DomainError(404, "NOT_FOUND", "修订不存在");
    return revision;
  }
  listRevisions(projectId: string): Revision[] { return this.jsonList("SELECT json FROM revisions WHERE project_id=? ORDER BY rowid DESC", projectId); }
  getManifest(revisionId: string): RevisionManifest {
    const manifest = this.json<RevisionManifest>("SELECT b.json FROM revisions r JOIN blobs b ON b.blob_id=r.manifest_blob_id WHERE r.revision_id=?", revisionId);
    if (!manifest) throw new DomainError(404, "NOT_FOUND", "修订清单不存在");
    return manifest;
  }
  private resolveRevision(projectId: string, revisionId?: string): string {
    const id = revisionId ?? this.projectBranch(projectId).headRevisionId;
    if (this.getRevision(id).projectId !== projectId) throw new DomainError(400, "SCOPE_MISMATCH", "修订不属于此作品");
    return id;
  }
  assertRevisionOnBranch(projectId: string, branchId: string, revisionId: string): void {
    const branch = this.projectBranch(projectId, branchId);
    this.resolveRevision(projectId, revisionId);
    const pending = [branch.headRevisionId];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === revisionId) return;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...this.getRevision(id).parentRevisionIds);
    }
    throw new DomainError(400, "SCOPE_MISMATCH", "修订不在此分支的历史中");
  }
  listScenes(projectId: string, revisionId?: string): Scene[] { return this.getManifest(this.resolveRevision(projectId, revisionId)).scenes; }
  getScene(sceneId: string, revisionId?: string): Scene {
    const row = this.db.prepare("SELECT project_id FROM scenes WHERE scene_id=?").get(sceneId) as { project_id: string } | undefined;
    if (!row) throw new DomainError(404, "NOT_FOUND", "场景不存在");
    const scene = this.listScenes(row.project_id, revisionId).find(item => item.sceneId === sceneId);
    if (!scene) throw new DomainError(404, "NOT_FOUND", "此修订中没有该场景");
    return scene;
  }
  listChapters(projectId: string, revisionId?: string) { return this.getManifest(this.resolveRevision(projectId, revisionId)).chapters; }
  getStoryGraph(projectId: string, revisionId?: string) { return this.getManifest(this.resolveRevision(projectId, revisionId)).storyGraph; }
  listEvidence(projectId: string, revisionId?: string): Evidence[] {
    const id = this.resolveRevision(projectId, revisionId);
    return this.listScenes(projectId, id).filter(scene => scene.body.length > 0).map(scene => ({
      evidenceId: `evidence_${sha256(`${id}:${scene.sceneId}:${scene.body}`).slice(0, 24)}`, projectId,
      sourceRevisionId: id, sceneId: scene.sceneId, blockId: "body", quote: scene.body,
      contentHash: sha256(scene.body), sourceKind: "manuscript", routeId: scene.routeId,
      narrationOrder: scene.narrationOrder,
    }));
  }
  private writeRevision(revision: Revision, manifest: RevisionManifest): void {
    manifest.storyGraph.revisionId = revision.revisionId;
    manifest.scenes = manifest.scenes.map(scene => ({ ...scene, baseRevisionId: revision.revisionId }));
    this.db.prepare("INSERT INTO revisions(revision_id,project_id,branch_id,manifest_blob_id,json) VALUES(?,?,?,?,?)")
      .run(revision.revisionId, revision.projectId, revision.branchId, this.blob(manifest), JSON.stringify(revision));
    for (const scene of manifest.scenes) {
      this.db.prepare("INSERT OR IGNORE INTO scenes(scene_id,project_id) VALUES(?,?)").run(scene.sceneId, scene.projectId);
      this.db.prepare("INSERT INTO scene_revisions(scene_id,revision_id,blob_id) VALUES(?,?,?)").run(scene.sceneId, revision.revisionId, this.blob(scene));
    }
    this.db.prepare("INSERT INTO domain_outbox(project_id,revision_id,created_at) VALUES(?,?,?)").run(revision.projectId, revision.revisionId, now());
  }
  createProject(input: { title?: string; premise?: string; example?: boolean; body?: string } = {}): Project {
    const title = input.title === undefined ? "未命名作品" : requiredString(input.title, "title", 200);
    if (input.premise !== undefined && typeof input.premise !== "string") throw new DomainError(400, "INVALID_INPUT", "premise 必须是文字");
    if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > 1_000_000)) throw new DomainError(400, "INVALID_INPUT", "第一场正文必须是文字且不超过 1 MiB 文本");
    return this.db.transaction(() => {
      const project: Project = { projectId: newId("project"), title, premise: input.premise ?? "", createdAt: now(), updatedAt: now(), activeBranchId: newId("branch"), activeRouteId: newId("route") };
      this.db.prepare("INSERT INTO projects(project_id,json) VALUES(?,?)").run(project.projectId, JSON.stringify(project));
      const route: StoryRoute = { routeId: project.activeRouteId, projectId: project.projectId, name: "主线" };
      this.db.prepare("INSERT INTO story_routes(route_id,project_id,json) VALUES(?,?,?)").run(route.routeId, project.projectId, JSON.stringify(route));
      const manifest = initialManifest(project.projectId, route.routeId, input.example === true);
      if (input.body) {
        manifest.scenes[0]!.body = input.body;
        manifest.scenes[0]!.status = "writing";
      }
      const revision: Revision = { revisionId: newId("revision"), projectId: project.projectId, branchId: project.activeBranchId, parentRevisionIds: [], name: "开始创作", kind: "named", createdAt: now(), wordCount: manifest.scenes.reduce((sum, scene) => sum + countWords(scene.body), 0) };
      this.writeRevision(revision, manifest);
      const branch: Branch = { branchId: project.activeBranchId, projectId: project.projectId, name: "主稿", headRevisionId: revision.revisionId };
      this.db.prepare("INSERT INTO branches(branch_id,project_id,head_revision_id,json) VALUES(?,?,?,?)").run(branch.branchId, project.projectId, revision.revisionId, JSON.stringify(branch));
      const selection = this.createDraft(project.projectId, branch.branchId);
      if (input.example) this.addProposalBatch(selection.draftId, EXAMPLE_IDEAS, "example");
      this.emit("project.created", project);
      return project;
    })();
  }
  putArtifact<T>(kind: string, value: T, taskId?: string, completeness: "complete" | "partial" = "complete", artifactId = newId("artifact")): ArtifactRecord<T> {
    if (taskId) this.getTask(taskId);
    const createdAt = now();
    this.db.prepare("INSERT INTO artifacts(artifact_id,artifact_kind,blob_id,task_id,completeness,created_at) VALUES(?,?,?,?,?,?)")
      .run(artifactId, kind, this.blob(value), taskId ?? null, completeness, createdAt);
    return { artifactId, kind, value, ...(taskId ? { taskId } : {}), completeness, createdAt };
  }
  getArtifact<T = unknown>(artifactId: string): ArtifactRecord<T> {
    const row = this.db.prepare("SELECT a.*,b.json FROM artifacts a JOIN blobs b ON b.blob_id=a.blob_id WHERE artifact_id=?").get(artifactId) as (JsonRow & { artifact_id: string; artifact_kind: string; task_id: string | null; completeness: "complete" | "partial"; created_at: string }) | undefined;
    if (!row) throw new DomainError(404, "NOT_FOUND", "产物不存在");
    return { artifactId: row.artifact_id, kind: row.artifact_kind, value: JSON.parse(row.json) as T, ...(row.task_id ? { taskId: row.task_id } : {}), completeness: row.completeness, createdAt: row.created_at };
  }
  createDraft(projectId: string, branchId?: string): AuthoringSelection {
    const branch = this.projectBranch(projectId, branchId);
    const selection: StoredSelection = {
      draftId: newId("draft"), projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId,
      selectionVersion: 0, selectionArtifactId: newId("artifact"), selectedCardRefs: [], lockedDecisions: [], protectedSpans: [], compositionSources: [], cards: [], batches: [], undoDepth: 0,
    };
    this.putArtifact("selection", selection, undefined, "complete", selection.selectionArtifactId);
    this.db.prepare("INSERT INTO authoring_drafts(draft_id,project_id,branch_id,base_revision_id,selection_version,selection_artifact_id) VALUES(?,?,?,?,?,?)")
      .run(selection.draftId, projectId, branch.branchId, branch.headRevisionId, 0, selection.selectionArtifactId);
    return this.getSelection(selection.draftId);
  }
  private storedSelection(draftId: string): StoredSelection {
    const row = this.db.prepare("SELECT selection_artifact_id FROM authoring_drafts WHERE draft_id=?").get(draftId) as { selection_artifact_id: string } | undefined;
    if (!row) throw new DomainError(404, "NOT_FOUND", "选择草稿不存在");
    return this.getArtifact<StoredSelection>(row.selection_artifact_id).value;
  }
  getSelection(draftId: string): AuthoringSelection {
    const { previousArtifactId: _previous, undoTargetArtifactId: _undo, ...selection } = this.storedSelection(draftId);
    return selection;
  }
  getAuthoringDraft(projectId: string, branchId?: string): AuthoringSelection {
    const branch = this.projectBranch(projectId, branchId);
    const row = this.db.prepare("SELECT draft_id FROM authoring_drafts WHERE project_id=? AND branch_id=? ORDER BY rowid LIMIT 1").get(projectId, branch.branchId) as { draft_id: string } | undefined;
    return row ? this.getSelection(row.draft_id) : this.createDraft(projectId, branch.branchId);
  }
  private conflict(branchId: string, draftId?: string): never {
    const head = this.getBranch(branchId).headRevisionId;
    const version = draftId ? this.getSelection(draftId).selectionVersion : undefined;
    throw new DomainError(409, "VERSION_CONFLICT", "内容或选择已改变，请重新比较后提交", head, version);
  }
  private writeSelection(previous: StoredSelection, next: StoredSelection, expectedVersion: number): AuthoringSelection {
    next.selectionVersion = expectedVersion + 1;
    next.selectionArtifactId = newId("artifact");
    next.previousArtifactId = previous.selectionArtifactId;
    this.putArtifact("selection", next, undefined, "complete", next.selectionArtifactId);
    const result = this.db.prepare("UPDATE authoring_drafts SET selection_version=?,selection_artifact_id=?,base_revision_id=? WHERE draft_id=? AND project_id=? AND branch_id=? AND selection_version=?")
      .run(next.selectionVersion, next.selectionArtifactId, next.baseRevisionId, next.draftId, next.projectId, next.branchId, expectedVersion);
    if (result.changes !== 1) this.conflict(previous.branchId, previous.draftId);
    this.emit("selection.changed", { draftId: next.draftId, selectionVersion: next.selectionVersion });
    return this.getSelection(next.draftId);
  }
  private findCard(selection: AuthoringSelection, ref: CardRef): IdeaCard {
    if (!ref || typeof ref.cardId !== "string" || !Number.isSafeInteger(ref.cardRevision)) throw new DomainError(400, "INVALID_INPUT", "卡片引用无效");
    let card = [...selection.cards, ...selection.batches.flatMap(batch => batch.cards)].find(item => cardKey(item) === cardKey(ref));
    if (!card && [...selection.cards, ...selection.batches.flatMap(batch => batch.cards)].some(item => item.cardId === ref.cardId)) {
      card = this.json<IdeaCard>("SELECT b.json FROM artifacts a JOIN blobs b ON b.blob_id=a.blob_id WHERE a.artifact_kind='idea_card' AND json_extract(b.json,'$.cardId')=? AND CAST(json_extract(b.json,'$.cardRevision') AS TEXT)=?", ref.cardId, String(ref.cardRevision));
    }
    if (!card) throw new DomainError(404, "NOT_FOUND", "卡片版本不存在");
    return card;
  }
  private fields(fields: Partial<IdeaCardFields>): void {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new DomainError(400, "INVALID_INPUT", "卡片字段无效");
    for (const [key, value] of Object.entries(fields)) {
      if (!["action", "motivation", "obstacle", "outcome", "focus", "tradeoff"].includes(key) || typeof value !== "string" || value.length > 10000) throw new DomainError(400, "INVALID_INPUT", "卡片字段无效");
    }
  }
  addProposalBatch(draftId: string, ideas: IdeaCardFields[], origin: "author" | "pi" | "example", taskId?: string): { batch: ProposalBatch; selection: AuthoringSelection } {
    if (!Array.isArray(ideas) || ideas.length === 0 || ideas.length > 20) throw new DomainError(400, "INVALID_OUTPUT", "点子批次应含 1–20 张卡片");
    for (const fields of ideas) { this.fields(fields); requiredString(fields.action, "action"); requiredString(fields.focus, "focus"); requiredString(fields.tradeoff, "tradeoff"); }
    return this.db.transaction(() => {
      const current = this.storedSelection(draftId);
      const task = taskId ? this.getTask(taskId) : undefined;
      const batchId = newId("batch");
      const cards: IdeaCard[] = ideas.map(fields => ({ cardId: newId("card"), cardRevision: 1, proposalBatchId: batchId, sourceRef: { origin, ...(taskId ? { taskId } : {}) }, proposedFields: fields, relatedEntityIds: [], dependencyRefs: [], differenceNote: fields.tradeoff }));
      const batch: ProposalBatch = {
        proposalBatchId: batchId, ...(current.batches.at(-1) ? { parentBatchId: current.batches.at(-1)!.proposalBatchId } : {}),
        generationRequestId: task?.generationRequestId ?? newId("generation"), attemptId: task?.attemptId ?? newId("attempt"), sourceTaskId: taskId ?? "local", baseRevisionId: this.getBranch(current.branchId).headRevisionId,
        basePlanHash: planHash(this.getManifest(this.getBranch(current.branchId).headRevisionId)), cardRefs: cards.map(({ cardId, cardRevision }) => ({ cardId, cardRevision })), cards, createdAt: now(),
      };
      for (const card of cards) this.putArtifact("idea_card", card, taskId);
      this.putArtifact("proposal_batch", batch, taskId);
      if (taskId && this.getGeneration(taskId).freshness === "stale") return { batch, selection: this.getSelection(draftId) };
      const retained = current.cards.filter(card => current.selectedCardRefs.some(ref => cardKey(ref) === cardKey(card)) || current.lockedDecisions.some(lock => lock.card.cardId === card.cardId));
      const next: StoredSelection = { ...current, cards: [...retained, ...cards], batches: [...current.batches, batch], undoDepth: current.undoDepth + 1, undoTargetArtifactId: current.selectionArtifactId };
      return { batch, selection: this.writeSelection(current, next, current.selectionVersion) };
    })();
  }
  completeIdeas(taskId: string, draftId: string, fields: IdeaCardFields[], origin: "pi" | "example", metadata?: { sessionId?: string; leafId?: string }) {
    return this.db.transaction(() => {
      const result = this.addProposalBatch(draftId, fields, origin, taskId);
      const receipt = this.finishGeneration(taskId, { output: "ideas", text: JSON.stringify({ cards: fields }), batch: result.batch, ...metadata });
      return { ...result, receipt };
    })();
  }
  updateSelection(draftId: string, expectedVersion: number, action: SelectionAction): AuthoringSelection {
    versionNumber(expectedVersion);
    return this.db.transaction(() => {
      const current = this.storedSelection(draftId);
      if (current.selectionVersion !== expectedVersion) this.conflict(current.branchId, draftId);
      let next = structuredClone(current);
      if (!action || typeof action !== "object") throw new DomainError(400, "INVALID_INPUT", "缺少选择操作");
      if (action.type === "undo") {
        if (!current.undoTargetArtifactId) throw new DomainError(400, "NO_UNDO", "没有可撤销的选择");
        const restored = this.getArtifact<StoredSelection>(current.undoTargetArtifactId).value;
        next = { ...restored, baseRevisionId: current.baseRevisionId };
      } else {
        next.undoTargetArtifactId = current.selectionArtifactId;
        next.undoDepth = current.undoDepth + 1;
        switch (action.type) {
          case "select": this.findCard(current, action.card); next.selectedCardRefs = [action.card]; break;
          case "reject": this.findCard(current, action.card); next.selectedCardRefs = current.selectedCardRefs.filter(ref => cardKey(ref) !== cardKey(action.card)); break;
          case "lock": {
            const card = this.findCard(current, action.card);
            if (!["action", "motivation", "obstacle", "outcome", "focus", "tradeoff"].includes(action.field)) throw new DomainError(400, "INVALID_INPUT", "锁定字段无效");
            const text = card.proposedFields[action.field];
            if (!text) throw new DomainError(400, "INVALID_INPUT", "空字段不能锁定");
            if (!next.lockedDecisions.some(lock => cardKey(lock.card) === cardKey(action.card) && lock.field === action.field)) next.lockedDecisions.push({ id: newId("lock"), card: action.card, field: action.field, text });
            break;
          }
          case "unlock": next.lockedDecisions = current.lockedDecisions.filter(lock => lock.id !== action.lockId); break;
          case "borrow":
          case "edit": {
            const ref = action.type === "borrow" ? action.targetCard : action.card;
            const card = this.findCard(current, ref);
            const patch: Partial<IdeaCardFields> = action.type === "edit" ? action.fields : { [action.field]: this.findCard(current, action.sourceCard).proposedFields[action.field] ?? "" };
            this.fields(patch);
            for (const lock of current.lockedDecisions) {
              if (lock.card.cardId === card.cardId && patch[lock.field] !== undefined && patch[lock.field] !== card.proposedFields[lock.field]) throw new DomainError(409, "LOCKED_DECISION", "请先解除保留项，再修改这个决定", this.getBranch(current.branchId).headRevisionId, current.selectionVersion);
            }
            const highest = this.db.prepare("SELECT MAX(CAST(json_extract(b.json,'$.cardRevision') AS INTEGER)) AS revision FROM artifacts a JOIN blobs b ON b.blob_id=a.blob_id WHERE a.artifact_kind='idea_card' AND json_extract(b.json,'$.cardId')=?").get(card.cardId) as { revision: number };
            const edited: IdeaCard = { ...card, cardRevision: highest.revision + 1, proposedFields: { ...card.proposedFields, ...patch }, sourceRef: { origin: "author" } };
            this.putArtifact("idea_card", edited);
            next.cards = next.cards.map(item => item.cardId === edited.cardId ? edited : item);
            const editedRef = { cardId: edited.cardId, cardRevision: edited.cardRevision };
            next.selectedCardRefs = next.selectedCardRefs.map(selected => cardKey(selected) === cardKey(ref) ? editedRef : selected);
            next.lockedDecisions = next.lockedDecisions.map(lock => cardKey(lock.card) === cardKey(ref) ? { ...lock, card: editedRef } : lock);
            if (action.type === "borrow") next.compositionSources.push({ targetCard: editedRef, fieldPath: action.field, sourceCard: action.sourceCard, base: card.proposedFields[action.field] ?? "", current: card.proposedFields[action.field] ?? "", candidate: edited.proposedFields[action.field] ?? "" });
            break;
          }
          default: throw new DomainError(400, "INVALID_INPUT", "未知选择操作");
        }
      }
      return this.writeSelection(current, next, expectedVersion);
    })();
  }

  createChangeSet(input: ChangeSetInput): ChangeSet {
    const branch = this.projectBranch(input.projectId, input.branchId);
    requiredString(input.acceptanceId, "acceptanceId", 200);
    requiredString(input.baseRevisionId, "baseRevisionId");
    this.assertRevisionOnBranch(input.projectId, branch.branchId, input.baseRevisionId);
    for (const changes of [input.sceneChanges, input.factChanges, input.graphChanges]) {
      if (changes !== undefined && !Array.isArray(changes)) throw new DomainError(400, "INVALID_INPUT", "变更内容必须是数组");
    }
    for (const change of input.sceneChanges ?? []) {
      if (!change || typeof change !== "object" || typeof change.sceneId !== "string" || typeof change.body !== "string" || typeof change.baseTextHash !== "string" || !/^[a-f0-9]{64}$/.test(change.baseTextHash)) throw new DomainError(400, "INVALID_INPUT", "正文变更缺少场景、正文或基础哈希");
    }
    for (const change of input.graphChanges ?? []) {
      if (!change || typeof change !== "object" || typeof change.sceneId !== "string" || !change.patch || typeof change.patch !== "object" || Array.isArray(change.patch)) throw new DomainError(400, "INVALID_INPUT", "剧情变更格式无效");
    }
    for (const scene of input.sceneAdditions ?? []) {
      if (!scene || typeof scene !== "object" || scene.projectId !== input.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "新增场景不属于此作品");
      requiredString(scene.sceneId, "sceneId", 200); requiredString(scene.chapterId, "chapterId", 200); requiredString(scene.routeId, "routeId", 200);
      this.patchScene(scene, { title: scene.title, summary: scene.summary, body: scene.body, status: scene.status, narrationOrder: scene.narrationOrder, entityIds: scene.entityIds, ...(scene.goal !== undefined ? { goal: scene.goal } : {}), ...(scene.conflict !== undefined ? { conflict: scene.conflict } : {}), ...(scene.pov !== undefined ? { pov: scene.pov } : {}), ...(scene.storyTime !== undefined ? { storyTime: scene.storyTime } : {}) });
    }
    for (const fact of input.factChanges ?? []) {
      if (!fact || typeof fact !== "object" || typeof fact.factId !== "string" || typeof fact.subjectId !== "string" || typeof fact.predicate !== "string" || !Array.isArray(fact.evidenceIds)) throw new DomainError(400, "INVALID_FACT", "事实字段不完整");
    }
    if (input.draftId !== undefined) {
      const draft = this.getSelection(input.draftId);
      if (draft.projectId !== input.projectId || draft.branchId !== branch.branchId) throw new DomainError(400, "SCOPE_MISMATCH", "草稿不属于此作品分支");
      versionNumber(input.selectionVersion);
    }
    if (input.sourceTaskId) {
      const record = this.taskRecord(input.sourceTaskId);
      if (record.task.projectId !== input.projectId || record.branchId !== branch.branchId || record.freeze.baseRevisionId !== input.baseRevisionId) throw new DomainError(400, "SCOPE_MISMATCH", "产物不属于此作品基础修订");
      if (record.task.state !== "succeeded") throw new DomainError(409, "TASK_NOT_COMPLETE", "任务尚无完整成功产物", branch.headRevisionId);
      if (record.freeze.draftId && (input.draftId !== record.freeze.draftId || input.selectionVersion !== record.freeze.selectionVersion)) throw new DomainError(409, "VERSION_CONFLICT", "必须使用产物冻结的选择版本", branch.headRevisionId, record.freeze.draftId ? this.getSelection(record.freeze.draftId).selectionVersion : undefined);
    }
    const payload = { projectId: input.projectId, branchId: branch.branchId, baseRevisionId: input.baseRevisionId, acceptanceId: input.acceptanceId, sceneChanges: input.sceneChanges ?? [], factChanges: input.factChanges ?? [], graphChanges: input.graphChanges ?? [], sceneAdditions: input.sceneAdditions ?? [], ...(input.restoreRevisionId ? { restoreRevisionId: input.restoreRevisionId } : {}), ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}), ...(input.draftId ? { draftId: input.draftId, selectionVersion: versionNumber(input.selectionVersion) } : {}) };
    const payloadHash = stableHash(payload);
    const existing = this.json<StoredChangeSet>("SELECT json FROM changesets WHERE acceptance_id=?", input.acceptanceId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "acceptanceId 已绑定其他采用内容", branch.headRevisionId, input.draftId ? this.getSelection(input.draftId).selectionVersion : undefined);
      return existing;
    }
    const changeset: StoredChangeSet = { changeSetId: newId("changeset"), ...payload, status: "pending", payloadHash };
    this.db.prepare("INSERT INTO changesets(changeset_id,project_id,branch_id,base_revision_id,acceptance_id,payload_hash,json) VALUES(?,?,?,?,?,?,?)")
      .run(changeset.changeSetId, input.projectId, branch.branchId, input.baseRevisionId, input.acceptanceId, payloadHash, JSON.stringify(changeset));
    return changeset;
  }
  getChangeSet(changeSetId: string): StoredChangeSet {
    const changeset = this.json<StoredChangeSet>("SELECT json FROM changesets WHERE changeset_id=?", changeSetId);
    if (!changeset) throw new DomainError(404, "NOT_FOUND", "变更集不存在");
    return changeset;
  }
  private patchScene(scene: Scene, patch: Partial<Scene>): Scene {
    const allowed = ["title", "summary", "body", "status", "pov", "goal", "conflict", "storyTime", "narrationOrder", "entityIds"];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) throw new DomainError(400, "INVALID_INPUT", `不能修改场景字段 ${key}`);
      if (key === "narrationOrder") { if (typeof value !== "number" || !Number.isFinite(value)) throw new DomainError(400, "INVALID_INPUT", "场景顺序无效"); }
      else if (key === "entityIds") { if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw new DomainError(400, "INVALID_INPUT", "元素列表无效"); }
      else if (typeof value !== "string" || value.length > 1_000_000) throw new DomainError(400, "INVALID_INPUT", "场景字段必须是文字");
      if (key === "status" && !["draft", "planned", "writing", "review", "final"].includes(String(value))) throw new DomainError(400, "INVALID_INPUT", "场景状态无效");
    }
    return { ...scene, ...patch, updatedAt: now() };
  }
  commitChangeSet(changeSetId: string, name = "采用修改", kind: Revision["kind"] = "changeset"): Revision {
    const identity = this.getChangeSet(changeSetId);
    try { return this.commitChangeSetTransaction(changeSetId, name, kind); }
    catch (error) {
      if (error instanceof DomainError && error.status === 409) {
        throw new DomainError(error.status, error.code, error.message, this.getBranch(identity.branchId).headRevisionId, identity.draftId ? this.getSelection(identity.draftId).selectionVersion : undefined);
      }
      throw error;
    }
  }
  private commitChangeSetTransaction(changeSetId: string, name: string, kind: Revision["kind"]): Revision {
    return this.db.transaction(() => {
      const changeset = this.getChangeSet(changeSetId);
      if (changeset.committedRevisionId) return this.getRevision(changeset.committedRevisionId);
      const branch = this.projectBranch(changeset.projectId, changeset.branchId);
      if (branch.headRevisionId !== changeset.baseRevisionId) this.conflict(branch.branchId, changeset.draftId);
      const manifest = this.getManifest(changeset.baseRevisionId);
      for (const scene of changeset.sceneAdditions ?? []) {
        if (manifest.scenes.some(item => item.sceneId === scene.sceneId) || manifest.storyGraph.nodes.some(node => node.id === scene.sceneId)) throw new DomainError(400, "SCOPE_MISMATCH", "新增场景或节点已存在");
        if (!manifest.chapters.some(chapter => chapter.chapterId === scene.chapterId) || !this.listRoutes(changeset.projectId).some(route => route.routeId === scene.routeId)) throw new DomainError(400, "SCOPE_MISMATCH", "新增场景的卷章或路线不属于此作品");
        manifest.scenes.push(scene);
        manifest.storyGraph.nodes.push({ id: scene.sceneId, kind: "scene", sceneId: scene.sceneId, title: scene.title, summary: scene.summary, position: { x: 80 + (manifest.scenes.length - 1) * 220, y: 120 } });
      }
      for (const change of changeset.sceneChanges) {
        const index = manifest.scenes.findIndex(scene => scene.sceneId === change.sceneId);
        const scene = manifest.scenes[index];
        if (!scene) throw new DomainError(400, "SCOPE_MISMATCH", "修改的场景不在此修订");
        if (sha256(scene.body) !== change.baseTextHash) this.conflict(branch.branchId, changeset.draftId);
        manifest.scenes[index] = this.patchScene(scene, { body: change.body });
      }
      for (const change of changeset.graphChanges) {
        const index = manifest.scenes.findIndex(scene => scene.sceneId === change.sceneId);
        const scene = manifest.scenes[index];
        if (!scene) throw new DomainError(400, "SCOPE_MISMATCH", "计划的场景不在此修订");
        manifest.scenes[index] = this.patchScene(scene, change.patch);
      }
      for (const fact of changeset.factChanges) {
        if (fact.projectId !== changeset.projectId || fact.sourceKind === "candidate" || fact.reviewState !== "confirmed" || !this.listRoutes(changeset.projectId).some(route => route.routeId === fact.routeId)) throw new DomainError(400, "INVALID_FACT", "事实须属于此作品路线并已明确确认");
        manifest.facts = [...manifest.facts.filter(item => item.factId !== fact.factId), fact];
      }
      for (const node of manifest.storyGraph.nodes) {
        const scene = manifest.scenes.find(item => item.sceneId === node.sceneId);
        if (scene) { node.title = scene.title; node.summary = scene.summary; }
      }
      const revision: Revision = { revisionId: newId("revision"), projectId: changeset.projectId, branchId: branch.branchId, parentRevisionIds: [changeset.baseRevisionId], name: requiredString(name, "name", 200), kind, createdAt: now(), wordCount: manifest.scenes.reduce((sum, scene) => sum + countWords(scene.body), 0) };
      this.writeRevision(revision, manifest);
      const update = this.db.prepare("UPDATE branches SET head_revision_id=? WHERE branch_id=? AND project_id=? AND head_revision_id=?")
        .run(revision.revisionId, branch.branchId, changeset.projectId, changeset.baseRevisionId);
      if (update.changes !== 1) this.conflict(branch.branchId, changeset.draftId);
      if (changeset.draftId) {
        const current = this.storedSelection(changeset.draftId);
        if (current.projectId !== changeset.projectId || current.branchId !== branch.branchId || current.selectionVersion !== changeset.selectionVersion) this.conflict(branch.branchId, changeset.draftId);
        this.writeSelection(current, { ...current, baseRevisionId: revision.revisionId, undoTargetArtifactId: current.selectionArtifactId, undoDepth: current.undoDepth + 1 }, changeset.selectionVersion!);
      }
      changeset.status = "committed";
      changeset.committedRevisionId = revision.revisionId;
      this.db.prepare("UPDATE changesets SET json=? WHERE changeset_id=?").run(JSON.stringify(changeset), changeset.changeSetId);
      const project = this.getProject(changeset.projectId);
      project.updatedAt = now();
      this.db.prepare("UPDATE projects SET json=? WHERE project_id=?").run(JSON.stringify(project), project.projectId);
      this.emit("revision.committed", revision);
      return revision;
    })();
  }
  saveScene(sceneId: string, input: { baseRevisionId: string; branchId?: string; body?: string; patch?: Partial<Scene>; acceptanceId?: string }): { scene: Scene; revision: Revision } {
    requiredString(input.baseRevisionId, "baseRevisionId");
    const scene = this.getScene(sceneId, input.baseRevisionId);
    const patch = { ...(input.patch ?? {}), ...(input.body !== undefined ? { body: input.body } : {}) };
    this.patchScene(scene, patch);
    const changeset = this.createChangeSet({ projectId: scene.projectId, ...(input.branchId ? { branchId: input.branchId } : {}), baseRevisionId: input.baseRevisionId, acceptanceId: input.acceptanceId ?? newId("acceptance"), graphChanges: [{ sceneId, patch }] });
    const revision = this.commitChangeSet(changeset.changeSetId, "自动保存", "autosave");
    return { scene: this.getScene(sceneId, revision.revisionId), revision };
  }
  addScenes(input: { projectId: string; branchId?: string; baseRevisionId: string; acceptanceId: string; scenes: Array<{ title: string; goal?: string; conflict?: string; summary?: string }> }): { revision: Revision; scenes: Scene[] } {
    if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 20) throw new DomainError(400, "INVALID_INPUT", "一次应采用 1–20 个场景");
    const branch = this.projectBranch(input.projectId, input.branchId);
    const project = this.getProject(input.projectId);
    const manifest = this.getManifest(input.baseRevisionId);
    const chapter = manifest.chapters[0];
    if (!chapter) throw new DomainError(400, "INVALID_INPUT", "当前作品没有可用章节");
    const firstOrder = Math.max(0, ...manifest.scenes.map(scene => scene.narrationOrder)) + 1;
    const scenes = input.scenes.map((item, index): Scene => ({
      sceneId: `scene_${sha256(`${input.acceptanceId}:${input.projectId}:${index}`).slice(0, 24)}`, projectId: input.projectId, chapterId: chapter.chapterId,
      title: requiredString(item.title, "场景标题", 200), summary: item.summary ?? "", body: "", status: "planned",
      narrationOrder: firstOrder + index, routeId: project.activeRouteId, entityIds: [], baseRevisionId: "", updatedAt: this.getRevision(input.baseRevisionId).createdAt,
      ...(item.goal !== undefined ? { goal: item.goal } : {}), ...(item.conflict !== undefined ? { conflict: item.conflict } : {}),
    }));
    const changeset = this.createChangeSet({ projectId: input.projectId, branchId: branch.branchId, baseRevisionId: input.baseRevisionId, acceptanceId: input.acceptanceId, sceneAdditions: scenes });
    const revision = this.commitChangeSet(changeset.changeSetId, "采用交互大纲");
    const ids = new Set(scenes.map(scene => scene.sceneId));
    return { revision, scenes: this.listScenes(input.projectId, revision.revisionId).filter(scene => ids.has(scene.sceneId)) };
  }
  nameRevision(projectId: string, input: { name: string; baseRevisionId: string; branchId?: string; acceptanceId?: string }): Revision {
    const changeset = this.createChangeSet({ projectId, baseRevisionId: input.baseRevisionId, ...(input.branchId ? { branchId: input.branchId } : {}), acceptanceId: input.acceptanceId ?? newId("acceptance") });
    return this.commitChangeSet(changeset.changeSetId, input.name, "named");
  }
  createBranch(projectId: string, input: { name: string; revisionId?: string; baseRevisionId?: string; activate?: boolean }): Branch {
    const project = this.getProject(projectId);
    const revisionId = this.resolveRevision(projectId, input.revisionId ?? input.baseRevisionId);
    return this.db.transaction(() => {
      const branch: Branch = { branchId: newId("branch"), projectId, name: requiredString(input.name, "name", 200), headRevisionId: revisionId, parentRevisionId: revisionId };
      this.db.prepare("INSERT INTO branches(branch_id,project_id,head_revision_id,json) VALUES(?,?,?,?)").run(branch.branchId, projectId, revisionId, JSON.stringify(branch));
      this.createDraft(projectId, branch.branchId);
      if (input.activate) { project.activeBranchId = branch.branchId; this.db.prepare("UPDATE projects SET json=? WHERE project_id=?").run(JSON.stringify(project), projectId); }
      this.emit("branch.created", branch);
      return branch;
    })();
  }
  restore(projectId: string, input: { revisionId: string; baseRevisionId: string; branchId?: string; name?: string; acceptanceId?: string }): Revision {
    this.resolveRevision(projectId, input.revisionId);
    const source = this.getManifest(input.revisionId);
    const changeset = this.createChangeSet({ projectId, ...(input.branchId ? { branchId: input.branchId } : {}), baseRevisionId: input.baseRevisionId, restoreRevisionId: input.revisionId, acceptanceId: input.acceptanceId ?? newId("acceptance"), graphChanges: source.scenes.map(scene => ({ sceneId: scene.sceneId, patch: { title: scene.title, summary: scene.summary, body: scene.body, status: scene.status, narrationOrder: scene.narrationOrder, entityIds: scene.entityIds, ...(scene.pov !== undefined ? { pov: scene.pov } : {}), ...(scene.goal !== undefined ? { goal: scene.goal } : {}), ...(scene.conflict !== undefined ? { conflict: scene.conflict } : {}), ...(scene.storyTime !== undefined ? { storyTime: scene.storyTime } : {}) } })), factChanges: source.facts });
    // Restore the complete immutable manifest, not merely the current scene fields.
    return this.db.transaction(() => {
      const stored = this.getChangeSet(changeset.changeSetId);
      if (stored.committedRevisionId) return this.getRevision(stored.committedRevisionId);
      const branch = this.projectBranch(projectId, input.branchId);
      if (branch.headRevisionId !== input.baseRevisionId) this.conflict(branch.branchId);
      const revision: Revision = { revisionId: newId("revision"), projectId, branchId: branch.branchId, parentRevisionIds: [input.baseRevisionId], kind: "restored", name: input.name ?? `恢复：${this.getRevision(input.revisionId).name}`, createdAt: now(), wordCount: source.scenes.reduce((sum, scene) => sum + countWords(scene.body), 0) };
      this.writeRevision(revision, source);
      if (this.db.prepare("UPDATE branches SET head_revision_id=? WHERE branch_id=? AND project_id=? AND head_revision_id=?").run(revision.revisionId, branch.branchId, projectId, input.baseRevisionId).changes !== 1) this.conflict(branch.branchId);
      stored.status = "committed"; stored.committedRevisionId = revision.revisionId;
      this.db.prepare("UPDATE changesets SET json=? WHERE changeset_id=?").run(JSON.stringify(stored), stored.changeSetId);
      this.emit("revision.restored", { revision, restoredFromRevisionId: input.revisionId });
      return revision;
    })();
  }
  adopt(draftId: string, input: { selectionVersion: number; baseRevisionId: string; acceptanceId: string; sceneId?: string }): { revision: Revision; selection: AuthoringSelection } {
    const selection = this.getSelection(draftId);
    const existing = this.json<StoredChangeSet>("SELECT json FROM changesets WHERE acceptance_id=?", input.acceptanceId);
    if (existing?.committedRevisionId) {
      if (existing.draftId !== draftId || existing.selectionVersion !== input.selectionVersion || existing.baseRevisionId !== input.baseRevisionId || (input.sceneId && existing.graphChanges[0]?.sceneId !== input.sceneId)) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "acceptanceId 已用于其他选择", this.getBranch(selection.branchId).headRevisionId, selection.selectionVersion);
      return { revision: this.getRevision(existing.committedRevisionId), selection };
    }
    if (selection.selectionVersion !== input.selectionVersion) this.conflict(selection.branchId, draftId);
    const cards = selection.selectedCardRefs.map(ref => this.findCard(selection, ref));
    if (!cards.length) throw new DomainError(400, "EMPTY_SELECTION", "请先选择一张卡片");
    const scene = input.sceneId ? this.getScene(input.sceneId, input.baseRevisionId) : this.listScenes(selection.projectId, input.baseRevisionId)[0];
    if (!scene || scene.projectId !== selection.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "场景不属于此作品");
    const changeset = this.createChangeSet({ projectId: selection.projectId, branchId: selection.branchId, baseRevisionId: input.baseRevisionId, acceptanceId: input.acceptanceId, draftId, selectionVersion: input.selectionVersion, graphChanges: [{ sceneId: scene.sceneId, patch: { summary: [...cards.map(card => [card.proposedFields.action, card.proposedFields.outcome].filter(Boolean).join("；")), ...selection.lockedDecisions.map(lock => `保留：${lock.text}`)].join("\n"), goal: cards.map(card => card.proposedFields.motivation ?? card.proposedFields.focus).join("；"), conflict: cards.map(card => card.proposedFields.obstacle ?? "").filter(Boolean).join("；"), status: "planned" } }] });
    const revision = this.commitChangeSet(changeset.changeSetId, "采用场景计划");
    return { revision, selection: this.getSelection(draftId) };
  }

  private selectionHash(selection: AuthoringSelection): string {
    return stableHash({ selectedCardRefs: selection.selectedCardRefs, lockedDecisions: selection.lockedDecisions, protectedSpans: selection.protectedSpans, compositionSources: selection.compositionSources });
  }
  private taskRecord(taskId: string): TaskRecord {
    const record = this.json<TaskRecord>("SELECT json FROM tasks WHERE task_id=?", taskId);
    if (!record) throw new DomainError(404, "NOT_FOUND", "任务不存在");
    return record;
  }
  getTask(taskId: string): AgentTask { return this.taskRecord(taskId).task; }
  listTasks(projectId: string): AgentTask[] { return this.jsonList<TaskRecord>("SELECT json FROM tasks WHERE project_id=? ORDER BY rowid DESC", projectId).map(record => record.task); }
  findGeneration(idempotencyKey: string, request: GenerationRequest): GenerationReceipt | undefined {
    const record = this.json<TaskRecord>("SELECT json FROM tasks WHERE idempotency_key=?", idempotencyKey);
    if (!record) return undefined;
    if (record.requestHash !== stableHash(request)) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "idempotencyKey 已绑定其他生成请求", this.getBranch(record.branchId).headRevisionId, record.freeze.draftId ? this.getSelection(record.freeze.draftId).selectionVersion : undefined);
    return this.getGeneration(record.task.taskId);
  }
  beginGeneration(request: GenerationRequest, context: ContextBundle): GenerationReceipt {
    requiredString(request.idempotencyKey, "idempotencyKey", 200);
    if (!["ideas", "scene", "rehearsal", "consistency", "polish", "guide"].includes(request.kind) || typeof request.input !== "string" || request.input.length > 100_000) throw new DomainError(400, "INVALID_INPUT", "生成请求无效");
    const previous = this.findGeneration(request.idempotencyKey, request);
    if (previous) return previous;
    return this.db.transaction(() => {
      const branch = this.projectBranch(request.projectId);
      const manifest = this.getManifest(branch.headRevisionId);
      if (request.sceneId && !manifest.scenes.some(scene => scene.sceneId === request.sceneId)) throw new DomainError(400, "SCOPE_MISMATCH", "场景不属于当前分支");
      const selection = request.draftId ? this.getSelection(request.draftId) : undefined;
      if (selection && (selection.projectId !== request.projectId || selection.branchId !== branch.branchId)) throw new DomainError(400, "SCOPE_MISMATCH", "选择草稿不属于当前分支");
      const task: AgentTask = { taskId: newId("task"), projectId: request.projectId, idempotencyKey: request.idempotencyKey, generationRequestId: newId("generation"), attemptId: newId("attempt"), state: "running", kind: request.kind, label: { ideas: "构思点子", scene: "场景写作", rehearsal: "片段试演", consistency: "一致性检查", polish: "推敲文字", guide: "交互大纲" }[request.kind], completeness: "partial", createdAt: now(), updatedAt: now(), ...(request.reuseOfArtifactId ? { reuseOfArtifactId: request.reuseOfArtifactId } : {}) };
      const contextSnapshotId = newId("context");
      task.contextSnapshotId = contextSnapshotId;
      const freeze: GenerationReceipt["freeze"] = { baseRevisionId: branch.headRevisionId, basePlanHash: planHash(manifest), intentHash: stableHash({ input: request.input, kind: request.kind, range: request.range, writingIntent: manifest.writingIntent, locks: selection?.lockedDecisions, protectedSpans: selection?.protectedSpans }), contextSnapshotId, ...(selection ? { draftId: selection.draftId, selectionVersion: selection.selectionVersion, selectionHash: this.selectionHash(selection) } : {}) };
      const frozenContext = { ...context, snapshotId: contextSnapshotId };
      const scene = request.sceneId ? manifest.scenes.find(item => item.sceneId === request.sceneId) : undefined;
      const record: TaskRecord = { task, request, requestHash: stableHash(request), branchId: branch.branchId, freeze, context: frozenContext, novel: { project: this.getProject(request.projectId), branchId: branch.branchId, routeId: scene?.routeId ?? this.getProject(request.projectId).activeRouteId, writingIntent: manifest.writingIntent, ...(scene ? { scene } : {}), ...(selection ? { selection } : {}) } };
      this.db.prepare("INSERT INTO tasks(task_id,project_id,idempotency_key,json) VALUES(?,?,?,?)").run(task.taskId, request.projectId, task.idempotencyKey, JSON.stringify(record));
      this.db.prepare("INSERT INTO context_snapshots(snapshot_id,task_id,revision_id,blob_id) VALUES(?,?,?,?)").run(contextSnapshotId, task.taskId, branch.headRevisionId, this.blob({ freeze, request, context: frozenContext }));
      this.emit("task.started", task);
      return this.getGeneration(task.taskId);
    })();
  }
  getGeneration(taskId: string): GenerationReceipt {
    const record = this.taskRecord(taskId);
    const branch = this.getBranch(record.branchId);
    const selection = record.freeze.draftId ? this.getSelection(record.freeze.draftId) : undefined;
    const fresh = branch.headRevisionId === record.freeze.baseRevisionId && planHash(this.getManifest(branch.headRevisionId)) === record.freeze.basePlanHash && (!selection || (selection.selectionVersion === record.freeze.selectionVersion && this.selectionHash(selection) === record.freeze.selectionHash));
    return { task: record.task, freeze: record.freeze, freshness: fresh ? "current" : "stale" };
  }
  generationContext(taskId: string) {
    const { request, context, freeze, novel } = this.taskRecord(taskId);
    return { request, context, freeze, novel };
  }
  taskByKey(key: string): AgentTask | undefined { return this.json<TaskRecord>("SELECT json FROM tasks WHERE idempotency_key=?", key)?.task; }
  preserveFailedOutput(taskId: string, result: unknown, message: string): void {
    const record = this.taskRecord(taskId);
    const artifact = this.putArtifact("agent_raw_output", result, taskId, "partial");
    record.task.result = { ...(result && typeof result === "object" ? result : { text: String(result) }), artifactId: artifact.artifactId };
    record.task.completeness = "partial";
    this.db.prepare("UPDATE tasks SET json=? WHERE task_id=?").run(JSON.stringify(record), taskId);
    this.failGeneration(taskId, message);
  }
  finishGeneration(taskId: string, result: unknown, completeness: "complete" | "partial" = "complete"): GenerationReceipt {
    return this.db.transaction(() => {
      const record = this.taskRecord(taskId);
      const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(record.task.state);
      if (terminal && record.task.result !== undefined) return this.getGeneration(taskId);
      const artifact = this.putArtifact("generation_result", result, taskId, completeness);
      record.task.result = result && typeof result === "object" && !Array.isArray(result)
        ? { ...result, artifactId: artifact.artifactId }
        : { text: typeof result === "string" ? result : JSON.stringify(result), artifactId: artifact.artifactId };
      record.task.completeness = terminal || record.task.state === "cancelling" ? "partial" : completeness;
      if (!terminal) record.task.state = record.task.state === "cancelling" ? "cancelled" : completeness === "complete" ? "succeeded" : "interrupted";
      record.task.updatedAt = now();
      this.db.prepare("UPDATE tasks SET json=? WHERE task_id=?").run(JSON.stringify(record), taskId);
      this.emit("task.finished", record.task);
      return this.getGeneration(taskId);
    })();
  }
  failGeneration(taskId: string, message: string): GenerationReceipt {
    const record = this.taskRecord(taskId);
    if (["succeeded", "cancelled", "interrupted"].includes(record.task.state)) return this.getGeneration(taskId);
    record.task.state = record.task.state === "cancelling" ? "cancelled" : "failed";
    record.task.error = message;
    record.task.updatedAt = now();
    this.db.prepare("UPDATE tasks SET json=? WHERE task_id=?").run(JSON.stringify(record), taskId);
    this.emit("task.failed", record.task);
    return this.getGeneration(taskId);
  }
  requestCancellation(taskId: string): AgentTask {
    const record = this.taskRecord(taskId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(record.task.state)) return record.task;
    record.task.state = "cancelling"; record.task.updatedAt = now();
    this.db.prepare("UPDATE tasks SET json=? WHERE task_id=?").run(JSON.stringify(record), taskId);
    this.emit("task.cancelling", record.task);
    return record.task;
  }
  confirmCancellation(taskId: string): AgentTask {
    const record = this.taskRecord(taskId);
    if (record.task.state !== "cancelling") return record.task;
    record.task.state = "cancelled"; record.task.updatedAt = now();
    this.db.prepare("UPDATE tasks SET json=? WHERE task_id=?").run(JSON.stringify(record), taskId);
    this.emit("task.cancelled", record.task);
    return record.task;
  }
}

export { DomainError } from "./domain.js";
