import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";
import { NotionCopilotPlugin } from "../src/integrations/notion-copilot.js";
import { createApp } from "../src/app.js";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";
import type { PiHost, WorkflowService } from "../src/contracts.js";

const token = "ntn_isolated_test_credential";
const config = { enabled: true, apiKeyEnv: "NOVA_NOTION_TEST_MISSING_KEY", agentId: "agent-test" };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function event(id: string, body: string) { return { id, type: "agent.message", content: [{ type: "text", text: body }], created_at: "2026-11-02T00:00:00Z" }; }
function frame(value: unknown) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }
function stream(envelopes: unknown[]) { return new Response(envelopes.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } }); }
function complete(body: string, id = "answer-1") { return stream([{ type: "session.snapshot", session: { id: "remote-session", status: "queued" } }, { type: "event.committed", event: event(id, body) }, { type: "stream.end", session_id: "remote-session", status: "completed" }]); }
function fixture(fetcher: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "nova-notion-test-"));
  const plugin = new NotionCopilotPlugin(dir, fetcher);
  return { dir, plugin, async close() { await plugin.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir(), "nova-notion-test-"))); rmSync(dir, { recursive: true, force: true }); } };
}
async function settled(plugin: NotionCopilotPlugin, id: string) {
  for (let count = 0; count < 300; count++) {
    const view = plugin.get(id);
    if (!["running", "stopping"].includes(view.status)) return view;
    await new Promise<void>(done => setImmediate(done));
  }
  throw new Error("Conversation did not settle");
}

test("optional plugin defaults off, never contacts Notion or serializes credentials", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return json({ results: [] }); });
  try {
    assert.equal(f.plugin.view().enabled, false);
    await assert.rejects(f.plugin.agents(), /先启用/);
    assert.throws(() => f.plugin.create(), /先启用/);
    assert.equal(requests, 0);
    await f.plugin.configure({ ...config, token });
    assert.equal(f.plugin.view().tokenSource, "session");
    const saved = readFileSync(join(f.dir, "plugins/notion-copilot/settings.json"), "utf8");
    assert.ok(!saved.includes(token));
    assert.ok(!JSON.stringify(f.plugin.view()).includes(token));
    const reopened = new NotionCopilotPlugin(f.dir);
    assert.equal(reopened.view().hasToken, false);
    await reopened.close();
    await f.plugin.configure({ ...config, enabled: false });
    assert.equal(f.plugin.view().hasToken, false);
  } finally { await f.close(); }
});

test("API token environment references are resolved without copying values to settings", async () => {
  const previous = process.env.NOVA_NOTION_TEST_MISSING_KEY;
  const f = fixture(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return json({ results: [{ id: "agent-test", name: "笔记助手", description: "外部资料" }], has_more: false });
  });
  try {
    process.env.NOVA_NOTION_TEST_MISSING_KEY = token;
    await f.plugin.configure(config);
    assert.equal(f.plugin.view().tokenSource, "environment");
    assert.equal((await f.plugin.agents())[0]?.name, "笔记助手");
    assert.ok(!readFileSync(join(f.dir, "plugins/notion-copilot/settings.json"), "utf8").includes(token));
  } finally { if (previous === undefined) delete process.env.NOVA_NOTION_TEST_MISSING_KEY; else process.env.NOVA_NOTION_TEST_MISSING_KEY = previous; await f.close(); }
});

test("agent discovery handles pagination and API failures without echoing upstream bodies", async () => {
  let count = 0;
  const f = fixture(async (url, init) => {
    assert.equal(String(url), "https://api.notion.com/v1/agents/query");
    assert.equal(new Headers(init?.headers).get("Notion-Version"), "2026-03-11");
    assert.equal(init?.redirect, "error");
    count++;
    if (count === 1) return json({ results: [{ id: "one", name: "One" }], has_more: true, next_cursor: "cursor" });
    assert.equal(JSON.parse(String(init?.body)).start_cursor, "cursor");
    return json({ results: [{ id: "two", name: "Two" }], has_more: false });
  });
  try {
    await f.plugin.configure({ ...config, token });
    assert.deepEqual((await f.plugin.agents()).map(item => item.id), ["one", "two"]);
    const rejected = new NotionCopilotPlugin(f.dir, async () => json({ message: token }, 401));
    await rejected.configure({ ...config, token });
    await assert.rejects(rejected.agents(), error => error instanceof Error && /无效/.test(error.message) && !error.message.includes(token));
    await rejected.close();
  } finally { await f.close(); }
});

test("SSE conversations continue the same session, deduplicate requests and persist committed replies", async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture(async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return complete(`笔记回复 ${requests.length}`, `answer-${requests.length}`); });
  try {
    await f.plugin.configure({ ...config, token });
    const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "找出灵感", requestId: "request-one" });
    f.plugin.send(conversation.id, { message: "找出灵感", requestId: "request-one" });
    assert.equal((await settled(f.plugin, conversation.id)).status, "completed");
    f.plugin.send(conversation.id, { message: "继续总结", requestId: "request-two" });
    const next = await settled(f.plugin, conversation.id);
    assert.equal(next.messages.length, 4);
    assert.deepEqual(requests, [{ agent_id: "agent-test", message: "找出灵感" }, { session_id: "remote-session", message: "继续总结" }]);
    const restored = new NotionCopilotPlugin(f.dir);
    assert.deepEqual(restored.get(conversation.id).messages, next.messages);
    await restored.close();
    assert.ok(!readFileSync(join(f.dir, "plugins/notion-copilot/conversations.json"), "utf8").includes(token));
  } finally { await f.close(); }
});

test("stream parser handles split UTF-8/CRLF, provisional replacement and committed event replay", async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode([
    frame({ type: "session.snapshot", session: { id: "remote-session" } }),
    frame({ type: "event.provisional", event: event("draft", "未完成草稿") }),
    frame({ type: "event.committed", event: event("final", `中文成稿 ${token}`) }),
    frame({ type: "event.committed", event: event("final", "重复不应显示") }),
    frame({ type: "stream.end", status: "completed" }),
  ].join(""));
  const f = fixture(async () => new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } }));
  try {
    await f.plugin.configure({ ...config, token });
    const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    const next = await settled(f.plugin, conversation.id);
    assert.equal(next.status, "completed");
    assert.equal(next.messages.length, 2);
    assert.equal(next.messages[1]?.text, "中文成稿 [REDACTED]");
    const saved = readFileSync(join(f.dir, "plugins/notion-copilot/conversations.json"), "utf8");
    assert.ok(!saved.includes("未完成草稿")); assert.ok(!saved.includes(token));
  } finally { await f.close(); }
});

test("dropped stream reconciles events without reposting a charged message", async () => {
  let sends = 0;
  const f = fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/sessions") { sends++; return stream([{ type: "session.snapshot", session: { id: "remote-session" } }, { type: "stream.timeout", session_id: "remote-session" }]); }
    if (path.endsWith("/events/query")) return json({ results: [event("answer", "断流后找回的回复")], has_more: false });
    return json({ id: "remote-session", status: "completed" });
  });
  try {
    await f.plugin.configure({ ...config, token });
    const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    const next = await settled(f.plugin, conversation.id);
    assert.equal(next.status, "completed"); assert.equal(next.messages[1]?.text, "断流后找回的回复"); assert.equal(sends, 1);
  } finally { await f.close(); }
});

test("cancel stops the remote session and configuration cannot change during a turn", async () => {
  let stops = 0;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const f = fixture(async (url) => {
    if (String(url).endsWith("/cancel")) { stops++; streamController.close(); return json({ id: "remote-session", status: "canceled" }); }
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode(frame({ type: "session.snapshot", session: { id: "remote-session" } }))); } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    await f.plugin.configure({ ...config, token });
    const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "整理笔记", requestId: "request-one" });
    for (let count = 0; !f.plugin.get(conversation.id).remoteSessionId && count < 100; count++) await new Promise<void>(done => setImmediate(done));
    await assert.rejects(f.plugin.configure({ ...config, enabled: false }), /先停止/);
    assert.equal((await f.plugin.cancel(conversation.id)).status, "canceled");
    assert.equal((await settled(f.plugin, conversation.id)).status, "canceled");
    assert.equal(stops, 1);
  } finally { await f.close(); }
});

test("required actions are displayed, never approved automatically", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return stream([{ type: "session.snapshot", session: { id: "remote-session" } }, { type: "stream.end", status: "requires_action" }]); });
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "查阅笔记", requestId: "request-one" });
    assert.equal((await settled(f.plugin, conversation.id)).status, "requires_action");
    assert.throws(() => f.plugin.send(conversation.id, { message: "继续", requestId: "request-two" }), /操作确认/);
    assert.equal(requests, 1);
  } finally { await f.close(); }
});

test("restart marks unfinished conversations interrupted and preserves corrupt files", async () => {
  const f = fixture(async () => complete("reply"));
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    const path = join(f.dir, "plugins/notion-copilot/conversations.json");
    const history = JSON.parse(readFileSync(path, "utf8")); history[0].status = "running"; history[0].remoteSessionId = "remote-session";
    writeFileSync(path, JSON.stringify(history));
    const restored = new NotionCopilotPlugin(f.dir);
    assert.equal(restored.get(conversation.id).status, "interrupted");
    await restored.configure({ ...config, token });
    assert.throws(() => restored.send(conversation.id, { message: "继续", requestId: "request-one" }), /运行状态/);
    await restored.close();
    writeFileSync(path, "broken JSON");
    const corrupt = new NotionCopilotPlugin(f.dir);
    assert.equal(corrupt.view().enabled, false); assert.match(corrupt.view().error!, /原文件已保留/);
    await assert.rejects(corrupt.configure(config), /无法读取/);
    assert.equal(readFileSync(path, "utf8"), "broken JSON"); await corrupt.close();
  } finally { await f.close(); }
});

test("plugin HTTP routes enforce pairing, reject domain fields and leave every SQLite object unchanged", async () => {
  const f = fixture(async () => complete("外部笔记回复"));
  const db = new Database(":memory:"); const store = new DomainStore(db); const knowledge = new SqliteKnowledgeService(db);
  const pi: PiHost = { getConnection: () => ({ state: "unconfigured", mode: "embedded", detail: "test", sendsDataTo: "test" }), generate: async () => { throw new Error("Novel generation must not run"); }, cancel: async () => {} };
  const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("unused"); }, decide: () => { throw new Error("unused"); }, cancel: () => { throw new Error("unused"); } };
  const previous = process.env.NOVA_NOVEL_PAIR_TOKEN; process.env.NOVA_NOVEL_PAIR_TOKEN = "notion-pair-test";
  const server = createApp({ store, knowledge, pi, workflow, notion: f.plugin });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`; const headers = { "Content-Type": "application/json", "X-Nova-Novel-Token": "notion-pair-test" };
  const route = "/api/plugins/notion-copilot";
  try {
    assert.equal((await fetch(`${base}${route}/settings`)).status, 403);
    assert.equal((await fetch(`${base}${route}/settings`, { headers: { ...headers, Origin: "https://other.example" } })).status, 403);
    const before = db.prepare("SELECT total_changes() AS changes").get();
    const snapshot = await (await fetch(`${base}/api/bootstrap`, { headers })).json();
    assert.equal((await fetch(`${base}${route}/settings`, { method: "PUT", headers, body: JSON.stringify({ ...config, token }) })).status, 200);
    assert.equal((await fetch(`${base}${route}/conversations`, { method: "POST", headers, body: JSON.stringify({ projectId: "forbidden" }) })).status, 400);
    const created = await (await fetch(`${base}${route}/conversations`, { method: "POST", headers, body: "{}" })).json() as { conversation: { id: string } };
    const id = created.conversation.id;
    assert.equal((await fetch(`${base}${route}/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ message: "总结", requestId: "request-one" }) })).status, 202);
    assert.equal((await settled(f.plugin, id)).status, "completed");
    assert.deepEqual(await (await fetch(`${base}/api/bootstrap`, { headers })).json(), snapshot);
    assert.deepEqual(db.prepare("SELECT total_changes() AS changes").get(), before);
    assert.equal((await fetch(`${base}${route}/conversations`, { headers })).status, 200);
  } finally {
    if (previous === undefined) delete process.env.NOVA_NOVEL_PAIR_TOKEN; else process.env.NOVA_NOVEL_PAIR_TOKEN = previous;
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); db.close(); await f.close();
  }
});

test("cancel before the first snapshot waits for the remote ID and then stops that session", async () => {
  let release: (response: Response) => void = () => {};
  let stops = 0;
  const f = fixture(async url => {
    if (String(url).endsWith("/cancel")) { stops++; return json({ status: "canceled" }); }
    return new Promise<Response>(done => { release = done; });
  });
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    assert.equal((await f.plugin.cancel(conversation.id)).status, "stopping");
    release(stream([{ type: "session.snapshot", session: { id: "remote-session" } }]));
    assert.equal((await settled(f.plugin, conversation.id)).status, "canceled"); assert.equal(stops, 1);
  } finally { await f.close(); }
});

test("an ambiguous network failure blocks automatic resubmission and mismatched idempotency keys", async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; throw new Error(`network ${token}`); });
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    const result = await settled(f.plugin, conversation.id);
    assert.equal(result.status, "interrupted"); assert.ok(!result.error?.includes(token));
    assert.throws(() => f.plugin.send(conversation.id, { message: "不同消息", requestId: "request-one" }), /不同消息/);
    assert.throws(() => f.plugin.send(conversation.id, { message: "总结", requestId: "request-two" }), /运行状态/);
    assert.equal(sends, 1);
  } finally { await f.close(); }
});

test("empty successful turns are reconciled and never reported as usable replies", async () => {
  const f = fixture(async url => String(url).endsWith("/events/query") ? json({ results: [], has_more: false }) : stream([{ type: "session.snapshot", session: { id: "remote-session" } }, { type: "stream.end", status: "completed" }]));
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    const result = await settled(f.plugin, conversation.id);
    assert.equal(result.status, "interrupted"); assert.match(result.error!, /没有返回可用回复/);
  } finally { await f.close(); }
});

test("JSON session responses are polled for canonical events and both event pages are collected", async () => {
  const f = fixture(async (url, init) => {
    if (!String(url).endsWith("/events/query")) return json({ id: "remote-session", status: "completed" });
    const input = JSON.parse(String(init?.body));
    return input.start_cursor ? json({ results: [event("second", "第二段")], has_more: false }) : json({ results: [event("first", "第一段")], has_more: true, next_cursor: "second-page" });
  });
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    const result = await settled(f.plugin, conversation.id);
    assert.equal(result.status, "completed"); assert.deepEqual(result.messages.slice(1).map(item => item.text), ["第一段", "第二段"]);
  } finally { await f.close(); }
});

test("a nonterminal cancel response is not reported as a confirmed remote stop", async () => {
  const f = fixture(async url => String(url).endsWith("/events/query") ? json({ results: [], has_more: false }) : json({ id: "remote-session", status: "in_progress" }));
  try {
    await f.plugin.configure({ ...config, token }); const conversation = f.plugin.create();
    f.plugin.send(conversation.id, { message: "总结", requestId: "request-one" });
    for (let count = 0; !f.plugin.get(conversation.id).remoteSessionId && count < 100; count++) await new Promise<void>(done => setImmediate(done));
    await assert.rejects(f.plugin.cancel(conversation.id), /尚未确认停止/);
    assert.equal((await settled(f.plugin, conversation.id)).status, "interrupted");
  } finally { await f.close(); }
});
