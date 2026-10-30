import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const appUrl = process.env.APP_URL ?? "http://127.0.0.1:43110/";
const serverUrl = process.env.SERVER_URL ?? appUrl.replace(/\/$/, "");
const fakeUrl = process.env.FAKE_OPENAI_URL ?? "http://127.0.0.1:43190/v1";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const outDir = process.env.OUT_DIR ?? "artifacts/foundation-smoke";
await mkdir(outDir, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(path, method = "GET", input) {
  const response = await fetch(`${serverUrl}${path}`, { method, ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const providerPayload = {
  name: "Foundation Fake",
  api: "openai-completions",
  baseUrl: fakeUrl,
  keySource: "manual",
  apiKey: "foundation-fake-key",
  models: [{ id: "nova-writer" }, { id: "nova-checker" }],
};
const settings = await call("/api/agent/settings");
const providerExists = settings.providers.some(item => item.providerId === "foundation-fake");
await call(providerExists ? "/api/agent/providers/foundation-fake" : "/api/agent/providers", providerExists ? "PATCH" : "POST", providerExists ? providerPayload : { providerId: "foundation-fake", ...providerPayload });
await call("/api/appearance", "PUT", { uiFont: "builtin", manuscriptFont: "builtin", uiScale: 100, manuscriptScale: 100 });

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find(item => item.type === "page");
assert.ok(target, "找不到浏览器页面");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result ?? {});
    return;
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "浏览器异常");
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? expression);
  return result.result?.value;
}
async function until(expression, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await wait(150); }
  throw new Error(`等待超时：${label}`);
}
const clickText = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.includes(${JSON.stringify(text)}) && !node.disabled && node.getClientRects().length); if (!el) return false; el.click(); return true; })()`);
const nav = label => clickText(".nav-button, .local-status", label);
const setValue = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const viewport = (width, height = 1000) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const shot = async name => { const result = await cdp("Page.captureScreenshot", { format: "png" }); await writeFile(`${outDir}/${name}.png`, Buffer.from(result.data, "base64")); };
const results = {};

try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await viewport(1426, 953);
  await cdp("Page.navigate", { url: appUrl });
  await until(`!!document.querySelector('.app-shell')`, "应用加载");
  assert.ok(await nav("写作"), "打开写作页");
  await until(`document.querySelectorAll('.writing-model-picker select').length === 2`, "写作模型选择器");
  const modelValue = await evaluate(`(() => { const select = document.querySelector('select[aria-label="续写场景实际执行模型"]'); const value = ${JSON.stringify("foundation-fake\u0000nova-writer")}; if (![...select.options].some(option => option.value === value)) return ''; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); return value; })()`);
  assert.ok(modelValue, "选择假模型");
  await until(`fetch('/api/agent/settings').then(r => r.json()).then(s => s.routes.find(r => r.kind === 'scene')?.modelId === 'nova-writer' && s.routes.find(r => r.kind === 'scene')?.provider === 'foundation-fake')`, "模型分配落库");
  results.modelPickerPersisted = true;

  const marker = `【立即生成保存屏障 ${Date.now()}】`;
  await evaluate(`(() => { window.__foundationFetch = window.fetch; window.__saveBarrier = false; window.fetch = (input, init) => { const url = typeof input === 'string' ? input : input.url; const method = init?.method ?? input.method ?? 'GET'; if (method === 'POST' && url.includes('/api/generate')) return window.__foundationFetch('/api/bootstrap').then(r => r.json()).then(state => { window.__saveBarrier = state.scenes.some(scene => scene.body.includes(${JSON.stringify(marker)})); return window.__foundationFetch(input, init); }); return window.__foundationFetch(input, init); }; return true; })()`);
  await evaluate(`(() => { const editor = document.querySelector('.manuscript-editor'); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; })()`);
  await cdp("Input.insertText", { text: marker });
  assert.ok(await clickText(".quick-actions button", "接着这场写"), "立即点击续写");
  await until(`!!document.querySelector('.candidate-panel')`, "续写候选", 30000);
  results.generateAfterUnsavedEdit = await evaluate("window.__saveBarrier");
  assert.equal(results.generateAfterUnsavedEdit, true, "生成前必须保存当前编辑器正文");
  await evaluate("window.fetch = window.__foundationFetch");
  await clickText(".candidate-heading button", "");

  const goal = `恢复目标 ${Date.now()}`;
  const pov = `恢复视角 ${Date.now()}`;
  const storyTime = `恢复时间 ${Date.now()}`;
  assert.ok(await clickText(".assistant-tabs button", "场景卡"), "打开场景卡");
  await setValue(".side-panel-content textarea", goal);
  await setValue('input[aria-label="场景卡视角人物"]', pov);
  await setValue('input[aria-label="场景卡故事时间"]', storyTime);
  await evaluate(`(() => { window.__foundationFetch = window.fetch; window.fetch = (input, init) => { const url = typeof input === 'string' ? input : input.url; const method = init?.method ?? input.method ?? 'GET'; return method === 'PATCH' && url.includes('/api/scenes/') ? Promise.reject(new TypeError('Failed to fetch')) : window.__foundationFetch(input, init); }; return true; })()`);
  assert.ok(await clickText(".side-panel-content button", "保存场景卡"), "触发场景卡保存失败");
  await until(`!!document.querySelector('.offline-banner .inline-note.error')`, "场景卡失败草稿");
  results.errorToast = await evaluate(`document.querySelector('.toast.error[role="alert"]') !== null`);
  assert.equal(results.errorToast, true, "保存失败必须显示错误 Toast");
  await evaluate("window.fetch = window.__foundationFetch");
  await clickText(".offline-banner button", "读取最新版本");
  await until(`[...document.querySelectorAll('.offline-banner button')].some(b => b.textContent.includes('确认保存本地草稿'))`, "两步恢复确认");
  await clickText(".offline-banner button", "确认保存本地草稿");
  await until(`!document.querySelector('.offline-banner .inline-note.error')`, "场景卡恢复完成");
  const recovered = await call("/api/bootstrap");
  assert.equal(recovered.scenes[0].goal, goal);
  assert.equal(recovered.scenes[0].pov, pov);
  assert.equal(recovered.scenes[0].storyTime, storyTime);
  results.sceneCardRetryPreserved = true;

  await evaluate(`(() => { window.__foundationFetch = window.fetch; window.fetch = (input, init) => { const url = typeof input === 'string' ? input : input.url; return url.includes('/api/assist/plot-ideate') ? Promise.reject(new TypeError('Failed to fetch')) : window.__foundationFetch(input, init); }; return true; })()`);
  await clickText(".side-panel-content button", "AI 帮我想目标");
  await until(`!!document.querySelector('.side-panel-content .inline-note.error')`, "场景脑暴失败提示");
  await evaluate("window.fetch = window.__foundationFetch");
  results.brainstormErrorVisible = true;
  await clickText(".assistant-tabs button", "助手");
  await evaluate(`[...document.querySelectorAll('.toast button')].forEach(button => button.click())`);
  await shot("writing-model-picker");

  await viewport(1426, 953);
  assert.ok(await nav("故事"), "打开故事画布");
  await until(`!!document.querySelector('.canvas-inspector.inspector-open')`, "宽屏检查器默认打开");
  await clickText(".toolbar-actions button", "收起检查器");
  await until(`getComputedStyle(document.querySelector('.canvas-inspector')).display === 'none'`, "宽屏检查器收起");
  results.storyInspectorToggle = true;
  await clickText(".toolbar-actions button", "场景检查器");
  await until(`getComputedStyle(document.querySelector('.canvas-inspector')).display !== 'none'`, "宽屏检查器重开");
  await shot("story-typography");

  assert.ok(await nav("工作流"), "打开工作流");
  await until(`!!document.querySelector('.workflow-workspace')`, "工作流画布");
  await clickText(".toolbar-actions button", "收起节点详情");
  await until(`getComputedStyle(document.querySelector('.node-inspector')).display === 'none'`, "宽屏节点详情收起");
  results.workflowInspectorToggle = true;

  await clickText(".search-trigger", "");
  const searchInput = '.command-input input';
  await setValue(searchInput, "阿禾");
  await until(`[...document.querySelectorAll('.command-result')].some(el => el.textContent.includes('元素') && el.textContent.includes('阿禾'))`, "元素搜索结果");
  await evaluate(`document.querySelector(${JSON.stringify(searchInput)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await until(`!!document.querySelector('.elements-workspace')`, "回车打开元素");
  results.commandElementSearch = true;
  await shot("elements-typography");
  results.elementFormContained = await evaluate(`[...document.querySelectorAll('.elements-page input, .elements-page select')].filter(el => el.getClientRects().length).every(el => { const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1; })`);
  assert.equal(results.elementFormContained, true, "元素页输入框与下拉框不得被挤出视口");
  await nav("便签");
  await until(`!!document.querySelector('.notes-page')`, "便签页");
  await shot("notes-typography");
  results.controlFontUnified = await evaluate(`(() => { const first = window.getComputedStyle(document.querySelector('.note-composer > input')).fontFamily.split(',')[0].replace(/[\\"']/g, '').trim(); const ui = window.getComputedStyle(document.documentElement).getPropertyValue('--ui-font').split(',')[0].replace(/[\\"']/g, '').trim(); return first === ui; })()`);
  assert.equal(results.controlFontUnified, true, "可编辑输入框应使用界面字体而不是阅读字体");

  assert.ok(await nav("模型与服务"), "打开外观设置");
  await until(`!!document.querySelector('.settings-section-tabs')`, "设置分类加载");
  assert.ok(await clickText(".settings-section-tabs button", "界面与字体"), "切换到外观设置");
  await until(`!!document.querySelector('.appearance-page')`, "外观页");
  results.defaultReadingFont = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font').includes('LXGW WenKai') && getComputedStyle(document.querySelector('.appearance-manuscript-preview p:not(.eyebrow)')).fontWeight === '500' && [...document.fonts].some(face => face.family.replace(/[\\"']/g, '') === 'LXGW WenKai' && face.weight === '500' && face.status === 'loaded')`);
  assert.equal(results.defaultReadingFont, true, "默认正文应实际加载文楷 Medium 字重");
  results.noSongFallback = await evaluate(`!getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font').replace(/sans-serif/gi, '').match(/Song|Serif|STSong|Georgia|SimSun/i)`);
  assert.equal(results.noSongFallback, true, "正文回退栈不得包含宋体或衬线字体");
  await shot("appearance-default-font");
  const manuscriptBeforeUiChange = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font')`);
  await evaluate(`(() => { const select = document.querySelector('select[aria-label="界面字体"]'); select.value = 'sarasa'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(`getComputedStyle(document.documentElement).getPropertyValue('--ui-font').includes('Sarasa UI SC')`, "界面字体生效");
  results.uiFontSelectable = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--display-font') === getComputedStyle(document.documentElement).getPropertyValue('--ui-font') && getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font') === ${JSON.stringify(manuscriptBeforeUiChange)} && document.fonts.check('400 14px "Sarasa UI SC"', '故事画布')`);
  assert.equal(results.uiFontSelectable, true, "界面字体应独立可选且标题与控件统一");
  results.readableTypeRamp = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.nav-button')).fontSize) >= 15 && parseFloat(getComputedStyle(document.querySelector('.appearance-scale button')).fontSize) >= 14 && parseFloat(getComputedStyle(document.querySelector('.appearance-manuscript-preview p:not(.eyebrow)')).fontSize) >= 18 && getComputedStyle(document.querySelector('.settings-section-head h2')).fontWeight === '600'`);
  assert.equal(results.readableTypeRamp, true, "默认字号和字重必须符合可读层级");
  const fontBefore = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.appearance-scale button')).fontSize)`);
  const displayBefore = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--display-font')`);
  await evaluate(`(() => { const row = [...document.querySelectorAll('.appearance-scale')].find(el => el.textContent.includes('界面字号')); const button = [...row.querySelectorAll('button')].find(el => el.textContent.includes('110%')); button.click(); return true; })()`);
  await until(`getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim() === '1.1'`, "UI 缩放生效");
  const fontAfter = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.appearance-scale button')).fontSize)`);
  assert.ok(fontAfter > fontBefore, `UI 字号应增大：${fontBefore} -> ${fontAfter}`);
  await evaluate(`(() => { const select = document.querySelector('select[aria-label="正文字体"]'); select.value = 'neo'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(`getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font').includes('LXGW Neo XiHei Screen')`, "新晰黑正文生效");
  results.localReadingFont = await evaluate(`document.fonts.check('400 17px "LXGW Neo XiHei Screen"', '阿禾') && getComputedStyle(document.querySelector('.appearance-manuscript-preview p:not(.eyebrow)')).fontWeight === '400'`);
  assert.equal(results.localReadingFont, true, "本机新晰黑应实际可用");
  results.displayFontIndependent = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--display-font') === ${JSON.stringify(displayBefore)}`);
  assert.equal(results.displayFontIndependent, true, "正文字体不应改变界面展示字体");
  results.uiScale = true;
  await evaluate(`[...document.querySelectorAll('.toast button')].forEach(button => button.click())`);
  await shot("appearance-ui-scale");
  await evaluate(`(() => { const select = document.querySelector('select[aria-label="正文字体"]'); select.value = 'sarasa'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(`getComputedStyle(document.documentElement).getPropertyValue('--manuscript-font').includes('Sarasa UI SC')`, "更纱黑体正文生效");
  results.sarasaReadingFont = await evaluate(`document.fonts.check('400 17px "Sarasa UI SC"', '阿禾')`);
  assert.equal(results.sarasaReadingFont, true, "本机更纱黑体应实际可用");
  await shot("appearance-sarasa");
  await evaluate(`(() => { const select = document.querySelector('select[aria-label="正文字体"]'); select.value = 'builtin'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(`getComputedStyle(document.documentElement).getPropertyValue('--manuscript-weight').trim() === '500'`, "恢复默认文楷 Medium");

  const created = await call("/api/projects", "POST", { title: `窄窗切换 ${Date.now()}`, premise: "窄窗回归" });
  await viewport(1000, 900);
  await cdp("Page.navigate", { url: appUrl });
  await until(`!!document.querySelector('.app-shell')`, "窄窗重新加载");
  await clickText('button[aria-label="管理作品"]', "");
  await until(`!!document.querySelector('.active-projects')`, "未归档作品列表");
  const switched = await evaluate(`(() => { const article = [...document.querySelectorAll('.active-projects article')].find(el => el.textContent.includes(${JSON.stringify(created.activeProject.title)})); const button = article?.querySelector('button'); if (!button) return false; button.click(); return true; })()`);
  assert.equal(switched, true, "窄窗通过管理列表切换作品");
  await until(`document.querySelector('select[aria-label="切换作品"]').value === ${JSON.stringify(created.activeProject.projectId)}`, "窄窗作品已切换");
  results.narrowProjectSwitch = true;

  await viewport(760, 900);
  await nav("故事");
  await until(`getComputedStyle(document.querySelector('.outline-toggle')).display !== 'none'`, "窄屏结构按钮");
  await clickText(".outline-toggle", "故事结构");
  await until(`getComputedStyle(document.querySelector('.canvas-outline.outline-open')).display !== 'none'`, "窄屏故事结构打开");
  results.narrowStoryStructure = await evaluate(`document.querySelector('input[aria-label="新场景标题"]').getClientRects().length > 0`);
  assert.equal(results.narrowStoryStructure, true);

  await viewport(1000, 900);
  await nav("模型与服务");
  await until(`!!document.querySelector('.route-row')`, "任务分配行");
  results.routeGridContained = await evaluate(`(() => { const table = document.querySelector('.route-table'); const bounds = table.getBoundingClientRect(); return [...table.querySelectorAll('select')].every(el => { const rect = el.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right + 1; }); })()`);
  assert.equal(results.routeGridContained, true, "模型选择下拉框不得被裁剪");
  assert.deepEqual(exceptions, [], "浏览器存在未处理异常");
  results.consoleExceptions = exceptions;
  await writeFile(`${outDir}/report.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await writeFile(`${outDir}/failure.json`, `${JSON.stringify({ error: String(error), results, exceptions }, null, 2)}\n`);
  throw error;
} finally {
  socket.close();
}
