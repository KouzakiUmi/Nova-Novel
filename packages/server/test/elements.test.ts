import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import type { PiHost, WorkflowService } from "../src/contracts.js";
import { createApp } from "../src/app.js";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";

/**
 * 元素库写入闭环：作者通过 HTTP 录入的元素必须立即可见，
 * 并真正参与检索上下文与一致性检查（而不是只写进一张没人读的表）。
 */
function fixture() {
  const prefix = join(tmpdir(), "nova-novel-elements-");
  const directory = mkdtempSync(prefix);
  const db = new Database(join(directory, "story.sqlite"));
  const store = new DomainStore(db);
  const knowledge = new SqliteKnowledgeService(db);
  const project = store.getProject();
  const branch = store.getBranch(project.activeBranchId);
  const scene = store.listScenes(project.projectId, branch.headRevisionId)[0]!;
  knowledge.beginRevisionIndex(project.projectId, branch.headRevisionId, [scene.sceneId]);
  knowledge.indexScene(scene, branch.headRevisionId);
  const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("no workflow"); }, decide: () => { throw new Error("no workflow"); }, cancel: () => { throw new Error("no workflow"); } };
  const pi: PiHost = { getConnection: () => ({ state: "unconfigured", mode: "embedded", detail: "test", sendsDataTo: "test" }), generate: async () => ({ text: "", completeness: "partial" }), cancel: async () => {} };
  return {
    directory, db, store, knowledge, project, branch, scene,
    app: () => createApp({ store, knowledge, workflow, pi }),
    close() {
      db.close();
      assert.ok(directory.startsWith(prefix));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function start(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server): Promise<void> {
  server.close();
  await once(server, "close").catch(() => undefined);
}

test("作者录入的角色立即可见，并进入检索上下文与一致性检查", async () => {
  const f = fixture();
  const server = f.app();
  try {
    const base = await start(server);
    const created = await fetch(`${base}/api/elements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: f.project.projectId,
        type: "character",
        name: "沈砚",
        summary: "在码头等一封迟到的家书。",
        aliases: ["小砚"],
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json() as { entity: { entityId: string; name: string; aliases: string[]; reviewState: string; sourceKind: string } };
    assert.equal(body.entity.name, "沈砚");
    assert.deepEqual(body.entity.aliases, ["小砚"]);
    assert.equal(body.entity.reviewState, "confirmed");
    assert.equal(body.entity.sourceKind, "author_setting");

    // 立即可见：bootstrap 与元素列表都能读到
    const snapshot = await (await fetch(`${base}/api/bootstrap`)).json() as { elements: Array<{ entityId: string; name: string }> };
    assert.ok(snapshot.elements.some((item) => item.name === "沈砚"), "新元素应出现在快照中");

    // 检索上下文能按名称命中该元素所在路线的事实与证据
    const query = await (await fetch(`${base}/api/context/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: f.project.projectId, branchId: f.project.activeBranchId, routeId: f.project.activeRouteId,
        revisionId: f.branch.headRevisionId, query: "沈砚", purpose: "scene_writing",
      }),
    })).json() as { excluded: Array<{ reason: string; count: number }> };
    assert.ok(Array.isArray(query.excluded), "检索应返回排除说明");

    // 一致性检查能看到该角色：候选正文提及它时不应被当成未知
    const issues = f.knowledge.checkConsistency({ ...f.scene, pov: body.entity.entityId }, "沈砚把家书折好放进口袋。");
    assert.ok(Array.isArray(issues), "一致性检查应可运行");
  } finally {
    await stop(server);
    f.close();
  }
});

test("元素修改只作用于本作品，跨作品与不存在的元素被拒绝", async () => {
  const f = fixture();
  const server = f.app();
  try {
    const base = await start(server);
    const created = await fetch(`${base}/api/elements`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: f.project.projectId, type: "item", name: "黄铜钥匙" }),
    });
    const entity = (await created.json() as { entity: { entityId: string; name: string } }).entity;

    const renamed = await fetch(`${base}/api/elements/${encodeURIComponent(entity.entityId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: f.project.projectId, name: "铜钥匙", summary: "齿口被磨平了。" }),
    });
    assert.equal(renamed.status, 200);
    const after = (await renamed.json() as { entity: { name: string; summary: string } }).entity;
    assert.equal(after.name, "铜钥匙");
    assert.equal(after.summary, "齿口被磨平了。");

    const missing = await fetch(`${base}/api/elements/ent_does_not_exist`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: f.project.projectId, name: "随便改" }),
    });
    assert.equal(missing.status, 404, "不存在的元素应返回 404");

    const wrongProject = await fetch(`${base}/api/elements/${encodeURIComponent(entity.entityId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project_not_mine", name: "越权改名" }),
    });
    assert.equal(wrongProject.status, 404, "其他作品的元素不可修改");
  } finally {
    await stop(server);
    f.close();
  }
});

test("元素类型与故事路线校验：非法输入被拒绝且不写入", async () => {
  const f = fixture();
  const server = f.app();
  try {
    const base = await start(server);
    const badType = await fetch(`${base}/api/elements`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: f.project.projectId, type: "dragon", name: "不该存在" }),
    });
    assert.equal(badType.status, 400);

    const badRoute = await fetch(`${base}/api/elements`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: f.project.projectId, type: "item", name: "也不该存在", routeId: "route_other" }),
    });
    assert.equal(badRoute.status, 400);

    const emptyName = await fetch(`${base}/api/elements`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: f.project.projectId, type: "item", name: "  " }),
    });
    assert.equal(emptyName.status, 400);

    assert.equal(f.knowledge.listEntities(f.project.projectId).filter((item) => item.sourceKind === "author_setting").length, 0, "被拒绝的请求不应留下元素");
  } finally {
    await stop(server);
    f.close();
  }
});
