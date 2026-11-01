import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { WorkspaceSnapshot } from "@nova-novel/shared";
import { DomainStore } from "../src/store.js";
import { exportBackup, exportMarkdown, parseManuscript, summarizeManuscript, sliceManuscript, headingCandidates } from "../src/transfer.js";
import { assistManuscript } from "../src/agent/import-assist.js";

test("markdown manuscript import creates chapters and scenes with one initial revision", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const parsed = parseManuscript("# 第一章\n\n## 第一场\n\n正文甲\n\n---\n\n## 第二场\n\n正文乙\n\n# 第二章\n\n## 第三场\n\n正文丙");
    assert.equal(parsed.chapters.length, 2);
    assert.equal(parsed.chapters[0]?.scenes.length, 2);
    assert.equal(parsed.chapters[0]?.scenes[0]?.body, "正文甲");
    assert.equal(parsed.chapters[0]?.scenes[1]?.body, "正文乙");
    assert.equal(parsed.chapters[1]?.scenes[0]?.body, "正文丙");
    const imported = store.importProject({ title: "导入测试", chapters: parsed.chapters });
    assert.equal(imported.project.title, "导入测试");
    assert.equal(store.listChapters(imported.project.projectId).length, 2);
    assert.equal(store.listScenes(imported.project.projectId).length, 3);
    assert.equal(store.listScenes(imported.project.projectId).map(scene => scene.narrationOrder).join(","), "1,2,3");
    assert.equal(store.listRevisions(imported.project.projectId).length, 1);
    assert.equal(store.listRevisions(imported.project.projectId)[0]?.name, "导入作品");
    const snapshot = {
      activeProject: imported.project,
      chapters: store.listChapters(imported.project.projectId),
      scenes: store.listScenes(imported.project.projectId),
      branches: [], routes: [], elements: [], facts: [], events: [], evidence: [], notes: [], annotations: [], characterArcs: [], authoringDraft: {}, revisions: [], workflows: [], workflowRuns: [], storyGraph: {}, tasks: [], connection: {},
    } as unknown as WorkspaceSnapshot;
    const markdown = exportMarkdown(snapshot);
    const roundtrip = parseManuscript(markdown);
    assert.equal(roundtrip.chapters.length, 2);
    assert.equal(roundtrip.chapters[0]?.scenes[0]?.body, "正文甲");
    assert.equal(roundtrip.chapters[1]?.scenes[0]?.body, "正文丙");
    const backupObject = exportBackup(snapshot);
    assert.ok(!("workflows" in backupObject));
    const backup = JSON.stringify(backupObject);
    assert.ok(!backup.includes("apiKey"));
    assert.ok(!backup.includes("NOVA_NOVEL_PAIR_TOKEN"));
  } finally { db.close(); }
});

test("plain chinese novel splits by 第X章 headings without markdown", () => {
  const text = "第一章 雨夜\n\n阿禾把最后一只鞋楦收进纸箱。\n\n第二章 旧收据\n\n柜台底下卡着一张收据。\n\n***\n\n她翻过来，背面写着一行小字。\n\n楔子\n\n很多年以前，铺子还亮着灯。";
  const parsed = parseManuscript(text);
  assert.equal(parsed.chapters.length, 3);
  assert.equal(parsed.chapters[0]?.title, "第一章 雨夜");
  assert.equal(parsed.chapters[1]?.title, "第二章 旧收据");
  assert.equal(parsed.chapters[1]?.scenes.length, 2, "*** 分场");
  assert.equal(parsed.chapters[2]?.title, "楔子");
  assert.equal(parsed.chapters[0]?.scenes[0]?.body, "阿禾把最后一只鞋楦收进纸箱。");
  const preview = summarizeManuscript(parsed.chapters, false);
  assert.equal(preview.chapterCount, 3);
  assert.equal(preview.sceneCount, 4);
  assert.ok(preview.wordCount > 0);
});

test("chapter-like sentences inside prose are not treated as headings", () => {
  const text = "第一章 雨夜\n\n他想起第三章里那句没说完的话，仍觉得不安。\n\n第二章 晴天\n\n雨停了。";
  const parsed = parseManuscript(text);
  assert.equal(parsed.chapters.length, 2);
  assert.ok(parsed.chapters[0]?.scenes[0]?.body.includes("第三章里那句没说完的话"));
});

test("abbreviated ch-XX headings split and strong candidates survive loose cap", () => {
  const text = "第1章 开始\n\n正文一\n\nch-18 战后的休整\n\n正文二\n\nch.19 新的旅程\n\n正文三";
  const parsed = parseManuscript(text);
  assert.equal(parsed.chapters.length, 3);
  assert.equal(parsed.chapters[1]?.title, "ch-18 战后的休整");
  assert.equal(parsed.chapters[2]?.scenes[0]?.body, "正文三");
  const longBook = Array.from({ length: 200 }, (_, i) => `ch-${i + 1}\n\n短句${i}\n\n${"正文。".repeat(20)}`).join("\n\n");
  const candidates = headingCandidates(longBook);
  const headings = candidates.filter(candidate => candidate.text.startsWith("ch-"));
  assert.equal(headings.length, 200, "全部 ch-XX 标题都在候选中");
  const sliced = sliceManuscript(longBook, headings.map(candidate => ({ line: candidate.line, level: "chapter" as const })));
  assert.equal(sliced?.length, 200, "长书后半部分同样可分章");
});

test("append imported chapters extends the same project with CAS protection", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const imported = store.importProject({ title: "分批导入", chapters: parseManuscript("第1章 开始\n\n正文一").chapters });
    const head = imported.revision.revisionId;
    const appended = store.appendImportedChapters({ projectId: imported.project.projectId, baseRevisionId: head, chapters: parseManuscript("第2章 继续\n\n正文二").chapters });
    assert.equal(store.listChapters(imported.project.projectId).length, 2);
    assert.equal(store.listScenes(imported.project.projectId).length, 2);
    assert.equal(store.listScenes(imported.project.projectId)[1]?.narrationOrder, 2);
    assert.equal(store.listRevisions(imported.project.projectId).length, 2);
    assert.throws(() => store.appendImportedChapters({ projectId: imported.project.projectId, baseRevisionId: head, chapters: parseManuscript("第3章 冲突\n\n正文三").chapters }), /已改变/);
    assert.equal(store.listChapters(imported.project.projectId).length, 2, "过期批次不会写入");
    assert.ok(appended.revision.revisionId);
  } finally { db.close(); }
});

test("AI decisions slice original text and ignore hallucinated line numbers", async () => {
  const text = "雨夜\n\n阿禾收铺。\n\n旧收据\n\n柜台底下卡着一张收据。";
  const candidates = headingCandidates(text);
  assert.ok(candidates.some(candidate => candidate.text === "雨夜"));
  const decisions = [{ line: 0, level: "chapter" as const, title: "第一章 雨夜" }, { line: 9999, level: "chapter" as const }, { line: 4, level: "chapter" as const, title: "第二章 旧收据" }];
  const chapters = sliceManuscript(text, decisions);
  assert.equal(chapters?.length, 2);
  assert.equal(chapters?.[0]?.title, "第一章 雨夜");
  assert.equal(chapters?.[0]?.scenes[0]?.body, "阿禾收铺。");
  assert.equal(chapters?.[1]?.scenes[0]?.body, "柜台底下卡着一张收据。");
  const assisted = await assistManuscript(text, { complete: async () => JSON.stringify([{ line: 0, level: "chapter", title: "第一章 雨夜" }, { line: 4, level: "chapter", title: "第二章 旧收据" }]) });
  assert.equal(assisted?.length, 2);
  const fallback = await assistManuscript(text, { complete: async () => "不是 JSON" });
  assert.equal(fallback, null);
});
