import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find((item) => item.type === "page");
assert.ok(target, "找不到Nova Novel页面");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result ?? {});
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "浏览器异常");
  }
  if (message.method === "Log.entryAdded" && message.params.entry?.level === "error") {
    consoleErrors.push(message.params.entry.text);
  }
});

function cdp(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "页面脚本执行失败");
  }
  return response.result?.value;
}

async function screenshot(name) {
  await evaluate("document.fonts.ready");
  await delay(350);
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL(`../artifacts/${name}.png`, import.meta.url), Buffer.from(result.data, "base64"));
}

async function navigate(label, expectedSelector) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.nav-button')].find((item) => item.textContent.includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `找不到导航：${label}`);
  await delay(500);
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(expectedSelector)}))`), true, `${label} 页面未渲染`);
}

const checks = [];
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: "http://127.0.0.1:43110" });
  await delay(1200);
  assert.equal(await evaluate("Boolean(document.querySelector('.start-view .creation-flow'))"), true, "首次入口不是创作起步");
  await evaluate("[...document.querySelectorAll('.nav-button')].find((item) => item.textContent.includes('写作')).click()");
  await delay(500);
  assert.equal(await evaluate("Boolean(document.querySelector('.manuscript-editor'))"), true, "编辑器未出现");
  assert.equal(await evaluate("document.querySelectorAll('.scene-row').length"), 1);
  checks.push("写作台与正文编辑器渲染");
  await screenshot("writing");

  const autosaveMarker = `【离开页面自动保存 ${Date.now()}】`;
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
  await cdp("Input.insertText", { text: autosaveMarker });
  await navigate("故事", ".story-canvas-main .react-flow");
  await delay(1600);
  await navigate("写作", ".manuscript-editor");
  assert.equal(await evaluate(`document.querySelector('.manuscript-editor').innerText.includes(${JSON.stringify(autosaveMarker)})`), true, "离开写作页前的未保存正文丢失");
  assert.equal(await evaluate(`fetch('/api/bootstrap').then((response) => response.json()).then((state) => state.scenes.some((scene) => scene.body.includes(${JSON.stringify(autosaveMarker)})))`), true, "离开写作页前的正文未写入本机数据库");
  checks.push("离开写作页时保存未落盘的正文");

  await navigate("创作起步", ".idea-grid");
  assert.equal(await evaluate("document.querySelectorAll('.idea-card').length"), 3, "点子卡不是三张");
  const versionBefore = await evaluate("document.querySelector('.history-actions span').textContent");
  await evaluate("document.querySelector('.idea-card .select-card').click()");
  await delay(400);
  const versionAfter = await evaluate("document.querySelector('.history-actions span').textContent");
  assert.notEqual(versionBefore, versionAfter, "选卡没有递增选择版本");
  assert.equal(await evaluate("document.querySelectorAll('.idea-card.selected').length"), 1);
  await evaluate("document.querySelector('.history-actions button').click()");
  await delay(400);
  assert.equal(await evaluate("document.querySelectorAll('.idea-card.selected').length"), 0, "撤销没有恢复原选择");
  checks.push("点子卡选择、快照递增与撤销");
  await screenshot("start");

  await navigate("故事", ".story-canvas-main .react-flow");
  assert.equal(await evaluate("document.querySelectorAll('.story-flow-node').length"), 2);
  await evaluate("[...document.querySelectorAll('.segmented-control button')].find((item) => item.textContent.includes('时间轴')).click()");
  await delay(250);
  assert.equal(await evaluate("document.querySelectorAll('.timeline-axis > button').length"), 1);
  await evaluate("[...document.querySelectorAll('.segmented-control button')].find((item) => item.textContent.includes('情节图')).click()");
  checks.push("剧情画布、时间轴与共享场景");
  await screenshot("story");

  await navigate("元素", ".element-detail");
  assert.equal(await evaluate("document.querySelectorAll('.element-list > button').length"), 4);
  await evaluate("[...document.querySelectorAll('.element-list > button')].find((item) => item.textContent.includes('旧收据')).click()");
  await delay(250);
  assert.match(await evaluate("document.querySelector('.element-detail-header h2').textContent"), /旧收据/);
  await evaluate("[...document.querySelectorAll('.detail-tabs button')].find((item) => item.textContent.includes('时间线')).click()");
  await delay(250);
  assert.equal(await evaluate("document.querySelectorAll('.entity-timeline article').length"), 1);
  checks.push("元素详情与状态事件时间线");
  await screenshot("elements");

  await navigate("工作流", ".workflow-page");
  assert.equal(await evaluate("document.querySelectorAll('.workflow-flow-node').length"), 7);
  await evaluate("[...document.querySelectorAll('.segmented-control button')].find((item) => item.textContent.includes('列表模式')).click()");
  await delay(250);
  assert.equal(await evaluate("document.querySelectorAll('.workflow-list-view > button').length"), 7);
  await evaluate("[...document.querySelectorAll('.segmented-control button')].find((item) => item.textContent.includes('画布')).click()");
  checks.push("工作流画布与无拖拽列表等价视图");
  await screenshot("workflow");

  await navigate("修订", ".revisions-page");
  assert.ok(await evaluate("document.querySelectorAll('.version-list > button').length") >= 2);
  checks.push("版本列表与恢复入口");
  await screenshot("revisions");

  assert.deepEqual(consoleErrors, [], "浏览器控制台存在错误");
  checks.push("浏览器控制台无错误");
  await writeFile(new URL("../artifacts/browser-smoke.json", import.meta.url), JSON.stringify({ ok: true, checks, consoleErrors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, consoleErrors }, null, 2));
} catch (error) {
  await writeFile(new URL("../artifacts/browser-smoke.json", import.meta.url), JSON.stringify({ ok: false, checks, consoleErrors, error: String(error) }, null, 2));
  throw error;
} finally {
  socket.close();
}
