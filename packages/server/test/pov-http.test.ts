import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import type { ContextBundle, ContextQuery, Entity, GenerationReceipt } from "@nova-novel/shared";
import type { KnowledgeService, PiHost, WorkflowService } from "../src/contracts.js";
import { createApp } from "../src/app.js";
import { DomainStore } from "../src/store.js";

function fixture() {
  const prefix = join(tmpdir(), "nova-novel-pov-http-");
  const directory = mkdtempSync(prefix);
  const db = new Database(join(directory, "story.sqlite"));
  const store = new DomainStore(db);
  const project = store.getProject();
  return {
    store,
    project,
    close() {
      db.close();
      assert.equal(resolve(directory), directory);
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(directory.startsWith(prefix));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function emptyContext(revisionId: string): ContextBundle {
  return { snapshotId: "pov-http", facts: [], evidence: [], selectedPlans: [], candidates: [], excluded: [], indexState: { keywordRevisionId: revisionId, semanticState: "unconfigured" } };
}

async function start(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

for (const pov of ["阿禾", "ent_ah", "小禾"]) {
  test(`HTTP generation resolves scene POV ${pov} to its entity ID`, async () => {
    const f = fixture();
    const captured: ContextQuery[] = [];
    const entity: Entity = { entityId: "ent_ah", projectId: f.project.projectId, type: "character", name: "阿禾", aliases: ["小禾"], summary: "修鞋的人", routeId: f.project.activeRouteId, sourceKind: "author_setting", reviewState: "confirmed", createdAt: f.project.createdAt, updatedAt: f.project.updatedAt };
    const knowledge: KnowledgeService = {
      listEntities: projectId => { assert.equal(projectId, f.project.projectId); return [entity]; },
      listFacts: () => [],
      listEvents: () => [],
      queryContext: query => { captured.push(query); return emptyContext(query.revisionId); },
      checkConsistency: () => [],
      indexScene: () => {},
    };
    const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("no workflow"); }, decide: () => { throw new Error("no workflow"); }, cancel: () => { throw new Error("no workflow"); } };
    const pi: PiHost = { getConnection: () => ({ state: "connected", mode: "embedded", detail: "test", sendsDataTo: "test" }), generate: async () => ({ text: "阿禾收起桌上的收据。", completeness: "complete" }), cancel: async () => {} };
    const server = createApp({ store: f.store, knowledge, workflow, pi });
    try {
      let scene = f.store.listScenes(f.project.projectId)[0]!;
      assert.equal(scene.pov, "阿禾", "the default example stores the character name rather than its entity ID");
      if (pov !== scene.pov) scene = f.store.saveScene(scene.sceneId, { baseRevisionId: scene.baseRevisionId, patch: { pov } }).scene;
      const base = await start(server);
      const response = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ projectId: f.project.projectId, sceneId: scene.sceneId, kind: "scene", input: "接着这场写一小段", idempotencyKey: `pov-http-${pov}` }),
      });
      const receipt = await response.json() as GenerationReceipt;
      assert.equal(response.status, 200);
      assert.equal(receipt.task.state, "succeeded");
      assert.equal(receipt.task.completeness, "complete");
      assert.equal(captured.length, 1);
      assert.equal(captured[0]!.projectId, f.project.projectId);
      assert.equal(captured[0]!.revisionId, scene.baseRevisionId);
      assert.equal(captured[0]!.povEntityId, "ent_ah");
      assert.notEqual(captured[0]!.povEntityId, "阿禾");
    } finally {
      try { await stop(server); }
      finally { f.close(); }
    }
  });
}
