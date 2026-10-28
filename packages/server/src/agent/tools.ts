import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import Database from "better-sqlite3";
import type { ContextQuery, WorkflowDefinition } from "@nova-novel/shared";
import { buildBuiltinDefinitions } from "../workflow/definitions.js";
import type { KnowledgeService } from "../contracts.js";
import type { DomainStore } from "../store.js";
import { parseStoryOrderFromTime, SqliteKnowledgeService } from "../knowledge/index.js";
import { DomainError } from "../domain.js";

/**
 * WAL 模式文件库序列化后，头部第 18、19 字节为 2（WAL），内存反序列化无法打开对应 -wal 文件。
 * 快照只读，改回 1（回滚日志）即可在内存中打开；不影响原数据库。
 */
export function memorySnapshot(serialized: Buffer): Buffer {
  const copy = Buffer.from(serialized);
  if (copy.length >= 20 && copy[18] === 2 && copy[19] === 2) { copy[18] = 1; copy[19] = 1; }
  return copy;
}

export interface WorkflowCatalog { listDefinitions(): WorkflowDefinition[] }

export function novelTools(store: DomainStore, knowledge: KnowledgeService, taskId: string, workflowCatalog: WorkflowCatalog = { listDefinitions: buildBuiltinDefinitions }): { tools: ToolDefinition[]; isVisible(value: unknown): boolean; dispose(): void } {
  const frozen = store.generationContext(taskId);
  const novel = frozen.novel;
  if (!novel) throw new DomainError(409, "MISSING_TASK_CONTEXT", "任务缺少小说上下文");
  const snapshotDb = new Database(memorySnapshot(store.db.serialize()));
  const frozenKnowledge = knowledge instanceof SqliteKnowledgeService ? new SqliteKnowledgeService(snapshotDb) : knowledge;
  const { project, scene, branchId, routeId } = novel;
  const storyOrder = scene ? parseStoryOrderFromTime(scene.storyTime) : undefined;
  const query: ContextQuery = { projectId: project.projectId, branchId, routeId, revisionId: frozen.freeze.baseRevisionId, query: "", purpose: frozen.request.kind === "ideas" ? "planning" : frozen.request.kind === "consistency" ? "fact_check" : "scene_writing", ...(scene ? { narrationOrder: scene.narrationOrder, ...(scene.pov ? { povEntityId: scene.pov } : {}) } : {}), ...(storyOrder !== undefined ? { storyOrder } : {}) };
  // Capture all tool data before the first await so edits during generation cannot move its boundary.
  const allEntities = frozenKnowledge.listEntities(project.projectId).filter(entity => entity.routeId === routeId && entity.reviewState === "confirmed");
  const context = frozenKnowledge.queryContext({ ...query, query: allEntities.map(entity => entity.name).join(" ") });
  const factSubjects = new Set(context.facts.map(fact => fact.subjectId));
  const entities = allEntities.filter(entity => entity.type !== "secret" || factSubjects.has(entity.entityId));
  const hiddenNames = allEntities.filter(entity => entity.type === "secret" && !factSubjects.has(entity.entityId)).flatMap(entity => [entity.name, entity.entityId, ...entity.aliases]);
  const hasHidden = (value: unknown) => hiddenNames.some(name => name && JSON.stringify(value).includes(name));
  const scenes = store.listScenes(project.projectId, query.revisionId).filter(item => {
    const order = parseStoryOrderFromTime(item.storyTime);
    return item.routeId === routeId && (!scene || item.narrationOrder <= scene.narrationOrder) && (storyOrder === undefined || order === undefined || order <= storyOrder);
  });
  const chapters = store.listChapters(project.projectId, query.revisionId);
  const graph = store.getStoryGraph(project.projectId, query.revisionId);
  const workflowDefinitions = workflowCatalog.listDefinitions();
  const worldService = frozenKnowledge as KnowledgeService & Partial<Pick<SqliteKnowledgeService, "getWorldState">>;
  const state = worldService.getWorldState?.(project.projectId, routeId, storyOrder, query.revisionId);
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
  const tools: ToolDefinition[] = [
    defineTool({ name: "novel_search", label: "查找小说资料", description: "按关键词检索任务冻结范围内的可见事实、原文证据与拟发生的选定计划。", parameters: Type.Object({ query: Type.String({ maxLength: 1000 }) }), async execute(_id, args) {
      return result(frozenKnowledge.queryContext({ ...query, query: args.query }));
    } }),
    defineTool({ name: "novel_get_scene", label: "读取场景", description: "读取当前修订与知识边界内的场景标题、目标、阻碍、预期结果／摘要和正文，正文最多 12000 字。", parameters: Type.Object({ sceneId: Type.String() }), async execute(_id, args) {
      const found = scenes.find(item => item.sceneId === args.sceneId);
      if (!found || hasHidden(found)) throw new Error("场景不存在或不在任务可见范围内");
      return result({ sceneId: found.sceneId, title: found.title, goal: found.goal, conflict: found.conflict, summary: found.summary, body: found.body.slice(0, 12000), truncated: found.body.length > 12000 });
    } }),
    defineTool({ name: "novel_list_scenes", label: "列出场景", description: "列出任务可见范围内的场景顺序、目标、阻碍与预期结果／摘要，不含正文。", parameters: Type.Object({}), async execute() {
      return result(scenes.filter(item => !hasHidden(item)).map(item => ({ sceneId: item.sceneId, chapterId: item.chapterId, title: item.title, narrationOrder: item.narrationOrder, goal: item.goal, conflict: item.conflict, summary: item.summary })));
    } }),
    defineTool({ name: "novel_get_outline", label: "读取大纲", description: "读取任务冻结修订中的章节、可见场景及剧情依赖，不包含隐藏秘密。", parameters: Type.Object({}), async execute() {
      const visibleScenes = scenes.filter(item => !hasHidden(item));
      const sceneIds = new Set(visibleScenes.map(item => item.sceneId));
      const nodes = graph.nodes.filter(node => !hasHidden(node) && (!node.sceneId || sceneIds.has(node.sceneId)));
      const nodeIds = new Set(nodes.map(node => node.id));
      return result({ revisionId: query.revisionId, chapters, scenes: visibleScenes.map(item => ({ sceneId: item.sceneId, chapterId: item.chapterId, title: item.title, narrationOrder: item.narrationOrder, goal: item.goal, conflict: item.conflict, summary: item.summary })), nodes, edges: graph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)) });
    } }),
    defineTool({ name: "novel_list_workflows", label: "列出工作流", description: "列出已注册的不可变工作流版本及节点类型，不包含运行中的敏感作品正文。", parameters: Type.Object({}), async execute() {
      return result(workflowDefinitions.filter(item => !hasHidden(item)).map(item => ({ workflowVersionId: item.workflowVersionId, name: item.name, description: item.description, nodes: item.nodes.map(node => ({ id: node.id, type: node.type, name: node.name })) })));
    } }),
    defineTool({ name: "novel_get_workflow", label: "读取工作流", description: "按不可变版本 ID 读取工作流节点、连线、输入映射与策略。", parameters: Type.Object({ workflowVersionId: Type.String() }), async execute(_id, args) {
      const found = workflowDefinitions.find(item => item.workflowVersionId === args.workflowVersionId);
      if (!found || hasHidden(found)) throw new Error("工作流版本不存在或不可见");
      return result(found);
    } }),
    defineTool({ name: "novel_list_elements", label: "列出元素", description: "列出任务可见的已确认元素，可按类型过滤。", parameters: Type.Object({ type: Type.Optional(Type.String()) }), async execute(_id, args) {
      return result(entities.filter(entity => (!args.type || entity.type === args.type) && !hasHidden(entity)).map(entity => ({ entityId: entity.entityId, name: entity.name, type: entity.type, summary: entity.summary })));
    } }),
    defineTool({ name: "novel_get_element", label: "读取元素", description: "按 ID 或名称读取可见元素、别名及已确认事实。", parameters: Type.Object({ idOrName: Type.String() }), async execute(_id, args) {
      const entity = entities.find(item => item.entityId === args.idOrName || item.name === args.idOrName || item.aliases.includes(args.idOrName));
      if (!entity || hasHidden(entity)) return result({ unknown: true });
      return result({ ...entity, facts: context.facts.filter(fact => fact.subjectId === entity.entityId) });
    } }),
    defineTool({ name: "novel_world_state", label: "读取世界状态", description: "读取冻结故事时点或更早时点的物品持有、位置与数量；可筛选元素 ID，不向未来查询。", parameters: Type.Object({ entityId: Type.Optional(Type.String()), storyOrder: Type.Optional(Type.Number()) }), async execute(_id, args) {
      if (args.storyOrder !== undefined && storyOrder !== undefined && args.storyOrder > storyOrder) throw new Error("不能查询任务时点之后的世界状态");
      const selectedState = args.storyOrder === undefined ? state : worldService.getWorldState?.(project.projectId, routeId, args.storyOrder, query.revisionId);
      const visible = new Set(entities.map(entity => entity.entityId));
      return result(selectedState ? { ...selectedState, entries: selectedState.entries.filter(entry => visible.has(entry.subjectId) && (!args.entityId || entry.subjectId === args.entityId)).map(entry => ({ ...entry, beliefs: entry.beliefs.filter(belief => belief.holderId === query.povEntityId), evidenceQuotes: entry.evidenceQuotes.filter(quote => context.evidence.some(evidence => evidence.quote === quote)) })).filter(entry => !hasHidden(entry)) } : { facts: context.facts.filter(fact => !args.entityId || fact.subjectId === args.entityId) });
    } }),
  ];
  return { tools, isVisible: value => !hasHidden(value), dispose: () => snapshotDb.close() };
}
