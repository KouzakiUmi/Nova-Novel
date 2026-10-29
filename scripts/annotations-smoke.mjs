import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/annotations-${randomUUID()}`);
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
async function setNative(selector, value) { await evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});const proto=i instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("写作");
  await evaluate("(()=>{const editor=document.querySelector('.manuscript-editor');editor.focus();const node=editor.querySelector('p')?.firstChild;if(!node)throw new Error('no text');const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(12,node.textContent.length));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);editor.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));document.dispatchEvent(new Event('selectionchange',{bubbles:true}));})()");
  await waitBody("批注");
  await until(() => evaluate("Boolean(document.querySelector('.selection-toolbar'))"), "选区工具栏");
  await evaluate("document.querySelector('.selection-toolbar button:last-child').click()");
  await setNative('textarea[aria-label="批注内容"]', "这里为什么突然决定？先保留疑问。");
  await clickText("保存批注");
  await waitBody("这里为什么突然决定？先保留疑问。");
  await clickText("标为解决");
  await evaluate("document.querySelector('select[aria-label=\"筛选批注\"]').value='resolved';document.querySelector('select[aria-label=\"筛选批注\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitBody("重新打开");
  await clickText("重新打开");
  const bootstrap = await (await fetch(`${serverUrl}/api/bootstrap`)).json();
  const scene = bootstrap.scenes[0];
  const save = await fetch(`${serverUrl}/api/scenes/${scene.sceneId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseRevisionId: scene.baseRevisionId, body: `这段原文已经改变。${scene.body.slice(12)}` }) });
  assert.equal(save.status, 200);
  await send("Page.reload", { ignoreCache: true });
  await waitBody("创作起步");
  await clickText("写作");
  await clickText("批注");
  await waitBody("原文已变化，请重新确认这段批注");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "annotation-stale.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, annotationCreated: true, resolvedAndReopened: true, staleAfterBodyChange: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
