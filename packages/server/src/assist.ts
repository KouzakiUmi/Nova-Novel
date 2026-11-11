import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  ArcAssistProposal,
  ArcDiagnosisReport,
  ApplyExtractedLedgerInput,
  AuthorNote,
  CharacterArcProfile,
  ElementDesignCard,
  ElementDesignFactProposal,
  ElementGuideSession,
  Entity,
  ExtractedElementProposal,
  ExtractedEventProposal,
  ExtractedFactProposal,
  ExtractedLedgerBundle,
  FactAssertion,
  GenerationRequest,
  GuidedAnswer,
  GuidedQuestion,
  NoteIncubateResult,
  NoteIncubateTarget,
  PlotIdeateMode,
  PlotIdeateResult,
  Revision,
  Scene,
  SceneFieldOption,
  SceneProposalCard,
  WorldEvent,
} from "@nova-novel/shared";
import type { KnowledgeService, PiHost } from "./contracts.js";
import { DomainError, requiredString } from "./domain.js";
import { parseGuideQuestion } from "./guide.js";
import { parseStoryOrderFromTime } from "./knowledge/index.js";
import { DomainStore } from "./store.js";
import { newId, now, sha256, stableHash } from "./utils.js";

export const ELEMENT_DESIGN_SCHEMA = "nova-novel.element-design/1";
export const ELEMENT_GUIDE_SCHEMA = "nova-novel.element-guide/1";
export const ARC_ASSIST_SCHEMA = "nova-novel.arc-assist/1";
export const PLOT_IDEATE_SCHEMA = "nova-novel.plot-ideate/1";
export const NOTE_INCUBATE_SCHEMA = "nova-novel.note-incubate/1";
export const EXTRACT_LEDGER_SCHEMA = "nova-novel.extract-ledger/1";

const ENTITY_TYPES: ReadonlyArray<Entity["type"]> = [
  "character",
  "item",
  "location",
  "organization",
  "ability",
  "rule",
  "event",
  "secret",
  "custom",
];
const SEMANTIC_TYPES: ReadonlyArray<FactAssertion["semanticType"]> = [
  "world_fact",
  "belief",
  "rumor",
  "deception",
  "plan",
  "hypothesis",
];

function invalid(message: string): never {
  throw new DomainError(502, "INVALID_ASSIST_OUTPUT", message);
}
function text(value: unknown, name: string, max = 4000, allowEmpty = false): string {
  if (typeof value !== "string") invalid(`${name} 必须是文字`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) invalid(`${name} 不能为空`);
  if (trimmed.length > max) invalid(`${name} 超出长度限制`);
  return trimmed;
}
function stringArray(value: unknown, name: string, maxItems = 20, maxLen = 400): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) invalid(`${name} 必须是数组且不超过 ${maxItems} 项`);
  return value.map((item) => text(item, name, maxLen)).filter(Boolean);
}
function parseJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("生成结果必须是 JSON 对象");
    return value as Record<string, unknown>;
  } catch {
    return invalid("生成结果不是有效 JSON");
  }
}

export function parseElementDesignCards(raw: string, fallbackType: Entity["type"] = "character"): ElementDesignCard[] {
  const value = parseJson(raw);
  const rawCards = Array.isArray(value.cards)
    ? value.cards
    : Array.isArray(value.elementCards)
      ? value.elementCards
      : undefined;
  if (!Array.isArray(rawCards) || rawCards.length < 1 || rawCards.length > 6) {
    invalid("元素共创方案应包含 1–6 张卡片");
  }
  const seen = new Set<string>();
  return rawCards.map((item: unknown, index: number): ElementDesignCard => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("元素方案卡格式无效");
    const card = item as Record<string, unknown>;
    const proposalId = typeof card.proposalId === "string" && card.proposalId.trim() ? text(card.proposalId, "方案 ID", 100) : `elem-${index + 1}`;
    if (seen.has(proposalId)) invalid("元素方案 ID 重复");
    seen.add(proposalId);
    const typeRaw = typeof card.type === "string" && ENTITY_TYPES.includes(card.type as Entity["type"]) ? (card.type as Entity["type"]) : fallbackType;
    const rawFacts = Array.isArray(card.proposedFacts) ? card.proposedFacts : [];
    const proposedFacts: ElementDesignFactProposal[] = rawFacts.slice(0, 20).map((f: unknown) => {
      if (!f || typeof f !== "object" || Array.isArray(f)) invalid("属性/关系事实提案格式无效");
      const fact = f as Record<string, unknown>;
      const predicate = text(fact.predicate, "事实谓词", 100);
      const semanticType: FactAssertion["semanticType"] =
        typeof fact.semanticType === "string" && SEMANTIC_TYPES.includes(fact.semanticType as FactAssertion["semanticType"])
          ? (fact.semanticType as FactAssertion["semanticType"])
          : "world_fact";
      let factVal: ElementDesignFactProposal["value"];
      if (fact.value && typeof fact.value === "object" && !Array.isArray(fact.value) && "entityName" in fact.value) {
        const ref = fact.value as Record<string, unknown>;
        factVal = {
          entityName: text(ref.entityName, "关联实体名称", 200),
          ...(typeof ref.entityId === "string" && ref.entityId.trim() ? { entityId: ref.entityId.trim() } : {}),
        };
      } else {
        factVal = text(String(fact.value ?? ""), "事实值", 1000);
      }
      return { predicate, value: factVal, semanticType };
    });

    const arcObj = card.arc && typeof card.arc === "object" && !Array.isArray(card.arc) ? (card.arc as Record<string, unknown>) : undefined;
    const worldObj = card.world && typeof card.world === "object" && !Array.isArray(card.world) ? (card.world as Record<string, unknown>) : undefined;
    const secretObj = card.secret && typeof card.secret === "object" && !Array.isArray(card.secret) ? (card.secret as Record<string, unknown>) : undefined;

    return {
      proposalId,
      type: typeRaw,
      name: text(card.name, "元素名称", 200),
      aliases: stringArray(card.aliases, "别名", 20, 200),
      summary: text(card.summary, "元素简介", 10000),
      differenceNote: typeof card.differenceNote === "string" && card.differenceNote.trim() ? text(card.differenceNote, "取向差异", 2000) : "独立设定方向",
      proposedFacts,
      ...(arcObj
        ? {
            arc: {
              motivation: text(arcObj.motivation ?? "", "抽象欲望", 4000, true),
              goal: text(arcObj.goal ?? "", "具体目标", 4000, true),
              conflict: text(arcObj.conflict ?? "", "核心阻碍", 4000, true),
              epiphany: text(arcObj.epiphany ?? "", "预期转变", 4000, true),
              notes: text(arcObj.notes ?? "", "弧线笔记", 4000, true),
            },
          }
        : {}),
      ...(worldObj
        ? {
            world: {
              constraints: stringArray(worldObj.constraints, "规则限制与代价", 10, 1000),
              sensoryDetails: stringArray(worldObj.sensoryDetails, "感官锚点", 10, 1000),
              storyHooks: stringArray(worldObj.storyHooks, "冲突钩子", 10, 1000),
            },
          }
        : {}),
      ...(secretObj
        ? {
            secret: {
              truth: text(secretObj.truth ?? "", "事实真相", 4000, true),
              falseBelief: text(secretObj.falseBelief ?? "", "表面假象", 4000, true),
              initialHolders: stringArray(secretObj.initialHolders, "初始知情人", 20, 200),
              revealCondition: text(secretObj.revealCondition ?? "", "揭示时机", 2000, true),
            },
          }
        : {}),
    };
  });
}

export function parseSceneProposalCards(raw: string, minCount = 1, maxCount = 6): SceneProposalCard[] {
  const value = parseJson(raw);
  const list = Array.isArray(value.scenes)
    ? value.scenes
    : Array.isArray(value.sceneCards)
      ? value.sceneCards
      : undefined;
  if (!Array.isArray(list) || list.length < minCount || list.length > maxCount) {
    invalid(`场景提案应包含 ${minCount}–${maxCount} 个场景`);
  }
  const seen = new Set<string>();
  return list.map((item: unknown, index: number): SceneProposalCard => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("场景提案格式无效");
    const scene = item as Record<string, unknown>;
    const proposalId = typeof scene.proposalId === "string" && scene.proposalId.trim() ? text(scene.proposalId, "提案 ID", 100) : `scene-${index + 1}`;
    if (seen.has(proposalId)) invalid("场景提案 ID 重复");
    seen.add(proposalId);
    return {
      proposalId,
      title: text(scene.title, "场景标题", 200),
      goal: text(scene.goal ?? "", "场景目标", 4000, true),
      conflict: text(scene.conflict ?? "", "场景阻碍", 4000, true),
      summary: text(scene.summary ?? "", "场景摘要", 4000),
      ...(typeof scene.pov === "string" && scene.pov.trim() ? { pov: text(scene.pov, "视角人物", 200) } : {}),
      ...(typeof scene.storyTime === "string" && scene.storyTime.trim() ? { storyTime: text(scene.storyTime, "故事时间", 200) } : {}),
      ...(typeof scene.differenceNote === "string" && scene.differenceNote.trim() ? { differenceNote: text(scene.differenceNote, "取向差异", 2000) } : {}),
    };
  });
}

export function parseSceneFieldOptions(raw: string): SceneFieldOption[] {
  const value = parseJson(raw);
  if (!Array.isArray(value.fieldOptions) || value.fieldOptions.length < 1 || value.fieldOptions.length > 5) {
    invalid("单字段急救应返回 1–5 个候选");
  }
  return value.fieldOptions.map((item: unknown, index: number): SceneFieldOption => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("字段候选格式无效");
    const opt = item as Record<string, unknown>;
    return {
      optionId: typeof opt.optionId === "string" && opt.optionId.trim() ? text(opt.optionId, "选项 ID", 100) : `opt-${index + 1}`,
      label: text(opt.label, "选项标签", 200),
      value: text(opt.value, "候选内容", 4000),
      rationale: text(opt.rationale ?? "", "设计理由", 2000, true),
    };
  });
}

export function parseArcProposals(raw: string): ArcAssistProposal[] {
  const value = parseJson(raw);
  if (!Array.isArray(value.proposals) || value.proposals.length < 1 || value.proposals.length > 4) {
    invalid("人物弧线推演应包含 1–4 套方案");
  }
  return value.proposals.map((item: unknown, index: number): ArcAssistProposal => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("人物弧线方案格式无效");
    const prop = item as Record<string, unknown>;
    return {
      proposalId: typeof prop.proposalId === "string" && prop.proposalId.trim() ? text(prop.proposalId, "方案 ID", 100) : `arc-${index + 1}`,
      label: text(prop.label ?? `弧线方案 ${index + 1}`, "方案名称", 200),
      differenceNote: text(prop.differenceNote ?? "不同人物变化路径", "取向说明", 2000),
      motivation: text(prop.motivation, "抽象欲望", 4000),
      goal: text(prop.goal, "具体目标", 4000),
      conflict: text(prop.conflict, "核心阻碍", 4000),
      epiphany: text(prop.epiphany, "预期转变", 4000),
      notes: text(prop.notes ?? "", "补充笔记", 4000, true),
    };
  });
}

export function parseArcDiagnosis(raw: string): ArcDiagnosisReport {
  const value = parseJson(raw);
  const unfulfilled = stringArray(value.unfulfilledConflicts, "尚未兑现的冲突", 20, 1000);
  const rawDilemmas = Array.isArray(value.nextDilemmaProposals) ? value.nextDilemmaProposals : [];
  const nextDilemmaProposals = rawDilemmas.slice(0, 6).map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("两难提案格式无效");
    const d = item as Record<string, unknown>;
    return {
      title: text(d.title, "两难标题", 200),
      conflict: text(d.conflict, "冲突焦点", 2000),
      choiceA: text(d.choiceA, "抉择 A", 1000),
      choiceB: text(d.choiceB, "抉择 B", 1000),
    };
  });
  return {
    progressSummary: text(value.progressSummary, "弧线进展评估", 4000),
    unfulfilledConflicts: unfulfilled,
    nextDilemmaProposals,
  };
}

const ELEMENT_GUIDE_STEPS: Record<string, readonly string[]> = {
  character: ["positioning", "conflict", "relationship"],
  secret: ["truth", "holders", "reveal"],
  default: ["core_rule", "cost", "story_hook"],
};

export function elementGuideStepsFor(type: Entity["type"]): readonly string[] {
  if (type === "character") return ELEMENT_GUIDE_STEPS.character!;
  if (type === "secret") return ELEMENT_GUIDE_STEPS.secret!;
  return ELEMENT_GUIDE_STEPS.default!;
}

/** 宿主状态机驱动的角色与世界观多轮问答引导服务。 */
export class ElementGuideService {
  private readonly nextRuns = new Map<string, Promise<ElementGuideSession>>();
  constructor(
    private readonly db: Database.Database,
    private readonly store: DomainStore,
    private readonly knowledge: KnowledgeService,
    private readonly pi: PiHost,
    private readonly assist: CreativeAssistService,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS element_guide_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      branch_id TEXT NOT NULL REFERENCES branches(branch_id),
      base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
      json TEXT NOT NULL
    )`);
  }

  current(projectId: string): ElementGuideSession | undefined {
    return (
      this.read("SELECT json FROM element_guide_sessions WHERE project_id=? AND json_extract(json,'$.status') IN ('active','ready') ORDER BY json_extract(json,'$.updatedAt') DESC", projectId) ??
      this.read("SELECT json FROM element_guide_sessions WHERE project_id=? AND json_extract(json,'$.status')='applied' ORDER BY json_extract(json,'$.updatedAt') DESC", projectId)
    );
  }

  get(sessionId: string): ElementGuideSession {
    const session = this.read("SELECT json FROM element_guide_sessions WHERE session_id=?", sessionId);
    if (!session) throw new DomainError(404, "ELEMENT_GUIDE_NOT_FOUND", "设定引导会话不存在");
    return session;
  }

  private read(sql: string, ...params: string[]): ElementGuideSession | undefined {
    const row = this.db.prepare(sql).get(...params) as { json?: string } | undefined;
    return row?.json ? (JSON.parse(row.json) as ElementGuideSession) : undefined;
  }

  private save(session: ElementGuideSession): ElementGuideSession {
    session.revision = (session.revision ?? 0) + 1;
    session.updatedAt = now();
    this.db.prepare("UPDATE element_guide_sessions SET json=? WHERE session_id=?").run(JSON.stringify(session), session.sessionId);
    return session;
  }

  async create(input: {
    projectId: string;
    type?: Entity["type"];
    targetEntityId?: string;
    prompt?: string;
    roleHint?: string;
    relatedEntityIds?: string[];
    forceNew?: boolean;
  }): Promise<ElementGuideSession> {
    const project = this.store.getProject(input.projectId);
    const type: Entity["type"] = input.type && ENTITY_TYPES.includes(input.type) ? input.type : "character";
    if (!input.forceNew) {
      const existing = this.read(
        "SELECT json FROM element_guide_sessions WHERE project_id=? AND json_extract(json,'$.status') IN ('active','ready') ORDER BY json_extract(json,'$.updatedAt') DESC",
        project.projectId,
      );
      if (existing && existing.type === type && existing.targetEntityId === input.targetEntityId) {
        return this.next(existing.sessionId);
      }
    }
    const branch = this.store.getBranch(project.activeBranchId);
    const timestamp = now();
    const session: ElementGuideSession = {
      sessionId: newId("elem_guide"),
      projectId: project.projectId,
      branchId: branch.branchId,
      baseRevisionId: branch.headRevisionId,
      type,
      ...(input.targetEntityId ? { targetEntityId: input.targetEntityId } : {}),
      ...(input.prompt ? { prompt: input.prompt.slice(0, 4000) } : {}),
      ...(input.roleHint ? { roleHint: input.roleHint.slice(0, 400) } : {}),
      relatedEntityIds: (input.relatedEntityIds ?? []).slice(0, 20),
      status: "active",
      stepIndex: 0,
      answers: [],
      questions: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare("INSERT INTO element_guide_sessions(session_id,project_id,branch_id,base_revision_id,json) VALUES(?,?,?,?,?)")
      .run(session.sessionId, project.projectId, branch.branchId, branch.headRevisionId, JSON.stringify(session));
    return this.next(session.sessionId);
  }

  async next(sessionId: string): Promise<ElementGuideSession> {
    const existing = this.nextRuns.get(sessionId);
    if (existing) return existing;
    const operation = this.performNext(sessionId);
    this.nextRuns.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.nextRuns.get(sessionId) === operation) this.nextRuns.delete(sessionId);
    }
  }

  private async performNext(sessionId: string): Promise<ElementGuideSession> {
    const session = this.get(sessionId);
    if (session.status !== "active") return session;
    if (session.pending) return session;
    const steps = elementGuideStepsFor(session.type);
    const stepId = steps[session.stepIndex] ?? "proposal";
    if (session.stepIndex < steps.length) {
      const cached = session.questions[stepId];
      if (cached) {
        session.pending = cached;
        return this.save(session);
      }
    }
    return this.generate(session, stepId);
  }

  private async generate(session: ElementGuideSession, stepId: string): Promise<ElementGuideSession> {
    const project = this.store.getProject(session.projectId);
    const steps = elementGuideStepsFor(session.type);
    const mode = session.stepIndex < steps.length ? "question" : "proposal";
    const entities = this.knowledge.listEntities(session.projectId);
    const targetEntity = session.targetEntityId ? entities.find((e) => e.entityId === session.targetEntityId) : undefined;
    const relatedEntities = entities.filter((e) => session.relatedEntityIds.includes(e.entityId));
    const inputPayload = {
      schema: ELEMENT_GUIDE_SCHEMA,
      mode,
      stepId,
      elementType: session.type,
      prompt: session.prompt ?? "",
      roleHint: session.roleHint ?? "",
      targetEntity: targetEntity ? { name: targetEntity.name, summary: targetEntity.summary, aliases: targetEntity.aliases } : undefined,
      relatedEntities: relatedEntities.map((e) => ({ name: e.name, type: e.type, summary: e.summary })),
      answers: session.answers,
    };
    const request: GenerationRequest = {
      projectId: session.projectId,
      kind: "guide",
      input: JSON.stringify(inputPayload),
      idempotencyKey: newId("elem_guide_step"),
    };
    const context = this.knowledge.queryContext({
      projectId: session.projectId,
      branchId: session.branchId,
      routeId: project.activeRouteId,
      revisionId: session.baseRevisionId,
      query: JSON.stringify(inputPayload),
      purpose: "planning",
    });
    const receipt = this.store.beginGeneration(request, context);
    try {
      const result = await this.pi.generate({ task: receipt.task, request, systemContext: "" });
      const latest = this.get(session.sessionId);
      if ((latest.revision ?? 0) !== (session.revision ?? 0)) {
        this.store.finishGeneration(receipt.task.taskId, { ...result, output: "guide" }, result.completeness);
        return latest;
      }
      if (result.completeness !== "complete" || !result.text.trim()) {
        throw new DomainError(502, "ELEMENT_GUIDE_INCOMPLETE", result.error ?? "设定引导生成尚未完整完成");
      }
      if (mode === "question") {
        const question = parseGuideQuestion(result.text, stepId);
        session.questions[stepId] = question;
        session.pending = question;
      } else {
        session.proposal = parseElementDesignCards(result.text, session.type);
        session.status = "ready";
      }
      this.save(session);
      this.store.finishGeneration(receipt.task.taskId, { output: "guide", text: result.text, sessionId: result.sessionId }, "complete");
      return session;
    } catch (error) {
      const latest = this.get(session.sessionId);
      if ((latest.revision ?? 0) !== (session.revision ?? 0)) {
        this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "设定引导生成失败");
        return latest;
      }
      this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "设定引导生成失败");
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, "ELEMENT_GUIDE_FAILED", error instanceof Error ? error.message : "设定引导生成失败");
    }
  }

  async answer(sessionId: string, input: { optionId?: string; custom?: string; skip?: boolean }): Promise<ElementGuideSession> {
    const session = this.get(sessionId);
    if (session.status !== "active" || !session.pending) throw new DomainError(409, "ELEMENT_GUIDE_STATE", "当前没有可回答的问题");
    const pending = session.pending;
    let answer: GuidedAnswer;
    if (input.skip === true) {
      if (!pending.allowSkip) throw new DomainError(400, "ELEMENT_GUIDE_STATE", "这一步不能跳过");
      answer = { stepId: pending.stepId, label: "暂时跳过", value: "", skipped: true };
    } else if (input.custom !== undefined && input.custom.trim()) {
      if (!pending.allowCustom) throw new DomainError(400, "ELEMENT_GUIDE_STATE", "这一步不能自定义回答");
      answer = { stepId: pending.stepId, label: "作者自答", value: text(input.custom, "自定义回答"), skipped: false };
    } else {
      const option = pending.options.find((item) => item.id === input.optionId);
      if (!option) throw new DomainError(400, "ELEMENT_GUIDE_STATE", "请选择一个选项或填写自己的回答");
      answer = { stepId: pending.stepId, label: option.label, value: option.detail, skipped: false };
    }
    session.answers = [...session.answers.filter((item) => item.stepId !== pending.stepId), answer];
    session.stepIndex += 1;
    delete session.pending;
    this.save(session);
    return this.next(sessionId);
  }

  back(sessionId: string): ElementGuideSession {
    const session = this.get(sessionId);
    if (session.stepIndex < 1 || session.status === "applied" || session.status === "cancelled") {
      throw new DomainError(409, "ELEMENT_GUIDE_STATE", "当前不能返回上一步");
    }
    session.stepIndex -= 1;
    session.answers = session.answers.slice(0, -1);
    delete session.proposal;
    session.status = "active";
    const steps = elementGuideStepsFor(session.type);
    const stepId = steps[session.stepIndex]!;
    const cached = session.questions[stepId];
    if (cached) session.pending = cached;
    else delete session.pending;
    return this.save(session);
  }

  cancel(sessionId: string): ElementGuideSession {
    const session = this.get(sessionId);
    if (session.status !== "applied") {
      session.status = "cancelled";
      delete session.pending;
      this.save(session);
    }
    return session;
  }

  updateProposal(sessionId: string, cards: unknown): ElementGuideSession {
    const session = this.get(sessionId);
    if (session.status !== "ready" || !session.proposal) throw new DomainError(409, "ELEMENT_GUIDE_STATE", "元素设定提案尚未就绪");
    session.proposal = parseElementDesignCards(JSON.stringify({ cards }), session.type);
    return this.save(session);
  }

  apply(sessionId: string, proposalId?: string, cardOverride?: ElementDesignCard): { session: ElementGuideSession; entity: Entity; arc?: CharacterArcProfile } {
    const session = this.get(sessionId);
    if (session.status === "applied" && session.appliedEntityId) {
      const entity = this.knowledge.listEntities(session.projectId).find((item) => item.entityId === session.appliedEntityId);
      if (entity) return { session, entity };
    }
    if (session.status !== "ready" || !session.proposal || session.proposal.length === 0) {
      throw new DomainError(409, "ELEMENT_GUIDE_STATE", "元素设定提案尚未就绪");
    }
    const chosen =
      cardOverride ??
      (proposalId ? session.proposal.find((item) => item.proposalId === proposalId) : session.proposal[0]);
    if (!chosen) throw new DomainError(400, "ELEMENT_GUIDE_INVALID_SELECTION", "所选方案卡不存在");
    const applied = this.assist.applyElementDesignCard({
      projectId: session.projectId,
      card: chosen,
      ...(session.targetEntityId ? { targetEntityId: session.targetEntityId } : {}),
      acceptanceId: `elem_guide_${session.sessionId}_${chosen.proposalId}`,
    });
    session.status = "applied";
    session.appliedEntityId = applied.entity.entityId;
    delete session.pending;
    this.save(session);
    return { session, ...applied };
  }
}

/** 全流程 AI 创作助手服务：元素卡片共创、人物弧线推演/诊断、局部情节推演、多便签孵化与正文反向抽取。 */
export class CreativeAssistService {
  private readonly appliedAcceptances = new Map<string, { payloadHash: string; result: unknown }>();

  constructor(
    private readonly db: Database.Database,
    private readonly store: DomainStore,
    private readonly knowledge: KnowledgeService,
    private readonly pi: PiHost,
  ) {}

  private queryContext(projectId: string, query: string, purpose: "planning" | "scene_writing" | "fact_check" = "planning", sceneId?: string) {
    const project = this.store.getProject(projectId);
    const branch = this.store.getBranch(project.activeBranchId);
    const scene = sceneId ? this.store.getScene(sceneId, branch.headRevisionId) : undefined;
    const storyOrder = scene ? parseStoryOrderFromTime(scene.storyTime) : undefined;
    return this.knowledge.queryContext({
      projectId,
      branchId: branch.branchId,
      routeId: scene?.routeId ?? project.activeRouteId,
      revisionId: branch.headRevisionId,
      query,
      purpose,
      ...(scene ? { narrationOrder: scene.narrationOrder } : {}),
      ...(storyOrder !== undefined ? { storyOrder } : {}),
    });
  }

  private async runStructuredTask(projectId: string, kind: GenerationRequest["kind"], payload: Record<string, unknown>, sceneId?: string): Promise<{ taskId: string; text: string }> {
    const input = JSON.stringify(payload);
    const request: GenerationRequest = {
      projectId,
      ...(sceneId ? { sceneId } : {}),
      kind,
      input,
      idempotencyKey: newId(`assist_${kind}`),
    };
    const purpose = kind === "consistency" ? "fact_check" : "planning";
    const receipt = this.store.beginGeneration(request, this.queryContext(projectId, input, purpose, sceneId));
    try {
      const result = await this.pi.generate({ task: receipt.task, request, systemContext: "" });
      if (result.completeness !== "complete" || !result.text.trim()) {
        this.store.finishGeneration(receipt.task.taskId, result, "partial");
        throw new DomainError(502, "ASSIST_INCOMPLETE", result.error ?? "AI 创作辅助生成尚未完整完成");
      }
      this.store.finishGeneration(receipt.task.taskId, { output: "guide", text: result.text, sessionId: result.sessionId }, "complete");
      return { taskId: receipt.task.taskId, text: result.text };
    } catch (error) {
      this.store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "AI 创作辅助失败");
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, "ASSIST_FAILED", error instanceof Error ? error.message : "AI 创作辅助失败");
    }
  }

  /** 1. 快速卡片共创：生成 2–3 张角色/世界观/秘密方案卡 */
  async generateElementDesign(input: {
    projectId: string;
    type?: Entity["type"];
    targetEntityId?: string;
    prompt: string;
    roleHint?: string;
    relatedEntityIds?: string[];
  }): Promise<{ artifactId: string; taskId: string; cards: ElementDesignCard[] }> {
    const project = this.store.getProject(input.projectId);
    const type: Entity["type"] = input.type && ENTITY_TYPES.includes(input.type) ? input.type : "character";
    const entities = this.knowledge.listEntities(project.projectId);
    const targetEntity = input.targetEntityId ? entities.find((e) => e.entityId === input.targetEntityId) : undefined;
    if (input.targetEntityId && !targetEntity) throw new DomainError(404, "NOT_FOUND", "目标元素不存在");
    const relatedEntities = entities.filter((e) => (input.relatedEntityIds ?? []).includes(e.entityId));
    const payload = {
      schema: ELEMENT_DESIGN_SCHEMA,
      elementType: type,
      prompt: requiredString(input.prompt, "构思描述", 4000),
      roleHint: input.roleHint ?? "",
      targetEntity: targetEntity ? { entityId: targetEntity.entityId, name: targetEntity.name, summary: targetEntity.summary, aliases: targetEntity.aliases } : undefined,
      relatedEntities: relatedEntities.map((e) => ({ entityId: e.entityId, name: e.name, type: e.type, summary: e.summary })),
    };
    const { taskId, text: outputText } = await this.runStructuredTask(project.projectId, "ideas", payload);
    const cards = parseElementDesignCards(outputText, type);
    const artifact = this.store.putArtifact(
      "element_design",
      { projectId: project.projectId, type, ...(input.targetEntityId ? { targetEntityId: input.targetEntityId } : {}), cards },
      taskId,
    );
    this.store.recordInteraction({ projectId: project.projectId, kind: "candidate-presented", actor: "system", meta: { assist: "element_design", type, count: cards.length } });
    return { artifactId: artifact.artifactId, taskId, cards };
  }

  /** 应用选定或混搭编辑后的 ElementDesignCard 到元素账本、人物弧线、事实与秘密知情事件 */
  applyElementDesignCard(input: {
    projectId: string;
    card: ElementDesignCard;
    targetEntityId?: string;
    routeId?: string;
    acceptanceId: string;
  }): { entity: Entity; arc?: CharacterArcProfile; facts: FactAssertion[]; events: WorldEvent[] } {
    const project = this.store.getProject(input.projectId);
    requiredString(input.acceptanceId, "acceptanceId", 200);
    const card = parseElementDesignCards(JSON.stringify({ cards: [input.card] }), input.card?.type ?? "character")[0]!;
    const payloadHash = stableHash({ projectId: project.projectId, card, targetEntityId: input.targetEntityId, routeId: input.routeId });
    const cached = this.appliedAcceptances.get(input.acceptanceId);
    if (cached) {
      if (cached.payloadHash !== payloadHash) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "acceptanceId 已绑定其他设定采用内容");
      return cached.result as { entity: Entity; arc?: CharacterArcProfile; facts: FactAssertion[]; events: WorldEvent[] };
    }
    if (!this.knowledge.addEntity) throw new DomainError(503, "ELEMENTS_UNAVAILABLE", "当前知识服务不支持元素写入");

    const routeId = input.routeId ?? project.activeRouteId;
    if (!this.store.listRoutes(project.projectId).some((r) => r.routeId === routeId)) {
      throw new DomainError(400, "SCOPE_MISMATCH", "故事路线不属于此作品");
    }

    let summaryParts = [card.summary];
    if (card.world) {
      if (card.world.constraints.length) summaryParts.push(`【规则与代价】${card.world.constraints.join("；")}`);
      if (card.world.sensoryDetails.length) summaryParts.push(`【感官细节】${card.world.sensoryDetails.join("；")}`);
      if (card.world.storyHooks.length) summaryParts.push(`【冲突钩子】${card.world.storyHooks.join("；")}`);
    }
    if (card.secret) {
      if (card.secret.truth) summaryParts.push(`【真相】${card.secret.truth}`);
      if (card.secret.falseBelief) summaryParts.push(`【表面假象】${card.secret.falseBelief}`);
      if (card.secret.revealCondition) summaryParts.push(`【揭示时机】${card.secret.revealCondition}`);
    }
    const finalSummary = summaryParts.filter(Boolean).join("\n");

    // 覆盖已有元素（targetEntityId 或重名/别名命中）时保留非空简介与原来源，
    // 并复用既有 entityId 合并写入，不产生第二个同名实体。
    const existingTarget = input.targetEntityId
      ? this.knowledge.listEntities(project.projectId).find((e) => e.entityId === input.targetEntityId)
      : this.knowledge.listEntities(project.projectId).find((e) => e.name === card.name || e.aliases.includes(card.name));
    const mergedSummary = finalSummary.trim() ? finalSummary.slice(0, 20000) : existingTarget?.summary ?? "";

    // 元素、别名、事实、事件与人物弧线同一事务写入：任一步失败整体回滚，不留半成品。
    const knowledge = this.knowledge;
    const applyCard = this.db.transaction((): { entity: Entity; arc?: CharacterArcProfile; facts: FactAssertion[]; events: WorldEvent[] } => {
      const entityId = knowledge.addEntity!({
        ...(existingTarget ? { entityId: existingTarget.entityId } : {}),
        projectId: project.projectId,
        type: card.type,
        name: card.name,
        summary: mergedSummary,
        routeId,
        sourceKind: existingTarget?.sourceKind ?? "author_setting",
        reviewState: "confirmed",
      });

      for (const alias of card.aliases) {
        this.knowledge.addAlias?.(project.projectId, entityId, alias);
      }

      const existingEntities = this.knowledge.listEntities(project.projectId);
      const resolveEntityRef = (nameOrId: string): Entity | undefined =>
        existingEntities.find((e) => e.entityId === nameOrId || e.name === nameOrId || e.aliases.includes(nameOrId));

      for (const factProp of card.proposedFacts) {
        let val: FactAssertion["value"];
        if (typeof factProp.value === "object" && factProp.value !== null && "entityName" in factProp.value) {
          const target = (factProp.value.entityId ? resolveEntityRef(factProp.value.entityId) : undefined) ?? resolveEntityRef(factProp.value.entityName);
          val = target ? { entityId: target.entityId } : factProp.value.entityName;
        } else {
          const matched = resolveEntityRef(String(factProp.value));
          val = matched && matched.entityId !== entityId ? { entityId: matched.entityId } : String(factProp.value);
        }
        this.knowledge.addFact?.({
          projectId: project.projectId,
          subjectId: entityId,
          predicate: factProp.predicate,
          value: val,
          semanticType: factProp.semanticType,
          reviewState: "confirmed",
          sourceKind: "author_setting",
          routeId,
        });
      }

      if (card.type === "secret" && card.secret) {
        if (card.secret.truth) {
          this.knowledge.addFact?.({
            projectId: project.projectId,
            subjectId: entityId,
            predicate: "truth",
            value: card.secret.truth,
            semanticType: "world_fact",
            reviewState: "confirmed",
            sourceKind: "author_setting",
            routeId,
          });
        }
        if (card.secret.falseBelief) {
          this.knowledge.addFact?.({
            projectId: project.projectId,
            subjectId: entityId,
            predicate: "false_belief",
            value: card.secret.falseBelief,
            semanticType: "deception",
            reviewState: "confirmed",
            sourceKind: "author_setting",
            routeId,
          });
        }
        for (const holderName of card.secret.initialHolders) {
          const holder = resolveEntityRef(holderName);
          this.knowledge.addEvent?.({
            projectId: project.projectId,
            kind: "known_by",
            routeId,
            storyOrder: 1,
            subjectId: entityId,
            toValue: holder ? holder.entityId : holderName,
            reviewState: "confirmed",
          });
          // 知情边界只有写成 known_by 事实才会被 secretVisibleTo 消费；事件仅供时间线展示。
          this.knowledge.addFact?.({
            projectId: project.projectId,
            subjectId: entityId,
            predicate: "known_by",
            value: holder ? { entityId: holder.entityId } : holderName,
            semanticType: "world_fact",
            reviewState: "confirmed",
            sourceKind: "author_setting",
            routeId,
            validFromOrder: 1,
          });
        }
        // 揭示条件记录为 revealed 边界事实：从此对全部视角可见（secretVisibleTo 只要求有效起点）。
        if (card.secret.revealCondition) {
          this.knowledge.addEvent?.({
            projectId: project.projectId,
            kind: "revealed",
            routeId,
            storyOrder: 1,
            subjectId: entityId,
            toValue: card.secret.revealCondition.slice(0, 500),
            reviewState: "confirmed",
          });
          this.knowledge.addFact?.({
            projectId: project.projectId,
            subjectId: entityId,
            predicate: "revealed",
            value: card.secret.revealCondition.slice(0, 2000),
            semanticType: "world_fact",
            reviewState: "confirmed",
            sourceKind: "author_setting",
            routeId,
            validFromOrder: 1,
          });
        }
      }

      let arc: CharacterArcProfile | undefined;
      if (card.type === "character" && card.arc) {
        const hasContent = Object.values(card.arc).some((v) => v.trim().length > 0);
        if (hasContent) {
          arc = this.store.saveCharacterArc(entityId, card.arc);
        }
      }

      const entity = this.knowledge.listEntities(project.projectId).find((e) => e.entityId === entityId)!;
      const facts = this.knowledge.listFacts(project.projectId).filter((f) => f.subjectId === entityId);
      const events = this.knowledge.listEvents(project.projectId).filter((ev) => ev.subjectId === entityId);
      return { entity, ...(arc ? { arc } : {}), facts, events };
    });
    const result = applyCard();
    this.appliedAcceptances.set(input.acceptanceId, { payloadHash, result });
    this.store.recordInteraction({ projectId: project.projectId, kind: "assist-applied", actor: "author", meta: { assist: "element_design", entityId: result.entity.entityId, type: card.type } });
    return result;
  }

  /** 2. 人物弧线 AI 推演与计划/实际事件对照诊断 */
  async assistCharacterArc(input: {
    projectId: string;
    entityId: string;
    mode: "propose" | "diagnose";
    prompt?: string;
  }): Promise<{ taskId: string; mode: "propose" | "diagnose"; proposals?: ArcAssistProposal[]; diagnosis?: ArcDiagnosisReport }> {
    const project = this.store.getProject(input.projectId);
    const entity = this.knowledge.listEntities(project.projectId).find((e) => e.entityId === input.entityId && e.type === "character");
    if (!entity) throw new DomainError(404, "NOT_FOUND", "人物不存在或不属于此作品");
    const currentArc = this.store.getCharacterArc(entity.entityId);
    const branch = this.store.getBranch(project.activeBranchId);
    const scenes = this.store.listScenes(project.projectId, branch.headRevisionId);
    const events = this.knowledge.listEvents(project.projectId).filter((ev) => ev.subjectId === entity.entityId || ev.toValue === entity.entityId);
    const facts = this.knowledge.listFacts(project.projectId).filter((f) => f.subjectId === entity.entityId);

    const payload = {
      schema: ARC_ASSIST_SCHEMA,
      mode: input.mode,
      prompt: input.prompt ?? "",
      character: { entityId: entity.entityId, name: entity.name, summary: entity.summary, aliases: entity.aliases },
      currentArc,
      facts: facts.map((f) => ({ predicate: f.predicate, value: f.value, semanticType: f.semanticType })),
      events: events.map((ev) => ({ kind: ev.kind, fromValue: ev.fromValue, toValue: ev.toValue, storyOrder: ev.storyOrder, storyTime: ev.storyTime })),
      scenes: scenes.map((s) => ({ title: s.title, goal: s.goal, conflict: s.conflict, summary: s.summary, narrationOrder: s.narrationOrder })),
    };

    const { taskId, text: outputText } = await this.runStructuredTask(project.projectId, "guide", payload);
    if (input.mode === "propose") {
      const proposals = parseArcProposals(outputText);
      this.store.putArtifact("arc_proposals", { projectId: project.projectId, entityId: entity.entityId, proposals }, taskId);
      return { taskId, mode: "propose", proposals };
    } else {
      const diagnosis = parseArcDiagnosis(outputText);
      this.store.putArtifact("arc_diagnosis", { projectId: project.projectId, entityId: entity.entityId, diagnosis }, taskId);
      return { taskId, mode: "diagnose", diagnosis };
    }
  }

  /** 3. 全周期局部情节推演（承接下一场、桥接过渡场、单场字段急救、单章拆细纲） */
  async ideatePlot(input: {
    projectId: string;
    mode: PlotIdeateMode;
    sceneId?: string;
    toSceneId?: string;
    chapterId?: string;
    fieldTarget?: "goal" | "conflict" | "summary";
    prompt?: string;
    reviewSummary?: string;
  }): Promise<PlotIdeateResult> {
    const project = this.store.getProject(input.projectId);
    const branch = this.store.getBranch(project.activeBranchId);
    const scenes = this.store.listScenes(project.projectId, branch.headRevisionId);
    const chapters = this.store.listChapters(project.projectId, branch.headRevisionId);

    if (!["next_scene", "bridge_scenes", "scene_brainstorm", "chapter_breakdown"].includes(input.mode)) {
      throw new DomainError(400, "INVALID_INPUT", "情节推演模式无效");
    }

    const fromScene = input.sceneId ? this.store.getScene(input.sceneId, branch.headRevisionId) : undefined;
    const toScene = input.toSceneId ? this.store.getScene(input.toSceneId, branch.headRevisionId) : undefined;
    const chapter = input.chapterId ? chapters.find((c) => c.chapterId === input.chapterId) : undefined;

    if ((input.mode === "next_scene" || input.mode === "scene_brainstorm") && !fromScene) {
      throw new DomainError(400, "INVALID_INPUT", "请指定参考场景");
    }
    if (input.mode === "bridge_scenes" && (!fromScene || !toScene)) {
      throw new DomainError(400, "INVALID_INPUT", "桥接推演需指定起始场景与目标场景");
    }
    if (input.mode === "chapter_breakdown" && !chapter) {
      throw new DomainError(400, "INVALID_INPUT", "单章拆细纲需指定目标章节");
    }

    const fieldTarget = input.fieldTarget ?? "conflict";
    const payload = {
      schema: PLOT_IDEATE_SCHEMA,
      mode: input.mode,
      fieldTarget: input.mode === "scene_brainstorm" ? fieldTarget : undefined,
      prompt: input.prompt ?? "",
      reviewSummary: input.reviewSummary ?? "",
      fromScene: fromScene
        ? {
            sceneId: fromScene.sceneId,
            title: fromScene.title,
            goal: fromScene.goal,
            conflict: fromScene.conflict,
            summary: fromScene.summary,
            pov: fromScene.pov,
            storyTime: fromScene.storyTime,
            bodyExcerpt: fromScene.body.slice(-1200),
          }
        : undefined,
      toScene: toScene
        ? {
            sceneId: toScene.sceneId,
            title: toScene.title,
            goal: toScene.goal,
            conflict: toScene.conflict,
            summary: toScene.summary,
            pov: toScene.pov,
            storyTime: toScene.storyTime,
          }
        : undefined,
      chapter: chapter ? { chapterId: chapter.chapterId, title: chapter.title, order: chapter.order } : undefined,
      existingOutline: scenes.map((s) => ({
        sceneId: s.sceneId,
        chapterId: s.chapterId,
        title: s.title,
        goal: s.goal,
        conflict: s.conflict,
        summary: s.summary,
        narrationOrder: s.narrationOrder,
      })),
    };

    const { taskId, text: outputText } = await this.runStructuredTask(project.projectId, "guide", payload, fromScene?.sceneId);
    if (input.mode === "scene_brainstorm") {
      const fieldOptions = parseSceneFieldOptions(outputText);
      const artifact = this.store.putArtifact(
        "plot_ideate",
        { projectId: project.projectId, mode: input.mode, sceneId: fromScene?.sceneId, fieldTarget, fieldOptions },
        taskId,
      );
      return { artifactId: artifact.artifactId, taskId, mode: input.mode, fieldTarget, fieldOptions };
    } else {
      const proposedScenes = parseSceneProposalCards(outputText, 1, 6);
      const artifact = this.store.putArtifact(
        "plot_ideate",
        {
          projectId: project.projectId,
          mode: input.mode,
          ...(fromScene ? { sceneId: fromScene.sceneId } : {}),
          ...(toScene ? { toSceneId: toScene.sceneId } : {}),
          ...(chapter ? { chapterId: chapter.chapterId } : {}),
          scenes: proposedScenes,
        },
        taskId,
      );
      return { artifactId: artifact.artifactId, taskId, mode: input.mode, scenes: proposedScenes };
    }
  }

  /** 采用局部情节推演结果（新增下一场/桥接场/章节细纲，或更新单场目标/阻碍/结果） */
  applyPlotIdeation(input: {
    projectId: string;
    baseRevisionId: string;
    acceptanceId: string;
    mode: PlotIdeateMode;
    sceneId?: string;
    chapterId?: string;
    scenes?: SceneProposalCard[];
    fieldTarget?: "goal" | "conflict" | "summary";
    fieldValue?: string;
  }): { revision: Revision; scenes: Scene[] } {
    const project = this.store.getProject(input.projectId);
    const branch = this.store.getBranch(project.activeBranchId);
    requiredString(input.acceptanceId, "acceptanceId", 200);
    requiredString(input.baseRevisionId, "baseRevisionId");

    if (input.mode === "scene_brainstorm") {
      const sceneId = requiredString(input.sceneId, "sceneId");
      const target = input.fieldTarget ?? "conflict";
      if (!["goal", "conflict", "summary"].includes(target)) throw new DomainError(400, "INVALID_INPUT", "目标字段无效");
      const value = requiredString(input.fieldValue, "fieldValue", 10000);
      const saved = this.store.saveScene(sceneId, {
        baseRevisionId: input.baseRevisionId,
        branchId: branch.branchId,
        acceptanceId: input.acceptanceId,
        patch: { [target]: value },
      });
      this.store.recordInteraction({ projectId: project.projectId, sceneId, kind: "assist-applied", actor: "author", meta: { assist: "scene_brainstorm", field: target } });
      return { revision: saved.revision, scenes: [saved.scene] };
    }

    const scenes = parseSceneProposalCards(JSON.stringify({ scenes: input.scenes }), 1, 10);
    const commitName =
      input.mode === "next_scene"
        ? "采用 AI 下一场提案"
        : input.mode === "bridge_scenes"
          ? "采用 AI 过渡桥接场景"
          : "采用 AI 章节拆细纲";
    const adopted = this.store.addScenes({
      projectId: project.projectId,
      branchId: branch.branchId,
      baseRevisionId: input.baseRevisionId,
      acceptanceId: input.acceptanceId,
      ...(input.chapterId ? { chapterId: input.chapterId } : {}),
      ...(input.sceneId ? { afterSceneId: input.sceneId } : {}),
      commitName,
      scenes,
    });
    this.store.recordInteraction({ projectId: project.projectId, kind: "assist-applied", actor: "author", meta: { assist: input.mode, count: adopted.scenes.length } });
    return adopted;
  }

  /** 4. 多便签 AI 孵化器（孵化为角色、世界观或串联场景卡） */
  async incubateNotes(input: {
    projectId: string;
    noteIds: string[];
    targetKind: NoteIncubateTarget;
    prompt?: string;
  }): Promise<NoteIncubateResult> {
    const project = this.store.getProject(input.projectId);
    if (!Array.isArray(input.noteIds) || input.noteIds.length < 1 || input.noteIds.length > 5) {
      throw new DomainError(400, "INVALID_INPUT", "请选择 1–5 条便签进行孵化");
    }
    if (!["character", "world", "scenes"].includes(input.targetKind)) {
      throw new DomainError(400, "INVALID_INPUT", "孵化目标类型无效");
    }
    const notes: AuthorNote[] = input.noteIds.map((id) => {
      const note = this.store.getNote(id);
      if (note.projectId !== project.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "便签不属于此作品");
      if (note.status === "archived") throw new DomainError(409, "NOTE_ARCHIVED", "已归档便签不能参与孵化");
      return note;
    });

    const payload = {
      schema: NOTE_INCUBATE_SCHEMA,
      targetKind: input.targetKind,
      prompt: input.prompt ?? "",
      notes: notes.map((n) => ({ noteId: n.noteId, title: n.title, body: n.body, tags: n.tags })),
    };

    const { taskId, text: outputText } = await this.runStructuredTask(project.projectId, "ideas", payload);
    if (input.targetKind === "scenes") {
      const sceneCards = parseSceneProposalCards(outputText, 1, 6);
      const artifact = this.store.putArtifact(
        "note_incubate",
        { projectId: project.projectId, noteIds: input.noteIds, targetKind: input.targetKind, sceneCards },
        taskId,
      );
      return { artifactId: artifact.artifactId, taskId, noteIds: input.noteIds, targetKind: input.targetKind, sceneCards };
    } else {
      const fallbackType: Entity["type"] = input.targetKind === "character" ? "character" : "rule";
      const elementCards = parseElementDesignCards(outputText, fallbackType);
      const artifact = this.store.putArtifact(
        "note_incubate",
        { projectId: project.projectId, noteIds: input.noteIds, targetKind: input.targetKind, elementCards },
        taskId,
      );
      return { artifactId: artifact.artifactId, taskId, noteIds: input.noteIds, targetKind: input.targetKind, elementCards };
    }
  }

  /** 采用多便签孵化结果并自动关联原便签 */
  applyNoteIncubation(input: {
    projectId: string;
    noteIds: string[];
    targetKind: NoteIncubateTarget;
    baseRevisionId: string;
    acceptanceId: string;
    elementCard?: ElementDesignCard;
    sceneCards?: SceneProposalCard[];
    chapterId?: string;
  }): { notes: AuthorNote[]; entity?: Entity; revision?: Revision; scenes?: Scene[] } {
    const project = this.store.getProject(input.projectId);
    if (!Array.isArray(input.noteIds) || input.noteIds.length < 1 || input.noteIds.length > 5) {
      throw new DomainError(400, "INVALID_INPUT", "便签列表无效");
    }
    for (const id of input.noteIds) {
      const note = this.store.getNote(id);
      if (note.projectId !== project.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "便签不属于此作品");
    }

    if (input.targetKind === "scenes") {
      const adopted = this.applyPlotIdeation({
        projectId: project.projectId,
        baseRevisionId: input.baseRevisionId,
        acceptanceId: input.acceptanceId,
        mode: "chapter_breakdown",
        ...(input.chapterId ? { chapterId: input.chapterId } : {}),
        scenes: input.sceneCards ?? [],
      });
      const firstSceneId = adopted.scenes[0]?.sceneId;
      const notes = input.noteIds.map((id) =>
        this.store.updateNote(id, { status: "linked", ...(firstSceneId ? { sceneId: firstSceneId } : {}) }),
      );
      return { notes, revision: adopted.revision, scenes: adopted.scenes };
    } else {
      if (!input.elementCard) throw new DomainError(400, "INVALID_INPUT", "缺少要采用的元素方案卡");
      const applied = this.applyElementDesignCard({
        projectId: project.projectId,
        card: input.elementCard,
        acceptanceId: input.acceptanceId,
      });
      const notes = input.noteIds.map((id) =>
        this.store.updateNote(id, { status: "linked", elementId: applied.entity.entityId }),
      );
      return { notes, entity: applied.entity };
    }
  }

  /** 5. 正文反向抽取元素与事实（强制核验原句 quote 并绑定确定性 evidenceId） */
  async extractLedgerFromScene(input: {
    projectId: string;
    sceneId: string;
  }): Promise<ExtractedLedgerBundle> {
    const project = this.store.getProject(input.projectId);
    const branch = this.store.getBranch(project.activeBranchId);
    const revisionId = branch.headRevisionId;
    const scene = this.store.getScene(input.sceneId, revisionId);
    if (scene.projectId !== project.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "场景不属于此作品");
    if (!scene.body.trim()) throw new DomainError(400, "EMPTY_SCENE_BODY", "当前场景正文为空，请先写作或采用正文后再提取");

    // 确保当前场景在当前修订已完成段落证据索引
    this.knowledge.indexScene(scene, revisionId);

    const blocks = scene.body
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    const effectiveBlocks = blocks.length > 0 ? blocks : [scene.body.trim()];
    const blockEvidence = effectiveBlocks.map((block, index) => {
      const blockId = `${scene.sceneId}_b${index + 1}`;
      const evidenceId = `evidence_${createHash("sha256").update(`${scene.projectId}:${revisionId}:${scene.sceneId}:${blockId}:${block}`).digest("hex").slice(0, 24)}`;
      return { block, blockId, evidenceId };
    });

    const matchQuoteEvidence = (quoteRaw: string): { quote: string; evidenceId: string } | undefined => {
      const trimmed = quoteRaw.trim();
      if (!trimmed) return undefined;
      const matched = blockEvidence.find((item) => item.block.includes(trimmed) || trimmed.includes(item.block));
      if (matched) return { quote: matched.block, evidenceId: matched.evidenceId };
      if (scene.body.includes(trimmed) && blockEvidence[0]) {
        return { quote: blockEvidence[0].block, evidenceId: blockEvidence[0].evidenceId };
      }
      return undefined;
    };

    const entities = this.knowledge.listEntities(project.projectId);
    const payload = {
      schema: EXTRACT_LEDGER_SCHEMA,
      sceneId: scene.sceneId,
      sceneTitle: scene.title,
      storyTime: scene.storyTime ?? "",
      pov: scene.pov ?? "",
      existingEntities: entities.map((e) => ({ entityId: e.entityId, name: e.name, type: e.type, aliases: e.aliases })),
    };

    const { taskId, text: outputText } = await this.runStructuredTask(project.projectId, "consistency", payload, scene.sceneId);
    const parsed = parseJson(outputText);
    const rawElements = Array.isArray(parsed.newElements) ? parsed.newElements : [];
    const rawFacts = Array.isArray(parsed.factProposals) ? parsed.factProposals : [];
    const rawEvents = Array.isArray(parsed.eventProposals) ? parsed.eventProposals : [];

    let filteredOutCount = 0;
    const newElements: ExtractedElementProposal[] = [];
    for (let i = 0; i < rawElements.length; i++) {
      const item = rawElements[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const quoteStr = typeof obj.quote === "string" ? obj.quote : "";
      const matched = matchQuoteEvidence(quoteStr);
      if (!matched) {
        filteredOutCount += 1;
        continue;
      }
      const type: Entity["type"] = typeof obj.type === "string" && ENTITY_TYPES.includes(obj.type as Entity["type"]) ? (obj.type as Entity["type"]) : "item";
      newElements.push({
        proposalId: typeof obj.proposalId === "string" && obj.proposalId.trim() ? obj.proposalId.trim() : `ne-${i + 1}`,
        type,
        name: text(obj.name, "提取元素名称", 200),
        aliases: stringArray(obj.aliases, "别名", 10, 200),
        summary: text(obj.summary ?? "", "提取元素简介", 4000, true),
        quote: matched.quote,
        evidenceId: matched.evidenceId,
      });
    }

    const resolveExistingId = (name: string): string | undefined =>
      entities.find((e) => e.name === name || e.aliases.includes(name))?.entityId;

    const factProposals: ExtractedFactProposal[] = [];
    for (let i = 0; i < rawFacts.length; i++) {
      const item = rawFacts[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const quoteStr = typeof obj.quote === "string" ? obj.quote : "";
      const matched = matchQuoteEvidence(quoteStr);
      if (!matched) {
        filteredOutCount += 1;
        continue;
      }
      const subjectName = text(obj.subjectName, "事实主体名称", 200);
      const subjectId = resolveExistingId(subjectName);
      const semanticType: FactAssertion["semanticType"] =
        typeof obj.semanticType === "string" && SEMANTIC_TYPES.includes(obj.semanticType as FactAssertion["semanticType"])
          ? (obj.semanticType as FactAssertion["semanticType"])
          : "world_fact";
      factProposals.push({
        proposalId: typeof obj.proposalId === "string" && obj.proposalId.trim() ? obj.proposalId.trim() : `fp-${i + 1}`,
        subjectName,
        ...(subjectId ? { subjectId } : {}),
        predicate: text(obj.predicate, "事实谓词", 100),
        value: text(String(obj.value ?? ""), "事实值", 1000),
        semanticType,
        quote: matched.quote,
        evidenceId: matched.evidenceId,
      });
    }

    const eventProposals: ExtractedEventProposal[] = [];
    for (let i = 0; i < rawEvents.length; i++) {
      const item = rawEvents[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      const quoteStr = typeof obj.quote === "string" ? obj.quote : "";
      const matched = matchQuoteEvidence(quoteStr);
      if (!matched) {
        filteredOutCount += 1;
        continue;
      }
      const subjectName = text(obj.subjectName, "事件主体名称", 200);
      const subjectId = resolveExistingId(subjectName);
      eventProposals.push({
        proposalId: typeof obj.proposalId === "string" && obj.proposalId.trim() ? obj.proposalId.trim() : `ep-${i + 1}`,
        subjectName,
        ...(subjectId ? { subjectId } : {}),
        kind: text(obj.kind ?? "status.change", "事件类型", 100),
        ...(typeof obj.fromValue === "string" && obj.fromValue.trim() ? { fromValue: obj.fromValue.trim().slice(0, 500) } : {}),
        toValue: text(obj.toValue, "变化后状态", 500),
        ...(typeof obj.storyTime === "string" && obj.storyTime.trim() ? { storyTime: obj.storyTime.trim().slice(0, 200) } : scene.storyTime ? { storyTime: scene.storyTime } : {}),
        quote: matched.quote,
        evidenceId: matched.evidenceId,
      });
    }

    const bundleBase = {
      taskId,
      sceneId: scene.sceneId,
      revisionId,
      newElements,
      factProposals,
      eventProposals,
      filteredOutCount,
    };
    const artifact = this.store.putArtifact("extracted_ledger", { projectId: project.projectId, ...bundleBase }, taskId);
    return { artifactId: artifact.artifactId, ...bundleBase };
  }

  /** 审阅确认并入库正文反向抽取的元素、事实与状态变化事件；提案正文来自服务端冻结产物。 */
  applyExtractedLedger(input: ApplyExtractedLedgerInput & { acceptanceId: string }): { entities: Entity[]; facts: FactAssertion[]; events: WorldEvent[]; revision?: Revision } {
    const project = this.store.getProject(input.projectId);
    const branch = this.store.getBranch(project.activeBranchId);
    const scene = this.store.getScene(input.sceneId, branch.headRevisionId);
    if (scene.projectId !== project.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "场景不属于此作品");
    requiredString(input.acceptanceId, "acceptanceId", 200);
    const artifact = this.store.getArtifact<ExtractedLedgerBundle & { projectId: string }>(requiredString(input.artifactId, "artifactId", 200));
    if (artifact.kind !== "extracted_ledger" || artifact.value.projectId !== project.projectId || artifact.value.sceneId !== scene.sceneId) throw new DomainError(400, "SCOPE_MISMATCH", "提取产物不属于此作品场景");
    const selectedIds = input.selectedProposalIds;
    if (!Array.isArray(selectedIds) || selectedIds.length === 0 || new Set(selectedIds).size !== selectedIds.length) throw new DomainError(400, "EMPTY_EXTRACTION_SELECTION", "请至少选择一项提取提案，且不能重复选择");
    const originalProposals = [...artifact.value.newElements, ...artifact.value.factProposals, ...artifact.value.eventProposals];
    const originalIds = new Set(originalProposals.map(item => item.proposalId));
    if (selectedIds.some(id => !originalIds.has(id))) throw new DomainError(400, "INVALID_EXTRACTION_SELECTION", "选中项不属于此提取产物");
    const edits = input.proposalEdits ?? {};
    for (const [proposalId, edit] of Object.entries(edits)) {
      if (!originalIds.has(proposalId) || !selectedIds.includes(proposalId) || !edit || typeof edit !== "object") throw new DomainError(400, "INVALID_EXTRACTION_EDIT", "修改内容不属于当前选中提案");
      if (["proposalId", "quote", "evidenceId"].some(key => key in edit)) throw new DomainError(400, "IMMUTABLE_EXTRACTION_EVIDENCE", "提案 ID、原文引文和证据不可修改");
    }
    const selected = <T extends { proposalId: string }>(items: T[]): T[] => items.filter(item => selectedIds.includes(item.proposalId));
    const newElements = selected(artifact.value.newElements).map(item => {
      const edit = edits[item.proposalId];
      return { ...item,
        ...(edit?.name !== undefined ? { name: edit.name } : {}),
        ...(edit?.aliases !== undefined ? { aliases: edit.aliases } : {}),
        ...(edit?.summary !== undefined ? { summary: edit.summary } : {}),
        ...(edit?.type !== undefined ? { type: edit.type } : {}),
      };
    });
    const factProposals = selected(artifact.value.factProposals).map(item => {
      const edit = edits[item.proposalId];
      return { ...item,
        ...(edit?.subjectName !== undefined ? { subjectName: edit.subjectName } : {}),
        ...(edit?.predicate !== undefined ? { predicate: edit.predicate } : {}),
        ...(edit?.value !== undefined ? { value: edit.value } : {}),
        ...(edit?.semanticType !== undefined ? { semanticType: edit.semanticType } : {}),
      };
    });
    const eventProposals = selected(artifact.value.eventProposals).map(item => {
      const edit = edits[item.proposalId];
      return { ...item,
        ...(edit?.subjectName !== undefined ? { subjectName: edit.subjectName } : {}),
        ...(edit?.kind !== undefined ? { kind: edit.kind } : {}),
        ...(edit?.fromValue !== undefined ? { fromValue: edit.fromValue } : {}),
        ...(edit?.toValue !== undefined ? { toValue: edit.toValue } : {}),
        ...(edit?.storyTime !== undefined ? { storyTime: edit.storyTime } : {}),
      };
    });
    const payloadHash = stableHash({ projectId: project.projectId, sceneId: scene.sceneId, artifactId: artifact.artifactId, selectedProposalIds: selectedIds, proposalEdits: edits });
    const cached = this.appliedAcceptances.get(input.acceptanceId);
    if (cached) {
      if (cached.payloadHash !== payloadHash) throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "acceptanceId 已绑定其他提取采用内容");
      return cached.result as { entities: Entity[]; facts: FactAssertion[]; events: WorldEvent[]; revision?: Revision };
    }

    const sourceScene = this.store.getScene(scene.sceneId, artifact.value.revisionId);
    if (sourceScene.body !== scene.body) throw new DomainError(409, "SCENE_CHANGED", "正文在提取后已修改，请重新执行「从本场提取设定」后再确认入库");
    this.knowledge.indexScene(scene, branch.headRevisionId);
    const currentEvidence = this.knowledge.listSceneEvidence?.(project.projectId, scene.sceneId, branch.headRevisionId)
      ?? this.store.listKnowledgeEvidence(project.projectId).filter(ev => ev.sceneId === scene.sceneId && ev.sourceRevisionId === branch.headRevisionId);
    const originalEvidence = this.store.listKnowledgeEvidence(project.projectId).filter(ev => ev.sourceRevisionId === artifact.value.revisionId);
    const rebind = <T extends { evidenceId: string; quote: string }>(proposal: T): T => {
      const original = originalEvidence.find(item => item.evidenceId === proposal.evidenceId);
      const matches = currentEvidence.filter(item => item.quote === proposal.quote && (!original?.blockId || item.blockId === original.blockId));
      if (matches.length !== 1) throw new DomainError(400, "INVALID_EVIDENCE", "提案在当前场景中缺少唯一有效的段落证据");
      return { ...proposal, evidenceId: matches[0]!.evidenceId };
    };
    const reviewedElements = newElements.map(rebind);
    const reviewedFacts = factProposals.map(rebind);
    const reviewedEvents = eventProposals.map(rebind);
    const validEvidenceIds = new Set(currentEvidence.map(item => item.evidenceId));

    const createdEntities: Entity[] = [];
    const createdFacts: FactAssertion[] = [];
    const createdEvents: WorldEvent[] = [];
    const storyOrder = parseStoryOrderFromTime(scene.storyTime);
    let revision: Revision | undefined;
    // 元素、事实、事件与场景关联同事务写入：任一步失败整体回滚，不留半成品。
    const applyAll = this.db.transaction(() => {
      const nameToEntityId = new Map<string, string>();
      for (const existing of this.knowledge.listEntities(project.projectId)) {
        nameToEntityId.set(existing.name, existing.entityId);
        for (const alias of existing.aliases) nameToEntityId.set(alias, existing.entityId);
      }

      for (const elem of reviewedElements) {
        if (!validEvidenceIds.has(elem.evidenceId)) {
          throw new DomainError(400, "INVALID_EVIDENCE", `提取元素「${elem.name}」缺少当前场景正文的有效证据`);
        }
        const existingId = nameToEntityId.get(elem.name);
        // 命中已有元素时保留其简介与来源，不用空摘要覆盖。
        const existingEntity = existingId ? this.knowledge.listEntities(project.projectId).find((e) => e.entityId === existingId) : undefined;
        const nextSummary = typeof elem.summary === "string" && elem.summary.trim() ? elem.summary.slice(0, 10000) : existingEntity?.summary ?? "";
        const entityId = this.knowledge.addEntity!({
          ...(existingId ? { entityId: existingId } : {}),
          projectId: project.projectId,
          type: ENTITY_TYPES.includes(elem.type) ? elem.type : "item",
          name: requiredString(elem.name, "name", 200),
          summary: nextSummary,
          routeId: scene.routeId,
          sourceKind: existingEntity?.sourceKind ?? "manuscript",
          reviewState: "confirmed",
        });
        nameToEntityId.set(elem.name, entityId);
        for (const alias of elem.aliases ?? []) {
          this.knowledge.addAlias?.(project.projectId, entityId, alias);
          nameToEntityId.set(alias, entityId);
        }
        const saved = this.knowledge.listEntities(project.projectId).find((e) => e.entityId === entityId);
        if (saved && !createdEntities.some((e) => e.entityId === entityId)) createdEntities.push(saved);
      }

      for (const fact of reviewedFacts) {
        if (!validEvidenceIds.has(fact.evidenceId)) {
          throw new DomainError(400, "INVALID_EVIDENCE", `提取事实「${fact.subjectName} · ${fact.predicate}」缺少当前场景正文的有效证据`);
        }
        const subjectId = fact.subjectId ?? nameToEntityId.get(fact.subjectName);
        if (!subjectId) {
          throw new DomainError(400, "SUBJECT_NOT_FOUND", `事实主体「${fact.subjectName}」尚未入库，请先勾选或创建对应元素`);
        }
        const targetEntityId = nameToEntityId.get(fact.value);
        const value: FactAssertion["value"] = targetEntityId && targetEntityId !== subjectId ? { entityId: targetEntityId } : fact.value;
        const factId = this.knowledge.addFact!({
          projectId: project.projectId,
          subjectId,
          predicate: requiredString(fact.predicate, "predicate", 100),
          value,
          semanticType: SEMANTIC_TYPES.includes(fact.semanticType) ? fact.semanticType : "world_fact",
          reviewState: "confirmed",
          sourceKind: "manuscript",
          routeId: scene.routeId,
          ...(storyOrder !== undefined ? { validFromOrder: storyOrder } : {}),
          evidenceIds: [fact.evidenceId],
        });
        const saved = this.knowledge.listFacts(project.projectId).find((f) => f.factId === factId);
        if (saved) createdFacts.push(saved);
      }

      for (const ev of reviewedEvents) {
        if (!validEvidenceIds.has(ev.evidenceId)) {
          throw new DomainError(400, "INVALID_EVIDENCE", `提取事件「${ev.subjectName} · ${ev.kind}」缺少当前场景正文的有效证据`);
        }
        const subjectId = ev.subjectId ?? nameToEntityId.get(ev.subjectName);
        if (!subjectId) {
          throw new DomainError(400, "SUBJECT_NOT_FOUND", `事件主体「${ev.subjectName}」尚未入库，请先勾选或创建对应元素`);
        }
        const resolvedStoryTime = ev.storyTime ?? scene.storyTime;
        const eventId = this.knowledge.addEvent!({
          projectId: project.projectId,
          kind: requiredString(ev.kind, "kind", 100),
          sceneId: scene.sceneId,
          routeId: scene.routeId,
          ...(resolvedStoryTime ? { storyTime: resolvedStoryTime } : {}),
          ...(storyOrder !== undefined ? { storyOrder } : {}),
          subjectId,
          ...(ev.fromValue ? { fromValue: ev.fromValue } : {}),
          toValue: requiredString(ev.toValue, "toValue", 500),
          reviewState: "confirmed",
          evidenceIds: [ev.evidenceId],
        });
        const saved = this.knowledge.listEvents(project.projectId).find((item) => item.eventId === eventId);
        if (saved) createdEvents.push(saved);
      }

      // 把新关联的元素写入当前场景的 entityIds（产生新修订并推进分支头）
      const mergedEntityIds = [...new Set([...scene.entityIds, ...createdEntities.map((e) => e.entityId)])];
      if (mergedEntityIds.length !== scene.entityIds.length) {
        const saved = this.store.saveScene(scene.sceneId, {
          baseRevisionId: branch.headRevisionId,
          branchId: branch.branchId,
          acceptanceId: `${input.acceptanceId}_scene_links`,
          patch: { entityIds: mergedEntityIds },
        });
        revision = saved.revision;
      }
    });
    applyAll();

    // 事实/事件证据绑定的是写入时的修订；saveScene 推进分支头后，须把证据重绑到新修订，
    // 否则 factSourceValid 在新 head 下判 source_missing，刚入库的事实立即不可见。
    // 这里只重写事实/事件的引用（旧→新确定性 evidenceId 映射）；kw_evidence 行本身由
    // 路由随后调用的 indexRevision(新修订) 按 writeSceneIndex 的确定性公式重建——
    // 两处必须使用同一哈希公式且 indexRevision 必须执行，缺失时新头下证据行不存在。
    if (revision) {
      const newRevisionId = revision.revisionId;
      const blockRows = this.db
        .prepare(
          "SELECT evidence_id, block_id, quote FROM kw_evidence WHERE project_id = ? AND source_revision_id = ? AND scene_id = ? AND source_kind = 'manuscript'",
        )
        .all(project.projectId, branch.headRevisionId, scene.sceneId) as Array<{ evidence_id: string; block_id: string | null; quote: string }>;
      const idFor = (blockId: string | null, quote: string) =>
        `evidence_${createHash("sha256").update(`${project.projectId}:${newRevisionId}:${scene.sceneId}:${blockId ?? `${scene.sceneId}_b1`}:${quote}`).digest("hex").slice(0, 24)}`;
      const oldToNew = new Map<string, string>();
      for (const row of blockRows) {
        const newId = idFor(row.block_id, row.quote);
        if (newId !== row.evidence_id) oldToNew.set(row.evidence_id, newId);
      }
      const remap = (ids: string[]) => ids.map((id) => oldToNew.get(id) ?? id);
      for (const fact of createdFacts) {
        fact.evidenceIds = remap(fact.evidenceIds);
        this.knowledge.addFact!({
          factId: fact.factId,
          projectId: project.projectId,
          subjectId: fact.subjectId,
          predicate: fact.predicate,
          value: fact.value,
          semanticType: fact.semanticType,
          reviewState: fact.reviewState,
          sourceKind: fact.sourceKind,
          routeId: fact.routeId,
          ...(fact.validFrom !== undefined ? { validFromOrder: Number(fact.validFrom) } : {}),
          ...(fact.validTo !== undefined ? { validToOrder: Number(fact.validTo) } : {}),
          evidenceIds: remap(fact.evidenceIds),
        });
      }
      for (const ev of createdEvents) {
        ev.evidenceIds = remap(ev.evidenceIds);
        this.knowledge.addEvent!({
          eventId: ev.eventId,
          projectId: project.projectId,
          kind: ev.kind,
          ...(ev.sceneId !== undefined ? { sceneId: ev.sceneId } : {}),
          routeId: ev.routeId,
          ...(ev.storyTime !== undefined ? { storyTime: ev.storyTime } : {}),
          storyOrder: ev.storyOrder,
          subjectId: ev.subjectId,
          ...(ev.fromValue !== undefined ? { fromValue: ev.fromValue } : {}),
          toValue: ev.toValue ?? "",
          ...(ev.location !== undefined ? { location: ev.location } : {}),
          reviewState: ev.reviewState,
          evidenceIds: remap(ev.evidenceIds),
        });
      }
    }

    const result = { entities: createdEntities, facts: createdFacts, events: createdEvents, ...(revision ? { revision } : {}) };
    this.appliedAcceptances.set(input.acceptanceId, { payloadHash, result });
    this.store.recordInteraction({
      projectId: project.projectId,
      sceneId: scene.sceneId,
      kind: "assist-applied",
      actor: "author",
      meta: { assist: "extract_ledger", elements: createdEntities.length, facts: createdFacts.length, events: createdEvents.length },
    });
    return result;
  }
}
