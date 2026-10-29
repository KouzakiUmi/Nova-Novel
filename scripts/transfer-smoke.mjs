import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/transfer-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 120) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
const fixture = join(root, "import-fixture.md");
await writeFile(fixture, "# 第一章\n\n## 第一场\n\n正文甲\n\n---\n\n## 第二场\n\n正文乙", "utf8");
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
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries"); await send("DOM.enable");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickText("修订");
  await waitBody("导入 Markdown/TXT");
  const imported = await fetch(`${serverUrl}/api/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "import-fixture", premise: "从本地 Markdown/TXT 导入", text: await readFile(fixture, "utf8") }) });
  assert.equal(imported.status, 201);
  await send("Page.reload", { ignoreCache: true });
  await waitBody("第一场");
  const importedJson = await imported.json();
  const projectId = importedJson.project.projectId;
  const bootstrap = await (await fetch(`${serverUrl}/api/bootstrap?projectId=${encodeURIComponent(projectId)}`)).json();
  assert.equal(bootstrap.activeProject.title, "import-fixture");
  assert.equal(bootstrap.scenes.length, 2);
  assert.equal(bootstrap.revisions.length, 1);
  assert.equal(bootstrap.scenes[0].body, "正文甲");
  assert.equal(bootstrap.scenes[1].body, "正文乙");
  await evaluate(`(()=>{const s=document.querySelector('select[aria-label="切换作品"]');s.value=${JSON.stringify(projectId)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitBody("第一场");
  const markdown = await (await fetch(`${serverUrl}/api/export/markdown?projectId=${encodeURIComponent(projectId)}`)).text();
  assert.ok(markdown.includes("## 第一场"));
  assert.ok(markdown.includes("正文乙"));
  const backup = await (await fetch(`${serverUrl}/api/export/backup?projectId=${encodeURIComponent(projectId)}`)).json();
  assert.equal(backup.format, "nova-novel-backup/1");
  assert.equal(backup.scenes.length, 2);
  assert.ok(!JSON.stringify(backup).includes("apiKey"));
  await clickText("修订");
  await clickText("Markdown");
  await clickText("JSON 备份");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "transfer-workspace.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, importedScenes: bootstrap.scenes.length, revisions: bootstrap.revisions.length, markdownExport: true, backupExport: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
