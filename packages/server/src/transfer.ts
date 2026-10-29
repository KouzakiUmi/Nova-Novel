import type { Chapter, Scene, WorkspaceSnapshot } from "@nova-novel/shared";
import { DomainError } from "./domain.js";

export interface ImportedScene { title: string; body: string; summary?: string }
export function parseManuscript(input: string): { chapterTitle: string; scenes: ImportedScene[] } {
  if (typeof input !== "string" || input.length > 1_000_000) throw new DomainError(400, "INVALID_INPUT", "导入文本必须是文字且不超过 1 MiB");
  const normalized = input.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let chapterTitle = "导入正文";
  const scenes: ImportedScene[] = [];
  let title = "第一场";
  let body: string[] = [];
  let hasContent = false;
  const push = () => {
    const text = body.join("\n").trim();
    if (text) scenes.push({ title, body: text });
    hasContent ||= Boolean(text);
    body = [];
  };
  for (const line of lines) {
    if (line.startsWith("# ")) { push(); chapterTitle = line.slice(2).trim() || chapterTitle; title = "第一场"; continue; }
    if (line.startsWith("## ")) { push(); title = line.slice(3).trim() || `第 ${scenes.length + 1} 场`; continue; }
    if (line.trim() === "---") { push(); title = `第 ${scenes.length + 1} 场`; continue; }
    if (line.startsWith("> ")) continue;
    body.push(line);
  }
  push();
  if (scenes.length === 0) scenes.push({ title: "第一场", body: "" });
  return { chapterTitle, scenes: scenes.filter(scene => scene.title || scene.body).slice(0, 500) };
}

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
  if (scenes.length < 1 || scenes.length > 500 || scenes.some(scene => typeof scene.sceneId !== "string" || typeof scene.chapterId !== "string" || typeof scene.routeId !== "string" || typeof scene.title !== "string" || typeof scene.body !== "string")) throw new DomainError(400, "INVALID_BACKUP", "备份必须包含 1–500 个有效场景");
  return value as NovaBackup;
}
