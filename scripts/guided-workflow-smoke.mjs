// 交互式工作流：动态问题、节点预览、恢复、不可变发布、显式运行与人工提交。
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
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
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
const shot = async (name) => { const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(`${outDir}/${name}.png`, Buffer.from(data, "base64")); };
const results = {};
const editedPrompt = "按反应、两难与决定生成候选，保留人物动机。";
try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await cdp("Runtime.discardConsoleEntries"); await cdp("Log.clear");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: appUrl });
  await waitFor(`!!document.querySelector('.start-view')`, "创作起步页");
  const baseline = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => ({ runs: state.workflowRuns.length, revisions: state.revisions.length, body: state.scenes[0].body }))`);
  assert.ok(await clickText(".nav-button", "工作流"), "打开工作流");
  assert.ok(await clickText(".toolbar-actions .button.secondary", "交互编排"), "打开交互编排");
  const started = await clickText(".guide-empty button", "开始交互式编排");
  if (!started) assert.ok(await clickText(".guide-empty button", "再编排一个"), "开始第一题");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('怎样帮助当前场景')`, "写作意图选择题");
  assert.ok(await clickText(".guide-options button", "反应与决定"), "选择写作意图");
  assert.ok(await clickText(".guide-answer-actions .button.primary", "保存回答"), "提交写作意图");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('一致性检查')`, "人工审阅选择题");
  assert.ok(await clickText(".guide-options button", "只由我本人审阅"), "选择人工审阅方式");
  assert.ok(await clickText(".guide-answer-actions .button.primary", "保存回答"), "提交审阅方式");
  await waitFor(`document.querySelectorAll('.workflow-proposal-graph .workflow-flow-node').length === 6`, "六节点工作流预览");
  results.previewEdges = await evaluate(`document.querySelectorAll('.workflow-proposal-graph .workflow-flow-edge').length`);
  assert.ok(results.previewEdges >= 6);
  assert.ok(await clickText(".workflow-proposal-graph .workflow-flow-node", "生成候选"), "选择生成节点");
  await waitFor(`!!document.querySelector('.workflow-node-editor-fields textarea')`, "节点参数编辑器");
  await evaluate(`(() => {
    const textarea = document.querySelector('.workflow-node-editor-fields textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(editedPrompt)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.ok(await clickText(".workflow-node-editor button", "保存节点修改"), "保存节点参数");
  await waitFor(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.workflowGuide.proposal.nodes.find((node) => node.id === 'generate').config.prompt === ${JSON.stringify(editedPrompt)})`, "节点参数落库");
  results.nodeEdited = true;
  await shot("guided-workflow-proposal");

  await evaluate(`document.querySelector('.guided-workflow-dialog > header .icon-button').click()`);
  assert.ok(await clickText(".toolbar-actions .button.secondary", "交互编排"), "恢复工作流提案");
  await waitFor(`document.querySelectorAll('.workflow-proposal-graph .workflow-flow-node').length === 6`, "恢复节点预览");
  results.proposalResumed = await evaluate(`document.querySelector('.workflow-node-editor-fields textarea').value === ${JSON.stringify(editedPrompt)}`);
  assert.equal(results.proposalResumed, true);
  assert.ok(await clickText(".guide-answer-actions .button.primary", "发布为不可变版本"), "发布工作流");
  await waitFor(`document.querySelector('.guide-empty')?.textContent.includes('工作流版本已发布')`, "发布完成");
  results.publishedVersionId = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.workflowGuide.publishedVersionId)`);
  results.publishedPrompt = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.workflows.find((workflow) => workflow.workflowVersionId === ${JSON.stringify(results.publishedVersionId)}).nodes.find((node) => node.id === 'generate').config.prompt)`);
  assert.equal(results.publishedPrompt, editedPrompt);
  results.runsAfterPublish = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.workflowRuns.length)`);
  assert.equal(results.runsAfterPublish, baseline.runs, "发布不应自动运行");
  await evaluate(`document.querySelector('.guide-empty .button.primary').click()`);
  await evaluate(`(() => {
    const select = document.querySelector('.workflow-name select');
    const option = [...select.options].find((item) => item.value === ${JSON.stringify(results.publishedVersionId)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`document.querySelector('.workflow-name select')?.value === ${JSON.stringify(results.publishedVersionId)}`, "选择新工作流版本");
  assert.ok(await clickText(".toolbar-actions .button.primary", "运行到审阅"), "显式运行新版本");
  await waitFor(`!!document.querySelector('.run-row .button.primary')`, "等待人工审阅", 30000);
  await clickText(".run-row .button.primary", "打开审阅");
  await waitFor(`!!document.querySelector('.review-dialog')`, "人工审阅框");
  assert.ok(await clickText(".review-dialog footer button", "接受并提交"), "接受并提交候选");
  await waitFor(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.workflowRuns.some((run) => run.workflowVersionId === ${JSON.stringify(results.publishedVersionId)} && run.state === 'succeeded'))`, "本次发布版本运行完成", 30000);
  results.runSucceeded = true;
  results.bodyCommitted = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.scenes[0].body.includes('决定先听来人把话说完') && state.revisions.length > ${JSON.stringify(baseline.revisions)})`);
  assert.equal(results.bodyCommitted, true);
  await shot("guided-workflow-run");
  assert.deepEqual(consoleErrors, [], "浏览器控制台存在错误");
  results.consoleErrors = consoleErrors;
  await writeFile(`${outDir}/guided-workflow-smoke.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally { socket.close(); }
