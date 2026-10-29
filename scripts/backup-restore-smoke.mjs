import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/backup-restore-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 120) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path, method = "GET", input) { const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) }); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`); return response.json(); }
const original = await call("/api/bootstrap");
const projectId = original.activeProject.projectId;
const scene = original.scenes[0];
const character = original.elements.find(entity => entity.type === "character");
await call("/api/notes", "POST", { projectId, sceneId: scene.sceneId, elementId: character.entityId, title: "备份便签", body: "恢复后仍应保留", tags: ["备份"] });
const rangeText = scene.body.slice(0, 12);
await call("/api/annotations", "POST", { projectId, sceneId: scene.sceneId, kind: "comment", body: "备份批注", range: { from: 0, to: 12, baseText: rangeText, textHash: createHash("sha256").update(rangeText).digest("hex") } });
await call(`/api/character-arcs/${character.entityId}`, "PUT", { motivation: "被父亲认可", goal: "结清旧账", conflict: "害怕面对", epiphany: "学会告别", notes: "备份弧线" });
const backup = await call(`/api/export/backup?projectId=${encodeURIComponent(projectId)}`);
await writeFile(join(root, "original-backup.json"), JSON.stringify(backup, null, 2));
const restored = await call("/api/import/backup", "POST", { backup });
const restoredId = restored.project.projectId;
assert.notEqual(restoredId, projectId);
assert.equal(restored.project.title, `${original.activeProject.title}（恢复）`);
const restoredSnapshot = restored.snapshot;
assert.equal(restoredSnapshot.scenes.length, original.scenes.length);
assert.equal(restoredSnapshot.scenes[0].body, scene.body);
assert.notEqual(restoredSnapshot.scenes[0].sceneId, scene.sceneId);
assert.equal(restoredSnapshot.elements.length, original.elements.length);
assert.ok(restoredSnapshot.elements.every(entity => entity.entityId !== character.entityId));
assert.equal(restoredSnapshot.notes[0].body, "恢复后仍应保留");
assert.equal(restoredSnapshot.annotations[0].body, "备份批注");
assert.equal(restoredSnapshot.characterArcs[0].goal, "结清旧账");
assert.equal(restoredSnapshot.facts.length, original.facts.length);
assert.ok(restoredSnapshot.facts.every(fact => restoredSnapshot.elements.some(entity => entity.entityId === fact.subjectId)));
const restoredEvidenceIds = new Set(restoredSnapshot.evidence.map(evidence => evidence.evidenceId));
for (const reference of [...restoredSnapshot.facts, ...restoredSnapshot.events]) for (const evidenceId of reference.evidenceIds) assert.ok(restoredEvidenceIds.has(evidenceId), `恢复后证据不存在：${evidenceId}`);
assert.ok(!("workflows" in backup));
const originalAfter = await call(`/api/bootstrap?projectId=${encodeURIComponent(projectId)}`);
assert.equal(originalAfter.scenes[0].body, scene.body);
assert.equal(originalAfter.activeProject.title, original.activeProject.title);

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
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await evaluate(`(()=>{const s=document.querySelector('select[aria-label="切换作品"]');s.value=${JSON.stringify(restoredId)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitBody("修鞋铺收据（恢复）");
  await clickText("修订");
  await waitBody("恢复 JSON 备份");
  await waitBody("从备份恢复");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "backup-restored.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, restoredAsNewProject: true, manuscriptPreserved: true, elements: restoredSnapshot.elements.length, facts: restoredSnapshot.facts.length, notes: restoredSnapshot.notes.length, annotations: restoredSnapshot.annotations.length, arcs: restoredSnapshot.characterArcs.length, originalUnchanged: true, evidenceReferencesResolved: true, workflowsExcluded: true, warnings: restored.warnings, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
