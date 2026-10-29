import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/interaction-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const fakeBaseUrl = process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:43190/v1";
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 160) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path, method = "GET", input) { const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) }); if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`); return response.json(); }
await call("/api/agent/providers", "POST", { providerId: "local-interaction", name: "本地回放", api: "openai-completions", baseUrl: fakeBaseUrl, apiKey: "interaction-test-secret", models: [{ id: "writer", maxTokens: 1024 }] });
await call("/api/agent/routes", "PUT", { routes: [{ kind: "scene", provider: "local-interaction", modelId: "writer", thinkingLevel: "low" }] });
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
  await clickText("接着这场写");
  await waitBody("接到正文末尾");
  await clickText("接到正文末尾");
  await clickText("修订");
  await clickText("过程回放");
  await waitBody("出现候选");
  await waitBody("采用候选");
  await waitBody("打开建议");
  await clickText("工作流");
  await clickText("运行到审阅");
  await waitBody("打开审阅");
  await clickText("打开审阅");
  await setNative(".review-note textarea", "保留当前结果，只减少解释性对白");
  await clickText("退回修改");
  await clickText("修订");
  await clickText("过程回放");
  await waitBody("记录审阅决定");
  await waitBody("退回修改");
  const replay = await (await fetch(`${serverUrl}/api/events/export?projectId=${encodeURIComponent((await call("/api/bootstrap")).activeProject.projectId)}`)).json();
  assert.ok(replay.events.some(event => event.kind === "candidate-accept"));
  assert.ok(replay.events.some(event => event.kind === "review-decided"));
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "interaction-replay.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, candidateEvents: true, reviewEvents: true, exportEvents: replay.events.length, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
