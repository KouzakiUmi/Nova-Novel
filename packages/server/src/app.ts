import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  ContextQuery, GenerationRequest, IdeaCardFields, SelectionAction, WorkspaceSnapshot, ProviderUpsert, TaskRoute, WorkflowDefinition,
} from "@nova-novel/shared";
import type { KnowledgeService, PiHost, WorkflowService } from "./contracts.js";
import { DomainError, EXAMPLE_IDEAS, requiredString, versionNumber } from "./domain.js";
import { DomainStore, type ChangeSetInput } from "./store.js";
import { newId, stableHash } from "./utils.js";
import { parseStoryOrderFromTime } from "./knowledge/index.js";
import type { GuidedOutlineService } from "./guide.js";
import type { GuidedWorkflowService } from "./workflow-guide.js";

export interface AppServices { store: DomainStore; knowledge: KnowledgeService; workflow: WorkflowService; pi: PiHost; guide?: GuidedOutlineService; workflowGuide?: GuidedWorkflowService }
const MAX_BODY_BYTES = 1_048_576;
type Body = Record<string, unknown>;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  response.end(JSON.stringify(value));
}
function protectLoopback(request: IncomingMessage): void {
  const remote = request.socket.remoteAddress;
  if (remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) throw new DomainError(403, "LOOPBACK_ONLY", "仅允许本机连接");
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:[1-9][0-9]{0,4}))?$/.test(host)) throw new DomainError(403, "INVALID_HOST", "Host 不在本机白名单内");
  const port = host.match(/:(\d+)$/)?.[1];
  if (port && Number(port) > 65535) throw new DomainError(403, "INVALID_HOST", "端口无效");
  const authority = new URL(`http://${host}`);
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== authority.origin) throw new DomainError(403, "INVALID_ORIGIN", "请求必须来自同源页面");
  if (request.headers["sec-fetch-site"] === "cross-site") throw new DomainError(403, "INVALID_ORIGIN", "不允许跨站请求");
  if (request.headers["transfer-encoding"] && request.headers["content-length"]) throw new DomainError(400, "INVALID_BODY", "请求长度不明确");
}
async function body(request: IncomingMessage): Promise<Body> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== undefined && contentType !== "application/json") throw new DomainError(415, "JSON_REQUIRED", "请使用 application/json");
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new DomainError(413, "BODY_TOO_LARGE", "请求正文超过 1 MiB");
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; reject(new DomainError(413, "BODY_TOO_LARGE", "请求正文超过 1 MiB")); chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!failed) resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", reject);
    request.on("aborted", () => reject(new DomainError(400, "ABORTED_REQUEST", "请求已中断")));
  });
  if (!text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new DomainError(400, "INVALID_JSON", "JSON 格式无效"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DomainError(400, "INVALID_JSON", "JSON 顶层必须是对象");
  return parsed as Body;
}
function optionalString(value: unknown, key: string): string | undefined { return value === undefined ? undefined : requiredString(value, key); }
function piIdeas(text: string): IdeaCardFields[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { throw new DomainError(502, "INVALID_PI_OUTPUT", "Pi 返回的点子不是有效 JSON"); }
  const cards = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "cards" in parsed ? parsed.cards : undefined;
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 20) throw new DomainError(502, "INVALID_PI_OUTPUT", "Pi 未返回可用点子卡");
  return cards.map((card: unknown) => {
    if (!card || typeof card !== "object") throw new DomainError(502, "INVALID_PI_OUTPUT", "点子卡格式无效");
    const value = "proposedFields" in card ? card.proposedFields : card;
    if (!value || typeof value !== "object") throw new DomainError(502, "INVALID_PI_OUTPUT", "点子卡缺少内容");
    const fields = value as Record<string, unknown>;
    for (const key of ["action", "focus", "tradeoff"]) if (typeof fields[key] !== "string" || !fields[key].trim() || fields[key].length > 10000) throw new DomainError(502, "INVALID_PI_OUTPUT", `点子卡缺少 ${key}`);
    for (const key of ["motivation", "obstacle", "outcome"]) if (fields[key] !== undefined && (typeof fields[key] !== "string" || fields[key].length > 10000)) throw new DomainError(502, "INVALID_PI_OUTPUT", `点子卡的 ${key} 无效`);
    return { action: fields.action as string, focus: fields.focus as string, tradeoff: fields.tradeoff as string, ...(fields.motivation !== undefined ? { motivation: fields.motivation as string } : {}), ...(fields.obstacle !== undefined ? { obstacle: fields.obstacle as string } : {}), ...(fields.outcome !== undefined ? { outcome: fields.outcome as string } : {}) };
  });
}

export function createApp({ store, knowledge, workflow, pi, guide, workflowGuide }: AppServices) {
  function snapshot(projectId?: string): WorkspaceSnapshot {
    const project = store.getProject(projectId);
    const branch = store.getBranch(project.activeBranchId);
    const guided = guide?.current(project.projectId);
    const guidedWorkflow = workflowGuide?.current(project.projectId);
    return {
      projects: store.listProjects(), activeProject: project, branches: store.listBranches(project.projectId), routes: store.listRoutes(project.projectId),
      chapters: store.listChapters(project.projectId, branch.headRevisionId), scenes: store.listScenes(project.projectId, branch.headRevisionId),
      elements: knowledge.listEntities(project.projectId), facts: knowledge.listFacts(project.projectId), events: knowledge.listEvents(project.projectId),
      evidence: store.listEvidence(project.projectId, branch.headRevisionId), authoringDraft: store.getAuthoringDraft(project.projectId),
      revisions: store.listRevisions(project.projectId), workflows: workflow.listDefinitions(), workflowRuns: workflow.listRuns(project.projectId),
      storyGraph: store.getStoryGraph(project.projectId, branch.headRevisionId), tasks: store.listTasks(project.projectId), connection: pi.getConnection(),
      ...(guided ? { guide: guided } : {}),
      ...(guidedWorkflow ? { workflowGuide: guidedWorkflow } : {}),
    };
  }
  function queryFor(request: GenerationRequest): ContextQuery {
    const project = store.getProject(request.projectId);
    const branch = store.getBranch(project.activeBranchId);
    const scene = request.sceneId ? store.getScene(request.sceneId, branch.headRevisionId) : undefined;
    const storyOrder = scene ? parseStoryOrderFromTime(scene.storyTime) : undefined;
    return { projectId: project.projectId, branchId: branch.branchId, routeId: scene?.routeId ?? project.activeRouteId, revisionId: branch.headRevisionId, query: request.input, purpose: request.kind === "consistency" ? "fact_check" : request.kind === "ideas" ? "planning" : "scene_writing", ...(scene ? { narrationOrder: scene.narrationOrder, ...(scene.pov ? { povEntityId: scene.pov } : {}) } : {}), ...(storyOrder !== undefined ? { storyOrder } : {}) };
  }
  function indexRevision(projectId: string, revisionId: string): void {
    // Indexing is derived: a failed rebuild must not undo a durable author save.
    for (const scene of store.listScenes(projectId, revisionId)) {
      try { knowledge.indexScene(scene, revisionId); }
      catch (error) { console.warn("Nova Novel index pending", error instanceof Error ? error.name : "IndexError"); }
    }
  }
  async function generate(request: GenerationRequest) {
    if (!["ideas", "scene", "rehearsal", "consistency", "polish", "guide"].includes(request.kind) || typeof request.input !== "string" || request.input.length > 100_000) throw new DomainError(400, "INVALID_INPUT", "生成请求无效");
    if (request.range !== undefined) {
      if (!request.range || !Number.isSafeInteger(request.range.from) || !Number.isSafeInteger(request.range.to) || request.range.from < 0 || request.range.to < request.range.from || typeof request.range.baseText !== "string") throw new DomainError(400, "INVALID_INPUT", "选区无效");
    }
    if (request.kind === "polish" && (!request.range || !request.range.baseText.trim())) throw new DomainError(400, "SELECTION_REQUIRED", "请先选中需要推敲的文字");
    const previous = store.findGeneration(request.idempotencyKey, request);
    if (previous) return previous;
    const receipt = store.beginGeneration(request, knowledge.queryContext(queryFor(request)));
    const taskId = receipt.task.taskId;
    try {
      if (request.reuseOfArtifactId) {
        const artifact = store.getArtifact(request.reuseOfArtifactId);
        if (!artifact.taskId || store.getTask(artifact.taskId).projectId !== request.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "不能复用其他作品的产物");
        return store.finishGeneration(taskId, artifact.value, artifact.completeness);
      }
      const result = await pi.generate({ task: receipt.task, request, systemContext: "" });
      if (result.completeness === "complete" && (typeof result.text !== "string" || !result.text.trim())) throw new DomainError(502, "MISSING_AGENT_OUTPUT", "模型未返回可用产物");
      // PiHost resolves only once its settled/abort/tool/required-output checks finish.
      return store.finishGeneration(taskId, result, result.completeness);
    } catch (error) {
      return store.failGeneration(taskId, error instanceof Error ? error.message : "Pi 生成失败");
    }
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    protectLoopback(request);
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (method === "GET" && path === "/api/health") { json(response, 200, { ok: true, storage: "sqlite", connection: pi.getConnection() }); return; }
    if (method === "GET" && path === "/api/bootstrap") { json(response, 200, snapshot(url.searchParams.get("projectId") ?? undefined)); return; }
    if (method === "GET" && path === "/api/agent/settings" && pi.settings) { json(response, 200, pi.settings.view()); return; }
    if (method === "GET" && path === "/api/generate/progress") {
      const key = requiredString(url.searchParams.get("key"), "key", 200);
      const task = store.taskByKey(key);
      json(response, 200, pi.progress?.(key) ?? { ...(task ? { taskId: task.taskId } : {}), state: task?.state ?? "unknown", text: "", tools: [] }); return;
    }
    if (method === "GET" && path === "/api/events") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      // Reconnect always replaces local state with a complete authoritative snapshot.
      let serialized = JSON.stringify(snapshot(projectId));
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Nova-Novel-Reconnect": "snapshot" });
      response.write(`retry: 1500\nid: ${store.eventCursor()}\nevent: snapshot\ndata: ${serialized}\n\n`);
      let blocked = false;
      response.on("drain", () => { blocked = false; });
      const timer = setInterval(() => {
        if (blocked || response.destroyed) return;
        try {
          const next = JSON.stringify(snapshot(projectId));
          if (next !== serialized) { serialized = next; blocked = !response.write(`id: ${store.eventCursor()}\nevent: snapshot\ndata: ${next}\n\n`); }
          else blocked = !response.write(": heartbeat\n\n");
        } catch {
          response.write("event: reconnect\ndata: {\"mode\":\"snapshot\"}\n\n");
          response.end();
        }
      }, 1500);
      timer.unref();
      response.on("close", () => clearInterval(timer));
      return;
    }
    const cancelTask = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (cancelTask && method === "GET") { json(response, 200, { task: store.getTask(cancelTask[1]!) }); return; }
    const getTask = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (getTask && method === "GET") { json(response, 200, store.getGeneration(getTask[1]!)); return; }
    if (!["POST", "PATCH", "DELETE", "PUT"].includes(method)) throw new DomainError(404, "NOT_FOUND", "接口不存在");
    const input = await body(request);
    if (path === "/api/guide/sessions" && method === "POST" && guide) { json(response, 201, { session: await guide.create(requiredString(input.projectId, "projectId")) }); return; }
    const guideRoute = path.match(/^\/api\/guide\/sessions\/([^/]+)\/(next|answer|back|cancel|apply|proposal)$/);
    if (guideRoute && guide) {
      const sessionId = guideRoute[1]!;
      const action = guideRoute[2]!;
      if (method === "PATCH" && action === "proposal") { json(response, 200, { session: guide.updateProposal(sessionId, input.scenes) }); return; }
      if (method === "POST" && action === "next") { json(response, 200, { session: await guide.next(sessionId) }); return; }
      if (method === "POST" && action === "answer") { json(response, 200, { session: await guide.answer(sessionId, { ...(typeof input.optionId === "string" ? { optionId: input.optionId } : {}), ...(typeof input.custom === "string" ? { custom: input.custom } : {}), skip: input.skip === true }) }); return; }
      if (method === "POST" && action === "back") { json(response, 200, { session: guide.back(sessionId) }); return; }
      if (method === "POST" && action === "cancel") { json(response, 200, { session: guide.cancel(sessionId) }); return; }
      if (method === "POST" && action === "apply") {
        const adopted = guide.apply(sessionId);
        indexRevision(adopted.revision.projectId, adopted.revision.revisionId);
        json(response, 200, { ...adopted, snapshot: snapshot(adopted.revision.projectId) }); return;
      }
    }
    if (path === "/api/workflow-guide/sessions" && method === "POST" && workflowGuide) { json(response, 201, { session: await workflowGuide.create(requiredString(input.projectId, "projectId")) }); return; }
    const workflowGuideRoute = path.match(/^\/api\/workflow-guide\/sessions\/([^/]+)\/(next|answer|back|cancel|publish|proposal)$/);
    if (workflowGuideRoute && workflowGuide) {
      const sessionId = workflowGuideRoute[1]!;
      const action = workflowGuideRoute[2]!;
      if (method === "PATCH" && action === "proposal") { json(response, 200, { session: workflowGuide.updateProposal(sessionId, input.definition as WorkflowDefinition) }); return; }
      if (method === "POST" && action === "next") { json(response, 200, { session: await workflowGuide.next(sessionId) }); return; }
      if (method === "POST" && action === "answer") { json(response, 200, { session: await workflowGuide.answer(sessionId, { ...(typeof input.optionId === "string" ? { optionId: input.optionId } : {}), ...(typeof input.custom === "string" ? { custom: input.custom } : {}), skip: input.skip === true }) }); return; }
      if (method === "POST" && action === "back") { json(response, 200, { session: workflowGuide.back(sessionId) }); return; }
      if (method === "POST" && action === "cancel") { json(response, 200, { session: workflowGuide.cancel(sessionId) }); return; }
      if (method === "POST" && action === "publish") { json(response, 200, { ...workflowGuide.publish(sessionId), snapshot: snapshot(requiredString(input.projectId, "projectId")) }); return; }
    }
    if (path === "/api/agent/providers" && method === "POST" && pi.settings) { const { providerId, ...provider } = input; json(response, 201, await pi.settings.upsert(requiredString(providerId, "providerId"), provider as unknown as ProviderUpsert)); return; }
    const providerRoute = path.match(/^\/api\/agent\/providers\/([^/]+)(?:\/(test|discover))?$/);
    if (providerRoute && pi.settings) {
      const id = decodeURIComponent(providerRoute[1]!);
      if (!providerRoute[2] && method === "PATCH") { json(response, 200, await pi.settings.upsert(id, input as unknown as ProviderUpsert, true)); return; }
      if (!providerRoute[2] && method === "DELETE") { json(response, 200, await pi.settings.delete(id)); return; }
      if (providerRoute[2] === "test" && method === "POST" && pi.testProvider) { json(response, 200, await pi.testProvider(id, optionalString(input.modelId, "modelId"))); return; }
      if (providerRoute[2] === "discover" && method === "POST" && pi.discoverProvider) { json(response, 200, await pi.discoverProvider(id, input)); return; }
    }
    if (path === "/api/agent/routes" && method === "PUT" && pi.settings) { json(response, 200, await pi.settings.routes(input.routes as TaskRoute[])); return; }
    if (path === "/api/generate/cancel" && method === "POST") {
      const task = store.taskByKey(requiredString(input.idempotencyKey, "idempotencyKey", 200));
      if (task) { const cancelling = store.requestCancellation(task.taskId); if (cancelling.state === "cancelling") { await pi.cancel(task.taskId); store.confirmCancellation(task.taskId); } }
      json(response, 200, task ? { task: store.getTask(task.taskId) } : {}); return;
    }
    if (method === "POST" && path === "/api/projects") {
      if (input.body !== undefined && typeof input.body !== "string") throw new DomainError(400, "INVALID_INPUT", "第一场正文必须是文字");
      const project = store.createProject({ ...(input.title !== undefined ? { title: requiredString(input.title, "title", 200) } : {}), ...(typeof input.premise === "string" ? { premise: input.premise } : {}), ...(typeof input.body === "string" ? { body: input.body } : {}), ...(input.mode === "example" || input.example === true ? { example: true } : {}) });
      const head = store.getBranch(project.activeBranchId).headRevisionId;
      indexRevision(project.projectId, head);
      json(response, 201, snapshot(project.projectId)); return;
    }
    const ideas = path.match(/^\/api\/projects\/([^/]+)\/ideas$/);
    if (ideas && method === "POST") {
      const project = store.getProject(ideas[1]!);
      const draft = input.draftId ? store.getSelection(requiredString(input.draftId, "draftId")) : store.getAuthoringDraft(project.projectId);
      if (draft.projectId !== project.projectId) throw new DomainError(400, "SCOPE_MISMATCH", "草稿不属于此作品");
      const mode = input.mode ?? "example";
      if (mode !== "example" && mode !== "pi" && mode !== "agent") throw new DomainError(400, "INVALID_INPUT", "mode 应为 example、pi 或 agent");
      const ideaInput = input.input ?? "";
      if (typeof ideaInput !== "string" || ideaInput.length > 100_000) throw new DomainError(400, "INVALID_INPUT", "input 必须是文字");
      const generation: GenerationRequest & { mode: string } = { projectId: project.projectId, draftId: draft.draftId, kind: "ideas", input: ideaInput, idempotencyKey: input.idempotencyKey === undefined ? newId("idempotency") : requiredString(input.idempotencyKey, "idempotencyKey", 200), mode };
      const existing = store.findGeneration(generation.idempotencyKey, generation);
      if (existing) {
        if (existing.task.state === "failed" || existing.task.state === "interrupted") throw new DomainError(502, "IDEAS_FAILED", existing.task.error ?? "点子生成未完成");
        json(response, 200, { draft: store.getSelection(draft.draftId), receipt: existing }); return;
      }
      const receipt = store.beginGeneration(generation, knowledge.queryContext(queryFor(generation)));
      try {
        let fields: IdeaCardFields[];
        let metadata: { sessionId?: string; leafId?: string } | undefined;
        if (mode === "example") fields = EXAMPLE_IDEAS.map(value => ({ ...value }));
        else {
          const result = await pi.generate({ task: receipt.task, request: generation, systemContext: "" });
          metadata = { ...(result.sessionId ? { sessionId: result.sessionId } : {}), ...(result.leafId ? { leafId: result.leafId } : {}) };
          store.putArtifact("pi_ideas_output", result, receipt.task.taskId, result.completeness);
          if (result.completeness !== "complete") {
            store.finishGeneration(receipt.task.taskId, result, "partial");
            throw new DomainError(502, "IDEAS_INCOMPLETE", "点子生成尚未完整完成");
          }
          fields = result.cards ?? piIdeas(result.text);
        }
        const state = store.getTask(receipt.task.taskId).state;
        if (state === "cancelling" || state === "cancelled") throw new DomainError(409, "TASK_CANCELLED", "点子任务已取消", store.getBranch(draft.branchId).headRevisionId, store.getSelection(draft.draftId).selectionVersion);
        const result = store.completeIdeas(receipt.task.taskId, draft.draftId, fields, mode === "example" ? "example" : "pi", metadata);
        json(response, 200, { draft: result.selection, batch: result.batch, receipt: result.receipt }); return;
      } catch (error) {
        store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "点子生成失败");
        if (error instanceof DomainError) throw error;
        throw new DomainError(502, "IDEAS_FAILED", error instanceof Error ? error.message : "Pi 生成失败");
      }
    }
    const selection = path.match(/^\/api\/drafts\/([^/]+)\/selection$/);
    if (selection && method === "POST") {
      const draft = store.updateSelection(selection[1]!, versionNumber(input.expectedVersion ?? input.selectionVersion), input.action as SelectionAction);
      json(response, 200, { draft }); return;
    }
    const adopt = path.match(/^\/api\/drafts\/([^/]+)\/adopt$/);
    if (adopt && method === "POST") {
      const draftId = adopt[1]!;
      const expectedVersion = versionNumber(input.expectedVersion ?? input.selectionVersion);
      const baseRevisionId = requiredString(input.baseRevisionId, "baseRevisionId");
      const acceptanceId = input.acceptanceId === undefined ? `adopt_${stableHash({ draftId, expectedVersion, baseRevisionId, sceneId: input.sceneId })}` : requiredString(input.acceptanceId, "acceptanceId", 200);
      const result = store.adopt(draftId, { selectionVersion: expectedVersion, baseRevisionId, acceptanceId, ...(input.sceneId ? { sceneId: requiredString(input.sceneId, "sceneId") } : {}) });
      indexRevision(result.revision.projectId, result.revision.revisionId);
      json(response, 200, snapshot(result.revision.projectId)); return;
    }
    const scene = path.match(/^\/api\/scenes\/([^/]+)$/);
    if (scene && method === "PATCH") {
      const { baseRevisionId, branchId, acceptanceId, ...patch } = input;
      const result = store.saveScene(scene[1]!, { baseRevisionId: requiredString(baseRevisionId, "baseRevisionId"), ...(branchId ? { branchId: requiredString(branchId, "branchId") } : {}), ...(acceptanceId ? { acceptanceId: requiredString(acceptanceId, "acceptanceId", 200) } : {}), patch });
      indexRevision(result.revision.projectId, result.revision.revisionId);
      json(response, 200, { scene: result.scene, revisionId: result.revision.revisionId }); return;
    }
    const revisions = path.match(/^\/api\/projects\/([^/]+)\/revisions$/);
    if (revisions && method === "POST") {
      const project = store.getProject(revisions[1]!);
      const branch = store.getBranch(optionalString(input.branchId, "branchId") ?? project.activeBranchId);
      const revision = store.nameRevision(project.projectId, { name: requiredString(input.name, "name", 200), baseRevisionId: optionalString(input.baseRevisionId, "baseRevisionId") ?? branch.headRevisionId, branchId: branch.branchId, ...(input.acceptanceId ? { acceptanceId: requiredString(input.acceptanceId, "acceptanceId", 200) } : {}) });
      indexRevision(project.projectId, revision.revisionId);
      json(response, 200, snapshot(project.projectId)); return;
    }
    const branches = path.match(/^\/api\/projects\/([^/]+)\/branches$/);
    if (branches && method === "POST") {
      const branch = store.createBranch(branches[1]!, { name: requiredString(input.name, "name", 200), ...(input.revisionId ? { revisionId: requiredString(input.revisionId, "revisionId") } : {}), ...(input.baseRevisionId ? { baseRevisionId: requiredString(input.baseRevisionId, "baseRevisionId") } : {}), activate: input.activate === true });
      json(response, 201, { branch, snapshot: snapshot(branch.projectId) }); return;
    }
    const restore = path.match(/^\/api\/projects\/([^/]+)\/restore$/);
    if (restore && method === "POST") {
      const revision = store.restore(restore[1]!, { revisionId: requiredString(input.revisionId, "revisionId"), baseRevisionId: requiredString(input.baseRevisionId, "baseRevisionId"), ...(input.branchId ? { branchId: requiredString(input.branchId, "branchId") } : {}), ...(input.name ? { name: requiredString(input.name, "name", 200) } : {}), ...(input.acceptanceId ? { acceptanceId: requiredString(input.acceptanceId, "acceptanceId", 200) } : {}) });
      indexRevision(revision.projectId, revision.revisionId);
      json(response, 200, snapshot(revision.projectId)); return;
    }
    if (path === "/api/context/query" && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const branch = store.getBranch(requiredString(input.branchId, "branchId"));
      const revisionId = requiredString(input.revisionId, "revisionId");
      const routeId = requiredString(input.routeId, "routeId");
      if (branch.projectId !== projectId || store.getRevision(revisionId).projectId !== projectId || !store.listRoutes(projectId).some(route => route.routeId === routeId)) throw new DomainError(400, "SCOPE_MISMATCH", "检索范围不属于此作品");
      store.assertRevisionOnBranch(projectId, branch.branchId, revisionId);
      if (!["planning", "scene_writing", "fact_check", "reader_check"].includes(String(input.purpose)) || typeof input.query !== "string") throw new DomainError(400, "INVALID_INPUT", "检索用途或文字无效");
      json(response, 200, knowledge.queryContext(input as unknown as ContextQuery)); return;
    }
    if (path === "/api/generate" && method === "POST") {
      requiredString(input.projectId, "projectId"); requiredString(input.idempotencyKey, "idempotencyKey", 200);
      if (input.draftId !== undefined) requiredString(input.draftId, "draftId");
      if (input.sceneId !== undefined) requiredString(input.sceneId, "sceneId");
      if (input.reuseOfArtifactId !== undefined) requiredString(input.reuseOfArtifactId, "reuseOfArtifactId");
      const receipt = await generate(input as unknown as GenerationRequest);
      json(response, 200, receipt); return;
    }
    if (cancelTask && method === "POST") {
      const task = store.requestCancellation(cancelTask[1]!);
      if (task.state === "cancelling") { await pi.cancel(task.taskId); store.confirmCancellation(task.taskId); }
      json(response, 200, { task: store.getTask(task.taskId) }); return;
    }
    const run = path.match(/^\/api\/workflows\/([^/]+)\/runs$/);
    if (run && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId"); store.getProject(projectId);
      const runInput = input.input ?? {};
      if (!runInput || typeof runInput !== "object" || Array.isArray(runInput)) throw new DomainError(400, "INVALID_INPUT", "工作流输入必须是对象");
      json(response, 201, { run: workflow.startRun(projectId, run[1]!, runInput as Record<string, unknown>) }); return;
    }
    const decision = path.match(/^\/api\/workflow-runs\/([^/]+)\/decision$/);
    if (decision && method === "POST") {
      json(response, 200, { run: workflow.decide(decision[1]!, requiredString(input.todoId, "todoId"), requiredString(input.answer, "answer"), requiredString(input.inputHash, "inputHash")) }); return;
    }
    const cancelRun = path.match(/^\/api\/workflow-runs\/([^/]+)\/cancel$/);
    if (cancelRun && method === "POST") { json(response, 200, { run: workflow.cancel(cancelRun[1]!) }); return; }
    if (path === "/api/changesets" && method === "POST") {
      requiredString(input.projectId, "projectId"); requiredString(input.baseRevisionId, "baseRevisionId"); requiredString(input.acceptanceId, "acceptanceId", 200);
      for (const key of ["sceneChanges", "factChanges", "graphChanges"]) if (input[key] !== undefined && !Array.isArray(input[key])) throw new DomainError(400, "INVALID_INPUT", `${key} 必须是数组`);
      json(response, 201, { changeSet: store.createChangeSet(input as unknown as ChangeSetInput) }); return;
    }
    const commit = path.match(/^\/api\/changesets\/([^/]+)\/commit$/);
    if (commit && method === "POST") {
      const revision = store.commitChangeSet(commit[1]!, optionalString(input.name, "name") ?? "采用修改");
      indexRevision(revision.projectId, revision.revisionId);
      json(response, 200, { revision, snapshot: snapshot(revision.projectId) }); return;
    }
    throw new DomainError(404, "NOT_FOUND", "接口不存在");
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof DomainError) {
        json(response, error.status, { error: { code: error.code, message: error.message, ...(error.currentRevisionId ? { currentRevisionId: error.currentRevisionId } : {}), ...(error.selectionVersion !== undefined ? { selectionVersion: error.selectionVersion } : {}) } });
      } else {
        json(response, 500, { error: { code: "INTERNAL_ERROR", message: "服务处理失败" } });
      }
    });
  });
  server.requestTimeout = 660_000;
  server.headersTimeout = 30_000;
  server.maxHeadersCount = 64;
  return server;
}
