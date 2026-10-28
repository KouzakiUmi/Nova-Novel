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
    routeId: ROUTE, holderId: linwu, validFromOrder: 2,
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
