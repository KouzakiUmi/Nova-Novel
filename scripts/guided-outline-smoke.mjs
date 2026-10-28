// 交互式大纲端到端：动态选择题、custom、返回、跳过、恢复、提案预览与采用。
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
const editedSceneTitle = `作者改写的场景 ${Date.now()}`;
try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await cdp("Runtime.discardConsoleEntries"); await cdp("Log.clear");
  await cdp("Runtime.discardConsoleEntries"); await cdp("Log.clear");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: appUrl });
  await waitFor(`!!document.querySelector('.start-view')`, "创作起步页");
  const initialSceneCount = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.scenes.length)`);
  assert.ok(await clickText(".start-actions .text-button", "AI 逐步带我列大纲"), "打开交互式大纲");
  const started = await clickText(".guide-empty button", "开始交互式大纲");
  if (!started) assert.ok(await clickText(".guide-empty button", "再生成一组"), "开始第一题");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('主角此刻最想完成什么')`, "第一道动态选择题");
  results.firstOptions = await evaluate(`document.querySelectorAll('.guide-options button').length`);
  assert.equal(results.firstOptions, 2);

  await evaluate(`(() => {
    const textarea = document.querySelector('.guide-question textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '我想让主角先完成关店，再处理旧收据。');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.ok(await clickText(".guide-answer-actions .button.primary", "保存回答"), "提交自定义回答");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('什么让这件事不容易')`, "第二道选择题");
  assert.ok(await clickText(".guide-options button", "来人不肯说出名字"), "选择第二题选项");
  assert.ok(await clickText(".guide-answer-actions .button.primary", "保存回答"), "提交第二题");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('什么发生了变化')`, "第三道选择题");
  assert.ok(await clickText(".guide-answer-actions .button.ghost", "上一步"), "返回第二题");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('什么让这件事不容易')`, "恢复第二题");
  results.customAnswerPreserved = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.guide.answers.some((answer) => answer.value.includes('先完成关店')))`);
  assert.equal(results.customAnswerPreserved, true);
  assert.ok(await clickText(".guide-options button", "父亲回避这段往事"), "修改第二题回答");
  assert.ok(await clickText(".guide-answer-actions .button.primary", "保存回答"), "重新提交第二题");
  await waitFor(`document.querySelector('.guide-question-heading h3')?.textContent.includes('什么发生了变化')`, "恢复第三题");
  assert.ok(await clickText(".guide-answer-actions .button.ghost", "暂时跳过"), "跳过第三题");
  await waitFor(`document.querySelectorAll('.guide-proposal-scenes article').length === 3`, "三场景提案");
  await evaluate(`(() => {
    const input = document.querySelectorAll('.guide-proposal-scenes .proposal-scene-title')[1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(editedSceneTitle)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.ok(await clickText(".guide-answer-actions .button.secondary", "保存提案修改"), "保存逐场编辑");
  await waitFor(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.guide.proposal[1].title === ${JSON.stringify(editedSceneTitle)})`, "逐场编辑落库");
  results.proposalEdited = true;
  await shot("guided-outline-proposal");

  await evaluate(`document.querySelector('.guided-outline-dialog > header .icon-button').click()`);
  assert.ok(await clickText(".nav-button", "故事"), "打开故事画布");
  assert.ok(await clickText(".toolbar-actions .button.secondary", "交互式大纲"), "恢复交互式大纲");
  await waitFor(`document.querySelectorAll('.guide-proposal-scenes article').length === 3`, "关闭后恢复提案");
  results.proposalResumed = await evaluate(`document.querySelectorAll('.guide-proposal-scenes .proposal-scene-title')[1].value === ${JSON.stringify(editedSceneTitle)}`);
  assert.equal(results.proposalResumed, true);
  assert.ok(await clickText(".guide-answer-actions .button.primary", "采用为三场景"), "采用大纲");
  await waitFor(`document.querySelector('.guide-empty')?.textContent.includes('三场景已经加入作品')`, "采用完成");
  await evaluate(`document.querySelector('.guide-empty .button.primary').click()`);
  await waitFor(`!document.querySelector('.guided-outline-dialog')`, "关闭对话框查看作品");
  results.scenesAfterApply = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.scenes.length)`);
  assert.equal(results.scenesAfterApply, initialSceneCount + 3);
  results.newScenesVisible = await evaluate(`document.body.innerText.includes('把旧收据问清楚') && document.body.innerText.includes(${JSON.stringify(editedSceneTitle)}) && document.body.innerText.includes('最后一次取鞋')`);
  assert.equal(results.newScenesVisible, true);
  await shot("guided-outline-applied");
  assert.deepEqual(consoleErrors, [], "浏览器控制台存在错误");
  results.consoleErrors = consoleErrors;
  await writeFile(`${outDir}/guided-outline-smoke.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally { socket.close(); }
