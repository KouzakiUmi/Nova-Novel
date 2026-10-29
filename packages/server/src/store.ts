import type Database from "better-sqlite3";
import {
  countWords, type AgentTask, type AuthoringSelection, type Branch, type CardRef, type ChangeSet,
  type AuthorNote, type Chapter, type StructureChange, type SceneAnnotation, type CharacterArcProfile, type AuthoringEvent,
  type ContextBundle, type Evidence, type FactAssertion, type GenerationReceipt, type GenerationRequest, type IdeaCard,
  type IdeaCardFields, type Project, type ProposalBatch, type Revision, type Scene, type SelectionAction,
  type StoryRoute,
} from "@nova-novel/shared";
import { DomainError, EXAMPLE_IDEAS, cardKey, initialManifest, planHash, requiredString, versionNumber, type RevisionManifest } from "./domain.js";
import { newId, now, sha256, stableHash } from "./utils.js";
import type { ImportedScene, NovaBackup } from "./transfer.js";

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
  structureChanges?: ChangeSet["structureChanges"];
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

const INTERACTION_KINDS = new Set(["suggestion-open", "candidate-presented", "candidate-dismiss", "candidate-accept", "candidate-revise", "candidate-reject", "review-open", "review-dismiss", "review-decided", "note-promoted", "scene-structure-saved", "scene-plan-saved", "element-created", "element-updated", "element-fact-added", "element-event-added", "assist-applied"]);

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
      CREATE TABLE IF NOT EXISTS notes (note_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), status TEXT NOT NULL, scene_id TEXT, element_id TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notes_project_idx ON notes(project_id,status,updated_at);
      CREATE TABLE IF NOT EXISTS annotations (annotation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), scene_id TEXT NOT NULL REFERENCES scenes(scene_id), status TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS annotations_scene_idx ON annotations(scene_id,status,updated_at);
      CREATE TABLE IF NOT EXISTS character_arcs (entity_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), json TEXT NOT NULL, updated_at TEXT NOT NULL);
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
  recordInteraction(input: { projectId: string; kind: string; sceneId?: string; actor?: AuthoringEvent["actor"]; meta?: AuthoringEvent["meta"] }): number {
    if (!INTERACTION_KINDS.has(input.kind)) throw new DomainError(400, "INVALID_INPUT", "交互事件类型无效");
    this.getProject(input.projectId);
    if (input.sceneId) this.getScene(input.sceneId);
    if (input.meta && (Object.keys(input.meta).length > 20 || Object.entries(input.meta).some(([key, value]) => key.length > 40 || !["string", "number", "boolean"].includes(typeof value) || String(value).length > 200))) throw new DomainError(400, "INVALID_INPUT", "交互事件元数据无效");
    this.emit(input.kind, { projectId: input.projectId, ...(input.sceneId ? { sceneId: input.sceneId } : {}), actor: input.actor ?? "author", createdAt: now(), ...(input.meta ? { meta: input.meta } : {}) });
    return this.eventCursor();
  }
  listInteractionEvents(projectId: string, cursor = 0, limit = 200): AuthoringEvent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const kinds = [...INTERACTION_KINDS];
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT seq,kind,json FROM domain_events WHERE json_extract(json,'$.projectId')=? AND seq>? AND kind IN (${placeholders}) ORDER BY seq LIMIT ?`).all(projectId, cursor, ...kinds, safeLimit) as Array<{ seq: number; kind: string; json: string }>;
    return rows.map(row => ({ seq: row.seq, kind: row.kind, ...JSON.parse(row.json) as Omit<AuthoringEvent, "seq" | "kind"> }));
  }
  listAllInteractionEvents(projectId: string): AuthoringEvent[] {
    const events: AuthoringEvent[] = [];
    let cursor = 0;
    while (true) {
      const batch = this.listInteractionEvents(projectId, cursor, 500);
      events.push(...batch);
      if (batch.length < 500) return events;
      cursor = batch.at(-1)!.seq;
    }
  }
  listProjects(includeArchived = false): Project[] { return this.jsonList<Project>("SELECT json FROM projects ORDER BY rowid").filter(project => includeArchived || !project.archivedAt); }
  getProject(projectId?: string): Project {
    const project = projectId ? this.json<Project>("SELECT json FROM projects WHERE project_id=?", projectId) : this.listProjects()[0];
    if (!project) throw new DomainError(404, "NOT_FOUND", "作品不存在");
    return project;
  }
  updateProject(projectId: string, patch: { title?: string; archived?: boolean }): Project {
    const current = this.getProject(projectId);
    const next: Project = { ...current, ...(patch.title !== undefined ? { title: requiredString(patch.title, "作品名称", 200) } : {}), updatedAt: now() };
    if (patch.archived === true) {
      if (!current.archivedAt && this.listProjects().length <= 1) throw new DomainError(409, "LAST_ACTIVE_PROJECT", "至少保留一个未归档作品；可以先复制作品再归档");
      next.archivedAt = current.archivedAt ?? now();
    } else if (patch.archived === false) delete next.archivedAt;
    this.db.prepare("UPDATE projects SET json=? WHERE project_id=?").run(JSON.stringify(next), projectId);
    this.emit(patch.archived === true ? "project.archived" : patch.archived === false ? "project.restored" : "project.renamed", { projectId, title: next.title });
    return next;
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
  listNotes(projectId: string, includeArchived = true): AuthorNote[] {
    return this.jsonList<AuthorNote>(`SELECT json FROM notes WHERE project_id=? ${includeArchived ? "" : "AND status != 'archived'"} ORDER BY updated_at DESC`, projectId);
  }
  getNote(noteId: string): AuthorNote {
    const note = this.json<AuthorNote>("SELECT json FROM notes WHERE note_id=?", noteId);
    if (!note) throw new DomainError(404, "NOT_FOUND", "便签不存在");
    return note;
  }
  createNote(input: { projectId: string; title: string; body?: string; sceneId?: string; elementId?: string; tags?: string[] }): AuthorNote {
    this.getProject(input.projectId);
    const note: AuthorNote = { noteId: newId("note"), projectId: input.projectId, title: requiredString(input.title, "便签标题", 200), body: input.body ?? "", status: "inbox", tags: (input.tags ?? []).slice(0, 20).map(tag => requiredString(tag, "标签", 40)), source: "author", createdAt: now(), updatedAt: now(), ...(input.sceneId ? { sceneId: input.sceneId } : {}), ...(input.elementId ? { elementId: input.elementId } : {}) };
    if (note.sceneId) this.getScene(note.sceneId);
    if (note.elementId) this.db.prepare("SELECT entity_id FROM kw_entities WHERE entity_id=?").get(note.elementId) ?? (() => { throw new DomainError(404, "NOT_FOUND", "元素不存在"); })();
    this.db.prepare("INSERT INTO notes(note_id,project_id,status,scene_id,element_id,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(note.noteId, note.projectId, note.status, note.sceneId ?? null, note.elementId ?? null, JSON.stringify(note), note.createdAt, note.updatedAt);
    this.emit("note.created", note);
    return note;
  }
  updateNote(noteId: string, patch: { title?: string; body?: string; status?: AuthorNote["status"]; sceneId?: string | null; elementId?: string | null; tags?: string[] }): AuthorNote {
    const current = this.getNote(noteId);
    const next: AuthorNote = { ...current, ...patch, updatedAt: now() } as AuthorNote;
    if (patch.sceneId === null) delete next.sceneId;
    if (patch.elementId === null) delete next.elementId;
    if (patch.title !== undefined) next.title = requiredString(patch.title, "便签标题", 200);
    if (patch.body !== undefined && (typeof patch.body !== "string" || patch.body.length > 100_000)) throw new DomainError(400, "INVALID_INPUT", "便签内容最多 100000 字符");
    if (patch.status !== undefined && !["inbox", "linked", "archived"].includes(patch.status)) throw new DomainError(400, "INVALID_INPUT", "便签状态无效");
    if (patch.tags !== undefined) next.tags = patch.tags.slice(0, 20).map(tag => requiredString(tag, "标签", 40));
    if (next.sceneId) this.getScene(next.sceneId);
    if (next.elementId) this.db.prepare("SELECT entity_id FROM kw_entities WHERE entity_id=?").get(next.elementId) ?? (() => { throw new DomainError(404, "NOT_FOUND", "元素不存在"); })();
    this.db.prepare("UPDATE notes SET status=?,scene_id=?,element_id=?,json=?,updated_at=? WHERE note_id=?").run(next.status, next.sceneId ?? null, next.elementId ?? null, JSON.stringify(next), next.updatedAt, noteId);
    this.emit("note.updated", next);
    return next;
  }
  promoteNote(noteId: string): { note: AuthorNote; scene: Scene; revision: Revision } {
    const current = this.getNote(noteId);
    if (current.status === "archived") throw new DomainError(409, "NOTE_ARCHIVED", "已归档便签不能转为场景");
    if (current.sceneId) return { note: current, scene: this.getScene(current.sceneId), revision: this.getRevision(this.projectBranch(current.projectId).headRevisionId) };
    return this.db.transaction(() => {
      const branch = this.projectBranch(current.projectId);
      const adopted = this.addScenes({ projectId: current.projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId, acceptanceId: `note_${noteId}`, scenes: [{ title: current.title, summary: current.body }] });
      const note = this.updateNote(noteId, { status: "linked", sceneId: adopted.scenes[0]!.sceneId });
      this.emit("note.promoted", { noteId, sceneId: note.sceneId, revisionId: adopted.revision.revisionId });
      return { note, scene: adopted.scenes[0]!, revision: adopted.revision };
    })();
  }
  listAnnotations(projectId: string, sceneId?: string): SceneAnnotation[] {
    return this.jsonList<SceneAnnotation>(`SELECT json FROM annotations WHERE project_id=? ${sceneId ? "AND scene_id=?" : ""} ORDER BY created_at DESC`, ...(sceneId ? [projectId, sceneId] : [projectId]));
  }
  getAnnotation(annotationId: string): SceneAnnotation {
    const annotation = this.json<SceneAnnotation>("SELECT json FROM annotations WHERE annotation_id=?", annotationId);
    if (!annotation) throw new DomainError(404, "NOT_FOUND", "批注不存在");
    return annotation;
  }
  createAnnotation(input: { projectId: string; sceneId: string; kind: SceneAnnotation["kind"]; body: string; range?: SceneAnnotation["range"] }): SceneAnnotation {
    this.getScene(input.sceneId);
    if (!["comment", "question", "todo"].includes(input.kind)) throw new DomainError(400, "INVALID_INPUT", "批注类型无效");
    if (input.range) {
      const { from, to, baseText, textHash } = input.range;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || baseText.length !== to - from || sha256(baseText) !== textHash) throw new DomainError(400, "INVALID_INPUT", "批注选区锚点无效");
    }
    const annotation: SceneAnnotation = { annotationId: newId("annotation"), projectId: input.projectId, sceneId: input.sceneId, kind: input.kind, body: requiredString(input.body, "批注内容", 20_000), status: "open", ...(input.range ? { range: input.range } : {}), createdAt: now(), updatedAt: now() };
    this.db.prepare("INSERT INTO annotations(annotation_id,project_id,scene_id,status,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(annotation.annotationId, annotation.projectId, annotation.sceneId, annotation.status, JSON.stringify(annotation), annotation.createdAt, annotation.updatedAt);
    this.emit("annotation.created", annotation);
    return annotation;
  }
  updateAnnotation(annotationId: string, patch: { body?: string; status?: SceneAnnotation["status"] }): SceneAnnotation {
    const current = this.getAnnotation(annotationId);
    const next: SceneAnnotation = { ...current, ...(patch.body !== undefined ? { body: requiredString(patch.body, "批注内容", 20_000) } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}), updatedAt: now(), ...(patch.status === "resolved" ? { resolvedAt: now() } : patch.status === "open" ? {} : { resolvedAt: current.resolvedAt }) };
    if (patch.status !== undefined && !["open", "resolved"].includes(patch.status)) throw new DomainError(400, "INVALID_INPUT", "批注状态无效");
    if (patch.status === "open") delete next.resolvedAt;
    this.db.prepare("UPDATE annotations SET status=?,json=?,updated_at=? WHERE annotation_id=?").run(next.status, JSON.stringify(next), next.updatedAt, annotationId);
    this.emit("annotation.updated", next);
    return next;
  }
  isAnnotationStale(annotation: SceneAnnotation): boolean {
    if (!annotation.range) return false;
    const body = this.getScene(annotation.sceneId).body;
    const { from, to, baseText, textHash } = annotation.range;
    return body.slice(from, to) !== baseText || sha256(body.slice(from, to)) !== textHash;
  }
  listCharacterArcs(projectId: string): CharacterArcProfile[] { return this.jsonList<CharacterArcProfile>("SELECT json FROM character_arcs WHERE project_id=? ORDER BY updated_at DESC", projectId); }
  getCharacterArc(entityId: string): CharacterArcProfile {
    const entity = this.db.prepare("SELECT type FROM kw_entities WHERE entity_id=?").get(entityId) as { type: string } | undefined;
    if (!entity || entity.type !== "character") throw new DomainError(404, "NOT_FOUND", "人物不存在");
    const stored = this.json<CharacterArcProfile>("SELECT json FROM character_arcs WHERE entity_id=?", entityId);
    if (stored) return stored;
    return { entityId, projectId: "", motivation: "", goal: "", conflict: "", epiphany: "", notes: "", updatedAt: "" };
  }
  saveCharacterArc(entityId: string, input: Pick<CharacterArcProfile, "motivation" | "goal" | "conflict" | "epiphany" | "notes">): CharacterArcProfile {
    const current = this.getCharacterArc(entityId);
    const projectId = (this.db.prepare("SELECT project_id FROM kw_entities WHERE entity_id=?").get(entityId) as { project_id: string }).project_id;
    for (const value of Object.values(input)) if (typeof value !== "string" || value.length > 20_000) throw new DomainError(400, "INVALID_INPUT", "人物弧线字段不能超过 20000 字符");
    const profile: CharacterArcProfile = { entityId, projectId, ...input, updatedAt: now() };
    this.db.prepare("INSERT INTO character_arcs(entity_id,project_id,json,updated_at) VALUES(?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at").run(entityId, projectId, JSON.stringify(profile), profile.updatedAt);
    this.emit("character_arc.updated", profile);
    return profile;
  }
  getScene(sceneId: string, revisionId?: string): Scene {
    const row = this.db.prepare("SELECT project_id FROM scenes WHERE scene_id=?").get(sceneId) as { project_id: string } | undefined;
    if (!row) throw new DomainError(404, "NOT_FOUND", "场景不存在");
    const scene = this.listScenes(row.project_id, revisionId).find(item => item.sceneId === sceneId);
    if (!scene) throw new DomainError(404, "NOT_FOUND", "此修订中没有该场景");
    return scene;
  }
  listChapters(projectId: string, revisionId?: string) { return this.getManifest(this.resolveRevision(projectId, revisionId)).chapters; }
  addChapter(projectId: string, title: string): { chapter: Chapter; revision: Revision } {
    const branch = this.projectBranch(projectId);
    const chapter: Chapter = { chapterId: newId("chapter"), projectId, title: requiredString(title, "章节标题", 200), order: Math.max(0, ...this.listChapters(projectId).map(item => item.order)) + 1 };
    const changeset = this.createChangeSet({ projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId, acceptanceId: `chapter_add_${chapter.chapterId}`, structureChanges: [{ kind: "chapter.add", chapter }] });
    return { chapter, revision: this.commitChangeSet(changeset.changeSetId, "新建章节") };
  }
  renameChapter(chapterId: string, title: string, baseRevisionId: string): Revision {
    const current = this.listChapters(this.getRevision(baseRevisionId).projectId, baseRevisionId).find(chapter => chapter.chapterId === chapterId);
    if (!current) throw new DomainError(404, "NOT_FOUND", "章节不存在");
    const changeset = this.createChangeSet({ projectId: current.projectId, baseRevisionId, acceptanceId: `chapter_rename_${chapterId}_${sha256(title).slice(0, 16)}`, structureChanges: [{ kind: "chapter.rename", chapterId, title: requiredString(title, "章节标题", 200) }] });
    return this.commitChangeSet(changeset.changeSetId, "重命名章节");
  }
  moveScene(sceneId: string, chapterId: string, narrationOrder: number, baseRevisionId: string): Revision {
    const scene = this.getScene(sceneId, baseRevisionId);
    if (!this.listChapters(scene.projectId, baseRevisionId).some(chapter => chapter.chapterId === chapterId)) throw new DomainError(404, "NOT_FOUND", "目标章节不存在");
    const changeset = this.createChangeSet({ projectId: scene.projectId, baseRevisionId, acceptanceId: `scene_move_${sceneId}_${chapterId}_${narrationOrder}`, structureChanges: [{ kind: "scene.move", sceneId, chapterId, narrationOrder }] });
    return this.commitChangeSet(changeset.changeSetId, "调整场景结构");
  }
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
  listKnowledgeEvidence(projectId: string): Evidence[] {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kw_evidence'").get();
    if (!table) return this.listEvidence(projectId);
    const rows = this.db.prepare("SELECT * FROM kw_evidence WHERE project_id=? ORDER BY source_revision_id, evidence_id").all(projectId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      evidenceId: String(row.evidence_id), projectId,
      sourceRevisionId: String(row.source_revision_id),
      ...(row.scene_id ? { sceneId: String(row.scene_id) } : {}),
      ...(row.block_id ? { blockId: String(row.block_id) } : {}),
      quote: String(row.quote), contentHash: String(row.content_hash), sourceKind: String(row.source_kind) as Evidence["sourceKind"], routeId: String(row.route_id),
      ...(row.narration_order !== null ? { narrationOrder: Number(row.narration_order) } : {}),
      ...(row.story_order !== null ? { storyOrder: Number(row.story_order) } : {}),
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
  /** 把已确认事实写入知识库（与备份恢复同一套值类型规则），供检索、世界状态与一致性检查使用。 */
  private syncFact(fact: FactAssertion): void {
    let valueKind: string;
    let valueText: string | null = null;
    let valueEntityId: string | null = null;
    if (typeof fact.value === "object" && fact.value !== null && "entityId" in fact.value) { valueKind = "entity"; valueEntityId = String(fact.value.entityId); }
    else if (fact.value === null) valueKind = "null";
    else if (typeof fact.value === "boolean") { valueKind = "boolean"; valueText = fact.value ? "1" : "0"; }
    else if (typeof fact.value === "number") { valueKind = "number"; valueText = String(fact.value); }
    else if (typeof fact.value === "object") { valueKind = "json"; valueText = JSON.stringify(fact.value); }
    else { valueKind = "text"; valueText = String(fact.value); }
    const validFrom = fact.validFrom !== undefined && Number.isFinite(Number(fact.validFrom)) ? Number(fact.validFrom) : null;
    const validTo = fact.validTo !== undefined && Number.isFinite(Number(fact.validTo)) ? Number(fact.validTo) : null;
    this.db.prepare(
      `INSERT INTO kw_facts(fact_id,project_id,subject_id,predicate,value_kind,value_text,value_entity_id,semantic_type,review_state,source_kind,route_id,valid_from_order,valid_to_order,holder_id,evidence_ids)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(fact_id) DO UPDATE SET
         predicate=excluded.predicate, value_kind=excluded.value_kind, value_text=excluded.value_text,
         value_entity_id=excluded.value_entity_id, semantic_type=excluded.semantic_type,
         review_state=excluded.review_state, source_kind=excluded.source_kind, route_id=excluded.route_id,
         valid_from_order=excluded.valid_from_order, valid_to_order=excluded.valid_to_order,
         holder_id=excluded.holder_id, evidence_ids=excluded.evidence_ids`,
    ).run(fact.factId, fact.projectId, fact.subjectId, fact.predicate, valueKind, valueText, valueEntityId, fact.semanticType, fact.reviewState, fact.sourceKind, fact.routeId, validFrom, validTo, fact.holderId ?? null, JSON.stringify(fact.evidenceIds ?? []));
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
  importProject(input: { title?: string; premise?: string; chapterTitle: string; scenes: ImportedScene[] }): { project: Project; revision: Revision } {
    if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 500) throw new DomainError(400, "INVALID_INPUT", "导入必须包含 1–500 个场景");
    const title = input.title === undefined ? "导入的作品" : requiredString(input.title, "title", 200);
    return this.db.transaction(() => {
      const project: Project = { projectId: newId("project"), title, premise: input.premise ?? "", createdAt: now(), updatedAt: now(), activeBranchId: newId("branch"), activeRouteId: newId("route") };
      this.db.prepare("INSERT INTO projects(project_id,json) VALUES(?,?)").run(project.projectId, JSON.stringify(project));
      const route: StoryRoute = { routeId: project.activeRouteId, projectId: project.projectId, name: "主线" };
      this.db.prepare("INSERT INTO story_routes(route_id,project_id,json) VALUES(?,?,?)").run(route.routeId, project.projectId, JSON.stringify(route));
      const chapterId = newId("chapter");
      const scenes: Scene[] = input.scenes.map((item, index) => ({ sceneId: newId("scene"), projectId: project.projectId, chapterId, title: requiredString(item.title || `第 ${index + 1} 场`, "场景标题", 200), summary: item.summary ?? "", body: item.body, status: item.body.trim() ? "writing" : "planned", narrationOrder: index + 1, routeId: route.routeId, entityIds: [], baseRevisionId: "", updatedAt: now() }));
      const manifest = { chapters: [{ chapterId, projectId: project.projectId, title: requiredString(input.chapterTitle, "章节标题", 200), order: 1 }], scenes, facts: [], writingIntent: {}, storyGraph: { projectId: project.projectId, revisionId: "", nodes: scenes.map((scene, index) => ({ id: scene.sceneId, kind: "scene" as const, sceneId: scene.sceneId, title: scene.title, summary: scene.summary, position: { x: 80 + index * 220, y: 120 } })), edges: [] } };
      const revision: Revision = { revisionId: newId("revision"), projectId: project.projectId, branchId: project.activeBranchId, parentRevisionIds: [], name: "导入作品", kind: "named", createdAt: now(), wordCount: scenes.reduce((sum, scene) => sum + countWords(scene.body), 0) };
      this.writeRevision(revision, manifest);
      const branch: Branch = { branchId: project.activeBranchId, projectId: project.projectId, name: "主稿", headRevisionId: revision.revisionId };
      this.db.prepare("INSERT INTO branches(branch_id,project_id,head_revision_id,json) VALUES(?,?,?,?)").run(branch.branchId, project.projectId, revision.revisionId, JSON.stringify(branch));
      this.createDraft(project.projectId, branch.branchId);
      this.emit("project.imported", { projectId: project.projectId, revisionId: revision.revisionId });
      return { project, revision };
    })();
  }
  duplicateProject(projectId: string): { project: Project; revision: Revision } {
    const source = this.getProject(projectId);
    const sourceBranch = this.projectBranch(projectId);
    const sourceManifest = this.getManifest(sourceBranch.headRevisionId);
    return this.db.transaction(() => {
      const project: Project = { ...source, projectId: newId("project"), title: requiredString(`${source.title.slice(0, 190)}（副本）`, "作品名称", 200), createdAt: now(), updatedAt: now(), activeBranchId: newId("branch"), activeRouteId: "" };
      delete project.archivedAt;
      this.db.prepare("INSERT INTO projects(project_id,json) VALUES(?,?)").run(project.projectId, JSON.stringify(project));
      const routeIds = new Map(this.listRoutes(projectId).map(route => [route.routeId, newId("route")]));
      if (!routeIds.has(source.activeRouteId)) routeIds.set(source.activeRouteId, newId("route"));
      for (const route of this.listRoutes(projectId)) {
        const next = { ...route, routeId: routeIds.get(route.routeId)!, projectId: project.projectId };
        this.db.prepare("INSERT INTO story_routes(route_id,project_id,json) VALUES(?,?,?)").run(next.routeId, next.projectId, JSON.stringify(next));
      }
      if (!this.listRoutes(projectId).length) {
        const route: StoryRoute = { routeId: routeIds.get(source.activeRouteId)!, projectId: project.projectId, name: "主线" };
        this.db.prepare("INSERT INTO story_routes(route_id,project_id,json) VALUES(?,?,?)").run(route.routeId, route.projectId, JSON.stringify(route));
      }
      project.activeRouteId = routeIds.get(source.activeRouteId)!;
      this.db.prepare("UPDATE projects SET json=? WHERE project_id=?").run(JSON.stringify(project), project.projectId);
      const chapterIds = new Map(sourceManifest.chapters.map(chapter => [chapter.chapterId, newId("chapter")]));
      const sceneIds = new Map(sourceManifest.scenes.map(scene => [scene.sceneId, newId("scene")]));
      const nodeIds = new Map(sourceManifest.storyGraph.nodes.map(node => [node.id, node.sceneId ? sceneIds.get(node.sceneId) ?? newId("node") : newId("node")]));
      const idMap = new Map([...chapterIds, ...sceneIds, ...routeIds, ...nodeIds]);
      const remapValue = (value: unknown): unknown => Array.isArray(value) ? value.map(remapValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapValue(item)])) : typeof value === "string" ? idMap.get(value) ?? value : value;
      const scenes = sourceManifest.scenes.map(scene => {
        const { pov: _pov, ...withoutPov } = scene;
        return { ...withoutPov, sceneId: sceneIds.get(scene.sceneId)!, projectId: project.projectId, chapterId: chapterIds.get(scene.chapterId)!, routeId: routeIds.get(scene.routeId) ?? project.activeRouteId, entityIds: [], baseRevisionId: "", updatedAt: now() };
      });
      const manifest: RevisionManifest = {
        chapters: sourceManifest.chapters.map(chapter => ({ ...chapter, chapterId: chapterIds.get(chapter.chapterId)!, projectId: project.projectId })),
        scenes,
        facts: [],
        writingIntent: remapValue(sourceManifest.writingIntent) as Record<string, unknown>,
        storyGraph: {
          projectId: project.projectId,
          revisionId: "",
          nodes: sourceManifest.storyGraph.nodes.map(node => ({ ...node, id: nodeIds.get(node.id)!, ...(node.sceneId ? { sceneId: sceneIds.get(node.sceneId)! } : {}) })),
          edges: sourceManifest.storyGraph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map(edge => ({ ...edge, id: newId("edge"), source: nodeIds.get(edge.source)!, target: nodeIds.get(edge.target)! })),
        },
      };
      const revision: Revision = { revisionId: newId("revision"), projectId: project.projectId, branchId: project.activeBranchId, parentRevisionIds: [], name: "复制当前作品", kind: "named", createdAt: now(), wordCount: scenes.reduce((sum, scene) => sum + countWords(scene.body), 0) };
      this.writeRevision(revision, manifest);
      const branch: Branch = { branchId: project.activeBranchId, projectId: project.projectId, name: "主稿", headRevisionId: revision.revisionId };
      this.db.prepare("INSERT INTO branches(branch_id,project_id,head_revision_id,json) VALUES(?,?,?,?)").run(branch.branchId, project.projectId, revision.revisionId, JSON.stringify(branch));
      this.createDraft(project.projectId, branch.branchId);
      this.emit("project.duplicated", { projectId: project.projectId, sourceProjectId: projectId, revisionId: revision.revisionId });
      return { project, revision };
    })();
  }
  restoreBackup(backup: NovaBackup): { project: Project; revision: Revision; warnings: string[] } {
    const warnings: string[] = ["恢复为当前快照的新作品；历史修订、任务运行和旧选择批次未恢复"];
    return this.db.transaction(() => {
      const source = backup.project;
      const project: Project = { ...source, projectId: newId("project"), title: requiredString(`${source.title.slice(0, 190)}（恢复）`, "作品名称", 200), createdAt: now(), updatedAt: now(), activeBranchId: newId("branch"), activeRouteId: "" };
      delete project.archivedAt;
      this.db.prepare("INSERT INTO projects(project_id,json) VALUES(?,?)").run(project.projectId, JSON.stringify(project));
      if (!backup.routes.length) throw new DomainError(400, "INVALID_BACKUP", "备份缺少故事路线");
      const routeIds = new Map(backup.routes.map(route => [route.routeId, newId("route")]));
      for (const route of backup.routes) {
        const next = { ...route, routeId: routeIds.get(route.routeId)!, projectId: project.projectId };
        this.db.prepare("INSERT INTO story_routes(route_id,project_id,json) VALUES(?,?,?)").run(next.routeId, next.projectId, JSON.stringify(next));
      }
      project.activeRouteId = routeIds.get(source.activeRouteId) ?? routeIds.values().next().value!;
      this.db.prepare("UPDATE projects SET json=? WHERE project_id=?").run(JSON.stringify(project), project.projectId);
      const chapterIds = new Map(backup.chapters.map(chapter => [chapter.chapterId, newId("chapter")]));
      const sceneIds = new Map(backup.scenes.map(scene => [scene.sceneId, newId("scene")]));
      const entityIds = new Map(backup.elements.map(entity => [entity.entityId, newId("entity")]));
      const scenes = backup.scenes.map(scene => {
        const chapterId = chapterIds.get(scene.chapterId);
        if (!chapterId) throw new DomainError(400, "INVALID_BACKUP", "场景引用了不存在的章节");
        const povEntity = scene.pov ? backup.elements.find(entity => entity.entityId === scene.pov || entity.name === scene.pov || entity.aliases.includes(scene.pov!)) : undefined;
        const pov = povEntity ? entityIds.get(povEntity.entityId) : undefined;
        if (scene.pov && !pov) throw new DomainError(400, "INVALID_BACKUP", "场景视角无法对应到备份中的人物 ID、名称或别名");
        return { ...scene, sceneId: sceneIds.get(scene.sceneId)!, projectId: project.projectId, chapterId, routeId: routeIds.get(scene.routeId) ?? project.activeRouteId, entityIds: scene.entityIds.map(id => entityIds.get(id)).filter((id): id is string => Boolean(id)), ...(pov ? { pov } : {}), baseRevisionId: "", updatedAt: now() };
      });
      const sourceGraph = backup.storyGraph;
      const nodeIds = new Map((sourceGraph?.nodes ?? []).map(node => [node.id, node.sceneId ? sceneIds.get(node.sceneId) ?? newId("node") : newId("node")]));
      const manifest: RevisionManifest = {
        chapters: backup.chapters.map(chapter => ({ ...chapter, chapterId: chapterIds.get(chapter.chapterId)!, projectId: project.projectId })),
        scenes,
        facts: [],
        writingIntent: {},
        storyGraph: sourceGraph ? {
          projectId: project.projectId,
          revisionId: "",
          nodes: sourceGraph.nodes.map(node => ({ ...node, id: nodeIds.get(node.id)!, ...(node.sceneId ? { sceneId: sceneIds.get(node.sceneId)! } : {}) })),
          edges: sourceGraph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map(edge => ({ ...edge, id: newId("edge"), source: nodeIds.get(edge.source)!, target: nodeIds.get(edge.target)! })),
        } : { projectId: project.projectId, revisionId: "", nodes: scenes.map((scene, index) => ({ id: scene.sceneId, kind: "scene" as const, sceneId: scene.sceneId, title: scene.title, summary: scene.summary, position: { x: 80 + index * 220, y: 120 } })), edges: [] },
      };
      const revision: Revision = { revisionId: newId("revision"), projectId: project.projectId, branchId: project.activeBranchId, parentRevisionIds: [], name: "从备份恢复", kind: "restored", createdAt: now(), wordCount: scenes.reduce((sum, scene) => sum + countWords(scene.body), 0) };
      this.writeRevision(revision, manifest);
      const branch: Branch = { branchId: project.activeBranchId, projectId: project.projectId, name: "主稿", headRevisionId: revision.revisionId };
      this.db.prepare("INSERT INTO branches(branch_id,project_id,head_revision_id,json) VALUES(?,?,?,?)").run(branch.branchId, project.projectId, revision.revisionId, JSON.stringify(branch));
      this.createDraft(project.projectId, branch.branchId);
      const evidenceIds = new Map<string, string>();
      const usedEvidenceIds = new Set<string>();
      const backupHeadRevisionId = backup.branches.find(branch => branch.branchId === source.activeBranchId)?.headRevisionId ?? backup.branches[0]?.headRevisionId ?? "";
      let migratedWholeEvidence = 0;
      for (const evidence of backup.evidence) {
        const sceneId = evidence.sceneId ? sceneIds.get(evidence.sceneId) : undefined;
        const scene = sceneId ? scenes.find(item => item.sceneId === sceneId) : undefined;
        const sourceRevisionId = evidence.sourceRevisionId === backupHeadRevisionId ? revision.revisionId : evidence.sourceRevisionId;
        let quote = evidence.quote;
        let blockId = evidence.blockId;
        if (scene && evidence.sourceKind === "manuscript") {
          const blocks = scene.body.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
          if (!blockId || blockId === "body") {
            const firstBlock = blocks[0];
            if (firstBlock) { quote = firstBlock; blockId = `${scene.sceneId}_b1`; migratedWholeEvidence++; }
          } else {
            const blockMatch = blockId.match(/_b(\d+)$/);
            if (blockMatch) blockId = `${scene.sceneId}_b${blockMatch[1]}`;
            else if (blocks.length) {
              const blockIndex = Math.max(0, blocks.indexOf(quote));
              blockId = `${scene.sceneId}_b${blockIndex + 1}`;
              quote = blocks[blockIndex] ?? quote;
            }
          }
        }
        const deterministicId = scene && evidence.sourceKind === "manuscript" && blockId ? `evidence_${sha256(`${project.projectId}:${sourceRevisionId}:${scene.sceneId}:${blockId}:${quote}`).slice(0, 24)}` : newId("evidence");
        const evidenceId = usedEvidenceIds.has(deterministicId) ? newId("evidence") : deterministicId;
        usedEvidenceIds.add(evidenceId);
        evidenceIds.set(evidence.evidenceId, evidenceId);
        this.db.prepare("INSERT INTO kw_evidence(evidence_id,project_id,source_revision_id,scene_id,block_id,quote,content_hash,source_kind,route_id,narration_order,story_order,entity_refs,secret_refs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(evidenceId, project.projectId, sourceRevisionId, sceneId ?? null, blockId ?? null, quote, sha256(quote), evidence.sourceKind, routeIds.get(evidence.routeId) ?? project.activeRouteId, evidence.narrationOrder ?? null, evidence.storyOrder ?? null, "[]", "[]");
      }
      if (migratedWholeEvidence) warnings.push(`${migratedWholeEvidence} 条旧版整场证据已按段落重新索引`);
      for (const entity of backup.elements) {
        const entityId = entityIds.get(entity.entityId)!;
        this.db.prepare("INSERT INTO kw_entities(entity_id,project_id,type,name,summary,route_id,source_kind,review_state,unique_flag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(entityId, project.projectId, entity.type, entity.name, entity.summary, routeIds.get(entity.routeId) ?? project.activeRouteId, entity.sourceKind, entity.reviewState, 0, entity.createdAt, entity.updatedAt);
        this.db.prepare("INSERT OR IGNORE INTO kw_aliases(project_id,entity_id,alias,kind) VALUES(?,?,?,?)").run(project.projectId, entityId, entity.name, "name");
        for (const alias of entity.aliases) this.db.prepare("INSERT OR IGNORE INTO kw_aliases(project_id,entity_id,alias,kind) VALUES(?,?,?,?)").run(project.projectId, entityId, alias, "alias");
      }
      const remapEvidence = (ids: string[]) => ids.map(id => {
        const mapped = evidenceIds.get(id);
        if (!mapped) throw new DomainError(400, "INVALID_BACKUP", "事实或事件引用了备份中不存在的证据");
        return mapped;
      });
      for (const fact of backup.facts) {
        const entityValue = typeof fact.value === "object" && fact.value !== null && "entityId" in fact.value ? entityIds.get(fact.value.entityId) : undefined;
        const valueKind = entityValue ? "entity" : fact.value === null ? "null" : typeof fact.value === "boolean" ? "boolean" : typeof fact.value === "number" ? "number" : "text";
        const valueText = entityValue ? null : fact.value === null ? null : typeof fact.value === "object" ? null : String(fact.value);
        const validFrom = fact.validFrom !== undefined && Number.isFinite(Number(fact.validFrom)) ? Number(fact.validFrom) : null;
        const validTo = fact.validTo !== undefined && Number.isFinite(Number(fact.validTo)) ? Number(fact.validTo) : null;
        this.db.prepare("INSERT INTO kw_facts(fact_id,project_id,subject_id,predicate,value_kind,value_text,value_entity_id,semantic_type,review_state,source_kind,route_id,valid_from_order,valid_to_order,holder_id,evidence_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(newId("fact"), project.projectId, entityIds.get(fact.subjectId) ?? fact.subjectId, fact.predicate, valueKind, valueText, entityValue ?? null, fact.semanticType, fact.reviewState, fact.sourceKind, routeIds.get(fact.routeId) ?? project.activeRouteId, validFrom, validTo, fact.holderId ? entityIds.get(fact.holderId) ?? null : null, JSON.stringify(remapEvidence(fact.evidenceIds)));
      }
      for (const event of backup.events) {
        this.db.prepare("INSERT INTO kw_world_events(event_id,project_id,kind,scene_id,route_id,story_time,story_order,subject_id,from_value,to_value,location,review_state,evidence_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(newId("event"), project.projectId, event.kind, event.sceneId ? sceneIds.get(event.sceneId) ?? null : null, routeIds.get(event.routeId) ?? project.activeRouteId, event.storyTime ?? null, event.storyOrder, entityIds.get(event.subjectId) ?? event.subjectId, event.fromValue ?? null, event.toValue ?? null, event.location ?? null, event.reviewState, JSON.stringify(remapEvidence(event.evidenceIds)));
      }
      for (const note of backup.notes) {
        const next = { ...note, noteId: newId("note"), projectId: project.projectId, ...(note.sceneId ? { sceneId: sceneIds.get(note.sceneId) } : {}), ...(note.elementId ? { elementId: entityIds.get(note.elementId) } : {}) };
        if (next.sceneId === undefined) delete next.sceneId;
        if (next.elementId === undefined) delete next.elementId;
        this.db.prepare("INSERT INTO notes(note_id,project_id,status,scene_id,element_id,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(next.noteId, project.projectId, next.status, next.sceneId ?? null, next.elementId ?? null, JSON.stringify(next), next.createdAt, next.updatedAt);
      }
      let skippedAnnotations = 0;
      for (const annotation of backup.annotations) {
        const sceneId = sceneIds.get(annotation.sceneId);
        if (!sceneId) { skippedAnnotations++; continue; }
        const next = { ...annotation, annotationId: newId("annotation"), projectId: project.projectId, sceneId };
        this.db.prepare("INSERT INTO annotations(annotation_id,project_id,scene_id,status,json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(next.annotationId, project.projectId, sceneId, next.status, JSON.stringify(next), next.createdAt, next.updatedAt);
      }
      if (skippedAnnotations) warnings.push(`${skippedAnnotations} 条批注因来源场景缺失而未恢复`);
      for (const arc of backup.characterArcs) {
        const entityId = entityIds.get(arc.entityId);
        if (!entityId) continue;
        const next = { ...arc, entityId, projectId: project.projectId };
        this.db.prepare("INSERT INTO character_arcs(entity_id,project_id,json,updated_at) VALUES(?,?,?,?)").run(entityId, project.projectId, JSON.stringify(next), next.updatedAt);
      }
      if (backup.workflows?.length) warnings.push("工作流定义未恢复；请在新作品中重新发布并检查场景引用");
      this.emit("project.backup_restored", { projectId: project.projectId, revisionId: revision.revisionId, sourceProjectId: source.projectId });
      return { project, revision, warnings };
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
    for (const changes of [input.sceneChanges, input.factChanges, input.graphChanges, input.structureChanges]) {
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
    for (const change of input.structureChanges ?? []) {
      if (!change || typeof change !== "object" || !["chapter.add", "chapter.rename", "scene.move"].includes(change.kind)) throw new DomainError(400, "INVALID_INPUT", "结构变更格式无效");
      if (change.kind === "chapter.add" && (!change.chapter || typeof change.chapter.chapterId !== "string" || typeof change.chapter.title !== "string")) throw new DomainError(400, "INVALID_INPUT", "新增章节字段不完整");
      if (change.kind === "chapter.rename" && (typeof change.chapterId !== "string" || typeof change.title !== "string")) throw new DomainError(400, "INVALID_INPUT", "章节重命名字段不完整");
      if (change.kind === "scene.move" && (typeof change.sceneId !== "string" || typeof change.chapterId !== "string" || !Number.isSafeInteger(change.narrationOrder) || change.narrationOrder < 1)) throw new DomainError(400, "INVALID_INPUT", "场景移动字段不完整");
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
    const payload = { projectId: input.projectId, branchId: branch.branchId, baseRevisionId: input.baseRevisionId, acceptanceId: input.acceptanceId, sceneChanges: input.sceneChanges ?? [], factChanges: input.factChanges ?? [], graphChanges: input.graphChanges ?? [], sceneAdditions: input.sceneAdditions ?? [], structureChanges: input.structureChanges ?? [], ...(input.restoreRevisionId ? { restoreRevisionId: input.restoreRevisionId } : {}), ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}), ...(input.draftId ? { draftId: input.draftId, selectionVersion: versionNumber(input.selectionVersion) } : {}) };
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
      for (const change of changeset.structureChanges ?? []) {
        if (change.kind === "chapter.add") {
          if (manifest.chapters.some(chapter => chapter.chapterId === change.chapter.chapterId) || manifest.chapters.some(chapter => chapter.title === change.chapter.title)) throw new DomainError(400, "SCOPE_MISMATCH", "章节已存在");
          manifest.chapters.push({ ...change.chapter, projectId: changeset.projectId, title: requiredString(change.chapter.title, "章节标题", 200) });
        } else if (change.kind === "chapter.rename") {
          const chapter = manifest.chapters.find(item => item.chapterId === change.chapterId);
          if (!chapter) throw new DomainError(400, "SCOPE_MISMATCH", "章节不在此修订");
          chapter.title = requiredString(change.title, "章节标题", 200);
        } else {
          const scene = manifest.scenes.find(item => item.sceneId === change.sceneId);
          if (!scene || !manifest.chapters.some(chapter => chapter.chapterId === change.chapterId)) throw new DomainError(400, "SCOPE_MISMATCH", "移动的场景或章节不在此修订");
          scene.chapterId = change.chapterId;
          const targetScenes = manifest.scenes.filter(item => item.chapterId === change.chapterId && item.sceneId !== scene.sceneId).sort((a, b) => a.narrationOrder - b.narrationOrder);
          targetScenes.splice(Math.max(0, Math.min(change.narrationOrder - 1, targetScenes.length)), 0, scene);
          targetScenes.forEach((item, index) => { item.narrationOrder = index + 1; });
        }
      }
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
        // 已确认事实必须同步进知识库，否则检索、世界状态与一致性检查都看不到它。
        this.syncFact(fact);
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
  createScene(projectId: string, chapterId: string | undefined, title: string): { revision: Revision; scene: Scene } {
    const branch = this.projectBranch(projectId);
    const adopted = this.addScenes({ projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId, acceptanceId: `scene_create_${newId("acceptance")}`, ...(chapterId ? { chapterId } : {}), scenes: [{ title: requiredString(title, "场景标题", 200) }] });
    return { revision: adopted.revision, scene: adopted.scenes[0]! };
  }
  addScenes(input: { projectId: string; branchId?: string; baseRevisionId: string; acceptanceId: string; chapterId?: string; afterSceneId?: string; commitName?: string; scenes: Array<{ title: string; goal?: string; conflict?: string; summary?: string; pov?: string; storyTime?: string }> }): { revision: Revision; scenes: Scene[] } {
    if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 20) throw new DomainError(400, "INVALID_INPUT", "一次应采用 1–20 个场景");
    const branch = this.projectBranch(input.projectId, input.branchId);
    const project = this.getProject(input.projectId);
    const manifest = this.getManifest(input.baseRevisionId);
    const afterScene = input.afterSceneId ? manifest.scenes.find(item => item.sceneId === input.afterSceneId) : undefined;
    if (input.afterSceneId && !afterScene) throw new DomainError(404, "NOT_FOUND", "前置参考场景不在此修订");
    const chapter = input.chapterId ? manifest.chapters.find(item => item.chapterId === input.chapterId) : afterScene ? manifest.chapters.find(item => item.chapterId === afterScene.chapterId) : manifest.chapters[0];
    if (!chapter) throw new DomainError(400, "INVALID_INPUT", "当前作品没有可用章节");
    const firstOrder = Math.max(0, ...manifest.scenes.map(scene => scene.narrationOrder)) + 1;
    const scenes = input.scenes.map((item, index): Scene => ({
      sceneId: `scene_${sha256(`${input.acceptanceId}:${input.projectId}:${index}`).slice(0, 24)}`, projectId: input.projectId, chapterId: chapter.chapterId,
      title: requiredString(item.title, "场景标题", 200), summary: item.summary ?? "", body: "", status: "planned",
      narrationOrder: firstOrder + index, routeId: project.activeRouteId, entityIds: [], baseRevisionId: "", updatedAt: this.getRevision(input.baseRevisionId).createdAt,
      ...(item.goal !== undefined ? { goal: item.goal } : {}), ...(item.conflict !== undefined ? { conflict: item.conflict } : {}),
      ...(item.pov !== undefined && item.pov.trim() ? { pov: item.pov.trim() } : {}), ...(item.storyTime !== undefined && item.storyTime.trim() ? { storyTime: item.storyTime.trim() } : {}),
    }));
    const changeset = this.createChangeSet({ projectId: input.projectId, branchId: branch.branchId, baseRevisionId: input.baseRevisionId, acceptanceId: input.acceptanceId, sceneAdditions: scenes });
    const revision = this.commitChangeSet(changeset.changeSetId, input.commitName ?? "采用交互大纲");
    if (afterScene) {
      const currentScenes = this.listScenes(input.projectId, revision.revisionId);
      const chapterScenes = currentScenes.filter(scene => scene.chapterId === chapter.chapterId && !scenes.some(added => added.sceneId === scene.sceneId)).sort((a, b) => a.narrationOrder - b.narrationOrder);
      const anchorIndex = chapterScenes.findIndex(scene => scene.sceneId === afterScene.sceneId);
      if (anchorIndex >= 0) {
        let rev = revision;
        for (let i = 0; i < scenes.length; i++) {
          rev = this.moveScene(scenes[i]!.sceneId, chapter.chapterId, anchorIndex + 2 + i, rev.revisionId);
        }
        const ids = new Set(scenes.map(scene => scene.sceneId));
        return { revision: rev, scenes: this.listScenes(input.projectId, rev.revisionId).filter(scene => ids.has(scene.sceneId)) };
      }
    }
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
      if (record.task.completeness !== "complete" && result && typeof result === "object" && "error" in result && typeof result.error === "string") record.task.error = result.error;
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
