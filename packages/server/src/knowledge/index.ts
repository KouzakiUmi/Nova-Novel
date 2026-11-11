/**
 * 元素账本、时态状态、混合检索与一致性检查（SQLite 实现）。
 *
 * 分层：
 * - 权威表：kw_entities / kw_aliases / kw_facts / kw_world_events / kw_evidence / kw_scene_refs / kw_plans
 * - 派生索引：kw_fts（FTS5，可从 kw_evidence 全量重建；不参与事实判定）
 *
 * 检索正确性条件：所有结果先按 route / revision / storyOrder / narrationOrder / POV /
 * 知识边界过滤，再回查权威证据（证据行存在、场景引用仍在、内容哈希一致）后才返回。
 * 语义通道未配置时 indexState.semanticState 固定为 "unconfigured"，不做随机相似度伪装。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ContextBundle,
  ContextQuery,
  Entity,
  Evidence,
  FactAssertion,
  Scene,
  WorldEvent,
} from "@nova-novel/shared";
import type { ConsistencyIssue, KnowledgeService } from "../contracts.js";

/**
 * better-sqlite3.Database 的结构化最小子集；better-sqlite3.Database 天然满足此接口，
 * 因此 constructor(db: better-sqlite3.Database) 直接可用，测试也可用 node:sqlite 替身。
 */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export class KnowledgeIndexError extends Error {
  readonly code = "KNOWLEDGE_FTS_UNAVAILABLE";
  constructor(detail: string) {
    super(`关键词索引初始化失败：${detail}。关键词检索不可用，未以降级结果伪装完整检索；请更换带 FTS5 的 SQLite 构建。`);
    this.name = "KnowledgeIndexError";
  }
}

export interface SeedExampleKnowledgeArgs {
  projectId: string;
  routeId: string;
  revisionId: string;
  sceneIds: string[];
}

export interface WorldStateBelief {
  holderId: string;
  predicate: string;
  valueText: string | null;
}

export interface WorldStateQuantity {
  value: number | null;
  unit: string | null;
  known: boolean;
}

export interface WorldStateEntry {
  subjectId: string;
  owner: string | null;
  possessor: string | null;
  location: string | null;
  stateKnown: boolean;
  indeterminate: boolean;
  possessorCandidates: string[];
  timeUnknown: boolean;
  quantity: WorldStateQuantity | null;
  beliefs: WorldStateBelief[];
  evidenceQuotes: string[];
}

export interface WorldStateSnapshot {
  projectId: string;
  routeId: string;
  storyOrder: number | null;
  entries: WorldStateEntry[];
  excluded: Array<{ reason: string; count: number }>;
}

interface EntityRow {
  entity_id: string;
  project_id: string;
  type: string;
  name: string;
  summary: string;
  route_id: string;
  source_kind: string;
  review_state: string;
  unique_flag: number;
  created_at: string;
  updated_at: string;
}

interface FactRow {
  fact_id: string;
  project_id: string;
  subject_id: string;
  predicate: string;
  value_kind: string;
  value_text: string | null;
  value_entity_id: string | null;
  semantic_type: string;
  review_state: string;
  source_kind: string;
  route_id: string;
  valid_from_order: number | null;
  valid_to_order: number | null;
  holder_id: string | null;
  evidence_ids: string;
}

interface EventRow {
  event_id: string;
  project_id: string;
  kind: string;
  scene_id: string | null;
  route_id: string;
  story_time: string | null;
  story_order: number | null;
  subject_id: string;
  from_value: string | null;
  to_value: string | null;
  location: string | null;
  review_state: string;
  evidence_ids: string;
}

interface EvidenceRow {
  evidence_id: string;
  project_id: string;
  source_revision_id: string;
  scene_id: string | null;
  block_id: string | null;
  quote: string;
  content_hash: string;
  source_kind: string;
  route_id: string;
  narration_order: number | null;
  story_order: number | null;
  entity_refs: string;
  secret_refs: string;
}

interface SceneRefRow {
  project_id: string;
  revision_id: string;
  scene_id: string;
  route_id: string;
  narration_order: number | null;
  story_order: number | null;
  pov: string | null;
  title: string;
  summary: string;
  body_hash: string;
}

interface PlanRow {
  plan_id: string;
  project_id: string;
  revision_id: string;
  route_id: string;
  scene_id: string | null;
  story_order: number | null;
  text: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kw_entities (
  entity_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  route_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  review_state TEXT NOT NULL,
  unique_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kw_entities_lookup_idx ON kw_entities(project_id, route_id);

CREATE TABLE IF NOT EXISTS kw_aliases (
  project_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'alias',
  PRIMARY KEY (entity_id, alias)
);
CREATE INDEX IF NOT EXISTS kw_aliases_lookup_idx ON kw_aliases(project_id, alias);

CREATE TABLE IF NOT EXISTS kw_facts (
  fact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value_kind TEXT NOT NULL,
  value_text TEXT,
  value_entity_id TEXT,
  semantic_type TEXT NOT NULL,
  review_state TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  route_id TEXT NOT NULL,
  valid_from_order INTEGER,
  valid_to_order INTEGER,
  holder_id TEXT,
  evidence_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS kw_facts_lookup_idx ON kw_facts(project_id, route_id, subject_id);

CREATE TABLE IF NOT EXISTS kw_world_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scene_id TEXT,
  route_id TEXT NOT NULL,
  story_time TEXT,
  story_order INTEGER,
  subject_id TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  location TEXT,
  review_state TEXT NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS kw_events_lookup_idx ON kw_world_events(project_id, route_id, subject_id, story_order);

CREATE TABLE IF NOT EXISTS kw_evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  scene_id TEXT,
  block_id TEXT,
  quote TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  route_id TEXT NOT NULL,
  narration_order INTEGER,
  story_order INTEGER,
  entity_refs TEXT NOT NULL DEFAULT '[]',
  secret_refs TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS kw_evidence_lookup_idx ON kw_evidence(project_id, route_id, source_revision_id);

CREATE TABLE IF NOT EXISTS kw_scene_refs (
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  narration_order INTEGER,
  story_order INTEGER,
  pov TEXT,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL,
  PRIMARY KEY (revision_id, scene_id)
);
CREATE INDEX IF NOT EXISTS kw_scene_refs_scene_idx ON kw_scene_refs(scene_id);

CREATE TABLE IF NOT EXISTS kw_plans (
  plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  scene_id TEXT,
  story_order INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kw_plans_lookup_idx ON kw_plans(project_id, route_id, revision_id);

CREATE TABLE IF NOT EXISTS kw_revision_indexes (
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  completed_json TEXT NOT NULL,
  failed_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (revision_id)
);
CREATE INDEX IF NOT EXISTS kw_revision_indexes_project_idx ON kw_revision_indexes(project_id, updated_at);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS kw_fts USING fts5(
  ref_type UNINDEXED,
  ref_id UNINDEXED,
  project_id UNINDEXED,
  route_id UNINDEXED,
  tokens
);
`;

const POSSESSION_EVENTS = new Set([
  "item.transfer_possession",
  "item.lost",
  "item.recover_possession",
  "item.borrow",
  "item.return",
]);

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toDb(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function parseJsonArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // 派生字段损坏时按空处理，权威行不受影响
  }
  return [];
}

/** 中文按单字切开成空格分隔的 token；unicode61 不做中文分词，索引与查询都预分词。 */
export function tokenizeForFts(text: string): string {
  return text
    .replace(/[\u3400-\u9fff]/g, (ch) => ` ${ch} `)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** 查询串转为 FTS5 短语组：拉丁词按词、中文按相邻单字短语，组间 AND。 */
export function buildFtsQuery(input: string): string {
  const groups: string[] = [];
  const seen = new Set<string>();
  const push = (phrase: string) => {
    const cleaned = phrase.replaceAll('"', "");
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      groups.push(`"${cleaned}"`);
    }
  };
  for (const word of input.match(/[A-Za-z0-9_]+/g) ?? []) push(word.toLowerCase());
  for (const run of input.match(/[\u3400-\u9fff]+/g) ?? []) push([...run].join(" "));
  return groups.join(" AND ");
}

/** 启发式：把 "day 2 09:00" / "第2天" / 纯数字序号 "2" 之类的故事时间折算为可比较的 story order。 */
export function parseStoryOrderFromTime(storyTime: string | undefined): number | undefined {
  if (!storyTime) return undefined;
  const dayMatch = /(?:day\s*|第\s*)(\d{1,4})/i.exec(storyTime);
  const timeMatch = /(\d{1,2}):(\d{2})/.exec(storyTime);
  const day = dayMatch?.[1] !== undefined ? Number(dayMatch[1]) : null;
  if (day === null && timeMatch === null) {
    // 作者可直接填故事时点序号（如 "1"、"2"）：按序号原值生效，不静默退化为 1。
    const plain = /^\s*(\d{1,4})\s*$/.exec(storyTime);
    return plain ? Number(plain[1]) : undefined;
  }
  const hours = timeMatch?.[1] !== undefined ? Number(timeMatch[1]) : 0;
  const minutes = timeMatch?.[2] !== undefined ? Number(timeMatch[2]) : 0;
  return (day ?? 0) * 1440 + hours * 60 + minutes;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "");
}

export interface AddEntityArgs {
  entityId?: string | undefined;
  projectId: string;
  type: Entity["type"];
  name: string;
  summary?: string | undefined;
  routeId: string;
  sourceKind: Entity["sourceKind"];
  reviewState: Entity["reviewState"];
  unique?: boolean | undefined;
}

export interface AddFactArgs {
  factId?: string | undefined;
  projectId: string;
  subjectId: string;
  predicate: string;
  value: string | number | boolean | null | { entityId: string } | { [key: string]: unknown };
  semanticType: FactAssertion["semanticType"];
  reviewState: FactAssertion["reviewState"];
  sourceKind: FactAssertion["sourceKind"];
  routeId: string;
  validFromOrder?: number | undefined;
  validToOrder?: number | undefined;
  holderId?: string | undefined;
  evidenceIds?: string[] | undefined;
}

export interface AddEventArgs {
  eventId?: string | undefined;
  projectId: string;
  kind: string;
  sceneId?: string | undefined;
  routeId: string;
  storyTime?: string | undefined;
  storyOrder?: number | undefined;
  subjectId: string;
  fromValue?: string | undefined;
  toValue?: string | undefined;
  location?: string | undefined;
  reviewState: WorldEvent["reviewState"];
  evidenceIds?: string[] | undefined;
}

export interface AddEvidenceArgs {
  evidenceId?: string | undefined;
  projectId: string;
  sourceRevisionId: string;
  sceneId?: string | undefined;
  blockId?: string | undefined;
  quote: string;
  sourceKind: Evidence["sourceKind"];
  routeId: string;
  narrationOrder?: number;
  storyOrder?: number | undefined;
}

export interface AddPlanArgs {
  planId?: string | undefined;
  projectId: string;
  revisionId: string;
  routeId: string;
  sceneId?: string | undefined;
  storyOrder?: number | undefined;
  text: string;
}

export interface RegisterSceneArgs {
  projectId: string;
  revisionId: string;
  sceneId: string;
  routeId: string;
  narrationOrder?: number;
  storyOrder?: number | undefined;
  pov?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  bodyHash: string;
}

type EvidenceCheck = "ok" | "source_missing" | "story_order_unknown" | "out_of_story_order" | "out_of_narration_order" | "secret_hidden";

interface MentionEntry {
  entityId: string;
  aliases: string[];
  secret: boolean;
}

interface CompletedSceneIndex {
  bodyHash: string;
  evidenceIds: string[];
}

interface RevisionIndexProgress {
  expected: Set<string> | null;
  completed: Map<string, CompletedSceneIndex>;
  failed: Set<string>;
}

export interface KeywordIndexStatus {
  state: "pending" | "error" | "ready";
  keywordRevisionId: string;
}

export class SqliteKnowledgeService implements KnowledgeService {
  private readonly db: SqliteDatabase;
  private readonly lastKeywordRevisions = new Map<string, string>();

  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(SCHEMA_SQL);
    try {
      db.exec(FTS_SQL);
      db.prepare("INSERT INTO kw_fts(kw_fts) VALUES ('optimize')").run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new KnowledgeIndexError(detail);
    }
  }

  private run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params.map(toDb));
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params.map(toDb)) as unknown as T[];
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params.map(toDb)) as unknown as T | undefined;
  }

  /** 进度与派生索引同事务持久化；不以进程内 Map 代替数据库事实。 */
  private readRevisionIndex(projectId: string, revisionId: string): RevisionIndexProgress | undefined {
    const row = this.get<{ expected_json: string; completed_json: string; failed_json: string }>(
      "SELECT expected_json, completed_json, failed_json FROM kw_revision_indexes WHERE project_id = ? AND revision_id = ?",
      projectId, revisionId,
    );
    if (!row) return undefined;
    try {
      const expectedValue = JSON.parse(row.expected_json) as unknown;
      const completedValue = JSON.parse(row.completed_json) as unknown;
      const failedValue = JSON.parse(row.failed_json) as unknown;
      if ((expectedValue !== null && (!Array.isArray(expectedValue) || !expectedValue.every(item => typeof item === "string"))) || !completedValue || typeof completedValue !== "object" || Array.isArray(completedValue) || !Array.isArray(failedValue)) return undefined;
      const completed = new Map<string, CompletedSceneIndex>();
      for (const [sceneId, value] of Object.entries(completedValue)) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as Partial<CompletedSceneIndex>;
        if (typeof candidate.bodyHash === "string" && Array.isArray(candidate.evidenceIds) && candidate.evidenceIds.every(id => typeof id === "string")) completed.set(sceneId, { bodyHash: candidate.bodyHash, evidenceIds: [...candidate.evidenceIds] });
      }
      return { expected: expectedValue === null ? null : new Set(expectedValue), completed, failed: new Set(failedValue.filter((id): id is string => typeof id === "string")) };
    } catch {
      return undefined;
    }
  }

  private writeRevisionIndex(projectId: string, revisionId: string, progress: RevisionIndexProgress): void {
    this.run(
      `INSERT INTO kw_revision_indexes(project_id,revision_id,expected_json,completed_json,failed_json,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(revision_id) DO UPDATE SET expected_json=excluded.expected_json, completed_json=excluded.completed_json, failed_json=excluded.failed_json, updated_at=excluded.updated_at`,
      projectId, revisionId, JSON.stringify(progress.expected === null ? null : [...progress.expected]),
      JSON.stringify(Object.fromEntries(progress.completed)), JSON.stringify([...progress.failed]), new Date().toISOString(),
    );
  }

  // ---------- 写入：权威对象 ----------

  addEntity(args: AddEntityArgs): string {
    const entityId = args.entityId ?? newId("ent");
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO kw_entities (entity_id, project_id, type, name, summary, route_id, source_kind, review_state, unique_flag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         type=excluded.type, name=excluded.name, summary=excluded.summary, route_id=excluded.route_id,
         source_kind=excluded.source_kind, review_state=excluded.review_state, unique_flag=excluded.unique_flag,
         updated_at=excluded.updated_at`,
      entityId, args.projectId, args.type, args.name, args.summary ?? "", args.routeId,
      args.sourceKind, args.reviewState, args.unique ? 1 : 0, now, now,
    );
    this.run("INSERT OR IGNORE INTO kw_aliases (project_id, entity_id, alias, kind) VALUES (?, ?, ?, 'name')", args.projectId, entityId, args.name);
    return entityId;
  }

  addAlias(projectId: string, entityId: string, alias: string, kind: "name" | "alias" = "alias"): void {
    this.run("INSERT OR IGNORE INTO kw_aliases (project_id, entity_id, alias, kind) VALUES (?, ?, ?, ?)", projectId, entityId, alias, kind);
  }

  removeAlias(projectId: string, entityId: string, alias: string): void {
    this.run("DELETE FROM kw_aliases WHERE project_id = ? AND entity_id = ? AND alias = ?", projectId, entityId, alias);
  }

  addFact(args: AddFactArgs): string {
    const factId = args.factId ?? newId("fact");
    let valueKind: string;
    let valueText: string | null = null;
    let valueEntityId: string | null = null;
    if (typeof args.value === "object" && args.value !== null && "entityId" in args.value) {
      valueKind = "entity";
      valueEntityId = String(args.value.entityId);
    } else if (args.value === null) {
      valueKind = "null";
    } else if (typeof args.value === "boolean") {
      valueKind = "boolean";
      valueText = args.value ? "1" : "0";
    } else if (typeof args.value === "number") {
      valueKind = "number";
      valueText = String(args.value);
    } else if (typeof args.value === "object") {
      valueKind = "json";
      valueText = JSON.stringify(args.value);
    } else {
      valueKind = "text";
      valueText = args.value;
    }
    this.run(
      `INSERT INTO kw_facts (fact_id, project_id, subject_id, predicate, value_kind, value_text, value_entity_id,
         semantic_type, review_state, source_kind, route_id, valid_from_order, valid_to_order, holder_id, evidence_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET
         predicate=excluded.predicate, value_kind=excluded.value_kind, value_text=excluded.value_text,
         value_entity_id=excluded.value_entity_id, semantic_type=excluded.semantic_type,
         review_state=excluded.review_state, source_kind=excluded.source_kind, route_id=excluded.route_id,
         valid_from_order=excluded.valid_from_order, valid_to_order=excluded.valid_to_order,
         holder_id=excluded.holder_id, evidence_ids=excluded.evidence_ids`,
      factId, args.projectId, args.subjectId, args.predicate, valueKind, valueText, valueEntityId,
      args.semanticType, args.reviewState, args.sourceKind, args.routeId,
      args.validFromOrder ?? null, args.validToOrder ?? null, args.holderId ?? null,
      JSON.stringify(args.evidenceIds ?? []),
    );
    return factId;
  }

  addEvent(args: AddEventArgs): string {
    const eventId = args.eventId ?? newId("ev");
    this.run(
      `INSERT INTO kw_world_events (event_id, project_id, kind, scene_id, route_id, story_time, story_order,
         subject_id, from_value, to_value, location, review_state, evidence_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         kind=excluded.kind, scene_id=excluded.scene_id, route_id=excluded.route_id, story_time=excluded.story_time,
         story_order=excluded.story_order, subject_id=excluded.subject_id, from_value=excluded.from_value,
         to_value=excluded.to_value, location=excluded.location, review_state=excluded.review_state,
         evidence_ids=excluded.evidence_ids`,
      eventId, args.projectId, args.kind, args.sceneId ?? null, args.routeId,
      args.storyTime ?? null, args.storyOrder ?? null, args.subjectId,
      args.fromValue ?? null, args.toValue ?? null, args.location ?? null,
      args.reviewState, JSON.stringify(args.evidenceIds ?? []),
    );
    return eventId;
  }

  addEvidence(args: AddEvidenceArgs): string {
    return this.writeEvidence(args, this.loadMentions(args.projectId, args.routeId));
  }

  private writeEvidence(args: AddEvidenceArgs, mentions: MentionEntry[]): string {
    const evidenceId = args.evidenceId ?? newId("evd");
    const entityRefs = this.matchMentions(mentions, args.quote);
    const secretRefs = mentions.filter((entry) => entry.secret && entityRefs.includes(entry.entityId)).map((entry) => entry.entityId);
    this.run(
      `INSERT INTO kw_evidence (evidence_id, project_id, source_revision_id, scene_id, block_id, quote, content_hash,
         source_kind, route_id, narration_order, story_order, entity_refs, secret_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(evidence_id) DO UPDATE SET
         quote=excluded.quote, content_hash=excluded.content_hash, source_kind=excluded.source_kind,
         route_id=excluded.route_id, narration_order=excluded.narration_order, story_order=excluded.story_order,
         entity_refs=excluded.entity_refs, secret_refs=excluded.secret_refs`,
      evidenceId, args.projectId, args.sourceRevisionId, args.sceneId ?? null, args.blockId ?? null,
      args.quote, sha256(args.quote), args.sourceKind, args.routeId,
      args.narrationOrder ?? null, args.storyOrder ?? null,
      JSON.stringify(entityRefs), JSON.stringify(secretRefs),
    );
    // 只有已采用正文进入普通关键词索引；candidate / selected_plan 不进 FTS。
    if (args.sourceKind === "manuscript") {
      this.run(
        "INSERT INTO kw_fts (ref_type, ref_id, project_id, route_id, tokens) VALUES ('evidence', ?, ?, ?, ?)",
        evidenceId, args.projectId, args.routeId, tokenizeForFts(args.quote),
      );
    }
    return evidenceId;
  }

  addPlan(args: AddPlanArgs): string {
    const planId = args.planId ?? newId("plan");
    this.run(
      `INSERT INTO kw_plans (plan_id, project_id, revision_id, route_id, scene_id, story_order, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET text=excluded.text, story_order=excluded.story_order, scene_id=excluded.scene_id`,
      planId, args.projectId, args.revisionId, args.routeId, args.sceneId ?? null,
      args.storyOrder ?? null, args.text,
    );
    return planId;
  }

  registerScene(args: RegisterSceneArgs): void {
    this.run(
      `INSERT INTO kw_scene_refs (project_id, revision_id, scene_id, route_id, narration_order, story_order, pov, title, summary, body_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(revision_id, scene_id) DO UPDATE SET
         route_id=excluded.route_id, narration_order=excluded.narration_order, story_order=excluded.story_order,
         pov=excluded.pov, title=excluded.title, summary=excluded.summary, body_hash=excluded.body_hash`,
      args.projectId, args.revisionId, args.sceneId, args.routeId,
      args.narrationOrder ?? null, args.storyOrder ?? null, args.pov ?? null,
      args.title ?? "", args.summary ?? "", args.bodyHash,
    );
  }

  // ---------- 采用正文派生索引 ----------

  /** 调用方须传入权威修订的完整场景清单；未声明清单的逐场索引不能证明修订完整。 */
  beginRevisionIndex(projectId: string, revisionId: string, sceneIds: readonly string[]): void {
    this.writeRevisionIndex(projectId, revisionId, { expected: new Set(sceneIds), completed: new Map(), failed: new Set() });
  }

  private sceneCompletionValid(ref: SceneRefRow, saved: CompletedSceneIndex): boolean {
    if (ref.body_hash !== saved.bodyHash || saved.evidenceIds.length !== new Set(saved.evidenceIds).size) return false;
    if (saved.evidenceIds.length === 0) return true;
    const placeholders = saved.evidenceIds.map(() => "?").join(",");
    const rows = this.all<EvidenceRow>(`SELECT * FROM kw_evidence WHERE evidence_id IN (${placeholders})`, ...saved.evidenceIds);
    if (rows.length !== saved.evidenceIds.length) return false;
    const ftsRows = this.all<{ ref_id: string; route_id: string }>(
      `SELECT ref_id, route_id FROM kw_fts WHERE ref_type = 'evidence' AND ref_id IN (${placeholders})`,
      ...saved.evidenceIds,
    );
    const routesById = new Map<string, string[]>();
    for (const row of ftsRows) routesById.set(row.ref_id, [...routesById.get(row.ref_id) ?? [], row.route_id]);
    return rows.every(row => this.evidenceSourceCompatible(row, ref) && routesById.get(row.evidence_id)?.length === 1 && routesById.get(row.evidence_id)?.[0] === row.route_id);
  }

  getIndexStatus(projectId: string, revisionId: string): KeywordIndexStatus {
    const progress = this.readRevisionIndex(projectId, revisionId);
    let state: KeywordIndexStatus["state"] = progress?.failed.size ? "error" : "pending";
    if (progress?.expected !== null && progress?.expected !== undefined && state !== "error") {
      const refs = this.all<SceneRefRow>("SELECT * FROM kw_scene_refs WHERE project_id = ? AND revision_id = ?", projectId, revisionId);
      const refsByScene = new Map(refs.map((ref) => [ref.scene_id, ref]));
      const complete = refs.length === progress.expected.size && [...progress.expected].every((sceneId) => {
        const saved = progress.completed.get(sceneId);
        const ref = refsByScene.get(sceneId);
        return saved !== undefined && ref !== undefined && this.sceneCompletionValid(ref, saved);
      });
      if (complete) state = "ready";
    }
    if (state === "ready") this.lastKeywordRevisions.set(projectId, revisionId);
    const previous = this.lastKeywordRevisions.get(projectId);
    return { state, keywordRevisionId: state === "ready" ? revisionId : previous !== revisionId && previous !== undefined ? previous : `${state}:${revisionId}` };
  }

  /**
   * 复用父修订中已完成且坐标兼容的场景索引。证据仍保留其真实来源修订，
   * 查询时由 evidenceSourceCompatible 验证它与当前场景清单的正文和坐标完全一致。
   */
  reuseSceneIndex(scene: Scene, revisionId: string, sourceRevisionId: string): boolean {
    if (revisionId === sourceRevisionId) return false;
    const progress = this.readRevisionIndex(scene.projectId, revisionId);
    const sourceProgress = this.readRevisionIndex(scene.projectId, sourceRevisionId);
    const saved = sourceProgress?.completed.get(scene.sceneId);
    const sourceRef = this.get<SceneRefRow>(
      "SELECT * FROM kw_scene_refs WHERE project_id = ? AND revision_id = ? AND scene_id = ? AND route_id = ?",
      scene.projectId, sourceRevisionId, scene.sceneId, scene.routeId,
    );
    const storyOrder = parseStoryOrderFromTime(scene.storyTime);
    const bodyHash = sha256(scene.body);
    if (!progress || !saved || !sourceRef || sourceProgress?.failed.has(scene.sceneId) || saved.bodyHash !== bodyHash || sourceRef.body_hash !== bodyHash || sourceRef.narration_order !== scene.narrationOrder || sourceRef.story_order !== (storyOrder ?? null)) return false;
    if (!this.sceneCompletionValid(sourceRef, saved)) return false;
    const savepoint = newId("kw_reuse");
    try {
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.registerScene({ projectId: scene.projectId, revisionId, sceneId: scene.sceneId, routeId: scene.routeId, narrationOrder: scene.narrationOrder, storyOrder, pov: scene.pov, title: scene.title, summary: scene.summary, bodyHash });
      progress.completed.set(scene.sceneId, { bodyHash, evidenceIds: [...saved.evidenceIds] });
      progress.failed.delete(scene.sceneId);
      this.writeRevisionIndex(scene.projectId, revisionId, progress);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return true;
    } catch (error) {
      try { this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "场景索引复用失败，回滚时发生错误"); }
      throw error;
    }
  }

  /** 把当前采用正文分块写入派生 FTS 与 manuscript 证据；不改写任何权威事实。幂等：重跑替换旧派生行。 */
  indexScene(scene: Scene, revisionId: string): void {
    const progress = this.readRevisionIndex(scene.projectId, revisionId) ?? { expected: null, completed: new Map<string, CompletedSceneIndex>(), failed: new Set<string>() };
    const savepoint = newId("kw_scene");
    let opened = false;
    try {
      this.db.exec(`SAVEPOINT ${savepoint}`);
      opened = true;
      const evidenceIds = this.writeSceneIndex(scene, revisionId);
      progress.completed.set(scene.sceneId, { bodyHash: sha256(scene.body), evidenceIds });
      progress.failed.delete(scene.sceneId);
      this.writeRevisionIndex(scene.projectId, revisionId, progress);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      if (opened) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "场景索引失败，回滚时发生错误");
        }
      }
      progress.failed.add(scene.sceneId);
      this.writeRevisionIndex(scene.projectId, revisionId, progress);
      throw error;
    }
  }

  private writeSceneIndex(scene: Scene, revisionId: string): string[] {
    const mentions = this.loadMentions(scene.projectId, scene.routeId);
    const existing = this.get<{ story_order: number | null }>(
      "SELECT story_order FROM kw_scene_refs WHERE project_id = ? AND revision_id = ? AND scene_id = ? AND route_id = ?",
      scene.projectId, revisionId, scene.sceneId, scene.routeId,
    );
    const storyOrder: number | undefined = existing?.story_order ?? parseStoryOrderFromTime(scene.storyTime);
    this.registerScene({
      projectId: scene.projectId,
      revisionId,
      sceneId: scene.sceneId,
      routeId: scene.routeId,
      narrationOrder: scene.narrationOrder,
      storyOrder: storyOrder ?? undefined,
      pov: scene.pov,
      title: scene.title,
      summary: scene.summary,
      bodyHash: sha256(scene.body),
    });
    const oldRows = this.all<{ evidence_id: string }>(
      "SELECT evidence_id FROM kw_evidence WHERE project_id = ? AND scene_id = ? AND source_revision_id = ? AND source_kind = 'manuscript'",
      scene.projectId, scene.sceneId, revisionId,
    );
    for (const row of oldRows) {
      this.run("DELETE FROM kw_fts WHERE rowid IN (SELECT rowid FROM kw_fts WHERE ref_type = 'evidence' AND ref_id = ?)", row.evidence_id);
      this.run("DELETE FROM kw_evidence WHERE evidence_id = ?", row.evidence_id);
    }
    const blocks = scene.body.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
    const effectiveBlocks = blocks.length > 0 ? blocks : scene.body.trim().length > 0 ? [scene.body.trim()] : [];
    const evidenceIds: string[] = [];
    let index = 0;
    for (const block of effectiveBlocks) {
      index += 1;
      evidenceIds.push(this.writeEvidence({
        evidenceId: `evidence_${createHash("sha256").update(`${scene.projectId}:${revisionId}:${scene.sceneId}:${scene.sceneId}_b${index}:${block}`).digest("hex").slice(0, 24)}`,
        projectId: scene.projectId,
        sourceRevisionId: revisionId,
        sceneId: scene.sceneId,
        blockId: `${scene.sceneId}_b${index}`,
        quote: block,
        sourceKind: "manuscript",
        routeId: scene.routeId,
        narrationOrder: scene.narrationOrder,
        storyOrder,
      }, mentions));
    }
    return evidenceIds;
  }

  /** 从 kw_evidence 全量重建派生 FTS（索引可丢弃重建，权威层不受影响）。 */
  rebuildSearchIndex(): void {
    this.run("DELETE FROM kw_fts WHERE rowid IN (SELECT rowid FROM kw_fts WHERE ref_type = 'evidence')");
    const rows = this.all<EvidenceRow>("SELECT * FROM kw_evidence WHERE source_kind = 'manuscript'");
    for (const row of rows) {
      this.run(
        "INSERT INTO kw_fts (ref_type, ref_id, project_id, route_id, tokens) VALUES ('evidence', ?, ?, ?, ?)",
        row.evidence_id, row.project_id, row.route_id, tokenizeForFts(row.quote),
      );
    }
  }

  /**
   * 从权威修订正文重建派生证据与 FTS，用于索引损坏或丢失后的恢复。
   * 只清理该作品该修订的派生行，权威事实与历史修订不受影响。
   */
  rebuildRevisionIndex(projectId: string, revisionId: string, scenes: readonly Scene[]): KeywordIndexStatus {
    this.beginRevisionIndex(projectId, revisionId, scenes.map(scene => scene.sceneId));
    const owned = scenes.filter(scene => scene.projectId === projectId);
    if (owned.length !== scenes.length) throw new KnowledgeIndexError("修订中的场景不属于此作品");
    const placeholders = owned.map(() => "?").join(",");
    if (owned.length > 0) {
      const staleEvidence = this.all<{ evidence_id: string }>(
        `SELECT evidence_id FROM kw_evidence WHERE project_id = ? AND source_revision_id = ? AND source_kind = 'manuscript'
         AND (scene_id IS NULL OR scene_id NOT IN (${placeholders}))`,
        projectId, revisionId, ...owned.map(scene => scene.sceneId),
      );
      for (const row of staleEvidence) this.dropEvidence(row.evidence_id);
    }
    for (const scene of owned) {
      // 逐场已使用 SAVEPOINT；失败场景保持 error，不会留下半成品证据。
      this.indexScene(scene, revisionId);
    }
    return this.getIndexStatus(projectId, revisionId);
  }

  private dropEvidence(evidenceId: string): void {
    this.run("DELETE FROM kw_fts WHERE rowid IN (SELECT rowid FROM kw_fts WHERE ref_type = 'evidence' AND ref_id = ?)", evidenceId);
    this.run("DELETE FROM kw_evidence WHERE evidence_id = ?", evidenceId);
  }

  // ---------- 实体与别名 ----------

  resolveEntityByName(projectId: string, routeId: string, name: string): Entity | undefined {
    const row = this.get<EntityRow>(
      `SELECT e.* FROM kw_entities e
       WHERE e.project_id = ? AND e.route_id = ? AND e.name = ?
       UNION ALL
       SELECT e.* FROM kw_entities e JOIN kw_aliases a ON a.entity_id = e.entity_id
       WHERE e.project_id = ? AND e.route_id = ? AND a.alias = ?
       LIMIT 1`,
      projectId, routeId, name, projectId, routeId, name,
    );
    return row ? this.toEntity(row) : undefined;
  }

  private toEntity(row: EntityRow): Entity {
    const aliasRows = this.all<{ alias: string }>("SELECT alias FROM kw_aliases WHERE entity_id = ? AND kind = 'alias'", row.entity_id);
    return {
      entityId: row.entity_id,
      projectId: row.project_id,
      type: row.type as Entity["type"],
      name: row.name,
      aliases: aliasRows.map((a) => a.alias),
      summary: row.summary,
      routeId: row.route_id,
      sourceKind: row.source_kind as Entity["sourceKind"],
      reviewState: row.review_state as Entity["reviewState"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listEntities(projectId: string): Entity[] {
    return this.all<EntityRow>("SELECT * FROM kw_entities WHERE project_id = ? ORDER BY entity_id", projectId).map((r) => this.toEntity(r));
  }

  listFacts(projectId: string): FactAssertion[] {
    return this.all<FactRow>("SELECT * FROM kw_facts WHERE project_id = ? ORDER BY fact_id", projectId).map((r) => this.toFact(r));
  }

  listEvents(projectId: string): WorldEvent[] {
    return this.all<EventRow>("SELECT * FROM kw_world_events WHERE project_id = ? ORDER BY event_id", projectId).map((r) => this.toEvent(r));
  }

  private toFact(row: FactRow): FactAssertion {
    let value: FactAssertion["value"];
    if (row.value_kind === "entity") value = { entityId: row.value_entity_id ?? "" };
    else if (row.value_kind === "number") value = row.value_text !== null ? Number(row.value_text) : null;
    else if (row.value_kind === "boolean") value = row.value_text === "1";
    else if (row.value_kind === "null") value = null;
    else value = row.value_text;
    const base: FactAssertion = {
      factId: row.fact_id,
      projectId: row.project_id,
      subjectId: row.subject_id,
      predicate: row.predicate,
      value,
      semanticType: row.semantic_type as FactAssertion["semanticType"],
      reviewState: row.review_state as FactAssertion["reviewState"],
      sourceKind: row.source_kind as FactAssertion["sourceKind"],
      routeId: row.route_id,
      evidenceIds: parseJsonArray(row.evidence_ids),
    };
    if (row.holder_id !== null) base.holderId = row.holder_id;
    if (row.valid_from_order !== null) base.validFrom = String(row.valid_from_order);
    if (row.valid_to_order !== null) base.validTo = String(row.valid_to_order);
    return base;
  }

  private toEvent(row: EventRow): WorldEvent {
    const base: WorldEvent = {
      eventId: row.event_id,
      projectId: row.project_id,
      kind: row.kind,
      routeId: row.route_id,
      storyOrder: row.story_order ?? 0,
      subjectId: row.subject_id,
      reviewState: row.review_state as WorldEvent["reviewState"],
      evidenceIds: parseJsonArray(row.evidence_ids),
    };
    if (row.scene_id !== null) base.sceneId = row.scene_id;
    if (row.story_time !== null) base.storyTime = row.story_time;
    if (row.from_value !== null) base.fromValue = row.from_value;
    if (row.to_value !== null) base.toValue = row.to_value;
    if (row.location !== null) base.location = row.location;
    return base;
  }

  private toEvidence(row: EvidenceRow): Evidence {
    const base: Evidence = {
      evidenceId: row.evidence_id,
      projectId: row.project_id,
      sourceRevisionId: row.source_revision_id,
      quote: row.quote,
      contentHash: row.content_hash,
      sourceKind: row.source_kind as Evidence["sourceKind"],
      routeId: row.route_id,
    };
    if (row.scene_id !== null) base.sceneId = row.scene_id;
    if (row.block_id !== null) base.blockId = row.block_id;
    if (row.narration_order !== null) base.narrationOrder = row.narration_order;
    if (row.story_order !== null) base.storyOrder = row.story_order;
    return base;
  }

  listSceneEvidence(projectId: string, sceneId: string, revisionId: string): Evidence[] {
    const ref = this.get<SceneRefRow>(
      "SELECT * FROM kw_scene_refs WHERE project_id = ? AND revision_id = ? AND scene_id = ?",
      projectId, revisionId, sceneId,
    );
    if (!ref) return [];
    const rows = this.all<EvidenceRow>(
      "SELECT * FROM kw_evidence WHERE project_id = ? AND scene_id = ? AND source_kind = 'manuscript' ORDER BY source_revision_id, evidence_id",
      projectId, sceneId,
    ).filter(row => this.evidenceSourceCompatible(row, ref));
    // 同一区块可能同时存在继承证据与本修订重建证据；当前修订优先，区块只展示一次。
    const byBlock = new Map<string, EvidenceRow>();
    for (const row of rows) {
      const key = row.block_id ?? row.content_hash;
      if (!byBlock.has(key) || row.source_revision_id === revisionId) byBlock.set(key, row);
    }
    return [...byBlock.values()].map(row => this.toEvidence(row));
  }

  // ---------- 提及解析与知识边界 ----------

  private loadMentions(projectId: string, routeId: string): MentionEntry[] {
    const rows = this.all<{ entity_id: string; type: string; alias: string | null }>(
      `SELECT e.entity_id, e.type, a.alias FROM kw_entities e LEFT JOIN kw_aliases a ON a.entity_id = e.entity_id
       WHERE e.project_id = ? AND e.route_id = ? ORDER BY e.rowid, a.alias`, projectId, routeId,
    );
    const entries = new Map<string, MentionEntry>();
    for (const row of rows) {
      const entry = entries.get(row.entity_id) ?? { entityId: row.entity_id, aliases: [], secret: row.type === "secret" };
      if (row.alias !== null) entry.aliases.push(row.alias);
      entries.set(row.entity_id, entry);
    }
    return [...entries.values()];
  }

  private matchMentions(entries: MentionEntry[], text: string): string[] {
    return entries.filter((entry) => entry.aliases.some((alias) => alias.length > 0 && text.includes(alias))).map((entry) => entry.entityId);
  }

  private resolveMentionIds(projectId: string, routeId: string, text: string): string[] {
    return this.matchMentions(this.loadMentions(projectId, routeId), text);
  }

  private factActiveAt(row: FactRow, storyOrder: number | null): boolean {
    if (storyOrder === null) return row.valid_from_order === null && row.valid_to_order === null;
    return (row.valid_from_order === null || storyOrder >= row.valid_from_order) &&
      (row.valid_to_order === null || storyOrder < row.valid_to_order);
  }

  /** 未变场景可继承历史证据，但正文哈希、路线、叙述顺序和故事时点必须一致。 */
  private evidenceSourceCompatible(row: EvidenceRow, ref: SceneRefRow): boolean {
    if (row.project_id !== ref.project_id || row.route_id !== ref.route_id || row.source_kind !== "manuscript" || row.scene_id !== ref.scene_id || sha256(row.quote) !== row.content_hash) return false;
    if (row.source_revision_id === ref.revision_id) return true;
    const sourceRef = this.get<SceneRefRow>(
      "SELECT * FROM kw_scene_refs WHERE project_id = ? AND route_id = ? AND revision_id = ? AND scene_id = ?",
      ref.project_id, ref.route_id, row.source_revision_id, ref.scene_id,
    );
    return sourceRef !== undefined && sourceRef.body_hash === ref.body_hash && sourceRef.narration_order === ref.narration_order && sourceRef.story_order === ref.story_order;
  }

  private evidenceSourceCheck(row: EvidenceRow, projectId: string, routeId: string, revisionId: string | undefined, storyOrder: number | null, narrationOrder: number | null = null): EvidenceCheck {
    if (row.project_id !== projectId || row.route_id !== routeId || row.source_kind !== "manuscript" || revisionId === undefined || row.scene_id === null) return "source_missing";
    const ref = this.get<SceneRefRow>(
      "SELECT * FROM kw_scene_refs WHERE project_id = ? AND route_id = ? AND revision_id = ? AND scene_id = ?", projectId, routeId, revisionId, row.scene_id,
    );
    if (!ref || !this.evidenceSourceCompatible(row, ref)) return "source_missing";
    if (row.story_order !== null && storyOrder === null) return "story_order_unknown";
    if (row.story_order !== null && storyOrder !== null && row.story_order > storyOrder) return "out_of_story_order";
    if (narrationOrder !== null && row.narration_order !== null && row.narration_order > narrationOrder) return "out_of_narration_order";
    return "ok";
  }

  private factSourceValid(row: FactRow, revisionId: string | undefined, storyOrder: number | null): boolean {
    if (row.source_kind === "author_setting") return true;
    if (row.source_kind !== "manuscript") return false;
    return parseJsonArray(row.evidence_ids).some((id) => {
      const evidence = this.get<EvidenceRow>("SELECT * FROM kw_evidence WHERE evidence_id = ?", id);
      return evidence !== undefined && this.evidenceSourceCheck(evidence, row.project_id, row.route_id, revisionId, storyOrder) === "ok";
    });
  }

  private secretVisibleTo(
    projectId: string, routeId: string, secretId: string,
    pov: string | undefined, storyOrder: number | null, purpose: ContextQuery["purpose"], revisionId?: string,
  ): boolean {
    if (purpose === "planning") return true; // 总体规划允许全知设定，由上层标注分区
    const permissions = this.all<FactRow>(
      `SELECT * FROM kw_facts WHERE project_id = ? AND route_id = ? AND subject_id = ?
       AND predicate IN ('known_by', 'revealed') AND semantic_type = 'world_fact' AND review_state = 'confirmed'
       ORDER BY valid_from_order, fact_id`,
      projectId, routeId, secretId,
    );
    return permissions.some((row) => this.factActiveAt(row, storyOrder) && this.factSourceValid(row, revisionId, storyOrder) &&
      (row.predicate === "known_by" ? pov !== undefined && row.value_entity_id === pov : storyOrder !== null && row.valid_from_order !== null));
  }

  private secretAliases(secretId: string): string[] {
    return this.all<{ alias: string }>(
      "SELECT alias FROM kw_aliases WHERE entity_id = ? UNION SELECT name FROM kw_entities WHERE entity_id = ?",
      secretId, secretId,
    ).map((r) => r.alias).filter((a) => a.length > 0);
  }

  // ---------- 世界状态投影 ----------

  /**
   * 事件是否属于当前投影的权威范围：绑定场景的事件须随其场景引用存在于指定修订，
   * 未绑定场景的事件视为作者直接设定，始终有效。revisionId 未给出时不按修订过滤。
   */
  private eventAuthoritative(ev: EventRow, revisionId?: string): boolean {
    if (ev.scene_id === null || revisionId === undefined) return true;
    const ref = this.get<SceneRefRow>(
      "SELECT scene_id FROM kw_scene_refs WHERE project_id = ? AND route_id = ? AND revision_id = ? AND scene_id = ?",
      ev.project_id, ev.route_id, revisionId, ev.scene_id,
    );
    return ref !== undefined;
  }

  getWorldState(projectId: string, routeId: string, storyOrder?: number, revisionId?: string): WorldStateSnapshot {
    const order = storyOrder ?? null;
    const subjects = new Set<string>();
    const unknownSubjects = new Set<string>();
    const unknownEvidence = new Set<string>();
    let factSourceMissing = 0;
    let factStoryUnknown = 0;
    const factRows = this.all<FactRow>(
      "SELECT * FROM kw_facts WHERE project_id = ? AND route_id = ? AND review_state = 'confirmed' AND semantic_type IN ('world_fact', 'belief') AND source_kind != 'selected_plan'",
      projectId, routeId,
    ).filter((row) => {
      if (!this.factSourceValid(row, revisionId, order)) {
        factSourceMissing += 1;
        if (order === null && row.source_kind === "manuscript") {
          let sourceTimeUnknown = false;
          for (const id of parseJsonArray(row.evidence_ids)) {
            const evidence = this.get<EvidenceRow>("SELECT * FROM kw_evidence WHERE evidence_id = ?", id);
            if (evidence && this.evidenceSourceCheck(evidence, projectId, routeId, revisionId, order) === "story_order_unknown") {
              unknownEvidence.add(id);
              unknownSubjects.add(row.subject_id);
              sourceTimeUnknown = true;
            }
          }
          if (sourceTimeUnknown) factStoryUnknown += 1;
        }
        return false;
      }
      if (order === null && !this.factActiveAt(row, order)) {
        factStoryUnknown += 1;
        unknownSubjects.add(row.subject_id);
      }
      return true;
    });
    const eventRows = this.all<EventRow>(
      "SELECT * FROM kw_world_events WHERE project_id = ? AND route_id = ? AND review_state = 'confirmed'",
      projectId, routeId,
    ).filter((e) => this.eventAuthoritative(e, revisionId));
    for (const f of factRows) subjects.add(f.subject_id);
    for (const e of eventRows) subjects.add(e.subject_id);
    for (const subjectId of unknownSubjects) subjects.add(subjectId);

    const evidenceQuote = (evidenceId: string): string | null => {
      const row = this.get<EvidenceRow>("SELECT * FROM kw_evidence WHERE evidence_id = ?", evidenceId);
      if (!row) return null;
      const verdict = this.evidenceSourceCheck(row, projectId, routeId, revisionId, order);
      if (verdict === "story_order_unknown") unknownEvidence.add(evidenceId);
      return verdict === "ok" ? row.quote : null;
    };

    const entries: WorldStateEntry[] = [];
    for (const subjectId of subjects) {
      const entry: WorldStateEntry = {
        subjectId,
        owner: null,
        possessor: null,
        location: null,
        stateKnown: false,
        indeterminate: false,
        possessorCandidates: [],
        timeUnknown: unknownSubjects.has(subjectId),
        quantity: null,
        beliefs: [],
        evidenceQuotes: [],
      };
      const applicableFacts = factRows.filter((f) => {
        if (f.subject_id !== subjectId) return false;
        return this.factActiveAt(f, order);
      });
      for (const fact of applicableFacts) {
        if (fact.semantic_type !== "world_fact") continue;
        if (fact.predicate === "owner") {
          entry.owner = fact.value_entity_id ?? fact.value_text;
          entry.stateKnown = true;
        } else if (fact.predicate === "possessor") {
          entry.possessor = fact.value_entity_id ?? fact.value_text;
          entry.stateKnown = true;
        } else if (fact.predicate === "location") {
          entry.location = fact.value_text ?? fact.value_entity_id;
          entry.stateKnown = true;
        } else if (fact.predicate === "quantity") {
          entry.quantity = this.parseQuantity(fact);
        }
        for (const evId of parseJsonArray(fact.evidence_ids)) {
          const quote = evidenceQuote(evId);
          if (quote !== null) entry.evidenceQuotes.push(quote);
        }
      }

      const subjectEvents = eventRows.filter((e) => e.subject_id === subjectId);
      const possessionEvents = subjectEvents.filter((e) => POSSESSION_EVENTS.has(e.kind));
      if (possessionEvents.some((e) => e.story_order == null)) entry.timeUnknown = true;
      if (order === null && subjectEvents.length > 0) entry.timeUnknown = true;
      const ordered = subjectEvents
        .filter((e) => e.story_order != null && order !== null && e.story_order <= order)
        .sort((a, b) => (a.story_order ?? 0) - (b.story_order ?? 0));
      let previousOrder: number | null = null;
      let group: EventRow[] = [];
      const applyEvent = (ev: EventRow) => {
        if (ev.kind === "item.lost") {
          entry.possessor = null;
          entry.location = ev.location ?? ev.to_value ?? entry.location;
        } else if (ev.kind === "item.transfer_possession" || ev.kind === "item.recover_possession" || ev.kind === "item.borrow" || ev.kind === "item.return") {
          entry.possessor = ev.to_value;
        }
        if (ev.kind === "item.move_location") entry.location = ev.to_value ?? ev.location;
        entry.stateKnown = true;
        for (const evId of parseJsonArray(ev.evidence_ids)) {
          const quote = evidenceQuote(evId);
          if (quote !== null) entry.evidenceQuotes.push(quote);
        }
      };
      const flushGroup = () => {
        if (group.length === 0) return;
        const possessorOutcomes = new Set<string | null>();
        const locationOutcomes = new Set<string>();
        for (const ev of group) {
          if (POSSESSION_EVENTS.has(ev.kind)) possessorOutcomes.add(ev.kind === "item.lost" ? null : ev.to_value);
          if (ev.kind === "item.lost" || ev.kind === "item.move_location") {
            const loc = ev.kind === "item.lost" ? ev.location ?? ev.to_value : ev.to_value ?? ev.location;
            if (loc != null) locationOutcomes.add(loc);
          }
        }
        // 同一时点互斥事件且顺序未知：不按插入顺序任选任一槽位，
        // 旧状态事实也不可采信（其后的未知事件可能已改写状态）
        if (possessorOutcomes.size > 1 || locationOutcomes.size > 1) {
          entry.indeterminate = true;
          entry.possessorCandidates = [...possessorOutcomes].filter((v): v is string => v !== null).sort();
          entry.possessor = null;
          entry.location = null;
          entry.stateKnown = false;
          group = [];
          previousOrder = null;
          return;
        }
        for (const ev of group) applyEvent(ev);
        group = [];
        previousOrder = null;
      };
      for (const ev of ordered) {
        if (previousOrder != null && ev.story_order !== previousOrder) flushGroup();
        if (entry.indeterminate) break;
        previousOrder = ev.story_order;
        group.push(ev);
      }
      flushGroup();

      for (const fact of applicableFacts) {
        if (fact.semantic_type !== "belief") continue;
        entry.beliefs.push({
          holderId: fact.holder_id ?? "",
          predicate: fact.predicate,
          valueText: fact.value_entity_id ?? fact.value_text,
        });
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.subjectId.localeCompare(b.subjectId));
    const excluded = [
      { reason: "fact_source_not_in_revision", count: factSourceMissing },
      { reason: "fact_story_order_unknown", count: factStoryUnknown },
      { reason: "evidence_story_order_unknown", count: unknownEvidence.size },
      { reason: "event_story_order_unknown", count: order === null ? eventRows.length : 0 },
    ].filter((entry) => entry.count > 0);
    return { projectId, routeId, storyOrder: order, entries, excluded };
  }

  private parseQuantity(fact: FactRow): WorldStateQuantity | null {
    const text = fact.value_text;
    if (text === null) return { value: null, unit: null, known: false };
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "value" in parsed) {
        const obj = parsed as { value?: unknown; unit?: unknown };
        const value = typeof obj.value === "number" ? obj.value : null;
        const unit = typeof obj.unit === "string" && obj.unit.length > 0 ? obj.unit : null;
        return { value, unit, known: value !== null && unit !== null };
      }
    } catch {
      // 非 JSON：按无单位数值处理
    }
    if (/^\d+(\.\d+)?$/.test(text)) return { value: Number(text), unit: null, known: false };
    return { value: null, unit: null, known: false };
  }

  // ---------- 混合检索 ----------

  queryContext(query: ContextQuery): ContextBundle {
    const excluded: Array<{ reason: string; count: number }> = [];
    const pushExcluded = (reason: string, count: number) => {
      if (count > 0) excluded.push({ reason, count });
    };
    const storyOrder = query.storyOrder ?? null;
    const narrationOrder = query.narrationOrder ?? null;
    const pov = query.povEntityId;
    const checkedEvidence = new Map<string, { row: EvidenceRow | undefined; verdict: EvidenceCheck }>();
    const checkEvidence = (row: EvidenceRow): EvidenceCheck => {
      const source = this.evidenceSourceCheck(row, query.projectId, query.routeId, query.revisionId, storyOrder, narrationOrder);
      if (source !== "ok") return source;
      for (const secretId of parseJsonArray(row.secret_refs)) {
        if (!this.secretVisibleTo(query.projectId, query.routeId, secretId, pov, storyOrder, query.purpose, query.revisionId)) return "secret_hidden";
      }
      return "ok";
    };
    const readEvidence = (id: string) => {
      const cached = checkedEvidence.get(id);
      if (cached) return cached;
      const row = this.get<EvidenceRow>("SELECT * FROM kw_evidence WHERE evidence_id = ?", id);
      const result = { row, verdict: row ? checkEvidence(row) : "source_missing" as const };
      checkedEvidence.set(id, result);
      return result;
    };

    // 结构化：已确认世界事实（计划不进事实；信念按持有者可见）
    const factRows = this.all<FactRow>(
      "SELECT * FROM kw_facts WHERE project_id = ? AND route_id = ? AND review_state = 'confirmed' AND source_kind != 'selected_plan'",
      query.projectId, query.routeId,
    );
    const secretIds = new Set(
      this.all<{ entity_id: string }>("SELECT entity_id FROM kw_entities WHERE project_id = ? AND type = 'secret'", query.projectId).map((r) => r.entity_id),
    );
    const facts: FactAssertion[] = [];
    let factSourceMissing = 0;
    let factStoryUnknown = 0;
    for (const row of factRows) {
      if (row.semantic_type === "plan" || row.semantic_type === "hypothesis") continue;
      if (!this.factActiveAt(row, storyOrder)) {
        if (storyOrder === null) factStoryUnknown += 1;
        continue;
      }
      if (row.source_kind !== "author_setting" && (row.source_kind !== "manuscript" || !parseJsonArray(row.evidence_ids).some((id) => readEvidence(id).verdict === "ok"))) {
        factSourceMissing += 1;
        if (storyOrder === null && parseJsonArray(row.evidence_ids).some((id) => readEvidence(id).verdict === "story_order_unknown")) factStoryUnknown += 1;
        continue;
      }
      const isBeliefLike = row.semantic_type !== "world_fact";
      if (isBeliefLike) {
        const visibleToPov = pov !== undefined && row.holder_id === pov;
        if (!visibleToPov && query.purpose !== "planning") continue;
      }
      if (secretIds.has(row.subject_id) && !this.secretVisibleTo(query.projectId, query.routeId, row.subject_id, pov, storyOrder, query.purpose, query.revisionId)) {
        continue;
      }
      facts.push(this.toFact(row));
    }
    pushExcluded("fact_source_not_in_revision", factSourceMissing);
    pushExcluded("fact_story_order_unknown", factStoryUnknown);

    // 选定计划：按用途进入；事实核对与读者视角不采信
    const plansVisible = query.purpose === "planning" || query.purpose === "scene_writing";
    const selectedPlans: ContextBundle["selectedPlans"] = [];
    if (plansVisible) {
      const planRows = this.all<PlanRow>(
        "SELECT * FROM kw_plans WHERE project_id = ? AND route_id = ? AND revision_id = ? ORDER BY plan_id",
        query.projectId, query.routeId, query.revisionId,
      );
      for (const plan of planRows) {
        const hiddenSecret = [...secretIds].some((secretId) =>
          !this.secretVisibleTo(query.projectId, query.routeId, secretId, pov, storyOrder, query.purpose, query.revisionId) &&
          this.secretAliases(secretId).some((alias) => plan.text.includes(alias)),
        );
        if (hiddenSecret) continue; // 选定计划不绕过知识边界
        const entry: ContextBundle["selectedPlans"][number] = {
          sceneId: plan.scene_id ?? "",
          text: plan.text,
          sourceKind: "selected_plan",
        };
        selectedPlans.push(entry);
      }
    } else {
      pushExcluded("selected_plan_not_applicable_to_purpose",
        this.all<{ c: number }>("SELECT COUNT(*) AS c FROM kw_plans WHERE project_id = ? AND route_id = ? AND revision_id = ?",
          query.projectId, query.routeId, query.revisionId)[0]?.c ?? 0);
    }

    // 候选：只经显式引用进入比较上下文，且永不进入证据/事实清单
    const explicitIds = query.explicitCandidateIds ?? [];
    const candidates: ContextBundle["candidates"] = [];
    if (explicitIds.length > 0) {
      const placeholders = explicitIds.map(() => "?").join(",");
      const rows = this.all<EvidenceRow>(
        `SELECT * FROM kw_evidence WHERE project_id = ? AND source_kind = 'candidate' AND evidence_id IN (${placeholders})`,
        query.projectId, ...explicitIds,
      );
      for (const row of rows) {
        candidates.push({ artifactId: row.evidence_id, text: row.quote, sourceKind: "candidate" });
      }
    }
    const candidateTotal = this.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM kw_evidence WHERE project_id = ? AND source_kind = 'candidate'", query.projectId)?.c ?? 0;
    pushExcluded("candidate_not_explicitly_referenced", Math.max(0, candidateTotal - candidates.length));

    // 证据：事实回查 + 关键词召回，均须通过权威校验
    const evidenceById = new Map<string, Evidence>();
    let sourceMissing = 0;
    let secretHidden = 0;
    let evidenceStoryUnknown = 0;
    let outOfStory = 0;
    let outOfNarration = 0;
    const collectEvidence = (id: string) => {
      if (evidenceById.has(id)) return;
      const { row, verdict } = readEvidence(id);
      if (row && verdict === "ok") evidenceById.set(id, this.toEvidence(row));
    };

    for (const fact of facts) {
      for (const evidenceId of fact.evidenceIds) {
        collectEvidence(evidenceId);
      }
    }

    const ftsQuery = buildFtsQuery(query.query);
    if (ftsQuery.length > 0) {
      const requestedLimit = query.limit ?? 40;
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.trunc(requestedLimit))) : 40;
      // 事实自身引用的证据不受关键词 Top-K 影响；这里只限制额外的正文召回。
      const hits = this.all<{ ref_id: string }>(
        "SELECT ref_id FROM kw_fts WHERE kw_fts MATCH ? AND project_id = ? AND route_id = ? AND ref_type = 'evidence' ORDER BY ref_id LIMIT ?",
        ftsQuery, query.projectId, query.routeId, limit,
      );
      for (const hit of hits) {
        collectEvidence(hit.ref_id);
      }
    }
    const byBlock = new Map<string, Evidence>();
    const currentFirst = [...evidenceById.values()].sort((a, b) => Number(b.sourceRevisionId === query.revisionId) - Number(a.sourceRevisionId === query.revisionId));
    for (const item of currentFirst) {
      const key = `${item.sceneId ?? ""}:${item.blockId ?? item.contentHash}`;
      if (!byBlock.has(key)) byBlock.set(key, item);
    }
    const evidence = [...byBlock.values()].sort((a, b) =>
      (a.storyOrder ?? Number.MAX_SAFE_INTEGER) - (b.storyOrder ?? Number.MAX_SAFE_INTEGER) ||
      (a.narrationOrder ?? Number.MAX_SAFE_INTEGER) - (b.narrationOrder ?? Number.MAX_SAFE_INTEGER));

    for (const { verdict } of checkedEvidence.values()) {
      if (verdict === "source_missing") sourceMissing += 1;
      else if (verdict === "story_order_unknown") evidenceStoryUnknown += 1;
      else if (verdict === "secret_hidden") secretHidden += 1;
      else if (verdict === "out_of_story_order") outOfStory += 1;
      else if (verdict === "out_of_narration_order") outOfNarration += 1;
    }
    pushExcluded("evidence_source_missing", sourceMissing);
    pushExcluded("evidence_story_order_unknown", evidenceStoryUnknown);
    pushExcluded("secret_not_visible_to_pov", secretHidden);
    pushExcluded("out_of_story_order_range", outOfStory);
    pushExcluded("out_of_narration_order_range", outOfNarration);
    if (facts.length === 0 && evidence.length === 0 && selectedPlans.length === 0 && candidates.length === 0) {
      excluded.push({ reason: "empty_knowledge_base", count: 1 });
    }

    const indexStatus = this.getIndexStatus(query.projectId, query.revisionId);
    if (indexStatus.state !== "ready") pushExcluded(`keyword_index_${indexStatus.state}`, 1);
    const bundle: ContextBundle = {
      snapshotId: newId("ctxsnap"),
      facts,
      evidence,
      selectedPlans,
      candidates,
      excluded,
      indexState: { keywordRevisionId: indexStatus.keywordRevisionId, semanticState: "unconfigured" },
    };
    return bundle;
  }

  // ---------- 一致性检查 ----------

  checkConsistency(scene: Scene, candidateText: string): ConsistencyIssue[] {
    const issues: ConsistencyIssue[] = [];
    const storyOrder = this.resolveSceneStoryOrder(scene);
    const mentions = this.resolveMentionIds(scene.projectId, scene.routeId, candidateText);
    const assertsUse = /(掏出|拿出|取出|使用|摸索|打开|割开|开启)/.test(candidateText);
    const assertsNumber = /\d/.test(candidateText);

    for (const entityId of mentions) {
      const entity = this.getEntityRow(entityId);
      if (!entity) continue;
      if (entity.type === "item") {
        const snapshot = this.getWorldState(
            scene.projectId, scene.routeId, storyOrder ?? undefined, scene.baseRevisionId,
          );
        const state = snapshot.entries.find((e) => e.subjectId === entityId);
        if (!state) continue;
        if (state.indeterminate) {
          issues.push({
            issueId: newId("issue"),
            severity: "unknown",
            title: `「${entity.name}」在此时点的占有关系无法确定`,
            detail: "同一故事时点存在多个互斥事件且先后未知，不能按记录顺序任选；请补充先后关系或改写候选正文。",
            evidence: state.evidenceQuotes,
            certainty: "possible",
          });
          continue;
        }
        if (state.timeUnknown) {
          const count = (reason: string) => snapshot.excluded.find((entry) => entry.reason === reason)?.count ?? 0;
          const excludedDetail = storyOrder === null ? `因故事时点未知，排除事实 ${count("fact_story_order_unknown")} 条、证据 ${count("evidence_story_order_unknown")} 条、事件 ${count("event_story_order_unknown")} 条。` : "";
          issues.push({
            issueId: newId("issue"),
            severity: "unknown",
            title: `「${entity.name}」相关状态缺少可核对的故事时间或先后关系`,
            detail: `${excludedDetail}无法判定候选正文中的使用是否成立；请补充故事时间或先后关系。`,
            evidence: state.evidenceQuotes,
            certainty: "possible",
          });
          continue;
        }
        if (assertsUse && state.stateKnown && state.possessor === null) {
          issues.push({
            issueId: newId("issue"),
            severity: "conflict",
            title: `唯一物品「${entity.name}」已不在任何角色手中，候选正文仍直接使用`,
            detail: `故事时点 ${storyOrder ?? "?"} 的状态：占有者为空，位置 ${state.location ?? "未知"}。缺少取回或替代事件；请补打捞/取回情节、改用其他方式，或由作者修改旧设定。`,
            evidence: state.evidenceQuotes,
            certainty: "confirmed",
          });
        }
        if (assertsNumber && state.quantity !== null && !state.quantity.known) {
          issues.push({
            issueId: newId("issue"),
            severity: "unknown",
            title: `「${entity.name}」的数量或单位未知，无法核对候选正文中的数字`,
            detail: "数量缺少单位或数值未知，按未知处理，不假定正常。",
            evidence: state.evidenceQuotes,
            certainty: "possible",
          });
        }
      } else if (entity.type === "secret") {
        const visible = this.secretVisibleTo(scene.projectId, scene.routeId, entityId, scene.pov, storyOrder, "scene_writing", scene.baseRevisionId);
        if (!visible) {
          issues.push({
            issueId: newId("issue"),
            severity: storyOrder === null ? "unknown" : "conflict",
            title: storyOrder === null ? `秘密「${entity.name}」缺少可核对的故事时点` : `候选正文引用了该视角尚不知晓的秘密「${entity.name}」`,
            detail: storyOrder === null ? "故事时点未知，无法确认视角是否已获知秘密；请补充故事时间后核对。" : "POV 未获知该秘密且尚未揭示；写入正文会泄漏知识边界外的信息。",
            evidence: [],
            certainty: storyOrder === null ? "possible" : "confirmed",
          });
        }
      }
    }

    // 审美提示（可选）：候选与既有场景摘要整体重复
    const normalized = normalizeText(candidateText);
    if (normalized.length >= 8) {
      const summaries = this.all<{ scene_id: string; summary: string }>(
        "SELECT scene_id, summary FROM kw_scene_refs WHERE project_id = ? AND route_id = ? AND scene_id != ?",
        scene.projectId, scene.routeId, scene.sceneId,
      );
      for (const row of summaries) {
        if (row.summary.length >= 8 && (normalizeText(row.summary) === normalized || normalized.includes(normalizeText(row.summary)))) {
          issues.push({
            issueId: newId("issue"),
            severity: "aesthetic",
            title: "候选正文与既有场景摘要整体重复",
            detail: `与场景 ${row.scene_id} 的摘要重复；重复可能有意为之，由作者判断。`,
            evidence: [row.summary],
            certainty: "possible",
          });
          break;
        }
      }
    }
    return issues;
  }

  private getEntityRow(entityId: string): EntityRow | undefined {
    return this.get<EntityRow>("SELECT * FROM kw_entities WHERE entity_id = ?", entityId);
  }

  private resolveSceneStoryOrder(scene: Scene): number | null {
    const ref = this.get<{ story_order: number | null }>(
      "SELECT story_order FROM kw_scene_refs WHERE project_id = ? AND route_id = ? AND revision_id = ? AND scene_id = ? AND story_order IS NOT NULL",
      scene.projectId, scene.routeId, scene.baseRevisionId, scene.sceneId,
    );
    if (ref?.story_order != null) return ref.story_order;
    return parseStoryOrderFromTime(scene.storyTime) ?? null;
  }

  // ---------- 示例数据（黄铜钥匙） ----------

  /**
   * 幂等灌入贯穿示例：S03 移交 / S05 倒叙清晨用钥匙 / S08 遗失河底 / S10 待写进入仓库，
   * 附唯一物品、所有权、信念、作者秘密、选定计划与一条候选试演。
   * sceneIds 依次对应 S03、S05、S08、S10；不足四个时跳过对应部分。
   */
  seedExampleKnowledge(args: SeedExampleKnowledgeArgs): void {
    const [s03, s05, s08, s10] = args.sceneIds;
    const project = args.projectId;
    const route = args.routeId;
    const revision = args.revisionId;

    const linwu = this.addEntity({
      entityId: `${project}_ent_linwu`, projectId: project, type: "character", name: "林雾",
      summary: "仓库管理员。", routeId: route, sourceKind: "author_setting", reviewState: "confirmed",
    });
    this.addAlias(project, linwu, "小雾");
    const shenyan = this.addEntity({
      entityId: `${project}_ent_shenyan`, projectId: project, type: "character", name: "沈砚",
      summary: "委托人。", routeId: route, sourceKind: "author_setting", reviewState: "confirmed",
    });
    this.addAlias(project, shenyan, "小砚");
    const key = this.addEntity({
      entityId: `${project}_ent_brass_key`, projectId: project, type: "item", name: "黄铜钥匙",
      summary: "唯一的黄铜钥匙，可打开仓库。", routeId: route, sourceKind: "author_setting",
      reviewState: "confirmed", unique: true,
    });
    this.addAlias(project, key, "钥匙");
    const secret = this.addEntity({
      entityId: `${project}_ent_secret`, projectId: project, type: "secret", name: "真凶",
      summary: "作者秘密：真凶身份，尚未向读者揭示。", routeId: route, sourceKind: "author_setting",
      reviewState: "confirmed",
    });
    this.addAlias(project, secret, "真凶身份");

    const evdS03 = s03 ? this.addEvidence({
      evidenceId: `${project}_evd_s03`, projectId: project, sourceRevisionId: revision, sceneId: s03,
      blockId: `${s03}_b1`, quote: "林雾把黄铜钥匙交到沈砚手里。", sourceKind: "manuscript",
      routeId: route, narrationOrder: 3, storyOrder: 2,
    }) : null;
    const evdS05 = s05 ? this.addEvidence({
      evidenceId: `${project}_evd_s05`, projectId: project, sourceRevisionId: revision, sceneId: s05,
      blockId: `${s05}_b1`, quote: "清晨，林雾用黄铜钥匙打开仓库。", sourceKind: "manuscript",
      routeId: route, narrationOrder: 5, storyOrder: 1,
    }) : null;
    const evdS08 = s08 ? this.addEvidence({
      evidenceId: `${project}_evd_s08`, projectId: project, sourceRevisionId: revision, sceneId: s08,
      blockId: `${s08}_b1`, quote: "黄铜钥匙从沈砚的口袋滑落，掉进河底。他想起真凶留下的字条。", sourceKind: "manuscript",
      routeId: route, narrationOrder: 8, storyOrder: 3,
    }) : null;
    this.addEvidence({
      evidenceId: `${project}_evd_candidate_01`, projectId: project, sourceRevisionId: revision,
      quote: "试演：沈砚撬开仓库的门锁。", sourceKind: "candidate", routeId: route,
      narrationOrder: 10, storyOrder: 4,
    });

    this.addFact({
      factId: `${project}_fact_key_owner`, projectId: project, subjectId: key, predicate: "owner",
      value: { entityId: shenyan }, semanticType: "world_fact", reviewState: "confirmed",
      sourceKind: "author_setting", routeId: route,
    });
    this.addFact({
      factId: `${project}_fact_key_unique`, projectId: project, subjectId: key, predicate: "unique",
      value: true, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: route,
    });
    this.addFact({
      factId: `${project}_fact_key_possessor_initial`, projectId: project, subjectId: key, predicate: "possessor",
      value: { entityId: linwu }, semanticType: "world_fact", reviewState: "confirmed",
      sourceKind: "author_setting", routeId: route, validToOrder: 2,
      evidenceIds: evdS05 ? [evdS05] : [],
    });
    this.addFact({
      factId: `${project}_fact_linwu_belief`, projectId: project, subjectId: key, predicate: "possessor",
      value: { entityId: shenyan }, semanticType: "belief", reviewState: "confirmed",
      sourceKind: "manuscript", routeId: route, holderId: linwu, validFromOrder: 2,
    });
    this.addFact({
      factId: `${project}_fact_secret_known_by`, projectId: project, subjectId: secret, predicate: "known_by",
      value: { entityId: shenyan }, semanticType: "world_fact", reviewState: "confirmed",
      sourceKind: "author_setting", routeId: route,
    });
    this.addFact({
      factId: `${project}_fact_secret_content`, projectId: project, subjectId: secret, predicate: "identity",
      value: "字条背后的真凶身份", semanticType: "world_fact", reviewState: "confirmed",
      sourceKind: "author_setting", routeId: route,
    });

    if (s05) {
      this.addEvent({
        eventId: `${project}_ev_key_use_morning`, projectId: project, kind: "item.use", sceneId: s05,
        routeId: route, storyTime: "day 1 08:00", storyOrder: 1, subjectId: key,
        fromValue: linwu, toValue: "打开仓库", reviewState: "confirmed", evidenceIds: evdS05 ? [evdS05] : [],
      });
    }
    if (s03) {
      this.addEvent({
        eventId: `${project}_ev_key_transfer`, projectId: project, kind: "item.transfer_possession", sceneId: s03,
        routeId: route, storyTime: "day 1 21:10", storyOrder: 2, subjectId: key,
        fromValue: linwu, toValue: shenyan, reviewState: "confirmed", evidenceIds: evdS03 ? [evdS03] : [],
      });
    }
    if (s08) {
      this.addEvent({
        eventId: `${project}_ev_key_lost`, projectId: project, kind: "item.lost", sceneId: s08,
        routeId: route, storyTime: "day 2 09:00", storyOrder: 3, subjectId: key,
        fromValue: shenyan, location: "河底", reviewState: "confirmed", evidenceIds: evdS08 ? [evdS08] : [],
      });
    }

    if (s03) {
      this.registerScene({
        projectId: project, revisionId: revision, sceneId: s03, routeId: route,
        narrationOrder: 3, storyOrder: 2, pov: linwu,
        title: "移交", summary: "林雾将唯一黄铜钥匙交给沈砚。", bodyHash: sha256("林雾把黄铜钥匙交到沈砚手里。"),
      });
    }
    if (s05) {
      this.registerScene({
        projectId: project, revisionId: revision, sceneId: s05, routeId: route,
        narrationOrder: 5, storyOrder: 1, pov: linwu,
        title: "回忆", summary: "清晨林雾用黄铜钥匙打开仓库。", bodyHash: sha256("清晨，林雾用黄铜钥匙打开仓库。"),
      });
    }
    if (s08) {
      this.registerScene({
        projectId: project, revisionId: revision, sceneId: s08, routeId: route,
        narrationOrder: 8, storyOrder: 3, pov: shenyan,
        title: "遗失", summary: "钥匙从沈砚口袋落入河底，尚未打捞。", bodyHash: sha256("黄铜钥匙从沈砚的口袋滑落，掉进河底。"),
      });
    }
    if (s10) {
      this.registerScene({
        projectId: project, revisionId: revision, sceneId: s10, routeId: route,
        narrationOrder: 10, storyOrder: 4, pov: shenyan,
        title: "进入仓库", summary: "待写：沈砚进入仓库。", bodyHash: sha256("待写：沈砚进入仓库。"),
      });
      this.addPlan({
        planId: `${project}_plan_s10`, projectId: project, revisionId: revision, routeId: route,
        sceneId: s10, storyOrder: 4, text: "沈砚进入仓库取回父亲的旧图。",
      });
    }
  }
}

/** 独立入口：供示例项目对既有数据库直接灌入示例知识。 */
export function seedExampleKnowledge(db: SqliteDatabase, args: SeedExampleKnowledgeArgs): void {
  new SqliteKnowledgeService(db).seedExampleKnowledge(args);
}
