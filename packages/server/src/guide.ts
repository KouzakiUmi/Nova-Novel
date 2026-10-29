import type Database from "better-sqlite3";
import type { GuidedAnswer, GuidedQuestion, GuidedSession, OutlineProposalScene, GenerationRequest, Revision, Scene } from "@nova-novel/shared";
import type { KnowledgeService, PiHost } from "./contracts.js";
import { DomainStore } from "./store.js";
import { DomainError } from "./domain.js";
import { newId, now } from "./utils.js";

const STEPS = ["goal", "conflict", "outcome"] as const;
const GUIDE_SCHEMA = "nova-novel.guide/1";

function invalid(message: string): never { throw new DomainError(502, "INVALID_GUIDE_OUTPUT", message); }
function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${name} 无效`);
  return value.trim();
}
function parseJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("引导结果必须是 JSON 对象");
    return value as Record<string, unknown>;
  } catch { return invalid("引导结果不是有效 JSON"); }
}
export function parseGuideQuestion(raw: string, stepId: string): GuidedQuestion {
  const value = parseJson(raw);
  if (value.stepId !== stepId) invalid("选择题步骤不匹配");
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) invalid("选择题应包含 2–4 个选项");
  const ids = new Set<string>();
  const options = value.options.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("选项格式无效");
    const option = item as Record<string, unknown>;
    const id = text(option.id, "选项 ID", 100);
    if (ids.has(id)) invalid("选项 ID 重复");
    ids.add(id);
    return { id, label: text(option.label, "选项标题", 1000), detail: text(option.detail, "选项说明", 2000) };
  });
  if (typeof value.allowCustom !== "boolean" || typeof value.allowSkip !== "boolean") invalid("自定义与跳过标记无效");
  return { stepId, question: text(value.question, "问题"), why: text(value.why, "问题作用"), options, allowCustom: value.allowCustom, allowSkip: value.allowSkip };
}
export function parseGuideProposal(raw: string): OutlineProposalScene[] {
  const value = parseJson(raw);
  if (!Array.isArray(value.scenes) || value.scenes.length !== 3) invalid("大纲应包含三个场景");
  const ids = new Set<string>();
  return value.scenes.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("大纲场景格式无效");
    const scene = item as Record<string, unknown>;
    const proposalId = text(scene.proposalId, "提案场景 ID", 100);
    if (ids.has(proposalId)) invalid("提案场景 ID 重复");
    ids.add(proposalId);
    return { proposalId, title: text(scene.title, "场景标题", 200), goal: text(scene.goal, "场景目标"), conflict: text(scene.conflict, "场景阻碍"), summary: text(scene.summary, "场景结果／摘要") };
  });
}

export class GuidedOutlineService {
  private readonly nextRuns = new Map<string, Promise<GuidedSession>>();
  constructor(private readonly db: Database.Database, private readonly store: DomainStore, private readonly knowledge: KnowledgeService, private readonly pi: PiHost) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS guide_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      branch_id TEXT NOT NULL REFERENCES branches(branch_id),
      base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
      json TEXT NOT NULL
    )`);
  }

  current(projectId: string): GuidedSession | undefined {
    return this.read("SELECT json FROM guide_sessions WHERE project_id=? AND json_extract(json,'$.status') IN ('active','ready') ORDER BY json_extract(json,'$.updatedAt') DESC", projectId)
      ?? this.read("SELECT json FROM guide_sessions WHERE project_id=? AND json_extract(json,'$.status')='applied' ORDER BY json_extract(json,'$.updatedAt') DESC", projectId);
  }
  get(sessionId: string): GuidedSession {
    const session = this.read("SELECT json FROM guide_sessions WHERE session_id=?", sessionId);
    if (!session) throw new DomainError(404, "GUIDE_NOT_FOUND", "交互大纲会话不存在");
    return session;
  }
  private read(sql: string, ...params: string[]): GuidedSession | undefined {
    const row = this.db.prepare(sql).get(...params) as { json?: string } | undefined;
    return row?.json ? JSON.parse(row.json) as GuidedSession : undefined;
  }
  private save(session: GuidedSession): GuidedSession {
    session.revision = (session.revision ?? 0) + 1;
    session.updatedAt = now();
    this.db.prepare("UPDATE guide_sessions SET json=? WHERE session_id=?").run(JSON.stringify(session), session.sessionId);
    return session;
  }
  private insert(projectId: string): GuidedSession {
    const project = this.store.getProject(projectId);
    const branch = this.store.getBranch(project.activeBranchId);
    const timestamp = now();
    const session: GuidedSession = { sessionId: newId("guide"), projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId, status: "active", stepIndex: 0, answers: [], questions: {}, createdAt: timestamp, updatedAt: timestamp };
    this.db.prepare("INSERT INTO guide_sessions(session_id,project_id,branch_id,base_revision_id,json) VALUES(?,?,?,?,?)").run(session.sessionId, projectId, branch.branchId, branch.headRevisionId, JSON.stringify(session));
    return session;
  }
  async create(projectId: string): Promise<GuidedSession> {
    const existing = this.read("SELECT json FROM guide_sessions WHERE project_id=? AND json_extract(json,'$.status') IN ('active','ready') ORDER BY json_extract(json,'$.updatedAt') DESC", projectId);
    if (existing) return this.next(existing.sessionId);
    return this.next(this.insert(projectId).sessionId);
  }
  async next(sessionId: string): Promise<GuidedSession> {
    const existing = this.nextRuns.get(sessionId);
    if (existing) return existing;
    const operation = this.performNext(sessionId);
    this.nextRuns.set(sessionId, operation);
    try { return await operation; }
    finally { if (this.nextRuns.get(sessionId) === operation) this.nextRuns.delete(sessionId); }
  }
  private async performNext(sessionId: string): Promise<GuidedSession> {
    const session = this.get(sessionId);
    if (session.status !== "active") return session;
    if (session.pending) return session;
    const stepId = STEPS[session.stepIndex] ?? "proposal";
    if (session.stepIndex < STEPS.length) {
      const cached = session.questions[stepId];
      if (cached) { session.pending = cached; return this.save(session); }
    }
    return this.generate(session, stepId);
  }
  private async generate(session: GuidedSession, stepId: string): Promise<GuidedSession> {
    const project = this.store.getProject(session.projectId);
    const mode = session.stepIndex < STEPS.length ? "question" : "proposal";
    const outline = this.store.listScenes(session.projectId, session.baseRevisionId).map(scene => ({ title: scene.title, goal: scene.goal, conflict: scene.conflict, summary: scene.summary, narrationOrder: scene.narrationOrder }));
    const inputPayload = { schema: GUIDE_SCHEMA, mode, stepId, premise: project.premise, answers: session.answers, existingOutline: outline };
    const request: GenerationRequest = { projectId: session.projectId, kind: "guide", input: JSON.stringify(inputPayload), idempotencyKey: newId("guide_step") };
    const context = this.knowledge.queryContext({ projectId: session.projectId, branchId: session.branchId, routeId: project.activeRouteId, revisionId: session.baseRevisionId, query: JSON.stringify(inputPayload), purpose: "planning" });
    const receipt = this.store.beginGeneration(request, context);
    try {
      const result = await this.pi.generate({ task: receipt.task, request, systemContext: "" });
      const latest = this.get(session.sessionId);
      if ((latest.revision ?? 0) !== (session.revision ?? 0)) {
        this.store.finishGeneration(receipt.task.taskId, { output: "guide", text: result.text, sessionId: result.sessionId }, result.completeness);
        return latest;
      }
      if (result.completeness !== "complete" || !result.text.trim()) throw new DomainError(502, "GUIDE_INCOMPLETE", "交互大纲生成尚未完整完成");
      if (mode === "question") {
        const question = parseGuideQuestion(result.text, stepId);
        session.questions[stepId] = question;
        session.pending = question;
      } else {
        session.proposal = parseGuideProposal(result.text);
        session.status = "ready";
      }
      this.save(session);
      this.store.finishGeneration(receipt.task.taskId, { output: "guide", text: result.text, sessionId: result.sessionId }, "complete");
      return session;
    } catch (error) {
      const latest = this.get(session.sessionId);
      if ((latest.revision ?? 0) !== (session.revision ?? 0)) {
        this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "交互大纲生成失败");
        return latest;
      }
      this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "交互大纲生成失败");
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, "GUIDE_FAILED", error instanceof Error ? error.message : "交互大纲生成失败");
    }
  }
  async answer(sessionId: string, input: { optionId?: string; custom?: string; skip?: boolean }): Promise<GuidedSession> {
    const session = this.get(sessionId);
    if (session.status !== "active" || !session.pending) throw new DomainError(409, "GUIDE_STATE", "当前没有可回答的问题");
    const pending = session.pending;
    let answer: GuidedAnswer;
    if (input.skip === true) {
      if (!pending.allowSkip) throw new DomainError(400, "GUIDE_STATE", "这一步不能跳过");
      answer = { stepId: pending.stepId, label: "暂时跳过", value: "", skipped: true };
    } else if (input.custom !== undefined && input.custom.trim()) {
      if (!pending.allowCustom) throw new DomainError(400, "GUIDE_STATE", "这一步不能自定义回答");
      answer = { stepId: pending.stepId, label: "作者自答", value: text(input.custom, "自定义回答"), skipped: false };
    } else {
      const option = pending.options.find(item => item.id === input.optionId);
      if (!option) throw new DomainError(400, "GUIDE_STATE", "请选择一个选项或填写自己的回答");
      answer = { stepId: pending.stepId, label: option.label, value: option.detail, skipped: false };
    }
    session.answers = [...session.answers.filter(item => item.stepId !== pending.stepId), answer];
    session.stepIndex += 1;
    delete session.pending;
    this.save(session);
    return this.next(sessionId);
  }
  back(sessionId: string): GuidedSession {
    const session = this.get(sessionId);
    if (session.stepIndex < 1 || session.status === "applied" || session.status === "cancelled") throw new DomainError(409, "GUIDE_STATE", "当前不能返回上一步");
    session.stepIndex -= 1;
    session.answers = session.answers.slice(0, -1);
    delete session.proposal;
    session.status = "active";
    const stepId = STEPS[session.stepIndex]!;
    const cached = session.questions[stepId];
    if (cached) session.pending = cached; else delete session.pending;
    return this.save(session);
  }
  cancel(sessionId: string): GuidedSession {
    const session = this.get(sessionId);
    if (session.status !== "applied") { session.status = "cancelled"; delete session.pending; this.save(session); }
    return session;
  }
  updateProposal(sessionId: string, scenes: unknown): GuidedSession {
    const session = this.get(sessionId);
    if (session.status !== "ready" || !session.proposal) throw new DomainError(409, "GUIDE_STATE", "大纲提案尚未就绪");
    session.proposal = parseGuideProposal(JSON.stringify({ scenes }));
    return this.save(session);
  }
  apply(sessionId: string, proposalIds?: string[]): { session: GuidedSession; revision: Revision; scenes: Scene[] } {
    const session = this.get(sessionId);
    if (session.status === "applied" && session.appliedRevisionId) return { session, revision: this.store.getRevision(session.appliedRevisionId), scenes: [] };
    if (session.status !== "ready" || !session.proposal) throw new DomainError(409, "GUIDE_STATE", "大纲提案尚未就绪");
    const selected = proposalIds === undefined ? session.proposal : session.proposal.filter(scene => proposalIds.includes(scene.proposalId));
    if (selected.length === 0) throw new DomainError(400, "GUIDE_EMPTY_SELECTION", "请至少选择一个要加入作品的场景");
    if (proposalIds && (new Set(proposalIds).size !== proposalIds.length || selected.length !== proposalIds.length)) throw new DomainError(400, "GUIDE_INVALID_SELECTION", "选择的场景不属于当前提案");
    const adopted = this.store.addScenes({ projectId: session.projectId, branchId: session.branchId, baseRevisionId: session.baseRevisionId, acceptanceId: `guide_${session.sessionId}`, scenes: selected });
    session.status = "applied";
    session.appliedRevisionId = adopted.revision.revisionId;
    session.appliedProposalIds = selected.map(scene => scene.proposalId);
    delete session.pending;
    this.save(session);
    return { session, ...adopted };
  }
}
