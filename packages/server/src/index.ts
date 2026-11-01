import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationRequest } from "@nova-novel/shared";
import { createApp, SECURITY_HEADERS } from "./app.js";
import { VolcengineService } from "./agent/volcengine/service.js";
import { DomainStore } from "./store.js";
import { SqliteKnowledgeService, parseStoryOrderFromTime } from "./knowledge/index.js";
import { PersistentWorkflowService, type WorkflowHooks } from "./workflow/index.js";
import { EmbeddedAgentHost } from "./agent/engine.js";
import { GuidedOutlineService } from "./guide.js";
import { GuidedWorkflowService } from "./workflow-guide.js";
import { newId } from "./utils.js";
import { NotionCopilotPlugin } from "./integrations/notion-copilot.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../..");
const dataDir = resolve(process.env.NOVA_NOVEL_DATA_DIR ?? resolve(projectRoot, "data"));
await mkdir(dataDir, { recursive: true, mode: 0o700 });

const defaultDatabase = resolve(dataDir, "nova-novel.sqlite");
const legacyDatabase = resolve(dataDir, "storyweave.sqlite");
const databasePath = resolve(process.env.NOVA_NOVEL_DB_PATH ?? (!existsSync(defaultDatabase) && existsSync(legacyDatabase) ? legacyDatabase : defaultDatabase));
await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
const db = new Database(databasePath);
const store = new DomainStore(db);
const knowledge = new SqliteKnowledgeService(db);

function prepareProject(projectId: string): void {
  const project = store.getProject(projectId);
  const branch = store.getBranch(project.activeBranchId);
  const scenes = store.listScenes(projectId, branch.headRevisionId);
  if (knowledge.listEntities(projectId).length === 0 && project.title === "修鞋铺收据") {
    const routeId = project.activeRouteId;
    const ahe = knowledge.addEntity({ entityId: `${projectId}_ent_ahe`, projectId, type: "character", name: "阿禾", summary: "准备关掉修鞋铺的年轻人，认得父亲的字迹。", routeId, sourceKind: "author_setting", reviewState: "confirmed" });
    const father = knowledge.addEntity({ entityId: `${projectId}_ent_father`, projectId, type: "character", name: "父亲", summary: "旧修鞋铺原来的主人；过去与现在的关系仍待作者决定。", routeId, sourceKind: "author_setting", reviewState: "confirmed" });
    const receipt = knowledge.addEntity({ entityId: `${projectId}_ent_receipt`, projectId, type: "item", name: "旧收据", summary: "一张标着“已付，待取”的旧收据，背面有父亲的补线叮嘱。", routeId, sourceKind: "manuscript", reviewState: "confirmed", unique: true });
    knowledge.addAlias(projectId, receipt, "收据");
    const shop = knowledge.addEntity({ entityId: `${projectId}_ent_shop`, projectId, type: "location", name: "旧修鞋铺", summary: "即将关门的铺子，柜台下仍留着旧物。", routeId, sourceKind: "author_setting", reviewState: "confirmed" });
    knowledge.addFact({ factId: `${projectId}_fact_receipt_location`, projectId, subjectId: receipt, predicate: "location", value: { entityId: shop }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "manuscript", routeId, validFromOrder: 1 });
    knowledge.addFact({ factId: `${projectId}_fact_ahe_father`, projectId, subjectId: ahe, predicate: "parent", value: { entityId: father }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId });
    const scene = scenes[0];
    if (scene) {
      knowledge.addEvent({ eventId: `${projectId}_ev_receipt_found`, projectId, kind: "item.discover", sceneId: scene.sceneId, routeId, storyTime: scene.storyTime, storyOrder: 1, subjectId: receipt, fromValue: "柜台底下", toValue: "阿禾手中", reviewState: "confirmed" });
      if (scene.entityIds.length === 0) {
        store.saveScene(scene.sceneId, { baseRevisionId: branch.headRevisionId, patch: { entityIds: [ahe, father, receipt, shop] }, acceptanceId: `${projectId}_example_links` });
      }
    }
  }
  const headRevisionId = store.getBranch(project.activeBranchId).headRevisionId;
  const headScenes = store.listScenes(projectId, headRevisionId);
  // 启动时同样声明完整清单，否则索引状态会永远停在 pending。
  knowledge.beginRevisionIndex(projectId, headRevisionId, headScenes.map(scene => scene.sceneId));
  for (const scene of headScenes) knowledge.indexScene(scene, headRevisionId);
}

for (const project of store.listProjects()) prepareProject(project.projectId);

const pi = await EmbeddedAgentHost.create({ dataDir, store, knowledge });
const volcengine = await VolcengineService.create(dataDir, pi.settings);
pi.volcengine = volcengine;
pi.usage.setVolcBackend(volcengine);

function generationRequest(input: { projectId: string; sceneId?: string; kind: GenerationRequest["kind"]; input: string }): GenerationRequest {
  return { ...input, idempotencyKey: newId("workflow_generation") };
}

const hooks: WorkflowHooks = {
  getRevisionId(projectId) {
    const project = store.getProject(projectId);
    return store.getBranch(project.activeBranchId).headRevisionId;
  },
  getScene(projectId, sceneId) {
    const scene = store.getScene(sceneId, hooks.getRevisionId(projectId));
    return scene.projectId === projectId ? scene : undefined;
  },
  retrieve(query) {
    const project = store.getProject(query.projectId);
    return knowledge.queryContext({ ...query, branchId: query.branchId || project.activeBranchId });
  },
  async generate(input) {
    const request = generationRequest(input);
    const project = store.getProject(input.projectId);
    const branch = store.getBranch(project.activeBranchId);
    const scene = input.sceneId ? store.getScene(input.sceneId, branch.headRevisionId) : undefined;
    const storyOrder = scene ? parseStoryOrderFromTime(scene.storyTime) : undefined;
    const context = knowledge.queryContext({
      projectId: input.projectId,
      branchId: branch.branchId,
      routeId: scene?.routeId ?? project.activeRouteId,
      revisionId: branch.headRevisionId,
      query: input.input,
      purpose: input.kind === "consistency" ? "fact_check" : "scene_writing",
      ...(scene ? { narrationOrder: scene.narrationOrder } : {}),
      ...(scene?.pov ? { povEntityId: scene.pov } : {}),
      ...(storyOrder !== undefined ? { storyOrder } : {}),
    });
    const receipt = store.beginGeneration(request, context);
    try {
      const result = await pi.generate({ task: receipt.task, request, systemContext: "" });
      const finished = store.finishGeneration(receipt.task.taskId, result, result.completeness);
      if (finished.task.state !== "succeeded") throw new Error(finished.task.error ?? "生成未完整完成");
      // 工作流检查节点按 JSON 解析分级问题；纯文本 summary 会丢失结构化报告。
      const text = result.report ? JSON.stringify(result.report) : result.text;
      return { text, taskId: receipt.task.taskId };
    } catch (error) {
      store.failGeneration(receipt.task.taskId, error instanceof Error ? error.message : "生成失败");
      throw error;
    }
  },
  commit({ sceneId, body, expectedRevisionId, decisionId }) {
    store.saveScene(sceneId, { baseRevisionId: expectedRevisionId, body, acceptanceId: decisionId ? `workflow_decision_${decisionId}` : newId("workflow_acceptance") });
  },
};

const workflow = new PersistentWorkflowService(db, hooks);
workflow.resumeIncompleteRuns();
pi.setWorkflowCatalog(workflow);
const guide = new GuidedOutlineService(db, store, knowledge, pi);
const workflowGuide = new GuidedWorkflowService(db, store, knowledge, pi, workflow);
const notion = new NotionCopilotPlugin(dataDir);
const apiServer = createApp({ store, knowledge, workflow, pi, guide, workflowGuide, notion });
const apiHandler = apiServer.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => void;

const webRoot = resolve(process.env.NOVA_NOVEL_WEB_ROOT ?? resolve(projectRoot, "packages/web/dist"));
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

async function serveWeb(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
    response.writeHead(405).end("Method Not Allowed");
    return;
  }
  if (!existsSync(resolve(webRoot, "index.html"))) {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("前端尚未构建。请运行 pnpm --filter @nova-novel/web build，或使用 pnpm dev 启动开发界面。");
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  const candidate = resolve(webRoot, `.${pathname}`);
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  let file = candidate;
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
  } catch {
    file = resolve(webRoot, "index.html");
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable", ...SECURITY_HEADERS });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("页面不存在");
  }
}

const server = createServer((request, response) => {
  if ((request.url ?? "").startsWith("/api/")) apiHandler(request, response);
  else void serveWeb(request, response);
});

server.requestTimeout = 660_000;
server.headersTimeout = 30_000;
// 安全生产基线：在 Electron 内（打包或 dev spawn 都会注入令牌）若令牌缺失，说明启动链路异常，
// 此时所有请求会免认证，必须直接失败退出（fail-closed）。纯 Node dev 模式（无 Electron）仍允许裸跑调试。
if (process.versions.electron && !process.env.NOVA_NOVEL_PAIR_TOKEN) {
  throw new Error("NOVA_NOVEL_PAIR_TOKEN 缺失：打包环境必须注入配对令牌，服务拒绝以无认证状态启动");
}
const host = process.env.NOVA_NOVEL_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Nova Novel 仅允许监听本机回环地址");
const port = Number(process.env.NOVA_NOVEL_PORT ?? 43110);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("NOVA_NOVEL_PORT 无效");
server.listen(port, host, () => {
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  console.log(`Nova Novel ready at http://${host}:${actualPort}`);
  console.log(`SQLite: ${databasePath}; Pi: ${pi.getConnection().state}`);
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  await notion.close();
  await pi.close();
  db.close();
}
process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
