import type { Chapter, Scene, WorkspaceSnapshot } from "@nova-novel/shared";
import type { ImportedChapterDraft, ImportedSceneDraft, ManuscriptPreview } from "@nova-novel/shared";
import { DomainError } from "./domain.js";

export type ImportedScene = ImportedSceneDraft;
const NUM = "0-9零一二三四五六七八九十百千万两";
const CHAPTER_RE = new RegExp(`^第[${NUM}]+[章卷](?![节回])`);
const SCENE_RE = new RegExp(`^第[${NUM}]+[节场](?![话])`);
const EN_CHAPTER_RE = /^chapter\s+\d+\b/i;
const ABBREV_CHAPTER_RE = /^ch(?:apter)?[.\-_\s]?\d+\b/i;
const SPECIAL_CHAPTER_RE = /^(?:(?:楔子|序章|序言|尾声|后记)(?:$|[ 　:：\-—·])|番外[0-9零一二三四五六七八九十]*(?:$|[ 　:：\-—·]))/;
const MAX_TITLE_LINE = 60;
const MD_HEADING_RE = /^#{1,6}\s+/;

function cleanHeadingLine(line: string): string {
  // 统一全角数字，去掉成对包裹：【第14章】、[ch-18] 与 第14章 / ch-18 同等处理。
  return line.trim().replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10)).replace(/^[【\[]+|[】\]]+$/g, "").trim();
}
function isChapterHeading(line: string): boolean {
  const text = cleanHeadingLine(line);
  if (!text || text.length > MAX_TITLE_LINE) return false;
  return CHAPTER_RE.test(text) || EN_CHAPTER_RE.test(text) || ABBREV_CHAPTER_RE.test(text) || SPECIAL_CHAPTER_RE.test(text);
}
function isSceneHeading(line: string): boolean {
  const text = cleanHeadingLine(line);
  if (!text || text.length > MAX_TITLE_LINE) return false;
  return SCENE_RE.test(text);
}
function isSeparator(line: string): boolean {
  const text = line.trim();
  return text === "---" || text === "***" || text === "* * *";
}

/** 本地确定性分章：Markdown 标题按内容判定层级，目录与元信息跳过，正文保持原文。 */
export function parseManuscript(input: string): { chapters: ImportedChapterDraft[] } {
  if (typeof input !== "string" || input.length > 1_000_000) throw new DomainError(400, "INVALID_INPUT", "导入文本必须是文字且不超过 1 MiB");
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const chapters: ImportedChapterDraft[] = [];
  let chapter: ImportedChapterDraft = { title: "导入正文", scenes: [] };
  let sceneTitle = "第一场";
  let body: string[] = [];
  let skippingToc = false;
  let sawChapter = false;
  const pushScene = () => {
    const text = body.join("\n").trim();
    if (text) chapter.scenes.push({ title: sceneTitle, body: text });
    body = [];
  };
  const pushChapter = () => {
    pushScene();
    if (chapter.scenes.length || chapters.length === 0) chapters.push(chapter);
    chapter = { title: "", scenes: [] };
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (MD_HEADING_RE.test(trimmed)) {
      const title = cleanHeadingLine(trimmed.replace(MD_HEADING_RE, ""));
      if (/^目录$/.test(title)) { pushScene(); skippingToc = true; continue; }
      if (isChapterHeading(title)) {
        skippingToc = false;
        pushChapter();
        chapter.title = title;
        sceneTitle = "第一场";
        sawChapter = true;
        continue;
      }
      if (skippingToc) continue;
      if (isSceneHeading(title)) { pushScene(); sceneTitle = title; continue; }
      // 一级标题且尚未出现章节：兼容“# 书名 / # 第一章”的旧导出；其余分组标题不混入正文。
      if (/^#\s+/.test(trimmed) && !sawChapter) { pushChapter(); chapter.title = title; sceneTitle = "第一场"; continue; }
      continue;
    }
    if (skippingToc) continue;
    if (isChapterHeading(line)) { pushChapter(); chapter.title = cleanHeadingLine(line); sceneTitle = "第一场"; sawChapter = true; continue; }
    if (isSceneHeading(line)) { pushScene(); sceneTitle = cleanHeadingLine(line); continue; }
    if (isSeparator(line)) { pushScene(); sceneTitle = `第 ${chapter.scenes.length + 1} 场`; continue; }
    if (trimmed.startsWith("> ") || trimmed.startsWith("<a ")) continue;
    // 导出工具的书目元信息（- 作者：…）只出现在正文开始前，不作为小说内容。
    if (!sawChapter && !chapters.some(item => item.scenes.length > 0) && /^[-*]\s+[^：:]+\s*[：:]/.test(trimmed)) continue;
    body.push(line);
  }
  pushChapter();
  let filled = chapters.filter(item => item.scenes.length > 0);
  if (filled.length < 2) {
    // 无编号、无 Markdown 的书：以“上下空行的独立短行”推断章节结构。
    const loose = looseHeadingCandidates(input).filter((candidate, index, all) => index === 0 || candidate.line - all[index - 1]!.line >= 4);
    if (loose.length >= 3) {
      const sliced = sliceManuscript(input, loose.map(candidate => ({ line: candidate.line, level: "chapter" as const })));
      if (sliced && sliced.length >= 2) filled = sliced;
    }
  }
  if (!filled.length) return { chapters: [{ title: chapters[0]?.title || "导入正文", scenes: [{ title: "第一场", body: "" }] }] };
  let total = 0;
  for (const item of filled) {
    item.title ||= `第 ${filled.indexOf(item) + 1} 章`;
    for (const scene of item.scenes) { total += 1; scene.title ||= `第 ${total} 场`; }
  }
  return { chapters: filled.slice(0, 500).map(item => ({ ...item, scenes: item.scenes.slice(0, 500) })) };
}

export function summarizeManuscript(chapters: ImportedChapterDraft[], aiUsed: boolean, warnings: string[] = []): ManuscriptPreview {
  const scenes = chapters.flatMap(chapter => chapter.scenes);
  return {
    chapters,
    chapterCount: chapters.length,
    sceneCount: scenes.length,
    wordCount: scenes.reduce((sum, scene) => sum + scene.body.replace(/\s/g, "").length, 0),
    aiUsed,
    warnings,
  };
}

export interface HeadingCandidate { line: number; text: string; before: string; after: string }
/** 仅靠空行与长度推测的宽松标题候选（供结构推断与 AI 补充），限制数量控制规模。 */
export function looseHeadingCandidates(input: string): HeadingCandidate[] {
  return splitHeadingCandidates(input).loose;
}
function splitHeadingCandidates(input: string): { strong: HeadingCandidate[]; loose: HeadingCandidate[] } {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const strong: HeadingCandidate[] = [];
  const loose: HeadingCandidate[] = [];
  const excerpt = (index: number, direction: -1 | 1): string => {
    const parts: string[] = [];
    for (let i = index + direction; i >= 0 && i < lines.length && parts.join("").length < 60; i += direction) {
      const text = lines[i]!.trim();
      if (text) parts.push(text);
      if (parts.length >= 2) break;
    }
    return (direction === -1 ? parts.reverse() : parts).join(" / ").slice(0, 60);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.trim();
    if (!text || text.length > 40 || isSeparator(text)) continue;
    const candidate = { line: index, text, before: excerpt(index, -1), after: excerpt(index, 1) };
    if (isChapterHeading(text) || isSceneHeading(text) || text.startsWith("#")) { if (strong.length < 2000) strong.push(candidate); continue; }
    const blankAround = (index === 0 || !lines[index - 1]!.trim()) && (index === lines.length - 1 || !lines[index + 1]!.trim());
    if (blankAround && text.length <= 24 && !/[。！？；，、]$/.test(text)) loose.push(candidate);
  }
  return { strong, loose: loose.slice(0, 400) };
}
export function headingCandidates(input: string): HeadingCandidate[] {
  const { strong, loose } = splitHeadingCandidates(input);
  return [...strong, ...loose].sort((a, b) => a.line - b.line);
}

/** Agent 判定的标题模式经本地校验后按行切章；正文同样逐字保留。 */
export function sliceByChapterPattern(input: string, pattern: string): ImportedChapterDraft[] | null {
  let regex: RegExp;
  try { regex = new RegExp(pattern, "i"); } catch { return null; }
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const marks: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = cleanHeadingLine(lines[index]!.replace(MD_HEADING_RE, ""));
    if (text && text.length <= MAX_TITLE_LINE && regex.test(text)) marks.push(index);
  }
  if (marks.length < 2 || marks.length > 500) return null;
  const decisions = marks.map(line => ({ line, level: "chapter" as const }));
  return sliceManuscript(input, decisions);
}

export interface HeadingDecision { line: number; level: "chapter" | "scene"; title?: string }
/** 按 AI 确认的标题行切分原稿；行号必须来自候选集合，正文逐字取自原文。 */
export function sliceManuscript(input: string, decisions: HeadingDecision[]): ImportedChapterDraft[] | null {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const allowed = new Set(headingCandidates(input).map(candidate => candidate.line));
  const marks = decisions
    .filter(decision => Number.isInteger(decision.line) && allowed.has(decision.line) && lines[decision.line])
    .map(decision => ({ ...decision, title: (decision.title ?? cleanHeadingLine(lines[decision.line]!.replace(MD_HEADING_RE, ""))).trim() || cleanHeadingLine(lines[decision.line]!) }))
    .sort((a, b) => a.line - b.line);
  const chapterCount = marks.filter(mark => mark.level === "chapter").length;
  if (!marks.length || (!chapterCount && marks.length < 2)) return null;
  const chapters: ImportedChapterDraft[] = [];
  let chapter: ImportedChapterDraft = { title: "导入正文", scenes: [] };
  let sceneTitle = "第一场";
  let body: string[] = [];
  const pushScene = () => {
    const text = body.join("\n").trim();
    if (text) chapter.scenes.push({ title: sceneTitle, body: text });
    body = [];
  };
  const pushChapter = () => {
    pushScene();
    if (chapter.scenes.length) chapters.push(chapter);
    chapter = { title: "", scenes: [] };
  };
  const byLine = new Map(marks.map(mark => [mark.line, mark]));
  for (let index = 0; index < lines.length; index += 1) {
    const mark = byLine.get(index);
    const line = lines[index]!;
    if (mark?.level === "chapter") { pushChapter(); chapter.title = mark.title!; sceneTitle = "第一场"; continue; }
    if (mark?.level === "scene") { pushScene(); sceneTitle = mark.title!; continue; }
    if (line.startsWith("> ") || isSeparator(line)) { if (isSeparator(line)) { pushScene(); sceneTitle = `第 ${chapter.scenes.length + 1} 场`; } continue; }
    body.push(line);
  }
  pushChapter();
  if (!chapters.length) return null;
  let total = 0;
  for (const item of chapters) {
    item.title ||= `第 ${chapters.indexOf(item) + 1} 章`;
    for (const scene of item.scenes) { total += 1; scene.title ||= `第 ${total} 场`; }
  }
  return chapters.slice(0, 500);
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
