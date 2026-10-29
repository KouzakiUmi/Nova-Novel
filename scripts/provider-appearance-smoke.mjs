import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(process.argv[2] ?? `artifacts/provider-appearance-${randomUUID()}`);
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const consoleErrors = [];
const events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, attempts = 140) { for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await wait(100); } throw new Error(`等待超时：${label}`); }
async function call(path) { const response = await fetch(`${serverUrl}${path}`); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); }
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
async function selectOption(selector, value) { await evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); }

try {
  await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await send("Runtime.enable"); await send("Log.enable"); await send("Log.clear"); await send("Runtime.discardConsoleEntries");
  await send("Page.navigate", { url: serverUrl });
  await waitBody("创作起步");
  await evaluate("document.querySelector('.local-status').click()");
  await waitBody("检测到本机环境变量");
  await waitBody("OPENCODE_GO_API_KEY");
  await waitBody("MINIMAX_CN_API_KEY");
  await waitBody("MISTRAL_API_KEY");
  assert.equal(await evaluate("document.body.innerText.includes('smoke-go') || document.body.innerText.includes('smoke-cn') || document.body.innerText.includes('smoke-mistral')"), false);
  await clickText("添加 provider");
  await selectOption(".provider-preset-select select", "opencode");
  await selectOption(".editor-grid label:nth-child(5) select", "environment");
  await until(() => evaluate("document.querySelector('#api-key-env')?.value === 'OPENCODE_API_KEY'"), "Zen 默认变量名");
  await selectOption(".provider-preset-select select", "opencode-go");
  await selectOption(".editor-grid label:nth-child(5) select", "environment");
  await until(() => evaluate("document.querySelector('#api-key-env')?.value === 'OPENCODE_GO_API_KEY'"), "Go 默认变量名");
  await selectOption(".provider-preset-select select", "minimax-cn");
  await selectOption(".editor-grid label:nth-child(5) select", "environment");
  await until(() => evaluate("document.querySelector('#api-key-env')?.value === 'MINIMAX_CN_API_KEY'"), "CN 默认变量名");
  await clickText("取消");
  await evaluate("(()=>{const card=[...document.querySelectorAll('.detected-provider-card')].find(e=>e.textContent.includes('Mistral'));card.querySelector('button').click()})()");
  await waitBody("MISTRAL_API_KEY");
  await until(async () => (await call("/api/agent/settings")).providers.length === 1, "启用 Mistral");
  const enabledUsage = await call("/api/agent/usage");
  assert.deepEqual(enabledUsage.reports.map(report => report.providerId), ["my-mistral"]);
  await waitBody("禁用");
  await clickText("禁用");
  await until(async () => (await call("/api/agent/usage")).reports.length === 0, "禁用后用量消失");
  await waitBody("启用");
  await until(async () => {
    const current = await call("/api/agent/settings");
    if (current.providers[0]?.disabled === false) return true;
    await evaluate("(()=>{const card=[...document.querySelectorAll('.provider-card')].find(e=>e.textContent.includes('my-mistral'));const button=card.querySelector('.provider-actions button');button.focus();button.click()})()");
    await wait(300);
    return false;
  }, "重新启用 Mistral");
  await until(async () => (await call("/api/agent/usage")).reports[0]?.providerId === "my-mistral", "重新启用后用量恢复");
  await waitBody("暂不优先");
  const providerShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "provider-settings.png"), Buffer.from(providerShot.data, "base64"));
  await clickText("界面与字体");
  await selectOption('select[aria-label="正文字体"]', "wenkai");
  await clickText("较大");
  const font = await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font')");
  assert.ok(font.includes("LXGW WenKai"));
  const scale = await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--manuscript-scale')");
  assert.equal(scale, "1.1");
  const appearanceShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(root, "appearance-settings.png"), Buffer.from(appearanceShot.data, "base64"));
  assert.equal(consoleErrors.length, 0);
  const report = { passed: true, detectedWithoutSecrets: true, defaultEnvNames: true, usageFollowsEnabledProvider: true, appearanceApplied: true, consoleErrors: consoleErrors.length };
  await writeFile(join(root, "report.json"), JSON.stringify({ ...report, events }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ error: String(error), consoleErrors, events: events.slice(-30) }, null, 2));
  throw error;
} finally { ws.close(); }
