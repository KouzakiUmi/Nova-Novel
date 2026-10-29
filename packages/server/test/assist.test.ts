import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import type {
  ElementDesignCard,
  ElementGuideSession,
  ExtractedLedgerBundle,
  NoteIncubateResult,
  PlotIdeateResult,
  WorkspaceSnapshot,
} from "@nova-novel/shared";
import type { PiHost, WorkflowService } from "../src/contracts.js";
import { createApp } from "../src/app.js";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";

function createTestEnv(customReply?: (payload: Record<string, unknown>) => string) {
  const directory = mkdtempSync(join(tmpdir(), "nova-novel-assist-"));
  const filename = join(directory, "story.sqlite");
  const db = new Database(filename);
  const store = new DomainStore(db);
  const knowledge = new SqliteKnowledgeService(db);
  const project = store.getProject();
  const branch = store.getBranch(project.activeBranchId);
  const scenes = store.listScenes(project.projectId, branch.headRevisionId);
  for (const sc of scenes) knowledge.indexScene(sc, branch.headRevisionId);

  const workflow: WorkflowService = {
    listDefinitions: () => [],
    listRuns: () => [],
    startRun: () => {
      throw new Error("unused");
    },
    decide: () => {
      throw new Error("unused");
    },
    cancel: () => {
      throw new Error("unused");
    },
  };

  const pi: PiHost = {
    getConnection: () => ({ state: "connected", mode: "embedded", detail: "test", sendsDataTo: "local" }),
    cancel: async () => {},
    generate: async ({ request }) => {
      const parsed = JSON.parse(request.input) as Record<string, unknown>;
      if (customReply) {
        return { text: customReply(parsed), completeness: "complete", output: "guide" };
      }
      if (parsed.schema === "nova-novel.element-design/1") {
        return {
          completeness: "complete",
          output: "guide",
          text: JSON.stringify({
            cards: [
              {
                proposalId: "elem-1",
                type: parsed.elementType ?? "character",
                name: "沈伯",
                aliases: ["老沈"],
                summary: "二十年前与父亲合开皮具作坊的旧友。",
                differenceNote: "温和隐忍的旧友",
                proposedFacts: [{ predicate: "role", value: "旧友", semanticType: "world_fact" }],
                arc: {
                  motivation: "弥补当年的失信",
                  goal: "取回信物旧鞋",
                  conflict: "害怕阿禾责怪",
                  epiphany: "坦白当年真相",
                  notes: "弧线备注",
                },
                secret:
                  parsed.elementType === "secret"
                    ? {
                        truth: "鞋跟藏着旧船票",
                        falseBelief: "普通修鞋收据",
                        initialHolders: ["沈伯"],
                        // 不带 revealCondition：保持「初始未揭示」，让知情边界可测。
                      }
                    : undefined,
              },
            ],
          }),
        };
      }
      if (parsed.schema === "nova-novel.element-guide/1") {
        if (parsed.mode === "question") {
          return {
            completeness: "complete",
            output: "guide",
            text: JSON.stringify({
              stepId: parsed.stepId,
              question: "这个设定最核心的矛盾是什么？",
              why: "帮助收敛戏剧张力",
              options: [
                { id: "opt1", label: "隐瞒过往", detail: "为了保护阿禾而隐瞒" },
                { id: "opt2", label: "契约限制", detail: "受老街行规约束" },
              ],
              allowCustom: true,
              allowSkip: true,
            }),
          };
        }
        return {
          completeness: "complete",
          output: "guide",
          text: JSON.stringify({
            cards: [
              {
                proposalId: "guided-elem-1",
                type: parsed.elementType ?? "character",
                name: "周师兄",
                aliases: ["守钟人"],
                summary: "由多轮问答引导生成的修表匠。",
                differenceNote: "引导定制方案",
                proposedFacts: [{ predicate: "occupation", value: "修表匠", semanticType: "world_fact" }],
              },
            ],
          }),
        };
      }
      if (parsed.schema === "nova-novel.arc-assist/1") {
        if (parsed.mode === "diagnose") {
          return {
            completeness: "complete",
            output: "guide",
            text: JSON.stringify({
              progressSummary: "已完成起点铺垫，但尚未正面冲突。",
              unfulfilledConflicts: ["尚未当面核对收据年份"],
              nextDilemmaProposals: [
                {
                  title: "按时关店还是等待取鞋人",
                  conflict: "买家催促交钥匙",
                  choiceA: "立刻交钥匙",
                  choiceB: "推迟三天关店",
                },
              ],
            }),
          };
        }
        return {
          completeness: "complete",
          output: "guide",
          text: JSON.stringify({
            proposals: [
              {
                proposalId: "arc-1",
                label: "释怀线",
                differenceNote: "重在内心和解",
                motivation: "卸下旧铺负担",
                goal: "完成最后一单",
                conflict: "旧收据来历不明",
                epiphany: "理解父亲的坚守",
                notes: "测试弧线",
              },
            ],
          }),
        };
      }
      if (parsed.schema === "nova-novel.plot-ideate/1") {
        if (parsed.mode === "scene_brainstorm") {
          return {
            completeness: "complete",
            output: "guide",
            text: JSON.stringify({
              fieldOptions: [
                { optionId: "opt-1", label: "物证矛盾", value: "收据背面的年份比店铺开业还早", rationale: "强化悬念" },
              ],
            }),
          };
        }
        return {
          completeness: "complete",
          output: "guide",
          text: JSON.stringify({
            scenes: [
              {
                proposalId: "plot-1",
                title: "雨夜核对针脚",
                goal: "试探来人身份",
                conflict: "来人拒绝留名",
                summary: "阿禾借口上蜡留住对方",
                pov: "阿禾",
                storyTime: "2",
                differenceNote: "对手戏推进",
              },
            ],
          }),
        };
      }
      if (parsed.schema === "nova-novel.note-incubate/1") {
        if (parsed.targetKind === "scenes") {
          return {
            completeness: "complete",
            output: "guide",
            text: JSON.stringify({
              sceneCards: [
                {
                  proposalId: "inc-sc-1",
                  title: "便签串联的新场景",
                  goal: "查清旧收据",
                  conflict: "线索中断",
                  summary: "发现暗格",
                },
              ],
            }),
          };
        }
        return {
          completeness: "complete",
          output: "guide",
          text: JSON.stringify({
            elementCards: [
              {
                proposalId: "inc-el-1",
                type: parsed.targetKind === "character" ? "character" : "rule",
                name: "便签孵化角色",
                aliases: ["孵化别名"],
                summary: "由多条便签整合生成的设定。",
                differenceNote: "整合方案",
                proposedFacts: [{ predicate: "source", value: "便签孵化", semanticType: "world_fact" }],
              },
            ],
          }),
        };
      }
      if (parsed.schema === "nova-novel.extract-ledger/1") {
        const firstScene = store.listScenes(project.projectId)[0]!;
        const validQuote = firstScene.body.split(/\n{2,}/)[0]!.trim();
        return {
          completeness: "complete",
          output: "guide",
          text: JSON.stringify({
            newElements: [
              {
                proposalId: "ne-valid",
                type: "item",
                name: "铁盒",
                aliases: ["旧铁盒"],
                summary: "装收据的铁盒",
                quote: validQuote,
              },
              {
                proposalId: "ne-hallucinated",
                type: "item",
                name: "不存在的太空飞船",
                aliases: [],
                summary: "正文中完全没有提到的东西",
                quote: "这句台词在正文里绝对不存在123456789",
              },
            ],
            factProposals: [
              {
                proposalId: "fp-valid",
                subjectName: "铁盒",
                predicate: "location",
                value: "柜台下",
                semanticType: "world_fact",
                quote: validQuote,
              },
            ],
            eventProposals: [
              {
                proposalId: "ep-valid",
                subjectName: "铁盒",
                kind: "item.discover",
                fromValue: "柜台下",
                toValue: "被翻出",
                quote: validQuote,
              },
            ],
          }),
        };
      }
      return { text: "{}", completeness: "complete", output: "guide" };
    },
  };

  const server = createApp({ store, knowledge, workflow, pi });
  return {
    store,
    knowledge,
    project,
    branch,
    server,
    async start(): Promise<string> {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Dual-mode Element Co-Creation: fast card generation, idempotent apply, and manual fact/event/secret boundary endpoints", async () => {
  const env = createTestEnv();
  try {
    const base = await env.start();
    // 1. 快速卡片共创
    const designRes = await fetch(`${base}/api/assist/element-design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        type: "character",
        prompt: "一个迟到二十年的取鞋老人",
      }),
    });
    assert.equal(designRes.status, 200);
    const designed = (await designRes.json()) as { artifactId: string; cards: ElementDesignCard[] };
    assert.equal(designed.cards.length, 1);
    assert.equal(designed.cards[0]!.name, "沈伯");

    // 2. 应用卡片（幂等验证）
    const applyRes = await fetch(`${base}/api/assist/element-design/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        card: designed.cards[0],
        acceptanceId: "test_elem_apply_1",
      }),
    });
    assert.equal(applyRes.status, 200);
    const applied = (await applyRes.json()) as { entity: { entityId: string; name: string }; snapshot: WorkspaceSnapshot };
    assert.equal(applied.entity.name, "沈伯");
    assert.ok(applied.snapshot.characterArcs.some((a) => a.entityId === applied.entity.entityId));
    assert.ok(applied.snapshot.facts.some((f) => f.subjectId === applied.entity.entityId && f.predicate === "role"));

    // 重复相同 acceptanceId 幂等返回
    const dupRes = await fetch(`${base}/api/assist/element-design/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        card: designed.cards[0],
        acceptanceId: "test_elem_apply_1",
      }),
    });
    assert.equal(dupRes.status, 200);

    // 3. 手动添加事实与秘密知情事件
    const factRes = await fetch(`${base}/api/elements/${encodeURIComponent(applied.entity.entityId)}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        predicate: "habit",
        value: "先看鞋底针脚",
        semanticType: "world_fact",
      }),
    });
    assert.equal(factRes.status, 201);

    const eventRes = await fetch(`${base}/api/elements/${encodeURIComponent(applied.entity.entityId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        kind: "known_by",
        storyTime: "2",
        toValue: "阿禾",
      }),
    });
    assert.equal(eventRes.status, 201);

    // 秘密知情边界：采用秘密卡（initialHolders=沈伯）后，非知情视角检索不到秘密内容事实；
    // 事件路由录入的 known_by（storyOrder=2 前不可见）同样要被 secretVisibleTo 消费。
    const designSecretRes = await fetch(`${base}/api/assist/element-design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        type: "secret",
        prompt: "旧鞋鞋跟里的秘密",
      }),
    });
    assert.equal(designSecretRes.status, 200);
    const designedSecret = (await designSecretRes.json()) as { cards: ElementDesignCard[] };
    const applySecretRes = await fetch(`${base}/api/assist/element-design/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        card: designedSecret.cards[0],
        acceptanceId: "test_secret_apply_1",
      }),
    });
    assert.equal(applySecretRes.status, 200);
    const appliedSecret = (await applySecretRes.json()) as { entity: { entityId: string } };

    // 事件路由正向回归：对 secret 元素录 known_by 事件（storyTime="2"，纯数字序号按 2 生效），
    // 知情者沈伯在 storyOrder=3 必须能看到 truth（事件路由写入的边界事实生效）。
    const secretEventRes = await fetch(`${base}/api/elements/${encodeURIComponent(appliedSecret.entity.entityId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        kind: "known_by",
        storyTime: "2",
        toValue: "沈伯",
      }),
    });
    assert.equal(secretEventRes.status, 201);
    const holderQuery = await fetch(`${base}/api/context/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        branchId: env.store.getBranch(env.project.activeBranchId).branchId,
        revisionId: env.store.getBranch(env.project.activeBranchId).headRevisionId,
        routeId: env.project.activeRouteId,
        query: "旧船票 真相",
        purpose: "scene_writing",
        povEntityId: applied.entity.entityId,
        storyOrder: 3,
      }),
    });
    assert.equal(holderQuery.status, 200);
    const holderBundle = (await holderQuery.json()) as { facts: Array<{ subjectId: string; predicate: string }> };
    assert.ok(
      holderBundle.facts.some((f) => f.subjectId === appliedSecret.entity.entityId && f.predicate === "truth"),
      "知情者（沈伯）在获知时点（storyOrder=2 起）之后必须能看到秘密真相事实",
    );

    // 非知情视角：秘密卡只把沈伯写成知情者（storyOrder=1 起），
    // 其他视角在 storyOrder=1 时看不到 truth（known_by 事实边界生效）。
    const nonHolderQuery = await fetch(`${base}/api/context/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        branchId: env.store.getBranch(env.project.activeBranchId).branchId,
        revisionId: env.store.getBranch(env.project.activeBranchId).headRevisionId,
        routeId: env.project.activeRouteId,
        query: "旧船票 真相",
        purpose: "scene_writing",
        // 确定的非知情者：不是任何 known_by 事实的值。
        povEntityId: "someone_who_does_not_know",
        storyOrder: 1,
      }),
    });
    assert.equal(nonHolderQuery.status, 200);
    const bundle = (await nonHolderQuery.json()) as { facts: Array<{ subjectId: string }> };
    assert.ok(
      !bundle.facts.some((f) => f.subjectId === appliedSecret.entity.entityId && f.predicate === "truth"),
      "非知情视角在获知时点前不应看到秘密真相事实",
    );
  } finally {
    await env.close();
  }
});

test("Guided Element Q&A Session: multi-step state machine, back cache reuse, and apply", async () => {
  const env = createTestEnv();
  try {
    const base = await env.start();
    const createRes = await fetch(`${base}/api/element-guide/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        type: "character",
        prompt: "隔壁修表匠",
      }),
    });
    assert.equal(createRes.status, 201);
    let session = ((await createRes.json()) as { session: ElementGuideSession }).session;
    assert.equal(session.status, "active");
    assert.equal(session.stepIndex, 0);
    assert.ok(session.pending);

    // 回答第 1 步、第 2 步、第 3 步
    for (let i = 0; i < 3; i++) {
      const ansRes = await fetch(`${base}/api/element-guide/sessions/${session.sessionId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "opt1" }),
      });
      assert.equal(ansRes.status, 200);
      session = ((await ansRes.json()) as { session: ElementGuideSession }).session;
    }
    assert.equal(session.status, "ready");
    assert.ok(session.proposal && session.proposal.length > 0);

    // 返回上一步并验证问题缓存复用
    const backRes = await fetch(`${base}/api/element-guide/sessions/${session.sessionId}/back`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(backRes.status, 200);
    session = ((await backRes.json()) as { session: ElementGuideSession }).session;
    assert.equal(session.status, "active");
    assert.equal(session.stepIndex, 2);

    // 再次回答完成并 apply
    const finishRes = await fetch(`${base}/api/element-guide/sessions/${session.sessionId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom: "作者自定义补充答案" }),
    });
    session = ((await finishRes.json()) as { session: ElementGuideSession }).session;
    assert.equal(session.status, "ready");

    const applyRes = await fetch(`${base}/api/element-guide/sessions/${session.sessionId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: session.proposal![0]!.proposalId }),
    });
    assert.equal(applyRes.status, 200);
    const applied = (await applyRes.json()) as { entity: { name: string }; session: ElementGuideSession };
    assert.equal(applied.session.status, "applied");
    assert.equal(applied.entity.name, "周师兄");
  } finally {
    await env.close();
  }
});

test("Character Arc AI Propose & Diagnose, Local Plot Ideation (next_scene & scene_brainstorm), and Multi-Note Incubator", async () => {
  const env = createTestEnv();
  try {
    const base = await env.start();
    // 先创建一个角色用于弧线推演与诊断
    const charRes = await fetch(`${base}/api/elements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: env.project.projectId, type: "character", name: "阿禾", summary: "主角" }),
    });
    const charId = ((await charRes.json()) as { entity: { entityId: string } }).entity.entityId;

    const proposeRes = await fetch(`${base}/api/assist/arc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: env.project.projectId, entityId: charId, mode: "propose" }),
    });
    assert.equal(proposeRes.status, 200);
    const proposedArc = (await proposeRes.json()) as { proposals: Array<{ label: string }> };
    assert.equal(proposedArc.proposals[0]!.label, "释怀线");

    const diagRes = await fetch(`${base}/api/assist/arc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: env.project.projectId, entityId: charId, mode: "diagnose" }),
    });
    assert.equal(diagRes.status, 200);
    const diag = (await diagRes.json()) as { diagnosis: { nextDilemmaProposals: unknown[] } };
    assert.equal(diag.diagnosis.nextDilemmaProposals.length, 1);

    // 局部情节推演：next_scene 插入在第一场之后
    const firstScene = env.store.listScenes(env.project.projectId)[0]!;
    const ideateRes = await fetch(`${base}/api/assist/plot-ideate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        mode: "next_scene",
        sceneId: firstScene.sceneId,
      }),
    });
    assert.equal(ideateRes.status, 200);
    const ideated = (await ideateRes.json()) as PlotIdeateResult;
    assert.equal(ideated.scenes?.length, 1);

    const headBefore = env.store.getBranch(env.project.activeBranchId).headRevisionId;
    const applyPlotRes = await fetch(`${base}/api/assist/plot-ideate/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        baseRevisionId: headBefore,
        mode: "next_scene",
        sceneId: firstScene.sceneId,
        scenes: ideated.scenes,
      }),
    });
    assert.equal(applyPlotRes.status, 200);
    const plotApplied = (await applyPlotRes.json()) as { scenes: Array<{ title: string; narrationOrder: number }> };
    assert.equal(plotApplied.scenes[0]!.title, "雨夜核对针脚");
    assert.equal(plotApplied.scenes[0]!.narrationOrder, 2);

    // 多便签孵化器：创建 2 条便签并孵化为角色
    const n1 = env.store.createNote({ projectId: env.project.projectId, title: "线索一", body: "旧皮鞋后跟偏磨" });
    const n2 = env.store.createNote({ projectId: env.project.projectId, title: "线索二", body: "持票人左腿微跛" });
    const incRes = await fetch(`${base}/api/notes/incubate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        noteIds: [n1.noteId, n2.noteId],
        targetKind: "character",
      }),
    });
    assert.equal(incRes.status, 200);
    const incubated = (await incRes.json()) as NoteIncubateResult;
    assert.equal(incubated.elementCards?.length, 1);

    const applyIncRes = await fetch(`${base}/api/notes/incubate/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        noteIds: [n1.noteId, n2.noteId],
        targetKind: "character",
        baseRevisionId: env.store.getBranch(env.project.activeBranchId).headRevisionId,
        elementCard: incubated.elementCards![0],
      }),
    });
    assert.equal(applyIncRes.status, 200);
    const appliedInc = (await applyIncRes.json()) as { entity: { entityId: string }; notes: Array<{ status: string; elementId?: string }> };
    assert.ok(appliedInc.notes.every((n) => n.status === "linked" && n.elementId === appliedInc.entity.entityId));
  } finally {
    await env.close();
  }
});

test("Manuscript Reverse Extraction (extract_ledger): filters out hallucinated quotes and binds deterministic evidenceId", async () => {
  const env = createTestEnv();
  try {
    const base = await env.start();
    const firstScene = env.store.listScenes(env.project.projectId)[0]!;
    const extractRes = await fetch(`${base}/api/assist/extract-ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        sceneId: firstScene.sceneId,
      }),
    });
    assert.equal(extractRes.status, 200);
    const bundle = (await extractRes.json()) as ExtractedLedgerBundle;
    // 模型返回了 2 个元素（1 个有效原句，1 个虚构原句），宿主必须过滤掉虚构原句
    assert.equal(bundle.filteredOutCount, 1);
    assert.equal(bundle.newElements.length, 1);
    assert.equal(bundle.newElements[0]!.name, "铁盒");
    assert.match(bundle.newElements[0]!.evidenceId, /^evidence_[0-9a-f]{24}$/);

    // 确认入库
    const applyRes = await fetch(`${base}/api/assist/extract-ledger/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        sceneId: firstScene.sceneId,
        newElements: bundle.newElements,
        factProposals: bundle.factProposals,
        eventProposals: bundle.eventProposals,
      }),
    });
    assert.equal(applyRes.status, 200);
    const applied = (await applyRes.json()) as {
      entities: Array<{ name: string; sourceKind: string }>;
      facts: Array<{ predicate: string; evidenceIds: string[] }>;
      events: Array<{ kind: string; evidenceIds: string[] }>;
      revision?: { revisionId: string };
    };
    assert.equal(applied.entities[0]!.name, "铁盒");
    assert.equal(applied.entities[0]!.sourceKind, "manuscript");
    // 入库若推进了分支头，证据必须已重绑到新修订：事实引用不得再指向旧修订的证据 ID。
    const headRevisionId = env.store.getBranch(env.project.activeBranchId).headRevisionId;
    if (applied.revision) {
      assert.equal(applied.revision.revisionId, headRevisionId);
      assert.notEqual(applied.facts[0]!.evidenceIds[0], bundle.newElements[0]!.evidenceId);
      assert.match(applied.facts[0]!.evidenceIds[0]!, /^evidence_[0-9a-f]{24}$/);
    }

    // 核心承诺：入库后事实必须能被上下文检索读回（manuscript 事实依赖当前修订内的有效证据）。
    const headBranch = env.store.getBranch(env.project.activeBranchId);
    const headScene = env.store.listScenes(env.project.projectId, headBranch.headRevisionId).find((s) => s.sceneId === firstScene.sceneId)!;
    const queryRes = await fetch(`${base}/api/context/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: env.project.projectId,
        branchId: headBranch.branchId,
        revisionId: headBranch.headRevisionId,
        routeId: env.project.activeRouteId,
        query: "铁盒 位置",
        purpose: "fact_check",
        narrationOrder: headScene.narrationOrder,
        storyOrder: 1,
      }),
    });
    assert.equal(queryRes.status, 200);
    const queried = (await queryRes.json()) as { facts?: Array<{ predicate: string }> };
    assert.ok(
      queried.facts?.some((f) => f.predicate === "location"),
      "apply 后新事实应出现在上下文检索结果中",
    );
  } finally {
    await env.close();
  }
});
