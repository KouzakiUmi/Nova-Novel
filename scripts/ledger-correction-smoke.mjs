// 知识账本纠错与逐项提取审阅的真实浏览器回归；使用本机假模型，不调用外部服务。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const fakeBaseUrl = process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:43190/v1";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const root = resolve(`artifacts/ledger-correction-${randomUUID().slice(0, 8)}`);
await mkdir(root, { recursive: true });
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const until = async (fn, label, attempts = 200) => {
  for (let i = 0; i < attempts; i += 1) { const value = await fn(); if (value) return value; await wait(100); }
  throw new Error(`等待超时：${label}`);
};
const call = async (path, method = "GET", input) => {
  const response = await fetch(`${serverUrl}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
};
const providerPayload = { name: "本地账本审阅", api: "openai-completions", baseUrl: fakeBaseUrl, apiKey: "local-only", models: [{ id: "writer", contextWindow: 32768, maxTokens: 4096 }] };
const existingProvider = (await call("/api/agent/settings")).providers.some(provider => provider.providerId === "local-ledger-review");
await call(existingProvider ? "/api/agent/providers/local-ledger-review" : "/api/agent/providers", existingProvider ? "PATCH" : "POST", existingProvider ? providerPayload : { providerId: "local-ledger-review", ...providerPayload });

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find(item => item.type === "page" && item.url.startsWith(serverUrl)) ?? targets.find(item => item.type === "page");
assert.ok(target, "找不到浏览器页面");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => { ws.addEventListener("open", resolveOpen, { once: true }); ws.addEventListener("error", rejectOpen, { once: true }); });
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", event => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result ?? {});
  } else if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? "页面异常");
  else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") consoleErrors.push(message.params.entry.text);
});
const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => { const id = nextId++; pending.set(id, { resolve: resolveSend, reject: rejectSend }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result?.value;
};
const clickText = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.includes(${JSON.stringify(text)}) && !node.disabled); if (!el) return false; el.click(); return true; })()`);
const setInput = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const navigate = async (label, selector) => {
  assert.equal(await clickText(".nav-button", label), true, `找不到导航：${label}`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `${label} 页面渲染`);
};
const screenshot = async name => { const shot = await send("Page.captureScreenshot", { format: "png" }); await writeFile(join(root, `${name}.png`), Buffer.from(shot.data, "base64")); };
const checks = [];

try {
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: serverUrl });
  await until(() => evaluate("Boolean(document.querySelector('.app-shell'))"), "应用挂载");

  const project = (await call("/api/bootstrap")).activeProject;
  const created = await call("/api/elements", "POST", { projectId: project.projectId, type: "item", name: "验收铁盒", summary: "用于纠错回归" });
  const entityId = created.entity.entityId;
  const added = await call(`/api/elements/${entityId}/facts`, "POST", { projectId: project.projectId, predicate: "location", value: "柜台下", validFromOrder: 1 });
  const factId = added.fact.factId;
  await send("Page.navigate", { url: serverUrl });
  await wait(1000);
  await navigate("元素", ".elements-page");
  await setInput(".element-search input", "验收铁盒");
  await clickText(".element-list button", "验收铁盒");
  await until(() => evaluate("document.querySelector('.element-detail h2')?.textContent === '验收铁盒'"), "选中验收铁盒");
  const factCard = `.fact-card .text-button`;
  assert.equal(await clickText(factCard, "修改"), true, "打开事实修改");
  await setInput('input[aria-label="事实文字值"]', "柜台左抽屉");
  assert.equal(await clickText(".scene-structure-editor .button.primary", "保存事实修改"), true);
  await until(async () => (await call("/api/bootstrap")).facts.find(fact => fact.factId === factId)?.value === "柜台左抽屉", "事实修改落库");
  await until(() => evaluate(`[...document.querySelectorAll('.fact-card button')].some(button => button.textContent.includes('作废') && !button.disabled)`), "保存刷新结束且作废按钮可用");
  assert.equal(await clickText(factCard, "作废"), true);
  await until(async () => (await call("/api/bootstrap")).facts.find(fact => fact.factId === factId)?.reviewState === "rejected", "事实作废");
  await until(() => evaluate(`[...document.querySelectorAll('.fact-card button')].some(button => button.textContent.includes('恢复') && !button.disabled)`), "作废刷新结束且恢复按钮可用");
  assert.equal(await clickText(factCard, "恢复"), true);
  await until(async () => (await call("/api/bootstrap")).facts.find(fact => fact.factId === factId)?.reviewState === "confirmed", "事实恢复");
  checks.push("事实修改、作废与恢复");
  await screenshot("ledger-fact-correction");

  await navigate("资料", ".context-page");
  await until(() => evaluate("document.querySelector('.index-health')?.textContent.includes('已就绪')"), "索引状态就绪");
  assert.equal(await clickText(".index-health .button", "从正文重建"), true);
  await wait(500);
  await until(() => evaluate("document.querySelector('.index-health')?.textContent.includes('已就绪') && !document.querySelector('.index-health .button')?.disabled"), "索引重建完成");
  checks.push("真实索引状态与界面重建");

  await navigate("写作", ".manuscript-editor");
  assert.equal(await clickText(".quick-actions button", "从本场提取设定与状态"), true, "发起提取");
  await until(() => evaluate("Boolean(document.querySelector('.extraction-review'))"), "提取审阅显示");
  const count = await evaluate("document.querySelectorAll('.extraction-proposal').length");
  assert.equal(count, 4, "应显示两个元素、一个事实和一个事件");
  await setInput('input[aria-label="新元素名称 ne-1"]', "审阅铁盒");
  await setInput('input[aria-label="事实值 fp-1"]', "已付，待取，已核对");
  assert.equal(await clickText(".extraction-select", "采用事件"), true, "取消选择事件");
  await screenshot("ledger-extraction-review");
  assert.equal(await clickText(".extraction-review .button.primary", "确认入库"), true);
  await until(() => evaluate("!document.querySelector('.extraction-review')"), "选中提案入库");
  const state = await call("/api/bootstrap");
  assert.ok(state.elements.some(entity => entity.name === "审阅铁盒"));
  assert.ok(state.facts.some(fact => fact.predicate === "status" && fact.value === "已付，待取，已核对"));
  assert.equal(state.events.filter(event => event.kind === "item.check").length, 0, "未选事件不得入库");
  checks.push("逐项选择、编辑与未选项隔离");
  assert.deepEqual(consoleErrors, [], `控制台错误：${consoleErrors.join(" | ")}`);
  const report = { ok: true, checks, consoleErrors };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifacts: root }, null, 2));
} catch (error) {
  await writeFile(join(root, "report.json"), JSON.stringify({ ok: false, checks, consoleErrors, error: String(error?.message ?? error) }, null, 2));
  throw error;
} finally {
  ws.close();
}
