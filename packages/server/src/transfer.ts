import type { WorkspaceSnapshot } from "@nova-novel/shared";
import { DomainError } from "./domain.js";

// 分章与摘要逻辑已下沉到 @nova-novel/shared（前后端共用本地预处理管线），此处仅转口；
// ManuscriptError 由客户端本地解析抛出，服务端响应仍统一走 DomainError。
export { parseManuscript, summarizeManuscript, looseHeadingCandidates, headingCandidates, sliceByChapterPattern, sliceManuscript, manuscriptAsText, chunkImportedChapters, MANUSCRIPT_TEXT_MAX, ManuscriptError } from "@nova-novel/shared";
export type { ImportedScene, HeadingCandidate, HeadingDecision } from "@nova-novel/shared";

export function exportMarkdown(snapshot: WorkspaceSnapshot): string {
  const parts: string[] = [];
  for (const chapter of snapshot.chapters) {
    parts.push(`# ${chapter.title}`);
    for (const scene of snapshot.scenes.filter(scene => scene.chapterId === chapter.chapterId)) {
      parts.push(`## ${scene.title}`);
      if (scene.summary) parts.push(`> 摘要：${scene.summary}`);
      if (scene.goal) parts.push(`> 目标：${scene.goal}`);
      if (scene.conflict) parts.push(`> 阻碍：${scene.conflict}`);
      parts.push(scene.body);
      parts.push("---");
    }
  }
  return `${parts.join("\n\n")}\n`;
}

export function exportBackup(snapshot: WorkspaceSnapshot) {
  return {
    format: "nova-novel-backup/1",
    exportedAt: new Date().toISOString(),
    project: snapshot.activeProject,
    branches: snapshot.branches,
    routes: snapshot.routes,
    chapters: snapshot.chapters,
    scenes: snapshot.scenes,
    elements: snapshot.elements,
    facts: snapshot.facts,
    events: snapshot.events,
    evidence: snapshot.evidence,
    notes: snapshot.notes,
    annotations: snapshot.annotations,
    characterArcs: snapshot.characterArcs,
    storyGraph: snapshot.storyGraph,
    authoringDraft: snapshot.authoringDraft,
  };
}

export type NovaBackup = Omit<ReturnType<typeof exportBackup>, "storyGraph"> & { storyGraph?: WorkspaceSnapshot["storyGraph"]; workflows?: WorkspaceSnapshot["workflows"] };

export function parseBackup(value: unknown): NovaBackup {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(400, "INVALID_BACKUP", "备份必须是 JSON 对象");
  const backup = value as Record<string, unknown>;
  if (backup.format !== "nova-novel-backup/1") throw new DomainError(400, "INVALID_BACKUP", "不支持的备份格式");
  if (!backup.project || typeof backup.project !== "object" || typeof (backup.project as { title?: unknown }).title !== "string") throw new DomainError(400, "INVALID_BACKUP", "备份缺少作品信息");
  const arrays = ["branches", "routes", "chapters", "scenes", "elements", "facts", "events", "evidence", "notes", "annotations", "characterArcs"];
  for (const key of arrays) if (!Array.isArray(backup[key]) || (backup[key] as unknown[]).length > 20_000) throw new DomainError(400, "INVALID_BACKUP", `备份的 ${key} 无效或过大`);
  if (backup.workflows !== undefined && !Array.isArray(backup.workflows)) throw new DomainError(400, "INVALID_BACKUP", "备份的 workflows 无效");
  const scenes = backup.scenes as Array<Record<string, unknown>>;
  if (scenes.length < 1 || scenes.length > 500) throw new DomainError(400, "INVALID_BACKUP", "备份必须包含 1–500 个有效场景");
  for (const [index, scene] of scenes.entries()) {
    if (!scene || typeof scene !== "object") throw new DomainError(400, "INVALID_BACKUP", `场景 #${index + 1} 格式无效`);
    const strKeys = ["sceneId", "chapterId", "routeId", "title", "body"];
    for (const key of strKeys) if (typeof scene[key] !== "string") throw new DomainError(400, "INVALID_BACKUP", `场景 #${index + 1} 的 ${key} 无效`);
    if (scene.pov !== undefined && typeof scene.pov !== "string") throw new DomainError(400, "INVALID_BACKUP", `场景 #${index + 1} 的 pov 无效`);
    if (!Array.isArray(scene.entityIds)) throw new DomainError(400, "INVALID_BACKUP", `场景 #${index + 1} 的 entityIds 必须是数组`);
    if (scene.entityIds.some(id => typeof id !== "string")) throw new DomainError(400, "INVALID_BACKUP", `场景 #${index + 1} 的 entityIds 含非法项`);
  }
  const elements = backup.elements as Array<Record<string, unknown>>;
  for (const [index, entity] of elements.entries()) {
    if (!entity || typeof entity !== "object") throw new DomainError(400, "INVALID_BACKUP", `元素 #${index + 1} 格式无效`);
    if (typeof entity.entityId !== "string" || typeof entity.name !== "string") throw new DomainError(400, "INVALID_BACKUP", `元素 #${index + 1} 缺少 entityId 或 name`);
    if (!Array.isArray(entity.aliases)) throw new DomainError(400, "INVALID_BACKUP", `元素 #${index + 1} 的 aliases 必须是数组`);
    if (entity.aliases.some(alias => typeof alias !== "string")) throw new DomainError(400, "INVALID_BACKUP", `元素 #${index + 1} 的 aliases 含非法项`);
  }
  const facts = backup.facts as Array<Record<string, unknown>>;
  for (const [index, fact] of facts.entries()) {
    if (!fact || typeof fact !== "object") throw new DomainError(400, "INVALID_BACKUP", `事实 #${index + 1} 格式无效`);
    if (typeof fact.subjectId !== "string") throw new DomainError(400, "INVALID_BACKUP", `事实 #${index + 1} 缺少 subjectId`);
    if (!Array.isArray(fact.evidenceIds)) throw new DomainError(400, "INVALID_BACKUP", `事实 #${index + 1} 的 evidenceIds 必须是数组`);
    if (fact.evidenceIds.some(id => typeof id !== "string")) throw new DomainError(400, "INVALID_BACKUP", `事实 #${index + 1} 的 evidenceIds 含非法项`);
  }
  const events = backup.events as Array<Record<string, unknown>>;
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object") throw new DomainError(400, "INVALID_BACKUP", `事件 #${index + 1} 格式无效`);
    if (!Array.isArray(event.evidenceIds)) throw new DomainError(400, "INVALID_BACKUP", `事件 #${index + 1} 的 evidenceIds 必须是数组`);
    if (event.evidenceIds.some(id => typeof id !== "string")) throw new DomainError(400, "INVALID_BACKUP", `事件 #${index + 1} 的 evidenceIds 含非法项`);
  }
  return value as NovaBackup;
}
