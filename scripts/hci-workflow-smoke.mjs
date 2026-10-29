import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const Database = require("better-sqlite3");
const root = resolve(process.argv[2] ?? `artifacts/hci-workflow-${randomUUID()}`);
await mkdir(root, { recursive: true });
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const dataDir = process.env.NOVA_NOVEL_DATA_DIR;
const fakeBaseUrl = process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:43190/v1";
assert.ok(dataDir);
const reports = [];
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 180) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path, method = "GET", input) { const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) }); if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`); return response.json(); }
await call("/api/agent/providers", "POST", { providerId: "local-hci", name: "本地验收", api: "openai-completions", baseUrl: fakeBaseUrl, apiKey: "hci-test-secret", models: [{ id: "writer", maxTokens: 1024 }] });
await call("/api/agent/routes", "PUT", { routes: [{ kind: "scene", provider: "local-hci", modelId: "writer", thinkingLevel: "low" }] });
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find(item => item.type === "page") ?? targets[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id) { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); } }
  else { events.push(message); if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded" && message.params?.entry?.level === "error") consoleErrors.push(message); }
});
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
async function waitBody(text) { return until(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), text); }
async function clickText(text) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${text}`); }
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});const proto=i instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("写作");
  await waitBody("先复盘，再继续");
  await clickText("接着这场写");
  await waitBody("接到正文末尾");
  await clickText("接到正文末尾");
  await waitBody("看看实际写出了什么");
  reports.push({ phase: "next action after accepted candidate", passed: true });

  await clickText("创作起步");
  await clickText("AI 逐步带我列大纲");
  await clickText("开始交互式大纲");
  for (let step = 0; step < 3; step++) {
    await until(() => evaluate("Boolean(document.querySelector('.guide-options button'))"), `第 ${step + 1} 个问题`);
    await evaluate("document.querySelector('.guide-options button').click()");
    await clickText("保存回答，继续");
    await wait(250);
  }
  await waitBody("将新增 3 个场景");
  await evaluate("document.querySelector('input[aria-label=\"采用第 3 场\"]').click()");
  await waitBody("将新增 2 个场景");
  await clickText("采用 2 个场景");
  await waitBody("2 个场景已经加入作品");
  const bootstrap = await call("/api/bootstrap");
  assert.equal(bootstrap.scenes.length, 3);
  reports.push({ phase: "apply two of three outline scenes", scenes: bootstrap.scenes.length });
  await clickText("查看作品");

  const revisionsBefore = (await call("/api/bootstrap")).revisions.length;
  await clickText("工作流");
  await clickText("运行到审阅");
  await waitBody("打开审阅");
  await clickText("打开审阅");
  await waitBody("退回修改说明");
  await setNative(".review-note textarea", "保留当前结果，只减少解释性对白，不改变人物决定。");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "workflow-review-note.png"), Buffer.from(screenshot.data, "base64"));
  await clickText("退回修改");
  await until(() => evaluate("!document.querySelector('.review-dialog')"), "提交退回决定");
  const db = new Database(join(dataDir, "nova-novel.sqlite"), { readonly: true });
  const decision = db.prepare("SELECT decision_json FROM todos WHERE decision_json LIKE '%减少解释性对白%' ORDER BY updated_at DESC LIMIT 1").get();
  const revisionsAfter = (await call("/api/bootstrap")).revisions.length;
  db.close();
  assert.ok(decision);
  assert.equal(JSON.parse(decision.decision_json).reviewNote, "保留当前结果，只减少解释性对白，不改变人物决定。");
  assert.equal(revisionsAfter, revisionsBefore);
  reports.push({ phase: "review note without committing manuscript", reviewNotePersisted: true, revisionUnchanged: true });
  assert.equal(consoleErrors.length, 0);
  await writeFile(join(root, "report.json"), JSON.stringify({ passed: true, reports, consoleErrors, events }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), reports, consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
