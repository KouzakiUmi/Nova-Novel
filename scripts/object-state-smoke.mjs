import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/object-state-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 140) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path, method = "GET", input) { const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) }); if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`); return response.json(); }
const initial = await call("/api/bootstrap");
const marker = randomUUID().slice(0, 8);
const originalBody = initial.scenes[0].body;
await call(`/api/projects/${initial.activeProject.projectId}/revisions`, "POST", { name: "初稿" });
const beforeSave = await call("/api/bootstrap");
await call(`/api/scenes/${initial.scenes[0].sceneId}`, "PATCH", { baseRevisionId: beforeSave.branches[0].headRevisionId, body: `现稿-${marker}，完全不同于命名时正文。` });
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
async function clickElement(name) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('.element-list button')].find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(name)});if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到人物：${name}`); }
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});const proto=i instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function activeFromUi() { const projectId = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]').value"); return call(`/api/bootstrap?projectId=${encodeURIComponent(projectId)}`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("元素");
  await clickElement("阿禾");
  await setNative('textarea[aria-label="人物具体目标"]', `阿禾目标-${marker}`);
  await clickText("保存人物弧线");
  await until(async () => (await call("/api/bootstrap")).characterArcs.find(arc => arc.goal === `阿禾目标-${marker}`), "保存阿禾弧线");
  await clickElement("父亲");
  await until(() => evaluate(`document.querySelector('textarea[aria-label="人物具体目标"]')?.value !== ${JSON.stringify(`阿禾目标-${marker}`)}`), "父亲弧线表单隔离");
  await setNative('textarea[aria-label="人物具体目标"]', `父亲目标-${marker}`);
  await clickText("保存人物弧线");
  await clickElement("阿禾");
  await until(() => evaluate(`document.querySelector('textarea[aria-label="人物具体目标"]')?.value === ${JSON.stringify(`阿禾目标-${marker}`)}`), "阿禾弧线恢复");
  await clickText("修订");
  await clickText("初稿");
  await until(() => evaluate(`document.querySelector('.text-change-row')?.textContent.includes(${JSON.stringify(originalBody.slice(0, 12))})`), "命名时正文预览");
  assert.equal(await evaluate(`document.querySelector('.text-change-row')?.textContent.includes(${JSON.stringify(marker)})`), false);
  const createdB = await call("/api/projects", "POST", { title: "作品B", premise: "切换测试" });
  await send("Page.reload", { ignoreCache: true });
  await waitBody("创作起步");
  await clickText("故事");
  await until(() => evaluate(`[...document.querySelector('select[aria-label="切换作品"]').options].some(option => option.value === ${JSON.stringify(createdB.activeProject.projectId)})`), "作品B出现在切换器");
  await evaluate(`(()=>{const s=document.querySelector('select[aria-label="切换作品"]');s.value=${JSON.stringify(createdB.activeProject.projectId)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(async () => (await activeFromUi()).activeProject.projectId === createdB.activeProject.projectId, "切换作品B");
  await setNative('input[aria-label="新场景标题"]', "B的新场景");
  await clickText("新建场景");
  await waitBody("B的新场景");
  const b = await call(`/api/bootstrap?projectId=${createdB.activeProject.projectId}`);
  assert.equal(b.scenes.length, 2);
  assert.equal(b.scenes[1].title, "B的新场景");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "object-state.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, characterArcIsolation: true, historicalPreview: true, storyProjectSwitch: true, originalBodyPreserved: Boolean(originalBody), consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
