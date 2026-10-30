import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { readAppearanceSettings, writeAppearanceSettings } from "./appearance.js";
import { timingSafeEqual } from "node:crypto";
import type {
  ContextQuery, Entity, FactAssertion, GenerationRequest, IdeaCardFields, SelectionAction, WorkspaceSnapshot, ProviderUpsert, TaskRoute, WorkflowDefinition, SceneAnnotation, AuthoringEvent, ElementDesignCard, PlotIdeateMode, SceneProposalCard, NoteIncubateTarget, ExtractedElementProposal, ExtractedFactProposal, ExtractedEventProposal,
} from "@nova-novel/shared";
import type { KnowledgeService, PiHost, WorkflowService } from "./contracts.js";
import { DomainError, EXAMPLE_IDEAS, requiredString, versionNumber } from "./domain.js";
import { DomainStore, type ChangeSetInput } from "./store.js";
import { newId, stableHash } from "./utils.js";
import { parseStoryOrderFromTime } from "./knowledge/index.js";
import type { GuidedOutlineService } from "./guide.js";
import type { GuidedWorkflowService } from "./workflow-guide.js";
import { CreativeAssistService, ElementGuideService } from "./assist.js";
import { exportBackup, exportMarkdown, parseBackup, parseManuscript } from "./transfer.js";

export interface AppServices { store: DomainStore; knowledge: KnowledgeService; workflow: WorkflowService; pi: PiHost; guide?: GuidedOutlineService; workflowGuide?: GuidedWorkflowService; elementGuide?: ElementGuideService; assist?: CreativeAssistService }
const MAX_BODY_BYTES = 1_048_576;
type Body = Record<string, unknown>;

// 纵深防御：即便未来渲染层出现 XSS 疏漏，也挡住脚本执行、 framing 与跨源读取。
// 前端模板无内联脚本（仅 type=module），故 script-src 可收紧为 'self'；
// style-src-attr 放行 React 内联 style 属性，style-src 仍只限 'self'。
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...SECURITY_HEADERS });
  response.end(JSON.stringify(value));
}
function protectLoopback(request: IncomingMessage): void {
  const remote = request.socket.remoteAddress;
  if (remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) throw new DomainError(403, "LOOPBACK_ONLY", "仅允许本机连接");
  const pairToken = process.env.NOVA_NOVEL_PAIR_TOKEN;
  if (pairToken) {
    const supplied = request.headers["x-nova-novel-token"];
    if (typeof supplied !== "string" || supplied.length !== pairToken.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(pairToken))) throw new DomainError(403, "INVALID_PAIR_TOKEN", "本机配对令牌无效");
  }
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
async function body(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Body> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== undefined && contentType !== "application/json") throw new DomainError(415, "JSON_REQUIRED", "请使用 application/json");
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new DomainError(413, "BODY_TOO_LARGE", "请求正文超过允许大小");
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) { failed = true; reject(new DomainError(413, "BODY_TOO_LARGE", "请求正文超过允许大小")); chunks.length = 0; return; }
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

export function createApp({ store, knowledge, workflow, pi, guide, workflowGuide, elementGuide: providedElementGuide, assist: providedAssist }: AppServices) {
  const assist = providedAssist ?? new CreativeAssistService(store.db, store, knowledge, pi);
  const elementGuide = providedElementGuide ?? new ElementGuideService(store.db, store, knowledge, pi, assist);
  const appearanceDir = pi.settings?.view().dataDir ?? process.env.NOVA_NOVEL_DATA_DIR ?? resolve(process.cwd(), "data");
  function snapshot(projectId?: string): WorkspaceSnapshot {
    const project = store.getProject(projectId);
    const branch = store.getBranch(project.activeBranchId);
    const guided = guide?.current(project.projectId);
    const guidedWorkflow = workflowGuide?.current(project.projectId);
    const guidedElement = elementGuide?.current(project.projectId);
    return {
      projects: store.listProjects(), archivedProjects: store.listProjects(true).filter(item => item.archivedAt), activeProject: project, branches: store.listBranches(project.projectId), routes: store.listRoutes(project.projectId),
      chapters: store.listChapters(project.projectId, branch.headRevisionId), scenes: store.listScenes(project.projectId, branch.headRevisionId), notes: store.listNotes(project.projectId), annotations: store.listAnnotations(project.projectId), characterArcs: store.listCharacterArcs(project.projectId),
      elements: knowledge.listEntities(project.projectId), facts: knowledge.listFacts(project.projectId), events: knowledge.listEvents(project.projectId),
      evidence: store.listKnowledgeEvidence(project.projectId), authoringDraft: store.getAuthoringDraft(project.projectId),
      revisions: store.listRevisions(project.projectId), workflows: workflow.listDefinitions(), workflowRuns: workflow.listRuns(project.projectId),
      storyGraph: store.getStoryGraph(project.projectId, branch.headRevisionId), tasks: store.listTasks(project.projectId), connection: pi.getConnection(),
      ...(guided ? { guide: guided } : {}),
      ...(guidedWorkflow ? { workflowGuide: guidedWorkflow } : {}),
      ...(guidedElement ? { elementGuide: guidedElement } : {}),
    };
  }
  function queryFor(request: GenerationRequest): ContextQuery {
    const project = store.getProject(request.projectId);
    const branch = store.getBranch(project.activeBranchId);
    const scene = request.sceneId ? store.getScene(request.sceneId, branch.headRevisionId) : undefined;
    const storyOrder = scene ? parseStoryOrderFromTime(scene.storyTime) : undefined;
    const povEntityId = scene?.pov ? knowledge.listEntities(project.projectId).find(entity => entity.entityId === scene.pov || entity.name === scene.pov || entity.aliases.includes(scene.pov!))?.entityId : undefined;
    return { projectId: project.projectId, branchId: branch.branchId, routeId: scene?.routeId ?? project.activeRouteId, revisionId: branch.headRevisionId, query: request.input, purpose: request.kind === "consistency" ? "fact_check" : request.kind === "ideas" ? "planning" : "scene_writing", ...(scene ? { narrationOrder: scene.narrationOrder, ...(povEntityId ? { povEntityId } : {}) } : {}), ...(storyOrder !== undefined ? { storyOrder } : {}) };
  }
  function indexRevision(projectId: string, revisionId: string): void {
    // Indexing is derived: a failed rebuild must not undo a durable author save.
    const scenes = store.listScenes(projectId, revisionId);
    // 先声明完整清单，索引状态只有在全部场景成功后才会变成 ready。
    try { knowledge.beginRevisionIndex?.(projectId, revisionId, scenes.map(scene => scene.sceneId)); }
    catch (error) { console.warn("Nova Novel index begin failed", error instanceof Error ? error.name : "IndexError"); }
    for (const scene of scenes) {
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
    if (method === "GET" && path === "/api/appearance") { json(response, 200, readAppearanceSettings(appearanceDir)); return; }
    if (method === "GET" && path === "/api/health") { json(response, 200, { ok: true, storage: "sqlite", connection: pi.getConnection() }); return; }
    if (method === "GET" && path === "/api/bootstrap") { json(response, 200, snapshot(url.searchParams.get("projectId") ?? undefined)); return; }
    if (method === "GET" && path === "/api/export/markdown") { const projectId = requiredString(url.searchParams.get("projectId"), "projectId"); response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="nova-novel-${projectId}.md"`, "Cache-Control": "no-store" }); response.end(exportMarkdown(snapshot(projectId))); return; }
    if (method === "GET" && path === "/api/export/backup") { const projectId = requiredString(url.searchParams.get("projectId"), "projectId"); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="nova-novel-${projectId}.json"`, "Cache-Control": "no-store" }); response.end(JSON.stringify(exportBackup(snapshot(projectId)), null, 2)); return; }
    if (path === "/api/events" && method === "GET" && url.searchParams.has("projectId")) { json(response, 200, { events: store.listInteractionEvents(requiredString(url.searchParams.get("projectId"), "projectId"), Number(url.searchParams.get("cursor") ?? 0), Number(url.searchParams.get("limit") ?? 200)) }); return; }
    if (path === "/api/events/export" && method === "GET") { const projectId = requiredString(url.searchParams.get("projectId"), "projectId"); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="nova-novel-interactions-${projectId}.json"`, "Cache-Control": "no-store" }); response.end(JSON.stringify({ format: "nova-novel-interactions/1", events: store.listAllInteractionEvents(projectId) }, null, 2)); return; }
    if (path === "/api/notes" && method === "GET") { json(response, 200, { notes: store.listNotes(requiredString(url.searchParams.get("projectId"), "projectId")) }); return; }
    if (path === "/api/knowledge/index-status" && method === "GET") {
      const projectId = requiredString(url.searchParams.get("projectId"), "projectId");
      const revisionId = requiredString(url.searchParams.get("revisionId"), "revisionId");
      store.getProject(projectId);
      if (!knowledge.getIndexStatus) throw new DomainError(503, "INDEX_STATUS_UNAVAILABLE", "当前知识服务不支持索引状态查询");
      json(response, 200, knowledge.getIndexStatus(projectId, revisionId)); return;
    }
    if (path === "/api/annotations" && method === "GET") { json(response, 200, { annotations: store.listAnnotations(requiredString(url.searchParams.get("projectId"), "projectId"), url.searchParams.get("sceneId") ?? undefined) }); return; }
    if (path === "/api/character-arcs" && method === "GET") { const entityId = url.searchParams.get("entityId"); json(response, 200, { arcs: entityId ? [store.getCharacterArc(entityId)] : store.listCharacterArcs(requiredString(url.searchParams.get("projectId"), "projectId")) }); return; }
    if (method === "GET" && path === "/api/agent/settings" && pi.settings) { json(response, 200, pi.settings.view()); return; }
    if (method === "GET" && path === "/api/agent/usage" && pi.usage) { json(response, 200, { reports: await pi.usage.list(url.searchParams.get("refresh") === "true") }); return; }
    const oauth = path.match(/^\/api\/agent\/oauth\/([^/]+)$/);
    if (oauth && decodeURIComponent(oauth[1]!) === "volcengine" && pi.volcengine) {
      if (method === "GET") { json(response, 200, pi.volcengine.loginStatus()); return; }
      if (method === "POST") { json(response, 200, pi.volcengine.startLogin()); return; }
      if (method === "DELETE") { pi.volcengine.cancelLogin(); json(response, 200, { ok: true }); return; }
    }
    if (oauth && pi.settings) {
      const id = decodeURIComponent(oauth[1]!);
      if (method === "GET") { json(response, 200, pi.settings.oauthStatus(id)); return; }
      if (method === "POST") { json(response, 200, pi.settings.startOAuth(id)); return; }
      if (method === "DELETE") { pi.settings.oauthCancel(id); json(response, 200, { ok: true }); return; }
    }
    const oauthCode = path.match(/^\/api\/agent\/oauth\/([^/]+)\/code$/);
    if (oauthCode && method === "POST" && pi.settings) { const codeInput = await body(request); pi.settings.oauthCode(decodeURIComponent(oauthCode[1]!), requiredString(codeInput.code, "code", 4000)); json(response, 200, { ok: true }); return; }
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
    const revisionRoute = path.match(/^\/api\/revisions\/([^/]+)$/);
    if (revisionRoute && method === "GET") { const revision = store.getRevision(revisionRoute[1]!); const manifest = store.getManifest(revision.revisionId); json(response, 200, { revision, chapters: manifest.chapters, scenes: manifest.scenes, facts: manifest.facts }); return; }
    if (!["POST", "PATCH", "DELETE", "PUT"].includes(method)) throw new DomainError(404, "NOT_FOUND", "接口不存在");
    if (path === "/api/import/backup" && method === "POST") { const backupInput = await body(request, 20 * 1024 * 1024); const restored = store.restoreBackup(parseBackup(backupInput.backup)); indexRevision(restored.project.projectId, restored.revision.revisionId); json(response, 201, { ...restored, snapshot: snapshot(restored.project.projectId) }); return; }
    const input = await body(request);
    if (path === "/api/appearance" && method === "PUT") { json(response, 200, writeAppearanceSettings(appearanceDir, input)); return; }
    if (path === "/api/events" && method === "POST") { const seq = store.recordInteraction({ projectId: requiredString(input.projectId, "projectId"), kind: requiredString(input.kind, "kind", 100), ...(typeof input.sceneId === "string" ? { sceneId: input.sceneId } : {}), ...(input.actor === "system" || input.actor === "author" ? { actor: input.actor } : {}), ...(input.meta && typeof input.meta === "object" && !Array.isArray(input.meta) ? { meta: input.meta as AuthoringEvent["meta"] } : {}) }); json(response, 201, { seq }); return; }
    if (path === "/api/import" && method === "POST") { const parsed = parseManuscript(requiredString(input.text, "text", 1_000_000)); const imported = store.importProject({ ...(typeof input.title === "string" ? { title: input.title } : {}), ...(typeof input.premise === "string" ? { premise: input.premise } : {}), chapterTitle: parsed.chapterTitle, scenes: parsed.scenes }); indexRevision(imported.project.projectId, imported.revision.revisionId); json(response, 201, { ...imported, snapshot: snapshot(imported.project.projectId) }); return; }
    const arcRoute = path.match(/^\/api\/character-arcs\/([^/]+)$/);
    if (arcRoute && method === "PUT") { json(response, 200, { arc: store.saveCharacterArc(arcRoute[1]!, { motivation: typeof input.motivation === "string" ? input.motivation : "", goal: typeof input.goal === "string" ? input.goal : "", conflict: typeof input.conflict === "string" ? input.conflict : "", epiphany: typeof input.epiphany === "string" ? input.epiphany : "", notes: typeof input.notes === "string" ? input.notes : "" }) }); return; }
    if (path === "/api/annotations" && method === "POST") { const created = store.createAnnotation({ projectId: requiredString(input.projectId, "projectId"), sceneId: requiredString(input.sceneId, "sceneId"), kind: input.kind as "comment" | "question" | "todo", body: requiredString(input.body, "body", 20_000), ...(input.range && typeof input.range === "object" ? { range: input.range as SceneAnnotation["range"] } : {}) }); json(response, 201, { annotation: created }); return; }
    const annotationRoute = path.match(/^\/api\/annotations\/([^/]+)$/);
    if (annotationRoute && method === "PATCH") { json(response, 200, { annotation: store.updateAnnotation(annotationRoute[1]!, { ...(typeof input.body === "string" ? { body: input.body } : {}), ...(typeof input.status === "string" ? { status: input.status as "open" | "resolved" } : {}) }) }); return; }
    // 作者录入元素：与既有元素同一张表，来源标记为作者设定并默认已确认。
    if (path === "/api/elements" && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const project = store.getProject(projectId);
      if (!knowledge.addEntity) throw new DomainError(503, "ELEMENTS_UNAVAILABLE", "当前知识服务不支持元素写入");
      const type = requiredString(input.type, "type", 40);
      if (!["character", "item", "location", "organization", "ability", "rule", "event", "secret", "custom"].includes(type)) throw new DomainError(400, "INVALID_INPUT", "元素类型无效");
      const routeId = typeof input.routeId === "string" ? requiredString(input.routeId, "routeId") : project.activeRouteId;
      if (!store.listRoutes(projectId).some(route => route.routeId === routeId)) throw new DomainError(400, "SCOPE_MISMATCH", "故事路线不属于此作品");
      const entityId = knowledge.addEntity({
        projectId, type: type as Entity["type"], name: requiredString(input.name, "name", 200),
        summary: typeof input.summary === "string" ? input.summary.slice(0, 20_000) : "",
        routeId, sourceKind: "author_setting", reviewState: "confirmed",
        ...(input.unique === true ? { unique: true } : {}),
      });
      const aliases = Array.isArray(input.aliases) ? input.aliases.map(alias => requiredString(alias, "alias", 200)).slice(0, 20) : [];
      for (const alias of aliases) knowledge.addAlias?.(projectId, entityId, alias);
      store.recordInteraction({ projectId, kind: "element-created", actor: "author", meta: { entityId, type } });
      json(response, 201, { entity: knowledge.listEntities(projectId).find(item => item.entityId === entityId) }); return;
    }
    // 作者修改元素：只接受本作品已有元素，避免写入其他作品或凭空创建。
    const elementRoute = path.match(/^\/api\/elements\/([^/]+)$/);
    if (elementRoute && method === "PATCH") {
      const projectId = requiredString(input.projectId, "projectId");
      const entityId = decodeURIComponent(elementRoute[1]!);
      store.getProject(projectId);
      const existing = knowledge.listEntities(projectId).find(item => item.entityId === entityId);
      if (!existing) throw new DomainError(404, "NOT_FOUND", "元素不存在或不属于此作品");
      if (!knowledge.addEntity) throw new DomainError(503, "ELEMENTS_UNAVAILABLE", "当前知识服务不支持元素写入");
      knowledge.addEntity({
        entityId, projectId, type: existing.type,
        name: typeof input.name === "string" ? requiredString(input.name, "name", 200) : existing.name,
        summary: typeof input.summary === "string" ? input.summary.slice(0, 20_000) : existing.summary,
        routeId: existing.routeId, sourceKind: existing.sourceKind, reviewState: existing.reviewState,
      });
      if (Array.isArray(input.aliases)) {
        const next = input.aliases.map(alias => requiredString(alias, "alias", 200)).slice(0, 20);
        for (const alias of next) knowledge.addAlias?.(projectId, entityId, alias);
        // 全量同步：删除作者已移除的别名（不动与实体名同源的记录）。
        const removed = existing.aliases.filter(alias => !next.includes(alias));
        for (const alias of removed) knowledge.removeAlias?.(projectId, entityId, alias);
      }
      store.recordInteraction({ projectId, kind: "element-updated", actor: "author", meta: { entityId } });
      json(response, 200, { entity: knowledge.listEntities(projectId).find(item => item.entityId === entityId) }); return;
    }
    const elementFactsRoute = path.match(/^\/api\/elements\/([^/]+)\/facts$/);
    if (elementFactsRoute && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const entityId = decodeURIComponent(elementFactsRoute[1]!);
      const project = store.getProject(projectId);
      const existing = knowledge.listEntities(projectId).find(item => item.entityId === entityId);
      if (!existing) throw new DomainError(404, "NOT_FOUND", "元素不存在或不属于此作品");
      if (!knowledge.addFact) throw new DomainError(503, "ELEMENTS_UNAVAILABLE", "当前知识服务不支持事实写入");
      const predicate = requiredString(input.predicate, "predicate", 100);
      const semanticTypeRaw = typeof input.semanticType === "string" ? input.semanticType : "world_fact";
      if (!["world_fact", "belief", "rumor", "deception", "plan", "hypothesis"].includes(semanticTypeRaw)) throw new DomainError(400, "INVALID_INPUT", "语义类型无效");
      const routeId = typeof input.routeId === "string" ? requiredString(input.routeId, "routeId") : existing.routeId || project.activeRouteId;
      let value: FactAssertion["value"];
      if (typeof input.valueEntityId === "string" && input.valueEntityId.trim()) {
        value = { entityId: requiredString(input.valueEntityId, "valueEntityId", 200) };
      } else if (input.value && typeof input.value === "object" && !Array.isArray(input.value) && "entityId" in input.value) {
        value = { entityId: requiredString((input.value as { entityId: unknown }).entityId, "entityId", 200) };
      } else {
        value = requiredString(String(input.value ?? ""), "value", 2000);
      }
      const validFromOrder = input.validFromOrder !== undefined && Number.isFinite(Number(input.validFromOrder)) ? Number(input.validFromOrder) : undefined;
      const validToOrder = input.validToOrder !== undefined && Number.isFinite(Number(input.validToOrder)) ? Number(input.validToOrder) : undefined;
      const factId = knowledge.addFact({
        ...(typeof input.factId === "string" ? { factId: input.factId } : {}),
        projectId,
        subjectId: entityId,
        predicate,
        value,
        semanticType: semanticTypeRaw as FactAssertion["semanticType"],
        reviewState: "confirmed",
        sourceKind: "author_setting",
        routeId,
        ...(validFromOrder !== undefined ? { validFromOrder } : {}),
        ...(validToOrder !== undefined ? { validToOrder } : {}),
        ...(typeof input.holderId === "string" && input.holderId.trim() ? { holderId: input.holderId.trim() } : {}),
      });
      store.recordInteraction({ projectId, kind: "element-fact-added", actor: "author", meta: { entityId, factId, predicate } });
      json(response, 201, { fact: knowledge.listFacts(projectId).find(f => f.factId === factId), snapshot: snapshot(projectId) }); return;
    }
    const elementEventsRoute = path.match(/^\/api\/elements\/([^/]+)\/events$/);
    if (elementEventsRoute && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const entityId = decodeURIComponent(elementEventsRoute[1]!);
      const project = store.getProject(projectId);
      const existing = knowledge.listEntities(projectId).find(item => item.entityId === entityId);
      if (!existing) throw new DomainError(404, "NOT_FOUND", "元素不存在或不属于此作品");
      if (!knowledge.addEvent) throw new DomainError(503, "ELEMENTS_UNAVAILABLE", "当前知识服务不支持事件写入");
      const kind = requiredString(input.kind, "kind", 100);
      const routeId = typeof input.routeId === "string" ? requiredString(input.routeId, "routeId") : existing.routeId || project.activeRouteId;
      const storyTime = typeof input.storyTime === "string" && input.storyTime.trim() ? input.storyTime.trim().slice(0, 200) : undefined;
      const storyOrder = input.storyOrder !== undefined && Number.isFinite(Number(input.storyOrder)) ? Number(input.storyOrder) : (parseStoryOrderFromTime(storyTime) ?? 1);
      // 事件与边界事实同一事务写入：任一步失败整体回滚，不留「有事件无边界」的半成品。
      const writeEventAndBoundary = store.db.transaction(() => {
        const eventId = knowledge.addEvent!({
          ...(typeof input.eventId === "string" ? { eventId: input.eventId } : {}),
          projectId,
          kind,
          ...(typeof input.sceneId === "string" && input.sceneId.trim() ? { sceneId: input.sceneId.trim() } : {}),
          routeId,
          ...(storyTime ? { storyTime } : {}),
          storyOrder,
          subjectId: entityId,
          ...(typeof input.fromValue === "string" && input.fromValue.trim() ? { fromValue: input.fromValue.trim().slice(0, 1000) } : {}),
          toValue: requiredString(input.toValue, "toValue", 1000),
          ...(typeof input.location === "string" && input.location.trim() ? { location: input.location.trim().slice(0, 200) } : {}),
          reviewState: "confirmed",
        });
        // 秘密的知情/揭示边界要按「查询时点」生效：事件用于时间线展示，
        // 同时必须写成 known_by/revealed 边界事实，secretVisibleTo 才会消费。
        if (existing.type === "secret" && (kind === "known_by" || kind === "revealed") && knowledge.addFact) {
          const entityByName = (ref: string) =>
            knowledge.listEntities(projectId).find(item => item.entityId === ref || item.name === ref || item.aliases.includes(ref));
          const boundaryFact: Parameters<NonNullable<typeof knowledge.addFact>>[0] = {
            projectId,
            subjectId: entityId,
            predicate: kind,
            value: "",
            semanticType: "world_fact",
            reviewState: "confirmed",
            sourceKind: "author_setting",
            routeId,
            validFromOrder: storyOrder,
          };
          if (kind === "known_by") {
            const holder = entityByName(String(input.toValue));
            boundaryFact.value = holder ? { entityId: holder.entityId } : requiredString(String(input.toValue), "toValue", 1000);
          } else {
            boundaryFact.value = requiredString(String(input.toValue), "toValue", 1000);
          }
          knowledge.addFact(boundaryFact);
        }
        return eventId;
      });
      const eventId = writeEventAndBoundary();
      store.recordInteraction({ projectId, kind: "element-event-added", actor: "author", meta: { entityId, eventId, kind } });
      json(response, 201, { event: knowledge.listEvents(projectId).find(ev => ev.eventId === eventId), snapshot: snapshot(projectId) }); return;
    }
    if (path === "/api/assist/element-design" && method === "POST") {
      const result = await assist.generateElementDesign({
        projectId: requiredString(input.projectId, "projectId"),
        ...(typeof input.type === "string" ? { type: input.type as Entity["type"] } : {}),
        ...(typeof input.targetEntityId === "string" ? { targetEntityId: input.targetEntityId } : {}),
        prompt: requiredString(input.prompt, "prompt", 4000),
        ...(typeof input.roleHint === "string" ? { roleHint: input.roleHint } : {}),
        ...(Array.isArray(input.relatedEntityIds) ? { relatedEntityIds: input.relatedEntityIds.map(id => requiredString(id, "relatedEntityId", 200)) } : {}),
      });
      json(response, 200, result); return;
    }
    if (path === "/api/assist/element-design/apply" && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const applied = assist.applyElementDesignCard({
        projectId,
        card: input.card as ElementDesignCard,
        ...(typeof input.targetEntityId === "string" ? { targetEntityId: input.targetEntityId } : {}),
        ...(typeof input.routeId === "string" ? { routeId: input.routeId } : {}),
        acceptanceId: typeof input.acceptanceId === "string" ? requiredString(input.acceptanceId, "acceptanceId", 200) : newId("elem_apply"),
      });
      json(response, 200, { ...applied, snapshot: snapshot(projectId) }); return;
    }
    if (path === "/api/element-guide/sessions" && method === "POST") {
      const session = await elementGuide.create({
        projectId: requiredString(input.projectId, "projectId"),
        ...(typeof input.type === "string" ? { type: input.type as Entity["type"] } : {}),
        ...(typeof input.targetEntityId === "string" ? { targetEntityId: input.targetEntityId } : {}),
        ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
        ...(typeof input.roleHint === "string" ? { roleHint: input.roleHint } : {}),
        ...(Array.isArray(input.relatedEntityIds) ? { relatedEntityIds: input.relatedEntityIds.map(id => requiredString(id, "relatedEntityId", 200)) } : {}),
        forceNew: input.forceNew === true,
      });
      json(response, 201, { session }); return;
    }
    const elementGuideRoute = path.match(/^\/api\/element-guide\/sessions\/([^/]+)\/(next|answer|back|cancel|apply|proposal)$/);
    if (elementGuideRoute) {
      const sessionId = elementGuideRoute[1]!;
      const action = elementGuideRoute[2]!;
      if (method === "PATCH" && action === "proposal") { json(response, 200, { session: elementGuide.updateProposal(sessionId, input.cards) }); return; }
      if (method === "POST" && action === "next") { json(response, 200, { session: await elementGuide.next(sessionId) }); return; }
      if (method === "POST" && action === "answer") { json(response, 200, { session: await elementGuide.answer(sessionId, { ...(typeof input.optionId === "string" ? { optionId: input.optionId } : {}), ...(typeof input.custom === "string" ? { custom: input.custom } : {}), skip: input.skip === true }) }); return; }
      if (method === "POST" && action === "back") { json(response, 200, { session: elementGuide.back(sessionId) }); return; }
      if (method === "POST" && action === "cancel") { json(response, 200, { session: elementGuide.cancel(sessionId) }); return; }
      if (method === "POST" && action === "apply") {
        const applied = elementGuide.apply(sessionId, typeof input.proposalId === "string" ? input.proposalId : undefined, input.card ? input.card as ElementDesignCard : undefined);
        json(response, 200, { ...applied, snapshot: snapshot(applied.session.projectId) }); return;
      }
    }
    if (path === "/api/assist/arc" && method === "POST") {
      const mode = input.mode === "diagnose" ? "diagnose" : "propose";
      const result = await assist.assistCharacterArc({
        projectId: requiredString(input.projectId, "projectId"),
        entityId: requiredString(input.entityId, "entityId"),
        mode,
        ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
      });
      json(response, 200, result); return;
    }
    if (path === "/api/assist/plot-ideate" && method === "POST") {
      const result = await assist.ideatePlot({
        projectId: requiredString(input.projectId, "projectId"),
        mode: requiredString(input.mode, "mode", 40) as PlotIdeateMode,
        ...(typeof input.sceneId === "string" ? { sceneId: input.sceneId } : {}),
        ...(typeof input.toSceneId === "string" ? { toSceneId: input.toSceneId } : {}),
        ...(typeof input.chapterId === "string" ? { chapterId: input.chapterId } : {}),
        ...(typeof input.fieldTarget === "string" ? { fieldTarget: input.fieldTarget as "goal" | "conflict" | "summary" } : {}),
        ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
        ...(typeof input.reviewSummary === "string" ? { reviewSummary: input.reviewSummary } : {}),
      });
      json(response, 200, result); return;
    }
    if (path === "/api/assist/plot-ideate/apply" && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const adopted = assist.applyPlotIdeation({
        projectId,
        baseRevisionId: requiredString(input.baseRevisionId, "baseRevisionId"),
        acceptanceId: typeof input.acceptanceId === "string" ? requiredString(input.acceptanceId, "acceptanceId", 200) : newId("plot_apply"),
        mode: requiredString(input.mode, "mode", 40) as PlotIdeateMode,
        ...(typeof input.sceneId === "string" ? { sceneId: input.sceneId } : {}),
        ...(typeof input.chapterId === "string" ? { chapterId: input.chapterId } : {}),
        ...(Array.isArray(input.scenes) ? { scenes: input.scenes as SceneProposalCard[] } : {}),
        ...(typeof input.fieldTarget === "string" ? { fieldTarget: input.fieldTarget as "goal" | "conflict" | "summary" } : {}),
        ...(typeof input.fieldValue === "string" ? { fieldValue: input.fieldValue } : {}),
      });
      indexRevision(projectId, adopted.revision.revisionId);
      json(response, 200, { ...adopted, snapshot: snapshot(projectId) }); return;
    }
    if (path === "/api/notes/incubate" && method === "POST") {
      const result = await assist.incubateNotes({
        projectId: requiredString(input.projectId, "projectId"),
        noteIds: Array.isArray(input.noteIds) ? input.noteIds.map(id => requiredString(id, "noteId", 200)) : [],
        targetKind: requiredString(input.targetKind, "targetKind", 40) as NoteIncubateTarget,
        ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
      });
      json(response, 200, result); return;
    }
    if (path === "/api/notes/incubate/apply" && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const branch = store.getBranch(store.getProject(projectId).activeBranchId);
      const applied = assist.applyNoteIncubation({
        projectId,
        noteIds: Array.isArray(input.noteIds) ? input.noteIds.map(id => requiredString(id, "noteId", 200)) : [],
        targetKind: requiredString(input.targetKind, "targetKind", 40) as NoteIncubateTarget,
        baseRevisionId: typeof input.baseRevisionId === "string" ? requiredString(input.baseRevisionId, "baseRevisionId") : branch.headRevisionId,
        acceptanceId: typeof input.acceptanceId === "string" ? requiredString(input.acceptanceId, "acceptanceId", 200) : newId("incubate_apply"),
        ...(input.elementCard ? { elementCard: input.elementCard as ElementDesignCard } : {}),
        ...(Array.isArray(input.sceneCards) ? { sceneCards: input.sceneCards as SceneProposalCard[] } : {}),
        ...(typeof input.chapterId === "string" ? { chapterId: input.chapterId } : {}),
      });
      if (applied.revision) indexRevision(projectId, applied.revision.revisionId);
      json(response, 200, { ...applied, snapshot: snapshot(projectId) }); return;
    }
    if (path === "/api/assist/extract-ledger" && method === "POST") {
      const result = await assist.extractLedgerFromScene({
        projectId: requiredString(input.projectId, "projectId"),
        sceneId: requiredString(input.sceneId, "sceneId"),
      });
      json(response, 200, result); return;
    }
    if (path === "/api/assist/extract-ledger/apply" && method === "POST") {
      const projectId = requiredString(input.projectId, "projectId");
      const applied = assist.applyExtractedLedger({
        projectId,
        sceneId: requiredString(input.sceneId, "sceneId"),
        acceptanceId: typeof input.acceptanceId === "string" ? requiredString(input.acceptanceId, "acceptanceId", 200) : newId("extract_apply"),
        ...(Array.isArray(input.newElements) ? { newElements: input.newElements as ExtractedElementProposal[] } : {}),
        ...(Array.isArray(input.factProposals) ? { factProposals: input.factProposals as ExtractedFactProposal[] } : {}),
        ...(Array.isArray(input.eventProposals) ? { eventProposals: input.eventProposals as ExtractedEventProposal[] } : {}),
      });
      if (applied.revision) indexRevision(projectId, applied.revision.revisionId);
      json(response, 200, { ...applied, snapshot: snapshot(projectId) }); return;
    }
    if (path === "/api/notes" && method === "POST") { const created = store.createNote({ projectId: requiredString(input.projectId, "projectId"), title: requiredString(input.title, "title", 200), body: typeof input.body === "string" ? input.body : "", ...(typeof input.sceneId === "string" ? { sceneId: input.sceneId } : {}), ...(typeof input.elementId === "string" ? { elementId: input.elementId } : {}), ...(Array.isArray(input.tags) ? { tags: input.tags.map((tag: unknown) => requiredString(tag, "tag", 40)) } : {}) }); json(response, 201, { note: created }); return; }
    const noteRoute = path.match(/^\/api\/notes\/([^/]+)(?:\/(promote))?$/);
    if (noteRoute) {
      const noteId = noteRoute[1]!, action = noteRoute[2];
      if (method === "PATCH" && !action) { json(response, 200, { note: store.updateNote(noteId, { ...(typeof input.title === "string" ? { title: input.title } : {}), ...(typeof input.body === "string" ? { body: input.body } : {}), ...(typeof input.status === "string" ? { status: input.status as "inbox" | "linked" | "archived" } : {}), ...(Object.hasOwn(input, "sceneId") ? { sceneId: typeof input.sceneId === "string" ? input.sceneId : null } : {}), ...(Object.hasOwn(input, "elementId") ? { elementId: typeof input.elementId === "string" ? input.elementId : null } : {}), ...(Array.isArray(input.tags) ? { tags: input.tags.map((tag: unknown) => requiredString(tag, "tag", 40)) } : {}) }) }); return; }
      if (method === "DELETE" && !action) { json(response, 200, { note: store.updateNote(noteId, { status: "archived" }) }); return; }
      if (method === "POST" && action === "promote") { const promoted = store.promoteNote(noteId); indexRevision(promoted.revision.projectId, promoted.revision.revisionId); json(response, 200, { ...promoted, snapshot: snapshot(promoted.revision.projectId) }); return; }
    }
    if (path === "/api/chapters" && method === "POST") { const created = store.addChapter(requiredString(input.projectId, "projectId"), requiredString(input.title, "title", 200)); indexRevision(created.revision.projectId, created.revision.revisionId); json(response, 201, { ...created, snapshot: snapshot(created.revision.projectId) }); return; }
    const chapterRoute = path.match(/^\/api\/chapters\/([^/]+)$/);
    if (chapterRoute && method === "PATCH") { const revision = store.renameChapter(chapterRoute[1]!, requiredString(input.title, "title", 200), requiredString(input.baseRevisionId, "baseRevisionId")); indexRevision(revision.projectId, revision.revisionId); json(response, 200, { revision, snapshot: snapshot(revision.projectId) }); return; }
    if (path === "/api/scenes" && method === "POST") { const created = store.createScene(requiredString(input.projectId, "projectId"), typeof input.chapterId === "string" ? input.chapterId : undefined, requiredString(input.title, "title", 200)); indexRevision(created.revision.projectId, created.revision.revisionId); json(response, 201, { ...created, snapshot: snapshot(created.revision.projectId) }); return; }
    const moveRoute = path.match(/^\/api\/scenes\/([^/]+)\/move$/);
    if (moveRoute && method === "POST") { const revision = store.moveScene(moveRoute[1]!, requiredString(input.chapterId, "chapterId"), Number(input.narrationOrder), requiredString(input.baseRevisionId, "baseRevisionId")); indexRevision(revision.projectId, revision.revisionId); json(response, 200, { revision, snapshot: snapshot(revision.projectId) }); return; }
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
        const adopted = guide.apply(sessionId, input.proposalIds === undefined ? undefined : Array.isArray(input.proposalIds) ? input.proposalIds.map((id: unknown) => requiredString(id, "proposalId", 100)) : (() => { throw new DomainError(400, "GUIDE_INVALID_SELECTION", "proposalIds 必须是数组"); })());
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
    const duplicateProject = path.match(/^\/api\/projects\/([^/]+)\/duplicate$/);
    if (duplicateProject && method === "POST") { const duplicated = store.duplicateProject(duplicateProject[1]!); indexRevision(duplicated.project.projectId, duplicated.revision.revisionId); json(response, 201, { ...duplicated, snapshot: snapshot(duplicated.project.projectId) }); return; }
    const projectRoute = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectRoute && method === "PATCH") { const project = store.updateProject(projectRoute[1]!, { ...(typeof input.title === "string" ? { title: input.title } : {}), ...(typeof input.archived === "boolean" ? { archived: input.archived } : {}) }); json(response, 200, { project, snapshot: snapshot(project.archivedAt ? undefined : project.projectId) }); return; }
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
            // 引擎给出具体原因时优先显示，否则保留通用文案。
            throw new DomainError(502, "IDEAS_INCOMPLETE", result.error ?? "点子生成尚未完整完成");
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
      json(response, 200, { run: workflow.decide(decision[1]!, requiredString(input.todoId, "todoId"), requiredString(input.answer, "answer"), requiredString(input.inputHash, "inputHash"), input.reviewNote === undefined ? undefined : requiredString(input.reviewNote, "reviewNote", 4000)) }); return;
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
    if (path === "/api/knowledge/rebuild" && method === "POST") {
      // 只接受作品内已有修订 ID，正文一律取权威清单，不接受外部文本。
      const projectId = requiredString(input.projectId, "projectId");
      const revisionId = requiredString(input.revisionId, "revisionId");
      store.getProject(projectId);
      const revision = store.getRevision(revisionId);
      if (revision.projectId !== projectId) throw new DomainError(400, "SCOPE_MISMATCH", "修订不属于此作品");
      if (!knowledge.rebuildRevisionIndex) throw new DomainError(503, "INDEX_REBUILD_UNAVAILABLE", "当前知识服务不支持索引重建");
      const scenes = store.listScenes(projectId, revisionId);
      json(response, 200, { revisionId, ...knowledge.rebuildRevisionIndex(projectId, revisionId, scenes) }); return;
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
