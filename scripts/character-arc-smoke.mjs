import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/character-arc-${randomUUID()}`);
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
  await clickText("元素");
  await clickText("阿禾");
  await waitBody("人物弧线");
  await setNative('textarea[aria-label="人物抽象欲望"]', "想被父亲认可，而不是只想守住修鞋铺");
  await setNative('textarea[aria-label="人物具体目标"]', "关店前结清最后一笔旧账");
  await setNative('textarea[aria-label="人物核心阻碍"]', "害怕承认父亲也有未完成的事");
  await setNative('textarea[aria-label="人物预期变化"]', "接受有些账不必替父亲继续承担");
  await setNative('textarea[aria-label="人物弧线笔记"]', "暂定，不决定结局");
  await clickText("保存人物弧线");
  const bootstrap = await (await fetch(`${serverUrl}/api/bootstrap`)).json();
  const character = bootstrap.elements.find(entity => entity.type === "character");
  const arc = await (await fetch(`${serverUrl}/api/character-arcs?entityId=${encodeURIComponent(character.entityId)}`)).json();
  assert.equal(arc.arcs[0].goal, "关店前结清最后一笔旧账");
  assert.equal(arc.arcs[0].epiphany, "接受有些账不必替父亲继续承担");
  await waitBody("实际事件对照");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "character-arc.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, arcSaved: true, eventComparisonVisible: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
