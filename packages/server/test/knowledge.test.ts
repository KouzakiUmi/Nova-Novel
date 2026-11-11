import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ContextQuery, Scene } from "@nova-novel/shared";
import {
  SqliteKnowledgeService,
  tokenizeForFts,
  buildFtsQuery,
  type SqliteDatabase,
} from "../src/knowledge/index.js";

/**
 * 测试用临时数据库：优先 better-sqlite3（与生产一致），包未安装时回退 Node 内置
 * node:sqlite（SQLite >= 3.44 且启用 FTS5，行为等价于本服务用到的子集）。
 */
function createDatabase(): SqliteDatabase {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Better = require("better-sqlite3") as new (path: string) => SqliteDatabase;
    return new Better(":memory:");
  } catch {
    return new DatabaseSync(":memory:") as unknown as SqliteDatabase;
  }
}

const PROJECT = "proj_test";
const REVISION = "rev_r12";
const ROUTE = "route_main";
const OTHER_ROUTE = "route_sea";
const OTHER_REVISION = "rev_branch_b";

function newService(): SqliteKnowledgeService {
  return new SqliteKnowledgeService(createDatabase());
}

function baseQuery(overrides: Partial<ContextQuery> = {}): ContextQuery {
  return {
    projectId: PROJECT,
    branchId: "branch_main",
    routeId: ROUTE,
    revisionId: REVISION,
    query: "",
    purpose: "scene_writing",
    ...overrides,
  };
}

/** 与 seedExampleKnowledge 同构的最小钥匙示例（S03 交接 / S05 倒叙 / S08 遗失 / S10 待写）。 */
function seedKeyExample(kb: SqliteKnowledgeService): {
  linwu: string; shenyan: string; key: string; secret: string;
  s03: string; s05: string; s08: string; s10: string;
} {
  const linwu = kb.addEntity({
    entityId: "ent_linwu",
    projectId: PROJECT, type: "character", name: "林雾", routeId: ROUTE,
    sourceKind: "author_setting", reviewState: "confirmed",
  });
  const shenyan = kb.addEntity({
    entityId: "ent_shenyan",
    projectId: PROJECT, type: "character", name: "沈砚", routeId: ROUTE,
    sourceKind: "author_setting", reviewState: "confirmed",
  });
  const key = kb.addEntity({
    entityId: "ent_brass_key",
    projectId: PROJECT, type: "item", name: "黄铜钥匙", routeId: ROUTE,
    sourceKind: "author_setting", reviewState: "confirmed", unique: true,
  });
  kb.addAlias(PROJECT, key, "钥匙");
  const secret = kb.addEntity({
    entityId: "ent_secret",
    projectId: PROJECT, type: "secret", name: "真凶", routeId: ROUTE,
    sourceKind: "author_setting", reviewState: "confirmed",
  });

  const s05 = kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: REVISION, sceneId: "scene_s05", blockId: "b1",
    quote: "清晨，林雾用黄铜钥匙打开仓库。", sourceKind: "manuscript", routeId: ROUTE,
    narrationOrder: 5, storyOrder: 1,
  });
  const s03 = kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: REVISION, sceneId: "scene_s03", blockId: "b1",
    quote: "林雾把黄铜钥匙交到沈砚手里。", sourceKind: "manuscript", routeId: ROUTE,
    narrationOrder: 3, storyOrder: 2,
  });
  const s08 = kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: REVISION, sceneId: "scene_s08", blockId: "b1",
    quote: "黄铜钥匙从沈砚的口袋滑落，掉进河底，尚未打捞。", sourceKind: "manuscript", routeId: ROUTE,
    narrationOrder: 8, storyOrder: 3,
  });
  kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: OTHER_REVISION, sceneId: "scene_alt", blockId: "b1",
    quote: "沈砚把黄铜钥匙锁进了抽屉，妥善保管。", sourceKind: "manuscript", routeId: ROUTE,
    narrationOrder: 8, storyOrder: 3,
  });
  kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: REVISION, sceneId: "scene_other_route", blockId: "b1",
    quote: "林雾带着黄铜钥匙出海了。", sourceKind: "manuscript", routeId: OTHER_ROUTE,
    narrationOrder: 4, storyOrder: 4,
  });
  kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: REVISION, sceneId: "scene_secret_draft", blockId: "b1",
    quote: "沈砚低声说出真凶的名字。", sourceKind: "manuscript", routeId: ROUTE,
    narrationOrder: 12, storyOrder: 5,
  });

  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "owner", value: { entityId: shenyan },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE,
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "possessor", value: { entityId: linwu },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting",
    routeId: ROUTE, validToOrder: 2, evidenceIds: [s05],
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "possessor", value: { entityId: shenyan },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting",
    routeId: ROUTE, validFromOrder: 2, evidenceIds: [s03],
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "possessor", value: { entityId: linwu },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "manuscript",
    routeId: OTHER_ROUTE, validFromOrder: 2, evidenceIds: [],
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "possessor", value: { entityId: shenyan },
    semanticType: "belief", reviewState: "confirmed", sourceKind: "manuscript",
    routeId: ROUTE, holderId: linwu, validFromOrder: 2, evidenceIds: [s03],
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "quantity",
    value: { value: 1, unit: "把" },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE,
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "weight", value: null,
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE,
  });
  kb.addFact({
    projectId: PROJECT, subjectId: secret, predicate: "known_by", value: { entityId: shenyan },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE,
  });
  kb.addFact({
    projectId: PROJECT, subjectId: secret, predicate: "identity", value: "真凶身份保密",
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE,
  });

  kb.addEvent({
    projectId: PROJECT, kind: "item.use", sceneId: "scene_s05", routeId: ROUTE,
    storyTime: "day 1 08:00", storyOrder: 1, subjectId: key,
    fromValue: linwu, toValue: "打开仓库", reviewState: "confirmed", evidenceIds: [s05],
  });
  kb.addEvent({
    projectId: PROJECT, kind: "item.transfer_possession", sceneId: "scene_s03", routeId: ROUTE,
    storyTime: "day 1 21:10", storyOrder: 2, subjectId: key,
    fromValue: linwu, toValue: shenyan, reviewState: "confirmed", evidenceIds: [s03],
  });
  kb.addEvent({
    projectId: PROJECT, kind: "item.lost", sceneId: "scene_s08", routeId: ROUTE,
    storyTime: "day 2 09:00", storyOrder: 3, subjectId: key,
    fromValue: shenyan, location: "河底", reviewState: "confirmed", evidenceIds: [s08],
  });
  kb.addEvent({
    projectId: PROJECT, kind: "item.move_location", sceneId: "scene_alt", routeId: ROUTE,
    storyTime: "day 2 09:00", storyOrder: 3, subjectId: key,
    toValue: "抽屉", reviewState: "confirmed", evidenceIds: [],
  });

  kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: "scene_s05", routeId: ROUTE, narrationOrder: 5, storyOrder: 1, pov: linwu, title: "回忆", summary: "清晨林雾用黄铜钥匙打开仓库。", bodyHash: "h_s05" });
  kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: "scene_s03", routeId: ROUTE, narrationOrder: 3, storyOrder: 2, pov: linwu, title: "移交", summary: "林雾将唯一黄铜钥匙交给沈砚。", bodyHash: "h_s03" });
  kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: "scene_s08", routeId: ROUTE, narrationOrder: 8, storyOrder: 3, pov: shenyan, title: "遗失", summary: "钥匙落入河底，尚未打捞。", bodyHash: "h_s08" });
  kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: "scene_s10", routeId: ROUTE, narrationOrder: 10, storyOrder: 4, pov: shenyan, title: "进入仓库", summary: "待写：沈砚进入仓库。", bodyHash: "h_s10" });

  kb.addPlan({
    projectId: PROJECT, revisionId: REVISION, routeId: ROUTE, sceneId: "scene_s10",
    storyOrder: 4, text: "拟发生：沈砚进入仓库取回旧图。秘密仍是真凶未揭示。",
  });
  kb.addPlan({
    projectId: PROJECT, revisionId: REVISION, routeId: ROUTE, sceneId: "scene_s03",
    storyOrder: 2, text: "拟发生：林雾交出钥匙后返回仓库值班。",
  });
  kb.addPlan({
    projectId: PROJECT, revisionId: OTHER_REVISION, routeId: ROUTE, sceneId: "scene_alt",
    storyOrder: 4, text: "拟发生：沈砚从抽屉取回钥匙。",
  });
  kb.addEvidence({
    projectId: PROJECT, sourceRevisionId: REVISION, blockId: "rehearsal_1",
    quote: "试演：沈砚撬开仓库的门锁。", sourceKind: "candidate", routeId: ROUTE,
    narrationOrder: 10, storyOrder: 4,
  });

  return { linwu, shenyan, key, secret, s03, s05, s08, s10: "scene_s10" };
}

function sceneOf(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneId: "scene_s10",
    projectId: PROJECT,
    chapterId: "ch_10",
    title: "进入仓库",
    summary: "沈砚试图进入仓库。",
    body: "",
    status: "writing",
    pov: "ent_shenyan",
    storyTime: "day 2 10:00",
    narrationOrder: 10,
    routeId: ROUTE,
    entityIds: [],
    baseRevisionId: REVISION,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("tokenizer: 中文按字切分，拉丁词按词", () => {
  assert.equal(tokenizeForFts("林雾用黄铜钥匙"), "林 雾 用 黄 铜 钥 匙");
  assert.equal(tokenizeForFts("Key-01 opened"), "key 01 opened");
  assert.equal(buildFtsQuery("沈砚打开仓库"), "\"沈 砚 打 开 仓 库\"");
  assert.equal(buildFtsQuery("沈砚 打开仓库"), "\"沈 砚\" AND \"打 开 仓 库\"");
});

test("FTS5 不可用时构造函数抛出明确的初始化错误", () => {
  const db = createDatabase();
  db.exec("CREATE TABLE kw_fts (x)");
  assert.throws(
    () => new SqliteKnowledgeService(db),
    (error: unknown) => error instanceof Error && error.message.includes("关键词索引初始化失败"),
  );
});

test("构造幂等：同一数据库重复构造不报错、数据保留", () => {
  const db = createDatabase();
  const first = new SqliteKnowledgeService(db);
  first.seedExampleKnowledge({ projectId: PROJECT, routeId: ROUTE, revisionId: REVISION, sceneIds: ["s03", "s05", "s08", "s10"] });
  const second = new SqliteKnowledgeService(db);
  assert.equal(second.listEntities(PROJECT).length, first.listEntities(PROJECT).length);
  second.seedExampleKnowledge({ projectId: PROJECT, routeId: ROUTE, revisionId: REVISION, sceneIds: ["s03", "s05", "s08", "s10"] });
  assert.equal(second.listEntities(PROJECT).length, first.listEntities(PROJECT).length);
});

test("K02 倒叙前章：按故事时间还原，不因叙述顺序误报", () => {
  const kb = newService();
  seedKeyExample(kb);
  const state = kb.getWorldState(PROJECT, ROUTE, 1, REVISION);
  const key = state.entries.find((e) => e.subjectId.includes("brass_key"));
  assert.ok(key);
  assert.equal(key!.possessor, "ent_linwu");
  const later = kb.getWorldState(PROJECT, ROUTE, 3, REVISION);
  const keyLater = later.entries.find((e) => e.subjectId.includes("brass_key"));
  assert.ok(keyLater);
  assert.equal(keyLater!.possessor, null);
  assert.equal(keyLater!.location, "河底");
});

test("K03 作者秘密未向 POV 揭示：检索与计划不带入秘密", () => {
  const kb = newService();
  seedKeyExample(kb);
  const bundle = kb.queryContext(baseQuery({ query: "真凶", povEntityId: "ent_linwu", storyOrder: 3, narrationOrder: 9 }));
  for (const evidence of bundle.evidence) {
    assert.ok(!evidence.quote.includes("真凶"), `泄漏秘密证据：${evidence.quote}`);
  }
  for (const plan of bundle.selectedPlans) {
    assert.ok(!plan.text.includes("真凶"), `计划不得绕过知识边界：${plan.text}`);
  }
  const planningBundle = kb.queryContext(baseQuery({ query: "真凶", purpose: "planning" }));
  assert.ok(planningBundle.facts.some((f) => f.subjectId.includes("secret")));
});

test("K04 信念与世界事实不同：不误报硬冲突，信念按持有者可见", () => {
  const kb = newService();
  seedKeyExample(kb);
  const worldState = kb.getWorldState(PROJECT, ROUTE, 3, REVISION);
  const key = worldState.entries.find((e) => e.subjectId.includes("brass_key"));
  assert.ok(key);
  assert.equal(key!.possessor, null);
  assert.ok(key!.beliefs.some((b) => b.holderId === "ent_linwu" && b.valueText === "ent_shenyan"));
  const povBundle = kb.queryContext(baseQuery({ query: "钥匙", povEntityId: "ent_linwu", storyOrder: 3 }));
  assert.ok(povBundle.facts.some((f) => f.semanticType === "belief" && f.holderId === "ent_linwu"));
  const otherPov = kb.queryContext(baseQuery({ query: "钥匙", povEntityId: "ent_shenyan", storyOrder: 3 }));
  assert.ok(!otherPov.facts.some((f) => f.semanticType === "belief" && f.holderId === "ent_linwu"));
  const conflict = kb.checkConsistency(
    sceneOf({ pov: "ent_linwu" }),
    "林雾说道：我以为钥匙还在沈砚那里。",
  );
  assert.ok(!conflict.some((i) => i.severity === "conflict"));
});

test("K05 借出后遗失：owner / possessor / location 三者分离", () => {
  const kb = newService();
  seedKeyExample(kb);
  const state = kb.getWorldState(PROJECT, ROUTE, 3, REVISION);
  const key = state.entries.find((e) => e.subjectId.includes("brass_key"));
  assert.ok(key);
  assert.equal(key!.owner, "ent_shenyan");
  assert.equal(key!.possessor, null);
  assert.equal(key!.location, "河底");
  assert.ok(key!.evidenceQuotes.some((q) => q.includes("掉进河底")));
});

test("K06 + K07 其他 route 与废弃旧稿不可见：权威可见性过滤泄漏", () => {
  const kb = newService();
  seedKeyExample(kb);
  for (const order of [1, 2, 3, 4]) {
    const bundle = kb.queryContext(baseQuery({ query: "黄铜钥匙 沈砚 林雾 仓库 出海 抽屉", storyOrder: order, narrationOrder: 11 }));
    for (const evidence of bundle.evidence) {
      assert.ok(!evidence.quote.includes("出海"), "其他 route 泄漏");
      assert.ok(!evidence.quote.includes("锁进了抽屉"), "分支 B 旧稿泄漏");
    }
  }
});

test("K09 时间不明、数量单位不明：返回未知，不假定正常", () => {
  const kb = newService();
  const key = kb.addEntity({ projectId: PROJECT, type: "item", name: "铜钱", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.addEvent({
    projectId: PROJECT, kind: "item.transfer_possession", routeId: ROUTE,
    subjectId: key, toValue: "ent_other", reviewState: "confirmed",
  });
  kb.addFact({
    projectId: PROJECT, subjectId: key, predicate: "quantity", value: { value: null, unit: "枚" },
    semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE,
  });
  const state = kb.getWorldState(PROJECT, ROUTE, 5, REVISION);
  const coin = state.entries.find((e) => e.subjectId === key);
  assert.ok(coin);
  assert.equal(coin!.timeUnknown, true);
  assert.equal(coin!.quantity?.known, false);
  assert.equal(coin!.quantity?.value, null);
  assert.equal(coin!.quantity?.unit, "枚");
});

test("K14 同一时点互斥事件顺序未知：不按插入顺序任选", () => {
  const kb = newService();
  const key = kb.addEntity({ projectId: PROJECT, type: "item", name: "信物", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.addEvent({ projectId: PROJECT, kind: "item.transfer_possession", routeId: ROUTE, storyOrder: 2, subjectId: key, toValue: "ent_a", reviewState: "confirmed" });
  kb.addEvent({ projectId: PROJECT, kind: "item.lost", routeId: ROUTE, storyOrder: 2, subjectId: key, location: "集市", reviewState: "confirmed" });
  const state = kb.getWorldState(PROJECT, ROUTE, 3, REVISION);
  const token = state.entries.find((e) => e.subjectId === key);
  assert.ok(token);
  assert.equal(token!.indeterminate, true);
  assert.equal(token!.possessor, null);
  assert.deepEqual(token!.possessorCandidates, ["ent_a"]);
});

test("K21 按选定计划写作：计划可见且标拟发生；fact_check 不采信", () => {
  const kb = newService();
  seedKeyExample(kb);
  const writing = kb.queryContext(baseQuery({ query: "沈砚 仓库", purpose: "scene_writing", storyOrder: 3, narrationOrder: 9 }));
  assert.ok(writing.selectedPlans.length > 0);
  assert.ok(writing.selectedPlans.every((p) => p.sourceKind === "selected_plan"));
  assert.ok(!writing.selectedPlans.some((p) => p.text.includes("取回钥匙")));
  assert.ok(!writing.selectedPlans.some((p) => p.text.includes("真凶")), "含未来秘密的计划不得进入写作上下文");
  const factCheck = kb.queryContext(baseQuery({ query: "沈砚 仓库", purpose: "fact_check" }));
  assert.equal(factCheck.selectedPlans.length, 0);
  assert.ok(factCheck.excluded.some((e) => e.reason === "selected_plan_not_applicable_to_purpose"));
  assert.ok(!factCheck.facts.some((f) => f.sourceKind === "selected_plan"));
});

test("K22 空知识库：返回未找到，不凑结果", () => {
  const kb = newService();
  const bundle = kb.queryContext(baseQuery({ query: "任何词" }));
  assert.equal(bundle.facts.length, 0);
  assert.equal(bundle.evidence.length, 0);
  assert.equal(bundle.selectedPlans.length, 0);
  assert.equal(bundle.candidates.length, 0);
  assert.ok(bundle.excluded.some((e) => e.reason === "empty_knowledge_base"));
  assert.equal(bundle.indexState.semanticState, "unconfigured");
});

test("K23 candidate 只经显式引用进入比较上下文", () => {
  const kb = newService();
  seedKeyExample(kb);
  const without = kb.queryContext(baseQuery({ query: "试演 撬开 沈砚", storyOrder: 4 }));
  assert.equal(without.candidates.length, 0);
  assert.ok(without.excluded.some((e) => e.reason === "candidate_not_explicitly_referenced"));
  const candidateIds = (kb as any).db
    .prepare("SELECT evidence_id FROM kw_evidence WHERE source_kind = 'candidate'")
    .all() as Array<{ evidence_id: string }>;
  const withExplicit = kb.queryContext(baseQuery({
    query: "试演", storyOrder: 4,
    explicitCandidateIds: candidateIds.map((r) => r.evidence_id),
  }));
  assert.equal(withExplicit.candidates.length, candidateIds.length);
  for (const candidate of withExplicit.candidates) {
    assert.ok(!withExplicit.evidence.some((e) => e.evidenceId === candidate.artifactId), "候选不得混进证据清单");
    assert.ok(!withExplicit.facts.some((f) => f.sourceKind === "candidate"));
  }
});

test("两字人名与别名精确检索：沈砚 / 小砚 / 钥匙", () => {
  const kb = newService();
  const ids = seedKeyExample(kb);
  kb.addAlias(PROJECT, ids.shenyan, "小砚");
  for (const keyword of ["沈砚", "小砚", "钥匙"]) {
    const bundle = kb.queryContext(baseQuery({ query: keyword, storyOrder: 3 }));
    assert.ok(bundle.evidence.length > 0, `关键词「${keyword}」应命中证据`);
  }
  const resolved = kb.resolveEntityByName(PROJECT, ROUTE, "小砚");
  assert.ok(resolved);
  assert.equal(resolved!.entityId, ids.shenyan);
  kb.indexScene(sceneOf({ sceneId: "scene_alias", body: "小砚独自守在桥边。", storyTime: "day 0", narrationOrder: 1 }), REVISION);
  const aliasBundle = kb.queryContext(baseQuery({ query: "小砚", storyOrder: 3 }));
  assert.ok(aliasBundle.evidence.some((e) => e.sceneId === "scene_alias" && e.quote.includes("小砚")), "别名必须召回包含该别名的正文，不能只靠无关事实的证据凑数");
});

test("indexScene：采用正文写入派生 FTS 与证据，不改写权威事实", () => {
  const kb = newService();
  seedKeyExample(kb);
  const factsBefore = kb.listFacts(PROJECT).map((f) => f.factId).sort();
  const scene = sceneOf({
    body: "沈砚站在仓库门前，口袋空空。他望向河水。\n\n河水浑浊，什么也看不见。",
  });
  kb.indexScene(scene, REVISION);
  const factsAfter = kb.listFacts(PROJECT).map((f) => f.factId).sort();
  assert.deepEqual(factsAfter, factsBefore);
  const bundle = kb.queryContext(baseQuery({ query: "口袋空空", storyOrder: 4, narrationOrder: 11 }));
  assert.ok(bundle.evidence.some((e) => e.sceneId === "scene_s10" && e.sourceKind === "manuscript"));
  kb.indexScene(scene, REVISION);
  const count = (kb as any).db
    .prepare("SELECT COUNT(*) AS c FROM kw_evidence WHERE scene_id = 'scene_s10' AND source_revision_id = ?")
    .get(REVISION) as { c: number };
  assert.equal(count.c, 2);
  kb.rebuildSearchIndex();
  const rebuilt = kb.queryContext(baseQuery({ query: "口袋空空", storyOrder: 4, narrationOrder: 11 }));
  assert.ok(rebuilt.evidence.some((e) => e.sceneId === "scene_s10"));
});

test("checkConsistency：遗失后直接掏出使用 → conflict；缺时间 → unknown；审美提示可选", () => {
  const kb = newService();
  seedKeyExample(kb);
  const conflict = kb.checkConsistency(
    sceneOf({ storyTime: "day 2 10:00" }),
    "沈砚掏出黄铜钥匙，打开仓库的门。",
  );
  const hard = conflict.find((i) => i.severity === "conflict");
  assert.ok(hard, "应报告唯一钥匙遗失后直接使用的冲突");
  assert.ok(hard!.evidence.some((q) => q.includes("掉进河底")));
  assert.equal(hard!.certainty, "confirmed");
  assert.ok(conflict.every((i) => ["conflict", "unknown", "aesthetic"].includes(i.severity)));
  const morning = kb.checkConsistency(
    sceneOf({ sceneId: "scene_s05", storyTime: "day 1 08:00", narrationOrder: 5, pov: "ent_linwu" }),
    "林雾用黄铜钥匙打开仓库。",
  );
  assert.ok(!morning.some((i) => i.severity === "conflict"), "S05 倒叙用钥匙时钥匙仍在林雾处");
  const quantityUnknown = kb.checkConsistency(
    sceneOf(),
    "他数了数，一共 3 枚。钥匙仍不在身上。",
  );
  assert.ok(quantityUnknown.every((i) => i.severity !== "conflict") || quantityUnknown.some((i) => i.severity === "unknown"));
});

test("seedExampleKnowledge：幂等灌入黄铜钥匙示例并可检索", () => {
  const kb = newService();
  kb.seedExampleKnowledge({ projectId: PROJECT, routeId: ROUTE, revisionId: REVISION, sceneIds: ["s03", "s05", "s08", "s10"] });
  const linwu = kb.resolveEntityByName(PROJECT, ROUTE, "林雾");
  assert.ok(linwu);
  const bundle = kb.queryContext(baseQuery({ query: "黄铜钥匙 河底", storyOrder: 3, purpose: "planning" }));
  assert.ok(bundle.evidence.length > 0);
  const conflict = kb.checkConsistency(
    sceneOf({ storyTime: "day 2 10:00" }),
    "沈砚掏出黄铜钥匙打开仓库。",
  );
  assert.ok(conflict.some((i) => i.severity === "conflict"));
  kb.seedExampleKnowledge({ projectId: PROJECT, routeId: ROUTE, revisionId: REVISION, sceneIds: ["s03", "s05", "s08", "s10"] });
  assert.equal(kb.listEntities(PROJECT).length, 4);
  assert.ok(kb.listFacts(PROJECT).length > 0);
  assert.equal(kb.listEvents(PROJECT).length, 3);
  assert.ok(kb.listEvents(PROJECT).every((event) => event.projectId === PROJECT));
});

for (const predicate of ["known_by", "revealed"]) {
  test(`秘密 ${predicate}：只在生效区间可见，过去、到期与未知时点不泄漏`, () => {
    const kb = newService();
    const secret = kb.addEntity({ projectId: PROJECT, type: "secret", name: "密钥身份", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
    kb.addFact({ projectId: PROJECT, subjectId: secret, predicate: "identity", value: "守门人", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE });
    const permission = { projectId: PROJECT, subjectId: secret, predicate, value: { entityId: "pov" }, semanticType: "world_fact" as const, reviewState: "confirmed" as const, sourceKind: "author_setting" as const, routeId: ROUTE };
    // 故意先插入更晚的区间，避免实现退回无序 LIMIT 1。
    kb.addFact({ ...permission, validFromOrder: 40, validToOrder: 50 });
    kb.addFact({ ...permission, validFromOrder: 10, validToOrder: 20 });
    kb.indexScene(sceneOf({ sceneId: "secret_source", body: "密钥身份是守门人。", storyTime: "day 0", narrationOrder: 1 }), REVISION);
    kb.addPlan({ projectId: PROJECT, revisionId: REVISION, routeId: ROUTE, text: "密钥身份指向守门人。" });
    for (const order of [1, 9, 20, 30, undefined]) {
      const bundle = kb.queryContext(baseQuery({ query: "密钥身份", povEntityId: "pov", ...(order === undefined ? {} : { storyOrder: order }) }));
      assert.equal(bundle.facts.filter((f) => f.subjectId === secret).length, 0, `时点 ${order} 不应包含秘密事实`);
      assert.equal(bundle.evidence.length, 0, `时点 ${order} 不应包含秘密证据`);
      assert.equal(bundle.selectedPlans.length, 0, `时点 ${order} 不应包含秘密计划`);
    }
    for (const storyOrder of [10, 19, 40]) {
      const bundle = kb.queryContext(baseQuery({ query: "密钥身份", povEntityId: "pov", storyOrder }));
      assert.ok(bundle.facts.some((f) => f.subjectId === secret && f.predicate === "identity"));
      assert.equal(bundle.evidence.length, 1);
      assert.equal(bundle.selectedPlans.length, 1);
    }
    const target = sceneOf({ sceneId: "secret_target", pov: "pov", storyTime: "day 0" });
    kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: target.sceneId, routeId: ROUTE, storyOrder: 1, bodyHash: "target" });
    assert.ok(kb.checkConsistency(target, "密钥身份是守门人。").some((issue) => issue.severity === "conflict" && issue.title.includes("秘密")));
    kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: target.sceneId, routeId: ROUTE, storyOrder: 10, bodyHash: "target" });
    assert.ok(!kb.checkConsistency(target, "密钥身份是守门人。").some((issue) => issue.severity === "conflict"));
    assert.ok(kb.queryContext(baseQuery({ purpose: "planning" })).facts.some((f) => f.subjectId === secret && f.predicate === "identity"));
  });
}

test("一致性检查使用冻结修订的场景时点，不借用其他修订的未来时间", () => {
  const kb = newService();
  const secret = kb.addEntity({ projectId: PROJECT, type: "secret", name: "失踪秘密", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.addFact({ projectId: PROJECT, subjectId: secret, predicate: "known_by", value: { entityId: "pov" }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE, validFromOrder: 10 });
  kb.registerScene({ projectId: PROJECT, revisionId: REVISION, sceneId: "target", routeId: ROUTE, storyOrder: 1, bodyHash: "past" });
  kb.registerScene({ projectId: PROJECT, revisionId: OTHER_REVISION, sceneId: "target", routeId: ROUTE, storyOrder: 10, bodyHash: "future" });
  const target = sceneOf({ sceneId: "target", pov: "pov" });
  assert.ok(kb.checkConsistency(target, "他道出失踪秘密。").some((i) => i.severity === "conflict" && i.title.includes("秘密")));
  assert.ok(!kb.checkConsistency({ ...target, baseRevisionId: OTHER_REVISION }, "他道出失踪秘密。").some((i) => i.severity === "conflict"));
});

test("一致性检查不以叙述顺序填充未知故事时点来放行秘密", () => {
  const kb = newService();
  const secret = kb.addEntity({ projectId: PROJECT, type: "secret", name: "家族秘密", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.addFact({ projectId: PROJECT, subjectId: secret, predicate: "known_by", value: { entityId: "pov" }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE, validFromOrder: 10 });
  const target = sceneOf({ sceneId: "untimed_target", pov: "pov", narrationOrder: 30 });
  delete target.storyTime;
  const issues = kb.checkConsistency(target, "他道出家族秘密。");
  assert.ok(issues.some((i) => i.severity === "unknown" && i.title.includes("秘密")));
  assert.ok(!issues.some((i) => i.severity === "conflict"), "时点未知不能断言视角已知或尚未获知");
});

test("未知故事时点的物品状态与来源返回排除计数和 unknown，不回放未来遗失造成硬冲突", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const key = kb.addEntity({ projectId: PROJECT, type: "item", name: "钥匙", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  const coin = kb.addEntity({ projectId: PROJECT, type: "item", name: "铜钱", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.addFact({ projectId: PROJECT, subjectId: key, predicate: "possessor", value: "林雾", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE });
  kb.addFact({ projectId: PROJECT, subjectId: key, predicate: "location", value: "仓库", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE, validFromOrder: 1, validToOrder: 10 });
  kb.addEvent({ projectId: PROJECT, subjectId: key, kind: "item.transfer_possession", routeId: ROUTE, storyOrder: 1, toValue: "沈砚", reviewState: "confirmed" });
  kb.addEvent({ projectId: PROJECT, subjectId: key, kind: "item.lost", routeId: ROUTE, storyOrder: 2, location: "河底", reviewState: "confirmed" });
  kb.indexScene(sceneOf({ sceneId: "coin_source", body: "铜钱数量未明。", storyTime: "day 1" }), REVISION);
  const row = db.prepare("SELECT evidence_id FROM kw_evidence WHERE scene_id = 'coin_source'").get() as { evidence_id: string };
  kb.addFact({ projectId: PROJECT, subjectId: coin, predicate: "quantity", value: { value: null, unit: "枚" }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "manuscript", routeId: ROUTE, evidenceIds: [row.evidence_id] });
  const state = kb.getWorldState(PROJECT, ROUTE, undefined, REVISION);
  assert.equal(state.entries.find((e) => e.subjectId === key)?.timeUnknown, true);
  assert.equal(state.entries.find((e) => e.subjectId === key)?.possessor, "林雾", "不能在未知时点回放未来的转交或遗失");
  assert.equal(state.entries.find((e) => e.subjectId === key)?.location, null);
  assert.equal(state.entries.find((e) => e.subjectId === coin)?.timeUnknown, true);
  assert.equal(state.excluded.find((e) => e.reason === "fact_story_order_unknown")?.count, 2);
  assert.equal(state.excluded.find((e) => e.reason === "evidence_story_order_unknown")?.count, 1);
  assert.equal(state.excluded.find((e) => e.reason === "event_story_order_unknown")?.count, 2);
  const target = sceneOf({ sceneId: "untimed_item_target", narrationOrder: 30 });
  delete target.storyTime;
  const issues = kb.checkConsistency(target, "他掏出钥匙，又数出 3 枚铜钱。");
  assert.equal(issues.filter((i) => i.severity === "unknown").length, 2);
  assert.ok(issues.every((i) => i.severity !== "conflict"));
  assert.ok(issues.some((i) => i.detail.includes("事实 2 条、证据 1 条、事件 2 条")));
  assert.ok(kb.checkConsistency({ ...target, storyTime: "day 2" }, "他掏出钥匙。").some((i) => i.severity === "conflict"), "已知发生在遗失之后时仍必须报告原有硬冲突");
});

test("故事时点未知时显式计数排除时限设定与有时点证据，不伪装资料不存在", () => {
  const kb = newService();
  kb.indexScene(sceneOf({ sceneId: "timed_sources", body: "资料记载了第一件事。\n\n资料记载了第二件事。", storyTime: "day 1" }), REVISION);
  const timeless = kb.addFact({ projectId: PROJECT, subjectId: "item", predicate: "owner", value: "作者设定", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE });
  const timed = kb.addFact({ projectId: PROJECT, subjectId: "item", predicate: "location", value: "仓库", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE, validFromOrder: 1, validToOrder: 20 });
  const bundle = kb.queryContext(baseQuery({ query: "资料" }));
  assert.ok(bundle.facts.some((f) => f.factId === timeless));
  assert.ok(!bundle.facts.some((f) => f.factId === timed));
  assert.equal(bundle.evidence.length, 0);
  assert.equal(bundle.excluded.find((e) => e.reason === "fact_story_order_unknown")?.count, 1);
  assert.equal(bundle.excluded.find((e) => e.reason === "evidence_story_order_unknown")?.count, 2);
  const knownTime = kb.queryContext(baseQuery({ query: "资料", storyOrder: 2000 }));
  assert.equal(knownTime.evidence.length, 2);
});

test("秘密获知记录不能由失效修订的正文证据授权", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const secret = kb.addEntity({ projectId: PROJECT, type: "secret", name: "信件秘密", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.indexScene(sceneOf({ sceneId: "knowledge_source", body: "角色读到了信件秘密。", storyTime: "day 0" }), REVISION);
  const row = db.prepare("SELECT evidence_id FROM kw_evidence WHERE scene_id = 'knowledge_source'").get() as { evidence_id: string };
  kb.addFact({ projectId: PROJECT, subjectId: secret, predicate: "known_by", value: { entityId: "pov" }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "manuscript", routeId: ROUTE, evidenceIds: [row.evidence_id], validFromOrder: 10 });
  kb.addFact({ projectId: PROJECT, subjectId: secret, predicate: "identity", value: "信中真相", semanticType: "world_fact", reviewState: "confirmed", sourceKind: "author_setting", routeId: ROUTE });
  kb.addPlan({ projectId: PROJECT, revisionId: REVISION, routeId: ROUTE, text: "回应信件秘密。" });
  const query = baseQuery({ query: "信件秘密", storyOrder: 10, povEntityId: "pov" });
  assert.ok(kb.queryContext(query).facts.some((f) => f.predicate === "identity"));
  db.prepare("DELETE FROM kw_scene_refs WHERE scene_id = 'knowledge_source'").run();
  const stale = kb.queryContext(query);
  assert.equal(stale.facts.filter((f) => f.subjectId === secret).length, 0);
  assert.equal(stale.evidence.length, 0);
  assert.equal(stale.selectedPlans.length, 0);
});

test("正文来源事实没有有效证据时排除并计数，作者设定不依赖正文锚点", () => {
  const kb = newService();
  const source = { projectId: PROJECT, subjectId: "item", predicate: "location", value: "仓库", semanticType: "world_fact" as const, reviewState: "confirmed" as const, routeId: ROUTE };
  const unsupported = kb.addFact({ ...source, sourceKind: "manuscript" });
  const setting = kb.addFact({ ...source, sourceKind: "author_setting" });
  const bundle = kb.queryContext(baseQuery({ storyOrder: 10 }));
  assert.ok(!bundle.facts.some((f) => f.factId === unsupported));
  assert.ok(bundle.facts.some((f) => f.factId === setting));
  assert.equal(bundle.excluded.find((e) => e.reason === "fact_source_not_in_revision")?.count, 1);
  assert.equal(kb.getWorldState(PROJECT, ROUTE, 10, REVISION).entries.find((e) => e.subjectId === "item")?.location, "仓库");
});

test("正文事实随修订、场景、内容哈希与时点校验，一致性检查不采信失效来源", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const item = kb.addEntity({ projectId: PROJECT, type: "item", name: "信物", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  const sourceScene = sceneOf({ sceneId: "fact_source", body: "信物的数量未明。", storyTime: "day 1" });
  kb.indexScene(sourceScene, REVISION);
  const row = db.prepare("SELECT evidence_id FROM kw_evidence WHERE scene_id = ?").get(sourceScene.sceneId) as { evidence_id: string };
  const factId = kb.addFact({ projectId: PROJECT, subjectId: item, predicate: "quantity", value: { value: null, unit: "枚" }, semanticType: "world_fact", reviewState: "confirmed", sourceKind: "manuscript", routeId: ROUTE, evidenceIds: ["missing_evidence", row.evidence_id] });
  const query = baseQuery({ storyOrder: 2000, narrationOrder: 11 });
  assert.ok(kb.queryContext(query).facts.some((f) => f.factId === factId), "至少一条有效证据即可支持事实");
  assert.equal(kb.getWorldState(PROJECT, ROUTE, 2000, REVISION).entries.find((e) => e.subjectId === item)?.quantity?.known, false);
  const target = sceneOf({ sceneId: "fact_target", storyTime: "day 1 01:00" });
  assert.ok(kb.checkConsistency(target, "他数出 3 枚信物。").some((i) => i.severity === "unknown" && i.title.includes("数量")));
  const assertExcluded = (overrides: Partial<ContextQuery> = {}) => {
    const bundle = kb.queryContext({ ...query, ...overrides });
    assert.ok(!bundle.facts.some((f) => f.factId === factId));
    assert.equal(bundle.excluded.find((e) => e.reason === "fact_source_not_in_revision")?.count, 1);
  };
  assertExcluded({ revisionId: OTHER_REVISION });
  assertExcluded({ storyOrder: 1000 });
  assertExcluded({ narrationOrder: 5 });
  db.prepare("DELETE FROM kw_scene_refs WHERE revision_id = ? AND scene_id = ?").run(REVISION, sourceScene.sceneId);
  assertExcluded();
  assert.ok(!kb.getWorldState(PROJECT, ROUTE, 2000, REVISION).entries.some((e) => e.subjectId === item));
  assert.ok(!kb.checkConsistency(target, "他数出 3 枚信物。").some((i) => i.title.includes("数量")));
  kb.indexScene(sourceScene, REVISION);
  db.prepare("UPDATE kw_evidence SET quote = ? WHERE evidence_id = ?").run("已被篡改", row.evidence_id);
  assertExcluded();
  assert.ok(!kb.getWorldState(PROJECT, ROUTE, 2000, REVISION).entries.some((e) => e.subjectId === item));
  kb.indexScene(sourceScene, REVISION);
  db.prepare("DELETE FROM kw_evidence WHERE evidence_id = ?").run(row.evidence_id);
  assertExcluded();
});

for (const mismatch of ["route", "project", "candidate", "selected_plan", "author_setting", "ref_route", "ref_project"] as const) {
  test(`事实证据通道拒绝 ${mismatch} 归属或来源不符，并计入 source_missing`, () => {
    const kb = newService();
    const evidence = kb.addEvidence({ projectId: mismatch === "project" ? "other_project" : PROJECT, sourceRevisionId: REVISION, sceneId: "source_scene", quote: "不应返回的内容", sourceKind: mismatch === "candidate" || mismatch === "selected_plan" || mismatch === "author_setting" ? mismatch : "manuscript", routeId: mismatch === "route" ? OTHER_ROUTE : ROUTE, storyOrder: 1 });
    kb.registerScene({ projectId: mismatch === "ref_project" ? "other_project" : PROJECT, revisionId: REVISION, sceneId: "source_scene", routeId: mismatch === "ref_route" ? OTHER_ROUTE : ROUTE, bodyHash: "body" });
    const args = { projectId: PROJECT, subjectId: "item", predicate: "location", value: "仓库", semanticType: "world_fact" as const, reviewState: "confirmed" as const, routeId: ROUTE, evidenceIds: [evidence] };
    const setting = kb.addFact({ ...args, sourceKind: "author_setting" });
    const extracted = kb.addFact({ ...args, sourceKind: "manuscript" });
    const bundle = kb.queryContext(baseQuery({ storyOrder: 2 }));
    assert.ok(bundle.facts.some((f) => f.factId === setting));
    assert.ok(!bundle.facts.some((f) => f.factId === extracted));
    assert.equal(bundle.evidence.length, 0);
    assert.equal(bundle.excluded.find((e) => e.reason === "evidence_source_missing")?.count, 1);
    assert.equal(bundle.excluded.find((e) => e.reason === "fact_source_not_in_revision")?.count, 1);
    assert.deepEqual(kb.getWorldState(PROJECT, ROUTE, 2, REVISION).entries.find((e) => e.subjectId === "item")?.evidenceQuotes, []);
  });
}

test("indexScene 失败回滚证据、FTS 与场景引用，并保留外层 SAVEPOINT", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const oldScene = sceneOf({ body: "旧正文仍可检索。", storyTime: "day 0" });
  kb.beginRevisionIndex(PROJECT, REVISION, [oldScene.sceneId]);
  kb.indexScene(oldScene, REVISION);
  const snapshot = () => ({ evidence: db.prepare("SELECT * FROM kw_evidence ORDER BY evidence_id").all(), fts: db.prepare("SELECT * FROM kw_fts ORDER BY ref_id").all(), refs: db.prepare("SELECT * FROM kw_scene_refs ORDER BY scene_id").all() });
  const before = snapshot();
  db.exec("CREATE TRIGGER fail_scene_index BEFORE INSERT ON kw_evidence WHEN NEW.quote = '故障段' BEGIN SELECT RAISE(ABORT, 'scene index fault'); END");
  db.exec("SAVEPOINT outer_write");
  assert.throws(() => kb.indexScene({ ...oldScene, body: "已写入的第一段。\n\n故障段" }, REVISION), /scene index fault/);
  assert.deepEqual(snapshot(), before, "第二段失败后必须恢复旧证据、旧 FTS 与旧场景哈希");
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "error");
  const failed = kb.queryContext(baseQuery({ query: "旧正文", storyOrder: 1 }));
  assert.ok(failed.evidence.some((e) => e.quote === oldScene.body));
  assert.notEqual(failed.indexState.keywordRevisionId, REVISION);
  assert.ok(failed.excluded.some((e) => e.reason === "keyword_index_error"));
  kb.addPlan({ projectId: PROJECT, revisionId: REVISION, routeId: ROUTE, text: "外层事务继续写入。" });
  db.exec("RELEASE SAVEPOINT outer_write");
  db.exec("DROP TRIGGER fail_scene_index");
  kb.indexScene({ ...oldScene, body: "恢复后正文。" }, REVISION);
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "ready");
});

test("FTS 写入失败也回滚当前场全部新证据，不留下只有证据的半成品", () => {
  const db = createDatabase();
  let failFts = false;
  const tracked: SqliteDatabase = {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: (...params) => {
          if (failFts && sql.includes("INSERT INTO kw_fts") && params.includes(tokenizeForFts("故障段"))) throw new Error("FTS write fault");
          return statement.run(...params);
        },
      };
    },
  };
  const kb = new SqliteKnowledgeService(tracked);
  const scene = sceneOf({ body: "原正文。", storyTime: "day 0" });
  kb.indexScene(scene, REVISION);
  const before = { evidence: db.prepare("SELECT * FROM kw_evidence").all(), fts: db.prepare("SELECT * FROM kw_fts").all(), refs: db.prepare("SELECT * FROM kw_scene_refs").all() };
  failFts = true;
  assert.throws(() => kb.indexScene({ ...scene, body: "第一段。\n\n故障段" }, REVISION), /FTS write fault/);
  assert.deepEqual({ evidence: db.prepare("SELECT * FROM kw_evidence").all(), fts: db.prepare("SELECT * FROM kw_fts").all(), refs: db.prepare("SELECT * FROM kw_scene_refs").all() }, before);
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "error");
});

test("修订索引状态只有完整场景清单全部成功才 ready，pending/error 保留旧修订且进度可持久化", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const first = sceneOf({ sceneId: "first", body: "第一场", storyTime: "day 0" });
  const second = sceneOf({ sceneId: "second", body: "第二场", storyTime: "day 0" });
  kb.indexScene(first, REVISION);
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "pending", "逐场成功不代表修订完整");
  kb.beginRevisionIndex(PROJECT, REVISION, [first.sceneId, second.sceneId]);
  kb.indexScene(first, REVISION);
  assert.notEqual(kb.queryContext(baseQuery()).indexState.keywordRevisionId, REVISION);
  kb.indexScene(second, REVISION);
  assert.deepEqual(kb.getIndexStatus(PROJECT, REVISION), { state: "ready", keywordRevisionId: REVISION });
  assert.equal(kb.queryContext(baseQuery()).indexState.keywordRevisionId, REVISION);
  kb.beginRevisionIndex(PROJECT, OTHER_REVISION, [first.sceneId, second.sceneId]);
  kb.indexScene(first, OTHER_REVISION);
  const pending = kb.queryContext(baseQuery({ revisionId: OTHER_REVISION }));
  assert.equal(pending.indexState.keywordRevisionId, REVISION);
  assert.ok(pending.excluded.some((e) => e.reason === "keyword_index_pending"));
  db.exec("CREATE TRIGGER fail_second_scene BEFORE INSERT ON kw_evidence WHEN NEW.scene_id = 'second' BEGIN SELECT RAISE(ABORT, 'second fault'); END");
  assert.throws(() => kb.indexScene(second, OTHER_REVISION), /second fault/);
  const failed = kb.queryContext(baseQuery({ revisionId: OTHER_REVISION }));
  assert.equal(failed.indexState.keywordRevisionId, REVISION);
  assert.ok(failed.excluded.some((e) => e.reason === "keyword_index_error"));
  const restarted = new SqliteKnowledgeService(db);
  assert.equal(restarted.getIndexStatus(PROJECT, REVISION).state, "ready", "重启后读取持久化进度，并重新核验实际证据与 FTS");
});

test("外层回滚或 FTS 丢失后不沿用内存中的完整索引声明", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const scene = sceneOf({ body: "临时正文。", storyTime: "day 0" });
  kb.beginRevisionIndex(PROJECT, REVISION, [scene.sceneId]);
  db.exec("SAVEPOINT outer_write");
  kb.indexScene(scene, REVISION);
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "ready");
  db.exec("ROLLBACK TO SAVEPOINT outer_write; RELEASE SAVEPOINT outer_write");
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "pending");
  assert.notEqual(kb.queryContext(baseQuery()).indexState.keywordRevisionId, REVISION);
  kb.indexScene(scene, REVISION);
  db.exec("DELETE FROM kw_fts");
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "pending");
  kb.rebuildSearchIndex();
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "ready");
});

test("分段索引一次加载实体别名，SQL 数量不随段落乘实体数放大且匹配顺序稳定", () => {
  const db = createDatabase();
  const statements: string[] = [];
  const tracked: SqliteDatabase = { exec: (sql) => db.exec(sql), prepare: (sql) => { statements.push(sql); return db.prepare(sql); } };
  const kb = new SqliteKnowledgeService(tracked);
  const character = kb.addEntity({ entityId: "z_character", projectId: PROJECT, type: "character", name: "沈砚", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  kb.addAlias(PROJECT, character, "小砚");
  const item = kb.addEntity({ entityId: "a_item", projectId: PROJECT, type: "item", name: "钥匙", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  const secret = kb.addEntity({ projectId: PROJECT, type: "secret", name: "暗号", routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  for (let i = 0; i < 40; i += 1) {
    const id = kb.addEntity({ projectId: PROJECT, type: "item", name: `物件${i}`, routeId: ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
    kb.addAlias(PROJECT, id, "");
  }
  kb.addEntity({ projectId: PROJECT, type: "character", name: "小砚", routeId: OTHER_ROUTE, sourceKind: "author_setting", reviewState: "confirmed" });
  statements.length = 0;
  kb.indexScene(sceneOf({ body: Array.from({ length: 12 }, (_, i) => `小砚拿着钥匙，记住暗号，第${i}段。`).join("\n\n") }), REVISION);
  const reads = statements.filter((sql) => /^\s*SELECT/.test(sql));
  assert.equal(reads.filter((sql) => sql.includes("FROM kw_entities")).length, 1);
  assert.equal(reads.filter((sql) => sql.includes("FROM kw_aliases")).length, 0);
  assert.equal(reads.length, 4, "实体别名 JOIN、场景时间、旧证据与一条持久化进度读取，不按段或实体查询别名");
  const rows = db.prepare("SELECT entity_refs, secret_refs FROM kw_evidence WHERE source_revision_id = ?").all(REVISION) as Array<{ entity_refs: string; secret_refs: string }>;
  assert.equal(rows.length, 12);
  for (const row of rows) {
    assert.deepEqual(JSON.parse(row.entity_refs), [character, item, secret], "保留实体插入顺序、别名命中与非空约束，隔离其他路线");
    assert.deepEqual(JSON.parse(row.secret_refs), [secret]);
  }
});

test("关键词证据召回遵守数量上限且不混入其他场景", () => {
  const kb = newService();
  const scenes = Array.from({ length: 4 }, (_, index) => sceneOf({
    sceneId: `scene_limit_${index}`,
    body: `共同线索，第 ${index} 段。`,
    narrationOrder: index + 1,
    storyTime: "day 0",
  }));
  kb.beginRevisionIndex(PROJECT, REVISION, scenes.map(scene => scene.sceneId));
  for (const scene of scenes) kb.indexScene(scene, REVISION);
  const limited = kb.queryContext(baseQuery({ query: "共同线索", limit: 2, storyOrder: 1 }));
  assert.equal(limited.evidence.length, 2);
  assert.ok(limited.evidence.every(item => item.quote.includes("共同线索")));
  const clamped = kb.queryContext(baseQuery({ query: "共同线索", limit: 999, storyOrder: 1 }));
  assert.equal(clamped.evidence.length, 4, "上限只限制额外召回，不应复制或制造证据");
});

test("新修订复用未变场景证据，正文或时空坐标变化时拒绝复用", () => {
  const db = createDatabase();
  const kb = new SqliteKnowledgeService(db);
  const first = sceneOf({ sceneId: "scene_keep", body: "保留正文。", narrationOrder: 1, storyTime: "1" });
  const second = sceneOf({ sceneId: "scene_change", body: "旧第二场。", narrationOrder: 2, storyTime: "1" });
  kb.beginRevisionIndex(PROJECT, REVISION, [first.sceneId, second.sceneId]);
  kb.indexScene(first, REVISION);
  kb.indexScene(second, REVISION);
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "ready");
  const originalEvidence = kb.queryContext(baseQuery({ query: "保留正文", storyOrder: 1 })).evidence[0]!;

  kb.beginRevisionIndex(PROJECT, OTHER_REVISION, [first.sceneId, second.sceneId]);
  assert.equal(kb.reuseSceneIndex(first, OTHER_REVISION, REVISION), true);
  const changedSecond = { ...second, body: "新第二场。" };
  assert.equal(kb.reuseSceneIndex(changedSecond, OTHER_REVISION, REVISION), false, "正文变化必须重建");
  kb.indexScene(changedSecond, OTHER_REVISION);
  assert.equal(kb.getIndexStatus(PROJECT, OTHER_REVISION).state, "ready");

  const inherited = kb.queryContext(baseQuery({ revisionId: OTHER_REVISION, query: "保留正文", storyOrder: 1 })).evidence;
  assert.equal(inherited.length, 1);
  assert.equal(inherited[0]!.evidenceId, originalEvidence.evidenceId);
  assert.equal(inherited[0]!.sourceRevisionId, REVISION, "继承证据保留真实来源修订");
  assert.equal(kb.queryContext(baseQuery({ revisionId: OTHER_REVISION, query: "旧第二场", storyOrder: 1 })).evidence.length, 0, "旧稿仍留在 FTS 也不能进入新修订");
  assert.equal(kb.queryContext(baseQuery({ revisionId: OTHER_REVISION, query: "新第二场", storyOrder: 1 })).evidence.length, 1);

  const thirdRevision = "rev_changed_time";
  kb.beginRevisionIndex(PROJECT, thirdRevision, [first.sceneId]);
  assert.equal(kb.reuseSceneIndex({ ...first, storyTime: "2" }, thirdRevision, OTHER_REVISION), false, "故事时点变化不得沿用旧时间证据");
});

test("同一区块同时存在继承与重建证据时只返回当前修订的一份", () => {
  const kb = newService();
  const scene = sceneOf({ sceneId: "scene_dedupe", body: "唯一证据。", storyTime: "1" });
  kb.beginRevisionIndex(PROJECT, REVISION, [scene.sceneId]);
  kb.indexScene(scene, REVISION);
  kb.beginRevisionIndex(PROJECT, OTHER_REVISION, [scene.sceneId]);
  kb.indexScene(scene, OTHER_REVISION);
  const result = kb.queryContext(baseQuery({ revisionId: OTHER_REVISION, query: "唯一证据", storyOrder: 1 }));
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]!.sourceRevisionId, OTHER_REVISION);
});

test("约百万字、500 场景的新修订只重建一个变化场景", (t) => {
  const kb = newService();
  const scenes = Array.from({ length: 500 }, (_, index) => sceneOf({
    sceneId: `scene_scale_${index}`,
    body: `第${index}场共同正文。${"长".repeat(1980)}`,
    narrationOrder: index + 1,
    storyTime: "1",
  }));
  kb.beginRevisionIndex(PROJECT, REVISION, scenes.map(scene => scene.sceneId));
  for (const scene of scenes) kb.indexScene(scene, REVISION);
  assert.equal(kb.getIndexStatus(PROJECT, REVISION).state, "ready");

  let rebuilt = 0;
  let reused = 0;
  const indexScene = kb.indexScene.bind(kb);
  const reuseSceneIndex = kb.reuseSceneIndex.bind(kb);
  kb.indexScene = (scene, revisionId) => { rebuilt += 1; indexScene(scene, revisionId); };
  kb.reuseSceneIndex = (scene, revisionId, sourceRevisionId) => {
    const result = reuseSceneIndex(scene, revisionId, sourceRevisionId);
    if (result) reused += 1;
    return result;
  };
  const started = performance.now();
  kb.beginRevisionIndex(PROJECT, OTHER_REVISION, scenes.map(scene => scene.sceneId));
  for (const scene of scenes) {
    const next = scene.sceneId === "scene_scale_499" ? { ...scene, body: `${scene.body}\n\n唯一的新结尾。` } : scene;
    if (!kb.reuseSceneIndex(next, OTHER_REVISION, REVISION)) kb.indexScene(next, OTHER_REVISION);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(reused, 499);
  assert.equal(rebuilt, 1);
  assert.equal(kb.getIndexStatus(PROJECT, OTHER_REVISION).state, "ready");
  assert.equal(kb.queryContext(baseQuery({ revisionId: OTHER_REVISION, query: "唯一的新结尾", storyOrder: 1 })).evidence.length, 1);
  t.diagnostic(`500 场景增量索引单次测量：${elapsedMs.toFixed(1)}ms（499 场复用，1 场重建；非 P95 验收）`);
});
