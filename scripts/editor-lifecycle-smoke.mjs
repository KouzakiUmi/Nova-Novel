// 双场景回归：需要验收实例已配置模型，且当前作品至少有两个场景。
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const debugPort = Number(process.env.CDP_PORT ?? 9222);
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:43110/";
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
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await delay(150);
  }
  throw new Error(`等待超时：${label}`);
};
const clickText = (selector, text) => evaluate(`(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)}) && !node.disabled);
  if (!element) return false;
  element.click();
  return true;
})()`);

const results = {};
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.navigate", { url: appUrl });
  await waitFor(`document.querySelectorAll('.scene-row').length >= 2 && !!document.querySelector('.quick-actions')`, "双场景写作页");
  const previousTaskIds = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.tasks.map((task) => task.taskId))`);

  assert.ok(await clickText(".quick-actions button", "接着这场写"), "开始第一场生成");
  await waitFor(`!!document.querySelector('.candidate-loading')`, "第一场生成开始");
  await evaluate(`document.querySelectorAll('.scene-row')[1].click()`);
  await waitFor(`document.querySelector('.scene-title-block h1')?.textContent.includes('第二场')`, "切换到第二场");
  results.runningHiddenAfterSwitch = !await evaluate(`!!document.querySelector('.candidate-loading')`);
  assert.equal(results.runningHiddenAfterSwitch, true, "旧场景进度不应显示在新场景");
  await waitFor(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.tasks.some((task) => !${JSON.stringify(previousTaskIds)}.includes(task.taskId) && task.kind === 'scene' && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)))`, "第一场任务归档", 30000);
  results.crossSceneCandidate = await evaluate(`!!document.querySelector('.candidate-panel, .report-panel')`);
  assert.equal(results.crossSceneCandidate, false, "旧场景候选不应显示在新场景");
  results.secondBodyUnchanged = await evaluate(`document.querySelector('.manuscript-editor').innerText === '第二场只有这一段原文。'`);
  assert.equal(results.secondBodyUnchanged, true, "切换场景不应改动正文");

  const marker = `【场景卡同时保存 ${Date.now()}】`;
  const goal = `跨场景回归目标 ${Date.now()}`;
  await evaluate(`(() => {
    const editor = document.querySelector('.manuscript-editor');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  await cdp("Input.insertText", { text: marker });
  assert.ok(await clickText(".assistant-tabs button", "场景卡"), "打开场景卡");
  await evaluate(`(() => {
    const textarea = document.querySelector('.side-panel-content textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(goal)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.ok(await clickText(".side-panel-content button", "保存场景卡"), "保存场景卡");
  await waitFor(`document.querySelector('.side-panel-content button')?.textContent.includes('场景卡已保存')`, "场景卡保存完成");
  const persisted = await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => {
    const scene = state.scenes.find((item) => item.title.includes('第二场'));
    return { bodySaved: scene.body.includes(${JSON.stringify(marker)}), goalSaved: scene.goal === ${JSON.stringify(goal)} };
  })`);
  results.sceneCardSavedLatestBody = persisted.bodySaved;
  results.sceneCardSavedGoal = persisted.goalSaved;
  assert.equal(persisted.bodySaved, true, "场景卡保存不应覆盖编辑器中尚未落库的正文");
  assert.equal(persisted.goalSaved, true, "场景卡目标应保存");
  assert.deepEqual(consoleErrors, [], "浏览器控制台存在错误");
  results.consoleErrors = consoleErrors;
  await writeFile(new URL("../artifacts/editor-lifecycle-smoke.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  socket.close();
}
