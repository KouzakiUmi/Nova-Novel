import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/desktop-ux-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const pairToken = process.env.NOVA_NOVEL_PAIR_TOKEN ?? "desktop-test-token";
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 120) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path, method = "GET", input) { const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json", "X-Nova-Novel-Token": pairToken }, body: JSON.stringify(input) } : { headers: { "X-Nova-Novel-Token": pairToken } }) }); if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`); return response.json(); }
const snapshot = await call("/api/bootstrap");
await call("/api/events", "POST", { projectId: snapshot.activeProject.projectId, sceneId: snapshot.scenes[0].sceneId, kind: "suggestion-open" });
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
async function clickAria(label) { const clicked = await evaluate(`(()=>{const e=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(e){e.focus();e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${label}`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: `${serverUrl}#pair=${encodeURIComponent(pairToken)}` });
  await waitBody("创作起步");
  await clickText("修订");
  await waitBody("JSON 备份保存当前快照");
  await clickText("Markdown");
  await clickText("JSON 备份");
  await wait(250);
  assert.equal(await evaluate("Boolean(document.querySelector('.inline-note.error'))"), false);
  await clickText("过程回放");
  await clickText("导出回放");
  await wait(250);
  assert.equal(await evaluate("Boolean(document.querySelector('.inline-note.error'))"), false);
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await clickText("写作");
  await until(() => evaluate("getComputedStyle(document.querySelector('.assistant-sidebar')).display !== 'none'"), "窄窗助手可见");
  await clickAria("收起助手");
  await clickAria("展开助手");
  await clickText("故事");
  await clickText("场景检查器");
  await until(() => evaluate("getComputedStyle(document.querySelector('.canvas-inspector.inspector-open')).display === 'flex' && getComputedStyle(document.querySelector('.canvas-inspector.inspector-open')).flexDirection === 'column'"), "窄窗画布检查器");
  await clickAria("管理作品");
  await until(() => evaluate("document.activeElement?.getAttribute('aria-label') === '作品名称'"), "弹窗初始焦点");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until(() => evaluate("!document.querySelector('.project-manager-dialog')"), "Escape 关闭弹窗");
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "管理作品");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "desktop-ux.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, pairedDownloads: true, narrowSidebars: true, dialogKeyboard: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
