import type { ImportedChapterDraft } from "@nova-novel/shared";
import { headingCandidates, sliceManuscript, type HeadingCandidate, type HeadingDecision } from "../transfer.js";

export interface ImportAssistDeps { complete(prompt: string): Promise<string> }

function parseDecisions(text: string): HeadingDecision[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const raw: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const decision = item as { line?: unknown; level?: unknown; title?: unknown };
      if (typeof decision.line !== "number" || !Number.isInteger(decision.line)) return [];
      if (decision.level !== "chapter" && decision.level !== "scene") return [];
      return [{ line: decision.line, level: decision.level, ...(typeof decision.title === "string" && decision.title.trim() ? { title: decision.title.trim().slice(0, 120) } : {}) }];
    });
  } catch { return []; }
}

function promptFor(batch: HeadingCandidate[]): string {
  const lines = batch.map(candidate => `#${candidate.line} | ${candidate.text} | 前文:${candidate.before || "（无）"} | 后文:${candidate.after || "（无）"}`).join("\n");
  return [
    "你在整理一部小说原稿的章节结构。下面是疑似标题的候选行，格式为：行号 | 原文 | 前文摘录 | 后文摘录。",
    "请判断哪些行是真正的分章起点（chapter，包括卷、章、楔子、序章、番外等），哪些是章内的场景或小节起点（scene）。正文句子、对白和章节内的普通短句都不要选。拿不准的行宁可不选。",
    "只输出 JSON 数组，不要输出任何其他文字：[{\"line\":行号,\"level\":\"chapter\"或\"scene\",\"title\":\"规范后的标题\"}]",
    "候选行：",
    lines,
  ].join("\n");
}

/** AI 负责判断标题边界，正文切片由本地完成；任何一步失败都返回 null 交回本地规则。 */
export async function assistManuscript(input: string, deps: ImportAssistDeps): Promise<ImportedChapterDraft[] | null> {
  const candidates = headingCandidates(input);
  if (candidates.length < 2) return null;
  const decisions: HeadingDecision[] = [];
  for (let index = 0; index < candidates.length; index += 60) {
    const text = await deps.complete(promptFor(candidates.slice(index, index + 60)));
    decisions.push(...parseDecisions(text));
  }
  return sliceManuscript(input, decisions);
}
