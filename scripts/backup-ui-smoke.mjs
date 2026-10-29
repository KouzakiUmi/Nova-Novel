import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/backup-ui-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const original = await (await fetch(`${serverUrl}/api/bootstrap`)).json();
const backup = await (await fetch(`${serverUrl}/api/export/backup?projectId=${encodeURIComponent(original.activeProject.projectId)}`)).json();
const backupPath = join(root, "workspace-backup.json");
await writeFile(backupPath, JSON.stringify(backup));
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

try {
  await send("Page.enable"); await send("DOM.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("修订");
  await waitBody("恢复 JSON 备份");
  const document = await send("DOM.getDocument");
  const fileNode = await send("DOM.querySelector", { nodeId: document.root.nodeId, selector: 'input[accept=".json"]' });
  assert.ok(fileNode.nodeId, "找不到 JSON 文件输入");
  await send("DOM.setFileInputFiles", { files: [backupPath], nodeId: fileNode.nodeId });
  await evaluate("document.querySelector('input[accept=\".json\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitBody("已恢复为新作品");
  await waitBody("原作品未覆盖");
  await waitBody("从备份恢复");
  const activeId = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]').value");
  assert.notEqual(activeId, original.activeProject.projectId);
  const active = await (await fetch(`${serverUrl}/api/bootstrap?projectId=${encodeURIComponent(activeId)}`)).json();
  assert.equal(active.activeProject.title, `${original.activeProject.title}（恢复）`);
  assert.equal(active.scenes[0].body, original.scenes[0].body);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "backup-ui-restored.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, fileInputRestore: true, activatedRestoredProject: true, noticeVisible: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
