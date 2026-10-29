import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/notes-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const reports = [];
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 120) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
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
async function waitNoteTitle(text) { return until(() => evaluate(`[...document.querySelectorAll('.note-title-input')].some(i=>i.value===${JSON.stringify(text)})`), text); }
async function clickText(text) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${text}`); }
async function clickAria(label) { const clicked = await evaluate(`(()=>{const e=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${label}`); }
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});const proto=i instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("便签");
  await waitBody("创作便签");
  await setNative('input[aria-label="新便签标题"]', "父亲早已知道收据来历");
  await setNative('textarea[aria-label="新便签内容"]', "但他为什么一直不说？先别急着确定。 #收据 #父亲");
  await clickText("收下便签");
  await waitNoteTitle("父亲早已知道收据来历");
  await setNative('input[aria-label="搜索便签"]', "收据");
  await waitNoteTitle("父亲早已知道收据来历");
  await setNative('input[aria-label="搜索便签"]', "");
  await setNative('input[aria-label="便签标签"]', "父亲, 待定");
  await evaluate("document.querySelector('select[aria-label=\"便签关联场景\"]').selectedIndex=1;document.querySelector('select[aria-label=\"便签关联场景\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await evaluate("document.querySelector('.note-card-actions .button.ghost').click()");
  await wait(300);
  await clickAria("归档便签");
  await evaluate("document.querySelector('select[aria-label=\"筛选便签\"]').value='archived';document.querySelector('select[aria-label=\"筛选便签\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(() => evaluate("[...document.querySelectorAll('.note-card-actions button')].some(b=>b.textContent.includes('恢复'))"), "显示恢复按钮");
  await clickText("恢复");
  await evaluate("document.querySelector('select[aria-label=\"筛选便签\"]').value='active';document.querySelector('select[aria-label=\"筛选便签\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitBody("转为场景");
  await setNative('input[aria-label="新便签标题"]', "把疑问变成下一场");
  await setNative('textarea[aria-label="新便签内容"]', "由作者决定什么时候把想法变成场景。 ");
  await clickText("收下便签");
  await waitNoteTitle("把疑问变成下一场");
  await clickText("转为场景");
  await until(() => evaluate("Boolean(document.querySelector('.manuscript-editor'))"), "打开便签转成的场景");
  const bootstrap = await (await fetch(`${serverUrl}/api/bootstrap`)).json();
  assert.equal(bootstrap.scenes.length, 2);
  assert.equal(bootstrap.notes[0].status, "linked");
  assert.equal(bootstrap.notes[0].sceneId, bootstrap.scenes[1].sceneId);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "notes-workspace.png"), Buffer.from(screenshot.data, "base64"));
  reports.push({ phase: "create, search, link, archive, restore and promote note", scenes: bootstrap.scenes.length, noteStatus: bootstrap.notes[0].status });
  assert.equal(consoleErrors.length, 0);
  await writeFile(join(root, "report.json"), JSON.stringify({ passed: true, reports, consoleErrors, events }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), reports, consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
