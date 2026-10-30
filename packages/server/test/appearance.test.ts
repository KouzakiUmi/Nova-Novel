import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { createApp } from "../src/app.js";
import { DomainStore } from "../src/store.js";
import { AgentSettings } from "../src/agent/settings.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";
import type { PiHost, WorkflowService } from "../src/contracts.js";

async function start(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("appearance HTTP settings survive app restart and reject invalid UI fonts, manuscript fonts and scales", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nova-appearance-http-"));
  const resources: Array<{ server: Server; db: Database.Database }> = [];
  async function open() {
    const db = new Database(join(directory, "story.sqlite"));
    const store = new DomainStore(db);
    const knowledge = new SqliteKnowledgeService(db);
    const settings = await AgentSettings.create(directory);
    const pi: PiHost = { settings, getConnection: () => ({ state: "unconfigured", mode: "embedded", detail: "test", sendsDataTo: "test" }), generate: async () => ({ text: "unused", completeness: "complete" }), cancel: async () => {} };
    const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("unused"); }, decide: () => { throw new Error("unused"); }, cancel: () => { throw new Error("unused"); } };
    const server = createApp({ store, knowledge, workflow, pi });
    const resource = { server, db };
    resources.push(resource);
    return { ...resource, base: await start(server) };
  }
  async function close(resource: { server: Server; db: Database.Database }) {
    if (resource.server.listening) {
      resource.server.closeIdleConnections();
      await new Promise<void>((resolveClose, reject) => resource.server.close(error => error ? reject(error) : resolveClose()));
    }
    if (resource.db.open) resource.db.close();
  }
  try {
    const first = await open();
    const defaults = await fetch(`${first.base}/api/appearance`);
    assert.equal(defaults.status, 200, "GET must be reachable before the non-write route guard");
    assert.deepEqual(await defaults.json(), { uiFont: "builtin", manuscriptFont: "builtin", uiScale: 100, manuscriptScale: 100 });
    const expected = { uiFont: "sarasa", manuscriptFont: "neo", uiScale: 120, manuscriptScale: 110 };
    const saved = await fetch(`${first.base}/api/appearance`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: first.base }, body: JSON.stringify(expected) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), expected);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "appearance.json"), "utf8")), expected);
    await close(first);
    const reopened = await open();
    const restored = await fetch(`${reopened.base}/api/appearance`);
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), expected);
    for (const manuscriptScale of [105, 0, "110"]) {
      const invalid = await fetch(`${reopened.base}/api/appearance`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: reopened.base }, body: JSON.stringify({ manuscriptScale }) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, "INVALID_INPUT");
    }
    for (const uiScale of [105, 0, "120"]) {
      const invalid = await fetch(`${reopened.base}/api/appearance`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: reopened.base }, body: JSON.stringify({ uiScale }) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, "INVALID_INPUT");
    }
    for (const uiFont of ["songti", "", 42]) {
      const invalid = await fetch(`${reopened.base}/api/appearance`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: reopened.base }, body: JSON.stringify({ uiFont }) });
      assert.equal(invalid.status, 400, `uiFont ${JSON.stringify(uiFont)} must be rejected`);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, "INVALID_INPUT");
    }
    assert.deepEqual(await (await fetch(`${reopened.base}/api/appearance`)).json(), expected, "rejected updates must preserve the persisted appearance");
    await close(reopened);
    writeFileSync(join(directory, "appearance.json"), JSON.stringify({ uiFont: "songti", manuscriptFont: "wenkai", uiScale: 110, manuscriptScale: 90, extra: "ignored" }), "utf8");
    const legacy = await open();
    assert.deepEqual(await (await fetch(`${legacy.base}/api/appearance`)).json(), { uiFont: "builtin", manuscriptFont: "wenkai", uiScale: 110, manuscriptScale: 90 }, "unknown stored uiFont must fall back to builtin");
    const rewritten = await fetch(`${legacy.base}/api/appearance`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: legacy.base }, body: JSON.stringify({ uiScale: 100 }) });
    assert.equal(rewritten.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(directory, "appearance.json"), "utf8"))).sort(), ["manuscriptFont", "manuscriptScale", "uiFont", "uiScale"], "unknown request and legacy keys must not be persisted");
  } finally {
    try { for (const resource of resources) await close(resource); }
    finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-appearance-http-")));
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
