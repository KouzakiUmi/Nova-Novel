import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/project-management-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 120) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function bootstrap() { return (await fetch(`${serverUrl}/api/bootstrap`)).json(); }
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
async function activeFromUi() { const projectId = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]').value"); return (await fetch(`${serverUrl}/api/bootstrap?projectId=${encodeURIComponent(projectId)}`)).json(); }
async function waitBody(text) { return until(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), text); }
async function clickText(text) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${text}`); }
async function waitEnabled(text) { return until(() => evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));return Boolean(e&&!e.disabled)})()`), `${text}可用`); }
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await evaluate("document.querySelector('button[aria-label=\"管理作品\"]').click()");
  await waitBody("管理作品");
  await setNative('input[aria-label="作品名称"]', "修鞋铺收据 · 原稿");
  await clickText("保存名称");
  await until(async () => (await bootstrap()).activeProject.title === "修鞋铺收据 · 原稿", "作品重命名");
  await waitEnabled("复制当前作品");
  await clickText("复制当前作品");
  const copied = await until(async () => { const state = await activeFromUi(); return state.activeProject.title.endsWith("（副本）") ? state : null; }, "复制作品");
  assert.equal(copied.revisions.length, 1);
  assert.equal(copied.scenes.length, 1);
  await clickText("归档当前作品");
  const afterArchive = await until(async () => { const state = await activeFromUi(); return state.archivedProjects.length === 1 && state.activeProject.title === "修鞋铺收据 · 原稿" ? state : null; }, "归档作品");
  assert.equal(afterArchive.activeProject.title, "修鞋铺收据 · 原稿");
  await waitBody("恢复作品");
  await clickText("恢复作品");
  const restored = await until(async () => { const state = await activeFromUi(); return state.archivedProjects.length === 0 && state.activeProject.title.endsWith("（副本）") ? state : null; }, "恢复归档作品");
  assert.equal(restored.activeProject.projectId, copied.activeProject.projectId);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "project-manager.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, renamed: true, duplicated: true, archivedAndRestored: true, duplicateInitialRevisions: copied.revisions.length, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
