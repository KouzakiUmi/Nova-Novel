import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/provider-catalog-${randomUUID()}`);
await mkdir(root, { recursive: true });
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const fakeBaseUrl = process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:43190/v1";
const reports = [];
const consoleErrors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 120) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find(item => item.type === "page") ?? targets[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let nextId = 1;
const pending = new Map();
const events = [];
ws.addEventListener("message", async event => {
  const message = JSON.parse(event.data);
  if (message.id) { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); } }
  else {
    events.push(message);
    if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded" && message.params?.entry?.level === "error") consoleErrors.push(message);
    if (message.method === "Fetch.requestPaused") {
      await send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify({ reports: [{ providerId: "my-deepseek", label: "DeepSeek", state: "ok", windows: [{ kind: "month", percentUsed: 25 }], balance: { value: 12.5, currency: "CNY" }, coverage: "complete" }] })).toString("base64") });
    }
  }
});
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
async function waitBody(text) { return until(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), text); }
async function clickText(text) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮：${text}`); }
async function clickTitle(title) { const clicked = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(title)});if(e){e.click();return true}return false})()`); assert.ok(clicked, `找不到按钮标题：${title}`); }
async function selectByLabel(label, value) { await evaluate(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes(${JSON.stringify(label)}));const s=l?.querySelector('select');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function selectByAria(label, value) { await evaluate(`(()=>{const s=document.querySelector('select[aria-label=${JSON.stringify(label)}]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function inputByLabel(label, value) { await evaluate(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes(${JSON.stringify(label)}));const i=l?.querySelector('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*api/agent/usage*" }] });
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await clickTitle("管理模型与服务");
  await until(() => evaluate("Boolean(document.querySelector('#builtin-provider-select'))"), "内置 provider 选择器");
  const options = await evaluate("[...document.querySelector('#builtin-provider-select').options].map(o=>({value:o.value,text:o.textContent}))");
  assert.ok(options.some(option => option.value === "deepseek"));
  assert.ok(options.some(option => option.value === "openrouter"));
  assert.ok(options.some(option => option.value === "opendesign-plan" && option.text.includes("插件")));
  assert.ok(options.some(option => option.value === "opencode-go"));
  assert.ok(options.some(option => option.value === "mistral"));
  assert.ok(options.some(option => option.value === "azure"));
  assert.ok(options.some(option => option.value === "amazon-bedrock"));
  assert.ok(options.some(option => option.value === "volcengine-agent-plan"));
  assert.ok(options.some(option => option.value === "volcengine-coding-plan"));
  await selectByLabel("Pi 与插件服务", "volcengine-coding-plan");
  await until(() => evaluate("Boolean(document.querySelector('.provider-editor'))"), "火山方舟编辑器");
  await waitBody("使用 OAuth 登录");
  await until(() => evaluate("Boolean(document.querySelector('input[placeholder=\"VOLC_ACCESSKEY\"]'))"), "IAM Access Key 环境变量字段");
  await until(() => evaluate("Boolean(document.querySelector('input[placeholder=\"VOLC_SECRETKEY\"]'))"), "IAM Secret Key 环境变量字段");
  await evaluate("document.querySelector('.provider-editor header .icon-button').click()");
  await until(() => evaluate("!document.querySelector('.provider-editor')"), "关闭火山方舟编辑器");
  await selectByLabel("Pi 与插件服务", "openai");
  await until(() => evaluate("Boolean(document.querySelector('.provider-editor'))"), "OAuth provider 编辑器");
  await waitBody("使用 OAuth 登录");
  await evaluate("document.querySelector('.provider-editor header .icon-button').click()");
  await until(() => evaluate("!document.querySelector('.provider-editor')"), "关闭 OAuth provider 编辑器");
  await selectByLabel("Pi 与插件服务", "deepseek");
  await until(() => evaluate("Boolean(document.querySelector('.provider-editor'))"), "provider 编辑器");
  await inputByLabel("服务地址", fakeBaseUrl);
  await selectByLabel("密钥来源", "environment");
  await evaluate("(()=>{const i=document.querySelector('#api-key-env');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'FAKE_API_KEY');i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(() => evaluate("document.querySelector('.provider-editor footer .button.primary')?.disabled === false"), "保存按钮可用");
  await evaluate("document.querySelector('.provider-editor footer .button.primary').click()");
  await until(async () => { const settings = await (await fetch(`${serverUrl}/api/agent/settings`)).json(); return settings.providers.some(provider => provider.providerId === "my-deepseek" && provider.keySource === "environment" && provider.apiKeyEnv === "FAKE_API_KEY") && settings.models.some(model => model.provider === "my-deepseek"); }, "环境变量 provider 保存");
  const settings = await (await fetch(`${serverUrl}/api/agent/settings`)).json();
  const model = settings.models.find(item => item.provider === "my-deepseek");
  assert.ok(model);
  await selectByAria("续写场景使用的模型", `${model.provider}\u0000${model.modelId}`);
  await clickText("保存分配");
  await clickText("测试连接");
  await waitBody("连接成功");
  await waitBody("剩余 75%");
  await waitBody("12.50 CNY");
  const modelsJson = await readFile(join(process.env.NOVA_NOVEL_DATA_DIR, "agent/models.json"), "utf8");
  assert.ok(modelsJson.includes("$FAKE_API_KEY"));
  assert.ok(!modelsJson.includes("provider-smoke-secret"));
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "provider-catalog.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  reports.push({ phase: "provider catalog, environment key, routing and usage", options: options.length, provider: model.provider, modelId: model.modelId, usage: "remaining 75%, balance 12.50 CNY", consoleErrors: consoleErrors.length });
  await writeFile(join(root, "report.json"), JSON.stringify({ passed: true, reports, events }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), reports, consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
