import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/save-barrier-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const marker = randomUUID().slice(0, 8);
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 140) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path, method = "GET", input) { const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) }); if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`); return response.json(); }
const projectA = (await call("/api/bootstrap")).activeProject;
const projectB = (await call("/api/projects", "POST", { title: "作品B", premise: "保存屏障测试" })).activeProject;
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
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function activeFromUi() { const projectId = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]').value"); return call(`/api/bootstrap?projectId=${encodeURIComponent(projectId)}`); }
async function switchProject(projectId) { await evaluate(`(()=>{const s=document.querySelector('select[aria-label="切换作品"]');s.value=${JSON.stringify(projectId)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await until(async () => (await activeFromUi()).activeProject.projectId === projectId, `切换到${projectId}`); }
async function appendText(text) {
  await evaluate(`(()=>{const editor=document.querySelector('.manuscript-editor');editor.focus();const last=editor.querySelector('p:last-child');const range=document.createRange();range.selectNodeContents(last);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);editor.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));document.execCommand('insertText',false,'\\n\\n'+${JSON.stringify(text)});})()`);
}

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("写作");
  await appendText(`跨作品尾稿-${marker}`);
  await switchProject(projectB.projectId);
  const aAfterSwitch = await call(`/api/bootstrap?projectId=${projectA.projectId}`);
  assert.ok(aAfterSwitch.scenes[0].body.includes(`跨作品尾稿-${marker}`));
  await switchProject(projectA.projectId);
  await evaluate("document.querySelector('.assistant-tabs button:last-child').click()");
  await setNative('.revision-panel .field-label textarea', `新计划-${marker}`);
  await clickText("保存场景卡");
  await until(async () => (await call(`/api/bootstrap?projectId=${projectA.projectId}`)).scenes[0].goal === `新计划-${marker}`, "保存新计划");
  await appendText(`计划尾稿-${marker}`);
  await clickText("修订");
  await waitBody("修订与版本");
  await clickText("写作");
  const afterPlan = await call(`/api/bootstrap?projectId=${projectA.projectId}`);
  assert.equal(afterPlan.scenes[0].goal, `新计划-${marker}`);
  assert.ok(afterPlan.scenes[0].body.includes(`计划尾稿-${marker}`));
  await appendText(`副本尾稿-${marker}`);
  await evaluate("document.querySelector('button[aria-label=\"管理作品\"]').click()");
  await clickText("复制当前作品");
  const copied = await until(async () => { const state = await activeFromUi(); return state.activeProject.title.endsWith("（副本）") ? state : null; }, "激活副本");
  assert.ok(copied.scenes[0].body.includes(`副本尾稿-${marker}`));
  assert.equal(copied.scenes[0].goal, `新计划-${marker}`);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "save-barrier.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, quickProjectSwitchSaved: true, planPreservedOnLeave: true, duplicateIncludesLatestBody: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
