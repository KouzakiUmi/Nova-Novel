// 新手完整创作流程：无需模型，覆盖点子起步、方向选择、空白写作、片段创建与作品切换。
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
const setValue = (selector, value) => evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const shot = async (name) => {
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
};

const firstTitle = `我的第一部小说 ${Date.now()}`;
const secondTitle = `已有片段作品 ${Date.now()}`;
const premise = "一座只在午夜开放的车站，售票员发现了一张写给二十年后的车票。";
const pastedBody = "午夜的钟声停下时，站台上的旧时钟倒着走了一格。\n\n售票员把那张车票夹进登记簿，决定先查清落款。";
const results = {};
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: appUrl });
  await waitFor(`!!document.querySelector('.start-view .creation-flow')`, "首次创作起步页");
  results.flowSteps = await evaluate(`document.querySelectorAll('.creation-flow ol > li').length`);
  assert.equal(results.flowSteps, 4);
  results.roleGuideVisible = await evaluate(`document.querySelector('.creation-flow').innerText.includes('你决定') && document.querySelector('.creation-flow').innerText.includes('AI 协助') && document.querySelector('.creation-flow-boundary').innerText.includes('写入正文')`);
  assert.equal(results.roleGuideVisible, true);

  assert.ok(await clickText(".start-projectbar button", "新建自己的作品"), "打开新建作品");
  await waitFor(`!!document.querySelector('.new-project-dialog')`, "新建作品对话框");
  await shot("onboarding-new-project");
  assert.ok(await setValue(".new-project-body > label.field-label input", firstTitle), "填写作品名");
  assert.ok(await setValue(".new-project-body > label.field-label textarea", premise), "填写点子");
  assert.ok(await clickText(".new-project-dialog footer button", "创建并继续找方向"), "创建点子作品");
  await waitFor(`!document.querySelector('.new-project-dialog') && document.querySelector('.start-projectbar')?.textContent.includes(${JSON.stringify(firstTitle)})`, "进入自己的起步页");
  results.ideaProjectCreated = await evaluate(`document.querySelector('#idea-input').value === ${JSON.stringify(premise)}`);
  assert.equal(results.ideaProjectCreated, true);

  assert.ok(await clickText(".start-actions .button.primary", "示例方向"), "生成无需模型的示例方向");
  await waitFor(`document.querySelectorAll('.idea-card').length === 3`, "三张方向卡");
  await shot("onboarding-flow");
  await evaluate(`document.querySelector('.idea-card .select-card').click()`);
  await waitFor(`document.querySelectorAll('.idea-card.selected').length === 1`, "选定一个方向");
  assert.ok(await clickText(".selection-footer .button.primary", "第 4 步"), "进入第一场");
  await waitFor(`!!document.querySelector('.manuscript-editor') && !!document.querySelector('.blank-scene-guide')`, "空白第一场与可选提示");
  await shot("onboarding-blank-scene");
  results.blankGuideQuestions = await evaluate(`document.querySelectorAll('.blank-scene-guide ol > li').length`);
  assert.equal(results.blankGuideQuestions, 3);

  await evaluate(`document.querySelector('.manuscript-editor').focus()`);
  await cdp("Input.insertText", { text: "车站的灯在午夜亮起。" });
  await waitFor(`document.querySelector('.save-indicator')?.textContent.includes('已保存')`, "第一场自动保存");
  results.firstSentenceSaved = await evaluate(`fetch('/api/bootstrap?projectId=' + encodeURIComponent(document.querySelector('.project-switcher select').value)).then((response) => response.json()).then((state) => state.activeProject.title === ${JSON.stringify(firstTitle)} && state.scenes[0].body.includes('车站的灯在午夜亮起。'))`);
  assert.equal(results.firstSentenceSaved, true);

  assert.ok(await clickText(".nav-button", "创作起步"), "返回起步页");
  assert.ok(await clickText(".start-projectbar button", "新建自己的作品"), "打开片段创建入口");
  assert.ok(await clickText(".entry-mode-grid button", "我已有片段"), "选择已有片段");
  assert.ok(await setValue(".new-project-body > label.field-label input", secondTitle), "填写片段作品名");
  assert.ok(await setValue(".new-project-body > label.field-label textarea", pastedBody), "粘贴已有正文");
  assert.ok(await clickText(".new-project-dialog footer button", "保存为第一场"), "创建片段作品");
  await waitFor(`document.querySelector('.manuscript-editor')?.innerText.includes('旧时钟倒着走了一格')`, "片段成为第一场正文");
  results.pastedProject = await evaluate(`fetch('/api/bootstrap?projectId=' + encodeURIComponent(document.querySelector('.project-switcher select').value)).then((response) => response.json()).then((state) => ({ title: state.activeProject.title, body: state.scenes[0].body, revisions: state.revisions.length }))`);
  assert.equal(results.pastedProject.title, secondTitle);
  assert.equal(results.pastedProject.body, pastedBody);
  assert.equal(results.pastedProject.revisions, 1, "作品与粘贴片段应同属初始修订");
  results.pasteSkippedBlankGuide = !await evaluate(`!!document.querySelector('.blank-scene-guide')`);
  assert.equal(results.pasteSkippedBlankGuide, true);

  await evaluate(`(() => {
    const select = document.querySelector('.project-switcher select');
    const option = [...select.options].find((item) => item.textContent === ${JSON.stringify(firstTitle)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`document.querySelector('.breadcrumbs')?.textContent.includes(${JSON.stringify(firstTitle)})`, "切回第一部作品");
  results.projectSwitchPreservedBody = await evaluate(`document.querySelector('.manuscript-editor').innerText.includes('车站的灯在午夜亮起。')`);
  assert.equal(results.projectSwitchPreservedBody, true);
  assert.deepEqual(consoleErrors, [], "浏览器控制台存在错误");
  results.consoleErrors = consoleErrors;
  await writeFile(`${outDir}/onboarding-smoke.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  socket.close();
}
