import type { AgentTask, ContextBundle, ContextQuery, NodePortType } from "@nova-novel/shared";
import type { ConsistencyIssue } from "../contracts.js";
import { sha256 } from "../utils.js";
import type {
  DraftArtifactValue,
  DecisionRecordValue,
  IssueReportValue,
  NodeExecContext,
  NodeOutputSpec,
  NodeTypeSpec,
  SceneRefValue,
} from "./types.js";

/** 节点类型登记簿：只接受已登记的 type + typeVersion。 */
export class NodeTypeRegistry {
  private readonly specs = new Map<string, NodeTypeSpec>();

  register(spec: NodeTypeSpec): void {
    this.specs.set(keyOf(spec.type, spec.typeVersion), spec);
  }

  get(type: string, typeVersion: number): NodeTypeSpec | undefined {
    return this.specs.get(keyOf(type, typeVersion));
  }

  list(): NodeTypeSpec[] {
    return [...this.specs.values()];
  }

  outputsOf(
    spec: NodeTypeSpec,
    config: Record<string, unknown>,
  ): Record<string, NodeOutputSpec> {
    return typeof spec.outputs === "function" ? spec.outputs(config) : spec.outputs;
  }
}

function keyOf(type: string, typeVersion: number): string {
  return `${type}@${typeVersion}`;
}

function sceneRefOf(value: unknown): SceneRefValue {
  const ref = value as SceneRefValue | undefined;
  if (!ref || typeof ref.sceneId !== "string") {
    throw new Error("场景输入缺失或格式不正确");
  }
  return ref;
}

function sceneIdOf(ctx: NodeExecContext): string | undefined {
  const raw = ctx.runInput.sceneId;
  return typeof raw === "string" ? raw : undefined;
}

function parseIssues(text: string): ConsistencyIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { issues?: unknown }).issues)
      ? ((parsed as { issues: unknown[] }).issues as unknown[])
      : [];
  const issues: ConsistencyIssue[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const severity = record.severity;
    issues.push({
      issueId: typeof record.issueId === "string" ? record.issueId : `iss_${issues.length + 1}`,
      severity:
        severity === "conflict" || severity === "aesthetic" || severity === "unknown"
          ? severity
          : "unknown",
      title: typeof record.title === "string" ? record.title : "未命名问题",
      detail: typeof record.detail === "string" ? record.detail : "",
      evidence: Array.isArray(record.evidence)
        ? record.evidence.filter((item): item is string => typeof item === "string")
        : [],
      certainty: record.certainty === "confirmed" ? "confirmed" : "possible",
    });
  }
  return issues;
}

function buildReport(text: string, taskId: string): IssueReportValue {
  const issues = parseIssues(text);
  if (issues.length === 0) {
    // 结构化结果缺失时只记为未知级别，不判定为错误。
    issues.push({
      issueId: "iss_unknown_1",
      severity: "unknown",
      title: "一致性检查未返回结构化问题",
      detail: text.slice(0, 500),
      evidence: [],
      certainty: "possible",
    });
  }
  return {
    reportId: `rep_${taskId}`,
    issues,
    summary: `${issues.length} 条待核对项`,
    sourceTaskId: taskId,
  };
}

function mergeReports(reports: unknown[]): IssueReportValue {
  const issues: ConsistencyIssue[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    const list = (report as { issues?: unknown }).issues;
    if (!Array.isArray(list)) continue;
    for (const issue of list) {
      if (!issue || typeof issue !== "object") continue;
      const record = issue as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title : "未命名问题";
      const key = `${title}|${typeof record.detail === "string" ? record.detail : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue as ConsistencyIssue);
    }
  }
  const rank: Record<string, number> = { conflict: 0, unknown: 1, aesthetic: 2 };
  issues.sort((left, right) => (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3));
  return {
    reportId: `rep_merged_${issues.length}`,
    issues,
    summary: `合并 ${reports.length} 份报告，去重后 ${issues.length} 条`,
    sourceTaskId: undefined,
  };
}

/** 判断条件出口：true / false / unknown 三种，未知不当作 false。 */
export function evaluateCondition(value: unknown): "true" | "false" | "unknown" {
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return value === 0 ? "false" : "true";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "是", "通过", "accept", "ok", "true。"].includes(normalized)) return "true";
    if (["false", "no", "否", "不通过", "reject", "驳回"].includes(normalized)) return "false";
    return "unknown";
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.outcome === "string" || typeof record.outcome === "boolean") {
      return evaluateCondition(record.outcome);
    }
    if (typeof record.approved === "boolean") return record.approved ? "true" : "false";
    if (typeof record.severity === "string" && record.severity === "conflict") return "true";
  }
  return "unknown";
}

/** 人工答案是否构成接受。只有明确的接受语义才允许提交修订。 */
export function isApproval(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  const rejectWords = ["reject", "拒绝", "退回", "驳回", "不行", "否", "不同意", "revise", "重写"];
  if (rejectWords.some((word) => normalized.includes(word))) return false;
  const acceptWords = ["accept", "接受", "同意", "通过", "可以", "yes", "是", "approve", "ok"];
  return acceptWords.some((word) => normalized.includes(word));
}

/** 登记全部业务节点类型。 */
export function registerBuiltinNodeTypes(registry: NodeTypeRegistry): void {
  registry.register({
    type: "run.scene",
    typeVersion: 1,
    kind: "normal",
    inputs: { scene: { type: "SceneRef", required: true } },
    outputs: { scene: { type: "SceneRef" } },
    execute: (ctx) => {
      const ref = sceneRefOf(ctx.inputs.scene);
      const scene = ctx.hooks.getScene(ctx.projectId, ref.sceneId);
      if (!scene) throw new Error(`场景不存在：${ref.sceneId}`);
      return {
        scene: {
          sceneId: scene.sceneId,
          projectId: ctx.projectId,
          projectRevisionId: ctx.hooks.getRevisionId(ctx.projectId),
          routeId: scene.routeId,
          title: scene.title,
        } satisfies SceneRefValue,
      };
    },
  });

  registry.register({
    type: "run.sceneList",
    typeVersion: 1,
    kind: "normal",
    inputs: { sceneIds: { type: "SceneRef", required: true, batch: true } },
    outputs: { scenes: { type: "SceneRef", batch: true } },
    execute: (ctx) => ({ scenes: ctx.inputs.sceneIds ?? [] }),
  });

  registry.register({
    type: "run.freezeRevision",
    typeVersion: 1,
    kind: "normal",
    inputs: {},
    outputs: { revision: { type: "RevisionRef" } },
    execute: (ctx) => ({
      revision: {
        revisionId: ctx.hooks.getRevisionId(ctx.projectId),
        projectId: ctx.projectId,
      },
    }),
  });

  registry.register({
    type: "world.readState",
    typeVersion: 1,
    kind: "normal",
    inputs: { scene: { type: "SceneRef", required: true } },
    outputs: { state: { type: "WorldState" } },
    execute: (ctx) => {
      const ref = sceneRefOf(ctx.inputs.scene);
      const scene = ctx.hooks.getScene(ctx.projectId, ref.sceneId);
      if (!scene) throw new Error(`场景不存在：${ref.sceneId}`);
      return {
        state: {
          sceneId: scene.sceneId,
          projectId: ctx.projectId,
          projectRevisionId: ctx.hooks.getRevisionId(ctx.projectId),
          status: scene.status,
          storyTime: scene.storyTime,
          routeId: scene.routeId,
          knownEntityIds: scene.entityIds,
          bodyHash: sha256(scene.body),
        },
      };
    },
  });

  registry.register({
    type: "context.retrieve",
    typeVersion: 1,
    kind: "normal",
    inputs: {
      scene: { type: "SceneRef", required: true },
      state: { type: "WorldState", required: true },
    },
    outputs: { context: { type: "ContextBundle" } },
    execute: (ctx) => {
      const ref = sceneRefOf(ctx.inputs.scene);
      const scene = ctx.hooks.getScene(ctx.projectId, ref.sceneId);
      const purpose = (ctx.config.purpose as ContextQuery["purpose"]) ?? "scene_writing";
      const limit = ctx.config.maxEvidenceItems;
      const query: ContextQuery = {
        projectId: ctx.projectId,
        branchId: (ctx.config.branchId as string) ?? "",
        routeId: scene?.routeId ?? ref.routeId ?? "",
        revisionId: ctx.hooks.getRevisionId(ctx.projectId),
        query: (ctx.config.query as string) ?? scene?.title ?? ref.sceneId,
        purpose,
        ...(typeof limit === "number" ? { limit } : {}),
      };
      const bundle = ctx.hooks.retrieve(query);
      return { context: bundle };
    },
  });

  registry.register({
    type: "agent.generate",
    typeVersion: 1,
    kind: "normal",
    inputs: { context: { type: "ContextBundle", required: true } },
    outputs: { draft: { type: "DraftArtifact" } },
    execute: async (ctx) => {
      const context = ctx.inputs.context as ContextBundle | undefined;
      const kind = (ctx.config.kind as AgentTask["kind"]) ?? "scene";
      const instruction =
        typeof ctx.config.prompt === "string" && ctx.config.prompt.length > 0
          ? ctx.config.prompt
          : "根据检索上下文生成候选正文。";
      const payload = JSON.stringify({
        instruction,
        snapshotId: context?.snapshotId,
        facts: context?.facts ?? [],
        selectedPlans: context?.selectedPlans ?? [],
      });
      const sceneId = sceneIdOf(ctx);
      const result = await ctx.hooks.generate({
        projectId: ctx.projectId,
        ...(sceneId ? { sceneId } : {}),
        kind,
        input: payload,
      });
      const draft: DraftArtifactValue = {
        artifactId: result.taskId,
        taskId: result.taskId,
        kind,
        sceneId,
        text: result.text,
        createdAt: new Date().toISOString(),
      };
      return { draft };
    },
  });

  registry.register({
    type: "quality.checkConsistency",
    typeVersion: 1,
    kind: "normal",
    inputs: {
      draft: { type: "DraftArtifact", required: true },
      context: { type: "ContextBundle", required: false },
    },
    outputs: { report: { type: "IssueReport" } },
    execute: async (ctx) => {
      const draft = ctx.inputs.draft as DraftArtifactValue | undefined;
      if (!draft || typeof draft.text !== "string") {
        throw new Error("一致性检查缺少候选正文");
      }
      const context = ctx.inputs.context as ContextBundle | undefined;
      const payload = JSON.stringify({
        text: draft.text,
        facts: context?.facts ?? [],
        evidence: context?.evidence ?? [],
      });
      const sceneId = sceneIdOf(ctx);
      const result = await ctx.hooks.generate({
        projectId: ctx.projectId,
        ...(sceneId ? { sceneId } : {}),
        kind: "consistency",
        input: payload,
      });
      return { report: buildReport(result.text, result.taskId) };
    },
  });

  registry.register({
    type: "quality.checkScene",
    typeVersion: 1,
    kind: "normal",
    inputs: {
      scene: { type: "SceneRef", required: true },
      state: { type: "WorldState", required: false },
    },
    outputs: { report: { type: "IssueReport" } },
    execute: async (ctx) => {
      const ref = sceneRefOf(ctx.inputs.scene);
      const scene = ctx.hooks.getScene(ctx.projectId, ref.sceneId);
      if (!scene) throw new Error(`场景不存在：${ref.sceneId}`);
      const payload = JSON.stringify({
        text: scene.body,
        status: scene.status,
        storyTime: scene.storyTime,
      });
      const sceneId = sceneIdOf(ctx) ?? ref.sceneId;
      const result = await ctx.hooks.generate({
        projectId: ctx.projectId,
        sceneId,
        kind: "consistency",
        input: payload,
      });
      return { report: buildReport(result.text, result.taskId) };
    },
  });

  registry.register({
    type: "quality.mergeReports",
    typeVersion: 1,
    kind: "normal",
    inputs: { reports: { type: "IssueReport", required: true, batch: true } },
    outputs: { report: { type: "IssueReport" } },
    execute: (ctx) => {
      const reports = ctx.inputs.reports;
      const list = Array.isArray(reports) ? (reports as unknown[]) : [];
      return { report: mergeReports(list) };
    },
  });

  registry.register({
    type: "quality.joinReports",
    typeVersion: 1,
    kind: "normal",
    inputs: {
      a: { type: "IssueReport", required: true },
      b: { type: "IssueReport", required: true },
      c: { type: "IssueReport", required: true },
    },
    outputs: { report: { type: "IssueReport" } },
    execute: (ctx) => {
      const reports = [ctx.inputs.a, ctx.inputs.b, ctx.inputs.c].filter(
        (item) => item !== undefined && item !== null,
      );
      return { report: mergeReports(reports as unknown[]) };
    },
  });

  registry.register({
    type: "flow.condition",
    typeVersion: 1,
    kind: "normal",
    inputs: { value: { type: "DecisionRecord", required: true } },
    outputs: {
      true: { type: "DecisionRecord" },
      false: { type: "DecisionRecord" },
      unknown: { type: "DecisionRecord" },
    },
    execute: (ctx) => {
      const outcome = evaluateCondition(ctx.inputs.value);
      return { outcome, [outcome]: { outcome } };
    },
  });

  registry.register({
    type: "flow.foreach",
    typeVersion: 1,
    kind: "foreach",
    inputs: { items: { type: "SceneRef", required: true, batch: true } },
    outputs: (config) => ({
      results: { type: (config.resultType as NodePortType) ?? "IssueReport", batch: true },
    }),
  });

  registry.register({
    type: "human.review",
    typeVersion: 1,
    kind: "human",
    inputs: {
      candidate: { type: "any", required: true },
      report: { type: "IssueReport", required: false },
    },
    outputs: { decision: { type: "DecisionRecord" } },
  });

  registry.register({
    type: "revision.commit",
    typeVersion: 1,
    kind: "normal",
    inputs: {
      decision: { type: "DecisionRecord", required: true },
      draft: { type: "DraftArtifact", required: true },
    },
    outputs: { revision: { type: "RevisionRef" } },
    guard: (ctx) => {
      const decision = ctx.inputs.decision as { approved?: boolean } | undefined;
      return decision?.approved === true
        ? undefined
        : { skip: true, reason: "author_rejected" };
    },
    execute: (ctx) => {
      const draft = ctx.inputs.draft as DraftArtifactValue | undefined;
      if (!draft || typeof draft.text !== "string") {
        throw new Error("提交修订缺少候选正文");
      }
      if (draft.kind !== "scene") throw new Error("只有场景续写候选可以提交正文，报告与其他产物保持只读");
      const sceneId = draft.sceneId ?? sceneIdOf(ctx);
      if (!sceneId) throw new Error("提交修订缺少场景标识");
      const scene = ctx.hooks.getScene(ctx.projectId, sceneId);
      if (!scene) throw new Error("提交修订的场景不存在");
      const addition = draft.text.trim();
      if (!addition) throw new Error("续写候选为空，未提交正文");
      const base = scene.body.replace(/\s+$/, "");
      const body = base ? `${base}\n\n${addition}` : addition;
      const decision = ctx.inputs.decision as DecisionRecordValue;
      ctx.hooks.commit({
        projectId: ctx.projectId,
        sceneId,
        body,
        expectedRevisionId: ctx.baseRevisionId,
        decisionId: decision.decisionId,
      });
      return {
        revision: {
          revisionId: ctx.hooks.getRevisionId(ctx.projectId),
          projectId: ctx.projectId,
        },
      };
    },
  });
}
