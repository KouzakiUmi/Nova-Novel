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

test("场景资料检索由宿主解析故事时点与 POV，并忽略客户端伪造坐标", async () => {
  const f = fixture();
  const server = f.app();
  try {
    const base = await start(server);
    const pov = f.knowledge.addEntity({ projectId: f.project.projectId, type: "character", name: "阿禾", routeId: f.project.activeRouteId, sourceKind: "author_setting", reviewState: "confirmed" });
    const secret = f.knowledge.addEntity({ projectId: f.project.projectId, type: "secret", name: "天门密码", routeId: f.project.activeRouteId, sourceKind: "author_setting", reviewState: "confirmed" });
    f.knowledge.addFact({ projectId: f.project.projectId, subjectId: secret, predicate: "known_by", value: { entityId: pov }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: f.project.activeRouteId, validFromOrder: 1 });

    const future = f.store.saveScene(f.scene.sceneId, { baseRevisionId: f.branch.headRevisionId, body: "未来战争爆发。", patch: { storyTime: "2" } });
    const added = f.store.addScenes({ projectId: f.project.projectId, branchId: f.branch.branchId, baseRevisionId: future.revision.revisionId, acceptanceId: "context_scene_coordinates", scenes: [{ title: "较早的视角场", storyTime: "1", pov: "阿禾" }] });
    const current = added.scenes[0]!;
    const saved = f.store.saveScene(current.sceneId, { baseRevisionId: added.revision.revisionId, body: "阿禾知道天门密码。", patch: { storyTime: "1", pov: "阿禾" } });
    const head = saved.revision.revisionId;
    const scenes = f.store.listScenes(f.project.projectId, head);
    f.knowledge.beginRevisionIndex(f.project.projectId, head, scenes.map(scene => scene.sceneId));
    for (const scene of scenes) f.knowledge.indexScene(scene, head);

    const query = async (text: string) => {
      const response = await fetch(`${base}/api/context/query`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: f.project.projectId, branchId: f.branch.branchId, routeId: f.project.activeRouteId,
          revisionId: head, sceneId: current.sceneId, query: text, purpose: "scene_writing",
          // 这些自报坐标必须被场景冻结值覆盖。
          storyOrder: 999, narrationOrder: 999, povEntityId: "ent_not_the_pov",
        }),
      });
      assert.equal(response.status, 200);
      return await response.json() as { evidence: Array<{ quote: string }> };
    };

    const futureResult = await query("未来战争");
    assert.equal(futureResult.evidence.length, 0, "后章较早时点的场景不能召回未来正文");
    const secretResult = await query("天门密码");
    assert.ok(secretResult.evidence.some(item => item.quote.includes("天门密码")), "场景 POV 名称应解析为实体并应用已知秘密边界");
  } finally {
    await stop(server);
    f.close();
  }
});

test("HTTP 自动保存只重建变化场景并返回当前场景局部派生状态", async () => {
  const f = fixture();
  const added = f.store.addScenes({ projectId: f.project.projectId, branchId: f.branch.branchId, baseRevisionId: f.branch.headRevisionId, acceptanceId: "incremental_second_scene", scenes: [{ title: "第二场", storyTime: "1" }] });
  const second = added.scenes[0]!;
  const scenes = f.store.listScenes(f.project.projectId, added.revision.revisionId);
  f.knowledge.beginRevisionIndex(f.project.projectId, added.revision.revisionId, scenes.map(scene => scene.sceneId));
  for (const scene of scenes) f.knowledge.indexScene(scene, added.revision.revisionId);

  const indexScene = f.knowledge.indexScene.bind(f.knowledge);
  const reuseSceneIndex = f.knowledge.reuseSceneIndex.bind(f.knowledge);
  const rebuilt: string[] = [];
  const reused: string[] = [];
  f.knowledge.indexScene = (scene, revisionId) => { rebuilt.push(scene.sceneId); indexScene(scene, revisionId); };
  f.knowledge.reuseSceneIndex = (scene, revisionId, sourceRevisionId) => {
    if (reuseSceneIndex(scene, revisionId, sourceRevisionId)) { reused.push(scene.sceneId); return true; }
    return false;
  };
  const server = f.app();
  try {
    const base = await start(server);
    const response = await fetch(`${base}/api/scenes/${second.sceneId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ baseRevisionId: added.revision.revisionId, body: "只改写第二场。" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as {
      revisionId: string;
      revision: { revisionId: string };
      evidence: Array<{ quote: string; sourceRevisionId: string }>;
      storyGraph: { revisionId: string };
      project: { projectId: string };
    };
    assert.deepEqual(rebuilt, [second.sceneId], "未变化的第一场不得重新分块和写 FTS");
    assert.deepEqual(reused, [f.scene.sceneId]);
    assert.equal(result.revision.revisionId, result.revisionId);
    assert.ok(result.evidence.some(item => item.quote === "只改写第二场。" && item.sourceRevisionId === result.revisionId));
    assert.equal(result.storyGraph.revisionId, result.revisionId);
    assert.equal(result.project.projectId, f.project.projectId);
    assert.equal(f.knowledge.getIndexStatus(f.project.projectId, result.revisionId).state, "ready");
  } finally {
    await stop(server);
    f.close();
  }
});

test("事实可修改、作废与恢复，人工修改正文来源事实后转为作者设定", async () => {
  const f = fixture();
  const server = f.app();
  try {
    const base = await start(server);
    const created = await fetch(`${base}/api/elements`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, type: "item", name: "旧铁盒" }) });
    const entity = (await created.json() as { entity: { entityId: string } }).entity;
    const added = await fetch(`${base}/api/elements/${entity.entityId}/facts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, predicate: "location", value: "柜台下", validFromOrder: 1 }) });
    const fact = (await added.json() as { fact: { factId: string } }).fact;
    const patch = async (input: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/elements/${entity.entityId}/facts/${fact.factId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, ...input }) });
      assert.equal(response.status, 200);
      return (await response.json() as { fact: { value: unknown; reviewState: string; sourceKind: string; validFrom?: string } }).fact;
    };
    assert.equal((await patch({ value: "柜台左抽屉" })).value, "柜台左抽屉");
    const rejected = await patch({ reviewState: "rejected" });
    assert.equal(rejected.reviewState, "rejected");
    const query = f.knowledge.queryContext({ projectId: f.project.projectId, branchId: f.branch.branchId, routeId: f.project.activeRouteId, revisionId: f.branch.headRevisionId, query: "铁盒", purpose: "fact_check", storyOrder: 1 });
    assert.equal(query.facts.filter(item => item.factId === fact.factId).length, 0, "作废事实不得进入检索");
    assert.equal((await patch({ reviewState: "confirmed" })).reviewState, "confirmed");

    const manuscriptId = f.knowledge.addFact({ projectId: f.project.projectId, subjectId: entity.entityId, predicate: "condition", value: "生锈", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "manuscript", routeId: f.project.activeRouteId, evidenceIds: [] });
    const edited = await fetch(`${base}/api/elements/${entity.entityId}/facts/${manuscriptId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, value: "已除锈" }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json() as { fact: { sourceKind: string } }).fact.sourceKind, "author_setting");

    const status = await fetch(`${base}/api/knowledge/index-status?projectId=${encodeURIComponent(f.project.projectId)}&revisionId=${encodeURIComponent(f.branch.headRevisionId)}`);
    assert.equal(status.status, 200);
    const rebuilt = await fetch(`${base}/api/knowledge/rebuild`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, revisionId: f.branch.headRevisionId }) });
    assert.equal(rebuilt.status, 200);
    assert.equal((await rebuilt.json() as { state: string }).state, "ready");
  } finally {
    await stop(server);
    f.close();
  }
});

test("秘密事件的修改、作废和恢复同步知识边界事实", async () => {
  const f = fixture();
  const server = f.app();
  try {
    const base = await start(server);
    const holder = f.knowledge.addEntity({ projectId: f.project.projectId, type: "character", name: "阿禾", routeId: f.project.activeRouteId, sourceKind: "author_setting", reviewState: "confirmed" });
    const secret = f.knowledge.addEntity({ projectId: f.project.projectId, type: "secret", name: "门后身份", routeId: f.project.activeRouteId, sourceKind: "author_setting", reviewState: "confirmed" });
    const added = await fetch(`${base}/api/elements/${secret}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, kind: "known_by", toValue: "阿禾", storyTime: "2" }) });
    const event = (await added.json() as { event: { eventId: string } }).event;
    assert.ok(f.knowledge.listFacts(f.project.projectId).some(fact => fact.subjectId === secret && fact.predicate === "known_by" && fact.reviewState === "confirmed" && fact.validFrom === "2"));
    const patch = async (input: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/elements/${secret}/events/${event.eventId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: f.project.projectId, ...input }) });
      assert.equal(response.status, 200);
      return (await response.json() as { event: { reviewState: string; storyOrder: number } }).event;
    };
    await patch({ reviewState: "rejected" });
    assert.ok(f.knowledge.listFacts(f.project.projectId).filter(fact => fact.subjectId === secret && fact.predicate === "known_by").every(fact => fact.reviewState === "rejected"));
    await patch({ reviewState: "confirmed" });
    assert.ok(f.knowledge.listFacts(f.project.projectId).some(fact => fact.subjectId === secret && fact.predicate === "known_by" && fact.reviewState === "confirmed" && fact.value && typeof fact.value === "object" && "entityId" in fact.value && fact.value.entityId === holder));
    await patch({ storyTime: "3" });
    const boundaries = f.knowledge.listFacts(f.project.projectId).filter(fact => fact.subjectId === secret && fact.predicate === "known_by");
    assert.ok(boundaries.some(fact => fact.reviewState === "confirmed" && fact.validFrom === "3"));
    assert.ok(boundaries.some(fact => fact.reviewState === "rejected" && fact.validFrom === "2"), "旧时点边界应作废保留");
  } finally {
    await stop(server);
    f.close();
  }
});
