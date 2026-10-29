import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { WorkspaceSnapshot } from "@nova-novel/shared";
import { DomainStore } from "../src/store.js";
import { exportBackup, exportMarkdown, parseManuscript } from "../src/transfer.js";

test("manuscript import creates one initial revision and markdown roundtrip preserves scenes", () => {
  const db = new Database(":memory:");
  try {
    const store = new DomainStore(db);
    const parsed = parseManuscript("# 第一章\n\n## 第一场\n\n正文甲\n\n---\n\n## 第二场\n\n正文乙");
    assert.equal(parsed.scenes.length, 2);
    assert.equal(parsed.scenes[0]?.body, "正文甲");
    assert.equal(parsed.scenes[1]?.body, "正文乙");
    const imported = store.importProject({ title: "导入测试", chapterTitle: parsed.chapterTitle, scenes: parsed.scenes });
    assert.equal(imported.project.title, "导入测试");
    assert.equal(store.listScenes(imported.project.projectId).length, 2);
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
    assert.equal(roundtrip.scenes.length, 2);
    assert.equal(roundtrip.scenes[0]?.body, "正文甲");
    assert.equal(roundtrip.scenes[1]?.body, "正文乙");
    const backupObject = exportBackup(snapshot);
    assert.ok(!("workflows" in backupObject));
    const backup = JSON.stringify(backupObject);
    assert.ok(!backup.includes("apiKey"));
    assert.ok(!backup.includes("NOVA_NOVEL_PAIR_TOKEN"));
  } finally { db.close(); }
});
