import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/structure-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
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
async function clickText(text) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${text}`); }
async function clickAria(label) { const clicked = await evaluate(`(()=>{const e=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${label}`); }
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});const proto=i instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("故事");
  await waitBody("故事结构");
  await setNative('input[aria-label="新章节标题"]', "第二章 · 寻找");
  await clickText("新建章节");
  await waitBody("第二章 · 寻找");
  await clickAria("编辑章节 第二章 · 寻找");
  await setNative('input[aria-label="章节标题"]', "第二章 · 寻找旧主人");
  await evaluate("document.querySelector('.outline-chapter-row .text-button').click()");
  await waitBody("第二章 · 寻找旧主人");
  await setNative('input[aria-label="新场景标题"]', "门外的陌生人");
  await evaluate("document.querySelector('select[aria-label=\"新场景所属章节\"]').selectedIndex=1;document.querySelector('select[aria-label=\"新场景所属章节\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await clickText("新建场景");
  await waitBody("门外的陌生人");
  await clickText("故事");
  await clickText("关门前的收据");
  await evaluate("document.querySelector('select[aria-label=\"场景所属章节\"]').selectedIndex=1;document.querySelector('select[aria-label=\"场景所属章节\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await setNative('input[aria-label="场景叙述顺序"]', "2");
  await clickText("保存结构");
  const bootstrap = await (await fetch(`${serverUrl}/api/bootstrap`)).json();
  assert.equal(bootstrap.chapters.length, 2);
  assert.equal(bootstrap.scenes.length, 2);
  assert.equal(bootstrap.chapters[1].title, "第二章 · 寻找旧主人");
  assert.equal(bootstrap.scenes[0].chapterId, bootstrap.chapters[1].chapterId);
  assert.equal(bootstrap.scenes[0].narrationOrder, 2);
  assert.equal(bootstrap.scenes[1].narrationOrder, 1);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "story-structure.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, chapters: bootstrap.chapters.length, scenes: bootstrap.scenes.map(scene => ({ title: scene.title, chapterId: scene.chapterId, narrationOrder: scene.narrationOrder })), consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
