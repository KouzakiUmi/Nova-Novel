// 场景工作流：计划变化落库、反应意图真实进入模型请求、场景复盘不修改正文。
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const debugPort = Number(process.env.CDP_PORT ?? 9222);
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:43110/";
const outDir = process.env.OUT_DIR ?? "artifacts";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = targets.find((item) => item.type === "page");
assert.ok(target, "找不到浏览器页面");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const consoleErrors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result ?? {});
    return;
  }
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? "浏览器异常");
  if (message.method === "Log.entryAdded" && message.params.entry?.level === "error") consoleErrors.push(message.params.entry.text);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await delay(150); }
  throw new Error(`等待超时：${label}`);
};
const clickText = (selector, text) => evaluate(`(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)}) && !node.disabled);
  if (!element) return false;
  element.click();
  return true;
})()`);
const shot = async (name) => {
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
};
const results = {};
try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: appUrl });
  await waitFor(`!!document.querySelector('.start-view')`, "创作起步页");
  assert.ok(await clickText(".nav-button", "写作"), "打开写作");
  await waitFor(`document.querySelectorAll('.writing-intent-picker button').length === 3`, "三种场景写作意图");
  const originalBody = await evaluate(`document.querySelector('.manuscript-editor').innerText`);

  assert.ok(await clickText(".assistant-tabs button", "场景卡"), "打开场景卡");
  await waitFor(`document.querySelectorAll('.side-panel-content textarea').length === 3`, "目标、阻碍与预期结果字段");
  results.causalityVisible = await evaluate(`document.querySelector('.scene-causality')?.innerText.includes('结果 / 变化')`);
  assert.equal(results.causalityVisible, true);
  const expectedSummary = `场景复盘验收 ${Date.now()}：阿禾决定先听完来人的解释，关店计划不变。`;
  await evaluate(`(() => {
    const textarea = document.querySelectorAll('.side-panel-content textarea')[2];
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(expectedSummary)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.ok(await clickText(".side-panel-content button", "保存场景卡"), "保存预期变化");
  await waitFor(`document.querySelector('.side-panel-content button')?.textContent.includes('场景卡已保存')`, "场景卡保存完成");
  results.summaryPersisted = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.scenes[0].summary === ${JSON.stringify(expectedSummary)})`);
  assert.equal(results.summaryPersisted, true);
  await shot("scene-workflow-card");

  assert.ok(await clickText(".assistant-tabs button", "助手"), "返回写作助手");
  assert.ok(await clickText(".writing-intent-picker button", "反应与决定"), "选择反应与决定");
  assert.ok(await clickText(".quick-actions button", "接着这场写"), "生成反应场候选");
  await waitFor(`document.querySelector('.candidate-panel')?.innerText.includes('决定先听来人把话说完')`, "模型收到反应场意图并返回对应候选", 30000);
  results.reactionIntentReachedModel = true;
  results.candidateKeptOutOfBody = await evaluate(`document.querySelector('.manuscript-editor').innerText === ${JSON.stringify(originalBody)}`);
  assert.equal(results.candidateKeptOutOfBody, true);
  await shot("scene-workflow-reaction");

  assert.ok(await clickText(".quick-actions button", "复盘这场"), "生成场景复盘");
  await waitFor(`document.querySelector('.report-panel .candidate-heading')?.textContent.includes('场景复盘')`, "场景复盘报告", 30000);
  results.reviewHasNoAccept = !await evaluate(`!!document.querySelector('.report-panel .button.primary')`);
  assert.equal(results.reviewHasNoAccept, true);
  results.reviewKeptBody = await evaluate(`document.querySelector('.manuscript-editor').innerText === ${JSON.stringify(originalBody)}`);
  assert.equal(results.reviewKeptBody, true);
  await shot("scene-workflow-review");
  assert.deepEqual(consoleErrors, [], "浏览器控制台存在错误");
  results.consoleErrors = consoleErrors;
  await writeFile(`${outDir}/scene-workflow-smoke.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally { socket.close(); }
