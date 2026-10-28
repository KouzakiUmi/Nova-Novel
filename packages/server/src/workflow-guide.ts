import type Database from "better-sqlite3";
import type { GuidedAnswer, GuidedQuestion, WorkflowDefinition, WorkflowGuideSession, GenerationRequest } from "@nova-novel/shared";
import type { KnowledgeService, PiHost } from "./contracts.js";
import { DomainError } from "./domain.js";
import { DomainStore } from "./store.js";
import { newId, now } from "./utils.js";
import { parseGuideQuestion } from "./guide.js";
import { NodeTypeRegistry, registerBuiltinNodeTypes } from "./workflow/registry.js";
import { validateDefinition } from "./workflow/validation.js";
import type { PersistentWorkflowService } from "./workflow/service.js";

const STEPS = ["intent", "review"] as const;
const SCHEMA = "nova-novel.workflow-guide/1";
function invalid(message: string): never { throw new DomainError(502, "INVALID_WORKFLOW_GUIDE_OUTPUT", message); }
function text(value: unknown, name: string, max = 4000): string { if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${name} 无效`); return value.trim(); }
function parseProposal(raw: string, sessionId: string): WorkflowDefinition {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("工作流提案必须是对象");
    value = parsed as Record<string, unknown>;
  } catch { return invalid("工作流提案不是有效 JSON"); }
  if (value.schemaVersion !== "nova-novel.workflow/1") invalid("工作流 schemaVersion 无效");
  if (!Array.isArray(value.nodes) || value.nodes.length < 3 || value.nodes.length > 20 || !Array.isArray(value.edges) || value.edges.length > 60) invalid("工作流节点或连线数量无效");
  if (!value.policy || typeof value.policy !== "object" || Array.isArray(value.policy)) invalid("工作流策略无效");
  const policy = value.policy as Record<string, unknown>;
  for (const key of ["maxParallelNodes", "maxNodeAttempts", "maxIterations"]) if (!Number.isSafeInteger(policy[key]) || (policy[key] as number) < 1 || (policy[key] as number) > 16) invalid(`工作流策略 ${key} 无效`);
  return { schemaVersion: "nova-novel.workflow/1", workflowId: `wf_guided_${sessionId}`, workflowVersionId: `wfv_guided_${sessionId}_1`, name: text(value.name, "工作流名称", 200), description: text(value.description, "工作流说明", 2000), nodes: value.nodes, edges: value.edges, policy: policy as unknown as WorkflowDefinition["policy"] };
}
function validateProposal(definition: WorkflowDefinition): void {
  const registry = new NodeTypeRegistry(); registerBuiltinNodeTypes(registry);
  const issues = validateDefinition(definition, registry);
  if (!definition.nodes.some(node => node.type === "run.scene" && node.inputs.scene && "runInput" in node.inputs.scene && node.inputs.scene.runInput === "sceneId")) issues.push({ code: "missing_scene_input", message: "工作流必须从运行输入 sceneId 选择场景" });
  if (!definition.nodes.some(node => node.type === "agent.generate")) issues.push({ code: "missing_generation", message: "工作流必须包含候选生成节点" });
  if (!definition.nodes.some(node => node.type === "human.review")) issues.push({ code: "missing_human_review", message: "工作流必须包含人工审阅节点" });
  if (!definition.nodes.some(node => node.type === "revision.commit")) issues.push({ code: "missing_commit", message: "工作流必须包含人工决定后的提交节点" });
  if (issues.length) throw new DomainError(400, "INVALID_WORKFLOW_PROPOSAL", issues.map(issue => issue.message).join("；"));
}

export class GuidedWorkflowService {
  private readonly nextRuns = new Map<string, Promise<WorkflowGuideSession>>();
  constructor(private readonly db: Database.Database, private readonly store: DomainStore, private readonly knowledge: KnowledgeService, private readonly pi: PiHost, private readonly workflow: PersistentWorkflowService) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_guide_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      branch_id TEXT NOT NULL REFERENCES branches(branch_id),
      base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
      json TEXT NOT NULL
    )`);
  }
  current(projectId: string): WorkflowGuideSession | undefined {
    return this.read("SELECT json FROM workflow_guide_sessions WHERE project_id=? AND json_extract(json,'$.status') IN ('active','ready') ORDER BY json_extract(json,'$.updatedAt') DESC", projectId)
      ?? this.read("SELECT json FROM workflow_guide_sessions WHERE project_id=? AND json_extract(json,'$.status')='published' ORDER BY json_extract(json,'$.updatedAt') DESC", projectId);
  }
  get(sessionId: string): WorkflowGuideSession {
    const session = this.read("SELECT json FROM workflow_guide_sessions WHERE session_id=?", sessionId);
    if (!session) throw new DomainError(404, "WORKFLOW_GUIDE_NOT_FOUND", "交互式工作流会话不存在");
    return session;
  }
  private read(sql: string, ...params: string[]): WorkflowGuideSession | undefined {
    const row = this.db.prepare(sql).get(...params) as { json?: string } | undefined;
    return row?.json ? JSON.parse(row.json) as WorkflowGuideSession : undefined;
  }
  private save(session: WorkflowGuideSession): WorkflowGuideSession { session.revision = (session.revision ?? 0) + 1; session.updatedAt = now(); this.db.prepare("UPDATE workflow_guide_sessions SET json=? WHERE session_id=?").run(JSON.stringify(session), session.sessionId); return session; }
  private insert(projectId: string): WorkflowGuideSession {
    const project = this.store.getProject(projectId); const branch = this.store.getBranch(project.activeBranchId); const timestamp = now();
    const session: WorkflowGuideSession = { sessionId: newId("workflow_guide"), projectId, branchId: branch.branchId, baseRevisionId: branch.headRevisionId, status: "active", stepIndex: 0, answers: [], questions: {}, createdAt: timestamp, updatedAt: timestamp };
    this.db.prepare("INSERT INTO workflow_guide_sessions(session_id,project_id,branch_id,base_revision_id,json) VALUES(?,?,?,?,?)").run(session.sessionId, projectId, branch.branchId, branch.headRevisionId, JSON.stringify(session));
    return session;
  }
  async create(projectId: string): Promise<WorkflowGuideSession> {
    const existing = this.read("SELECT json FROM workflow_guide_sessions WHERE project_id=? AND json_extract(json,'$.status') IN ('active','ready') ORDER BY json_extract(json,'$.updatedAt') DESC", projectId);
    if (existing) return this.next(existing.sessionId);
    return this.next(this.insert(projectId).sessionId);
  }
  async next(sessionId: string): Promise<WorkflowGuideSession> {
    const existing = this.nextRuns.get(sessionId);
    if (existing) return existing;
    const operation = this.performNext(sessionId);
    this.nextRuns.set(sessionId, operation);
    try { return await operation; }
    finally { if (this.nextRuns.get(sessionId) === operation) this.nextRuns.delete(sessionId); }
  }
  private async performNext(sessionId: string): Promise<WorkflowGuideSession> {
    const session = this.get(sessionId);
    if (session.status !== "active" || session.pending) return session;
    const stepId = STEPS[session.stepIndex] ?? "proposal";
    if (session.stepIndex < STEPS.length) {
      const cached = session.questions[stepId];
      if (cached) { session.pending = cached; return this.save(session); }
    }
    return this.generate(session, stepId);
  }
  private async generate(session: WorkflowGuideSession, stepId: string): Promise<WorkflowGuideSession> {
    const project = this.store.getProject(session.projectId);
    const mode = session.stepIndex < STEPS.length ? "question" : "proposal";
    const payload = { schema: SCHEMA, mode, stepId, answers: session.answers, existingWorkflows: this.workflow.listDefinitions().map(item => ({ name: item.name, nodes: item.nodes.map(node => node.type) })) };
    const request: GenerationRequest = { projectId: session.projectId, kind: "guide", input: JSON.stringify(payload), idempotencyKey: newId("workflow_guide_step") };
    const context = this.knowledge.queryContext({ projectId: session.projectId, branchId: session.branchId, routeId: project.activeRouteId, revisionId: session.baseRevisionId, query: JSON.stringify(payload), purpose: "planning" });
    const receipt = this.store.beginGeneration(request, context);
    try {
      const result = await this.pi.generate({ task: receipt.task, request, systemContext: "" });
      const latest = this.get(session.sessionId);
      if ((latest.revision ?? 0) !== (session.revision ?? 0)) {
        this.store.finishGeneration(receipt.task.taskId, { output: "guide", text: result.text, sessionId: result.sessionId }, result.completeness);
        return latest;
      }
      if (result.completeness !== "complete" || !result.text.trim()) throw new DomainError(502, "WORKFLOW_GUIDE_INCOMPLETE", "工作流提案尚未完整生成");
      if (mode === "question") {
        const question = parseGuideQuestion(result.text, stepId);
        session.questions[stepId] = question; session.pending = question;
      } else {
        const proposal = parseProposal(result.text, session.sessionId);
        validateProposal(proposal);
        session.proposal = proposal; session.status = "ready";
      }
      this.save(session);
      this.store.finishGeneration(receipt.task.taskId, { output: "guide", text: result.text, sessionId: result.sessionId }, "complete");
      return session;
    } catch (error) {
      const latest = this.get(session.sessionId);
      if ((latest.revision ?? 0) !== (session.revision ?? 0)) {
        this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "工作流提案生成失败");
        return latest;
      }
      this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "工作流提案生成失败");
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, "WORKFLOW_GUIDE_FAILED", error instanceof Error ? error.message : "工作流提案生成失败");
    }
  }
  async answer(sessionId: string, input: { optionId?: string; custom?: string; skip?: boolean }): Promise<WorkflowGuideSession> {
    const session = this.get(sessionId);
    if (session.status !== "active" || !session.pending) throw new DomainError(409, "WORKFLOW_GUIDE_STATE", "当前没有可回答的问题");
    const pending = session.pending;
    let answer: GuidedAnswer;
    if (input.skip === true) {
      if (!pending.allowSkip) throw new DomainError(400, "WORKFLOW_GUIDE_STATE", "这一步不能跳过");
      answer = { stepId: pending.stepId, label: "暂时跳过", value: "", skipped: true };
    } else if (input.custom !== undefined && input.custom.trim()) {
      if (!pending.allowCustom) throw new DomainError(400, "WORKFLOW_GUIDE_STATE", "这一步不能自定义回答");
      answer = { stepId: pending.stepId, label: "作者自答", value: text(input.custom, "自定义回答"), skipped: false };
    } else {
      const option = pending.options.find(item => item.id === input.optionId);
      if (!option) throw new DomainError(400, "WORKFLOW_GUIDE_STATE", "请选择一个选项或填写自己的回答");
      answer = { stepId: pending.stepId, label: option.label, value: option.detail, skipped: false };
    }
    session.answers = [...session.answers.filter(item => item.stepId !== pending.stepId), answer];
    session.stepIndex += 1; delete session.pending;
    this.save(session);
    return this.next(sessionId);
  }
  back(sessionId: string): WorkflowGuideSession {
    const session = this.get(sessionId);
    if (session.stepIndex < 1 || session.status === "published" || session.status === "cancelled") throw new DomainError(409, "WORKFLOW_GUIDE_STATE", "当前不能返回上一步");
    session.stepIndex -= 1; session.answers = session.answers.slice(0, -1); delete session.proposal; session.status = "active";
    const stepId = STEPS[session.stepIndex]!; const cached = session.questions[stepId];
    if (cached) session.pending = cached; else delete session.pending;
    return this.save(session);
  }
  cancel(sessionId: string): WorkflowGuideSession {
    const session = this.get(sessionId);
    if (session.status !== "published") { session.status = "cancelled"; delete session.pending; this.save(session); }
    return session;
  }
  updateProposal(sessionId: string, input: WorkflowDefinition): WorkflowGuideSession {
    const session = this.get(sessionId);
    if (session.status !== "ready" || !session.proposal) throw new DomainError(409, "WORKFLOW_GUIDE_STATE", "工作流提案尚未就绪");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError(400, "INVALID_WORKFLOW_PROPOSAL", "工作流提案必须是对象");
    const proposal = { ...input, workflowId: session.proposal.workflowId, workflowVersionId: session.proposal.workflowVersionId };
    validateProposal(proposal);
    session.proposal = proposal;
    return this.save(session);
  }
  publish(sessionId: string): { session: WorkflowGuideSession; definition: WorkflowDefinition } {
    const session = this.get(sessionId);
    if (session.status === "published" && session.publishedVersionId) return { session, definition: this.workflow.getDefinition(session.publishedVersionId)! };
    if (session.status !== "ready" || !session.proposal) throw new DomainError(409, "WORKFLOW_GUIDE_STATE", "工作流提案尚未就绪");
    validateProposal(session.proposal);
    const definition = this.workflow.registerDefinition(session.proposal);
    session.status = "published"; session.publishedVersionId = definition.workflowVersionId; delete session.pending;
    this.save(session);
    return { session, definition };
  }
}
