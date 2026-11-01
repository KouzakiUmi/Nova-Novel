// Real Chromium UI against an isolated domain database and a fake Notion API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createApp } from "../packages/server/dist/app.js";
import { DomainStore } from "../packages/server/dist/store.js";
import { SqliteKnowledgeService } from "../packages/server/dist/knowledge/index.js";
import { NotionCopilotPlugin } from "../packages/server/dist/integrations/notion-copilot.js";

const browser = [process.env.NOVA_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(path => path && existsSync(path));
assert.ok(browser, "Set NOVA_BROWSER to an installed Chromium browser");
const requireServer = createRequire(new URL("../packages/server/package.json", import.meta.url));
const Database = requireServer("better-sqlite3");
const directory = await mkdtemp(join(tmpdir(), "nova-notion-ui-"));
const db = new Database(":memory:");
const store = new DomainStore(db);
const knowledge = new SqliteKnowledgeService(db);
const frames = value => `data: ${JSON.stringify(value)}\n\n`;
let messagesSent = 0;
let remoteCanceled = 0;
const notion = new NotionCopilotPlugin(directory, async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === "/v1/agents/query") return Response.json({ results: [{ id: "fixture-agent", name: "测试笔记助手", description: "仅测试数据" }], has_more: false });
  if (path.endsWith("/cancel")) { remoteCanceled++; return Response.json({ status: "canceled" }); }
  assert.equal(path, "/v1/sessions");
  messagesSent++;
  const message = JSON.parse(init.body).message;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames({ type: "session.snapshot", session: { id: "fixture-session" } })));
      const abort = () => { try { controller.close(); } catch { /* Stream already ended. */ } };
      init.signal.addEventListener("abort", abort, { once: true });
      if (message.includes("保持运行")) return;
      controller.enqueue(encoder.encode(frames({ type: "event.provisional", event: { id: "draft", type: "agent.message", content: [{ type: "text", text: "正在整理笔记…" }] } })));
      setTimeout(() => {
        try {
          controller.enqueue(encoder.encode(frames({ type: "event.committed", event: { id: `reply-${messagesSent}`, type: "agent.message", content: [{ type: "text", text: "这是从测试笔记整理出的灵感摘要。\n\n可以围绕人物动机继续提问。" }] } })));
          controller.enqueue(encoder.encode(frames({ type: "stream.end", status: "completed" })));
          controller.close();
        } catch { /* Test may stop a turn before the timer fires. */ }
        finally { init.signal.removeEventListener("abort", abort); }
      }, 1000);
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
});
const settings = { view: () => ({ providers: [], models: [], routes: [], builtinProviders: [], detectedProviders: [], engine: { name: "test", version: "test", mode: "embedded" }, dataDir: directory }) };
const pi = { settings, getConnection: () => ({ state: "unconfigured", mode: "embedded", detail: "test", sendsDataTo: "test" }), generate: async () => { throw new Error("Domain agent must not run"); }, cancel: async () => {} };
const workflow = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("unused"); }, decide: () => { throw new Error("unused"); }, cancel: () => { throw new Error("unused"); } };
const originalPairToken = process.env.NOVA_NOVEL_PAIR_TOKEN;
process.env.NOVA_NOVEL_PAIR_TOKEN = "notion-ui-fixture";
const api = createApp({ store, knowledge, pi, workflow, notion });
const apiHandler = api.listeners("request")[0];
const root = resolve("packages/web/dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const server = createServer((request, response) => {
  if (request.url.startsWith("/api/")) return apiHandler(request, response);
  void (async () => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    try { const body = await readFile(file); response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(body); }
    catch { response.writeHead(404).end(); }
  })();
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const before = db.prepare("SELECT total_changes() AS changes").get();
let child;
let socket;
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`UI timeout: ${description}`);
};
try {
  child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "browser")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let debugOutput = "";
  const endpoint = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chromium DevTools not ready: ${debugOutput.slice(-2000)}`)), 15_000);
    child.stderr.on("data", chunk => { debugOutput += String(chunk); const match = debugOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolveReady(match[1]); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Browser exited ${code}`)); });
  });
  socket = new WebSocket(endpoint); await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text); if (message.id && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer); if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result); } });
  const command = (method, params = {}, sessionId) => new Promise((resolveResult, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve: resolveResult, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
  await command("Runtime.enable", {}, sessionId);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async expression => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " " + (result.exceptionDetails.exception?.description ?? ""));
    return result.result.value;
  };
  const click = async label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(label)}); button.click(); })()`);
  const fill = async (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('Input unavailable'); const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await command("Page.navigate", { url: `${base}/#pair=notion-ui-fixture` }, sessionId);
  await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Notion 笔记')`), "app navigation");
  await click("Notion 笔记");
  await waitFor(() => evaluate(`!!document.querySelector('.notion-settings input[type=password]')`), "connection form");
  await evaluate(`document.querySelector('.notion-settings-title input[type=checkbox]').click()`);
  await fill(".notion-settings input[type=password]", "ntn_browser_fixture_token");
  await fill(".notion-settings-fields label:nth-child(3) input", "fixture-agent");
  await click("保存设置");
  await waitFor(() => evaluate(`document.querySelector('.notion-settings-actions').textContent.includes('凭据来源：本次运行')`), "settings saved");
  await click("验证连接并读取 Agent");
  await waitFor(() => evaluate(`document.body.textContent.includes('连接成功，可访问 1 个 Agent')`), "discovery");
  await click("连接设置");
  await click("新对话");
  await waitFor(() => evaluate(`!!document.querySelector('#notion-message:not(:disabled)')`), "new conversation");
  await fill("#notion-message", "总结我的灵感笔记"); await click("发送");
  await waitFor(() => evaluate(`document.body.textContent.includes('这是从测试笔记整理出的灵感摘要。') && document.querySelector('.notion-chat-title').textContent.includes('回复完成')`), "reply");
  await fill("#notion-message", "继续保持运行"); await click("发送");
  await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(item => item.textContent.trim() === '停止远端会话' && !item.disabled)`), "cancel available");
  await click("停止远端会话");
  await waitFor(() => evaluate(`document.querySelector('.notion-chat-title').textContent.includes('已停止')`), "remote cancellation");
  assert.equal(messagesSent, 2); assert.equal(remoteCanceled, 1);
  assert.deepEqual(db.prepare("SELECT total_changes() AS changes").get(), before, "Notion UI must not write novel data");
  const layout = await evaluate(`(() => { const root = document.querySelector('.notion-copilot'); return { overflow: root.scrollWidth > root.clientWidth, messages: document.querySelectorAll('.notion-message').length }; })()`);
  assert.equal(layout.overflow, false); assert.equal(layout.messages, 3);
  const screenshot = await command("Page.captureScreenshot", { format: "png" }, sessionId);
  const output = resolve(process.env.NOVA_NOTION_SCREENSHOT ?? "artifacts/notion-copilot-ui.png");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(screenshot.data, "base64"));
  // Re-open the page: history and settings recover, the backend-only temporary token is not echoed.
  await command("Page.reload", {}, sessionId);
  await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Notion 笔记')`), "reload");
  await click("Notion 笔记");
  await waitFor(() => evaluate(`document.body.textContent.includes('这是从测试笔记整理出的灵感摘要。')`), "history recovery");
  await command("Emulation.setDeviceMetricsOverride", { width: 900, height: 820, deviceScaleFactor: 1, mobile: false }, sessionId);
  assert.equal(await evaluate(`document.querySelector('.notion-copilot').scrollWidth > document.querySelector('.notion-copilot').clientWidth`), false);
  await click("连接设置");
  assert.equal(await evaluate(`document.querySelector('.notion-settings').scrollWidth > document.querySelector('.notion-settings').clientWidth`), false);
  await evaluate(`document.querySelector('.notion-settings-title input[type=checkbox]').click()`);
  await click("保存设置");
  await waitFor(() => evaluate(`!!document.querySelector('.notion-disabled')`), "plugin disabled");
  assert.equal(notion.view().hasToken, false);
  assert.deepEqual(db.prepare("SELECT total_changes() AS changes").get(), before);
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ ok: true, ui: "real Chromium", configure: true, discover: true, send: true, cancel: true, history: true, disable: true, narrowLayout: true, domainWrites: 0, unhandledExceptions: 0, screenshot: output }));
  await command("Browser.close").catch(() => undefined);
} finally {
  socket?.close();
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise(done => setTimeout(done, 3000))]); }
  await notion.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); db.close();
  if (originalPairToken === undefined) delete process.env.NOVA_NOVEL_PAIR_TOKEN; else process.env.NOVA_NOVEL_PAIR_TOKEN = originalPairToken;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-notion-ui-")));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
