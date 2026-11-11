// 本轮修复的回归：保存失败保留草稿与恢复、409 冲突不自动重试、切作品竞态、输入法组合输入不误触发。
// 连接已打开调试端口的 Chrome；服务由外部启动在 SERVER_URL。
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = `artifacts/reliability-${randomUUID().slice(0, 8)}`;
await mkdir(root, { recursive: true });
const serverUrl = process.env.SERVER_URL ?? "http://127.0.0.1:43110";
const cdpPort = Number(process.env.CDP_PORT ?? 9222);
const consoleErrors = [];
const checks = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) { const value = await fn(); if (value) return value; await wait(100); }
  throw new Error(`等待超时：${label}`);
}
async function call(path, method = "GET", input) {
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && item.url.startsWith(serverUrl)) ?? targets.find((item) => item.type === "page");
assert.ok(target, "找不到浏览器页面");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? "页面异常");
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") consoleErrors.push(message.params.entry.text);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result?.value;
}
async function navigate(label, selector) {
  const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('.nav-button')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
  assert.equal(clicked, true, `找不到导航：${label}`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `${label} 页面渲染`);
}
async function appendText(text) {
  await evaluate(`(() => {
    const editor = document.querySelector('.manuscript-editor');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, ${JSON.stringify(text)});
  })()`);
}
const draftAlert = "Boolean(document.querySelector('.inline-note.error[role=\"alert\"]'))";
const clearFetchPatch = "(() => { if (window.__novaPatch) { window.fetch = window.__novaPatch; delete window.__novaPatch; } return true; })()";

try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: serverUrl });
  await wait(1800);
  await until(() => evaluate("Boolean(document.querySelector('.app-shell') || document.querySelector('.start-view'))"), "应用挂载");
  await evaluate(clearFetchPatch);
  // 记录起始作品，后续切作品测试结束后用它恢复，避免测试相互干扰。
  const originProjectId = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]')?.value ?? ''");
  assert.ok(originProjectId, "应能确定起始作品");

  // 1) 保存失败：草稿保留、原因可见、恢复后真正落库
  await navigate("写作", ".manuscript-editor");
  const failMarker = `失败保留${Date.now()}`;
  await evaluate(`(() => {
    window.__novaPatch = window.fetch;
    window.__novaPatchCount = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (method === 'PATCH' && url.includes('/api/scenes/')) { window.__novaPatchCount += 1; return Promise.reject(new TypeError('Failed to fetch')); }
      return window.__novaPatch(input, init);
    };
    return true;
  })()`);
  await appendText(failMarker);
  await until(() => evaluate(draftAlert), "出现未保存草稿提示", 300);
  const draftText = await evaluate("document.querySelector('.inline-note.error[role=\"alert\"] textarea')?.value ?? ''");
  assert.ok(draftText.includes(failMarker), "草稿提示中应保留本次输入");
  const attempts = await evaluate("window.__novaPatchCount ?? 0");
  assert.ok(attempts >= 1 && attempts <= 3, `网络失败重试次数应为 1–3，实际 ${attempts}`);
  checks.push(`保存失败保留草稿（尝试 ${attempts} 次，未无界重试）`);

  await evaluate(clearFetchPatch);
  const retried = await evaluate(`(() => { const s = document.querySelector('.inline-note.error[role="alert"]'); const b = s && [...s.querySelectorAll('button')].find(x => x.textContent.includes('读取最新版本')); if (!b) return false; b.click(); return true; })()`);
  assert.equal(retried, true, "缺少读取最新版本的入口");
  await until(() => evaluate(`(() => { const s = document.querySelector('.inline-note.error[role="alert"]'); return Boolean(s && [...s.querySelectorAll('button')].some(x => x.textContent.includes('确认保存本地草稿'))); })()`), "两步确认出现");
  await evaluate(`(() => { const s = document.querySelector('.inline-note.error[role="alert"]'); const b = [...s.querySelectorAll('button')].find(x => x.textContent.includes('确认保存本地草稿')); if (b) b.click(); })()`);
  await until(() => evaluate(`(() => { const el = document.querySelector('.save-indicator'); return el && /已保存/.test(el.textContent || ''); })()`), "恢复后回到已保存", 200);
  const bootAfterRetry = await call("/api/bootstrap");
  assert.ok((bootAfterRetry.body?.scenes ?? []).some((scene) => (scene.body || "").includes(failMarker)), "恢复后草稿应真正写入服务端");
  checks.push("草稿经两步确认后写入服务端");

  // 2) 409 不被自动重试（用旧 baseRevisionId 制造冲突）
  await evaluate(clearFetchPatch);
  const bootstrap2 = (await call("/api/bootstrap")).body;
  const scene2 = bootstrap2.scenes[0];
  const branch2 = bootstrap2.branches.find((b) => b.branchId === bootstrap2.activeProject.activeBranchId);
  // 先推进一次版本，使编辑器持有的 baseRevisionId 过期
  const advanced = await call(`/api/scenes/${scene2.sceneId}`, "PATCH", { baseRevisionId: branch2.headRevisionId, body: `${scene2.body}\n\n推进版本以制造冲突。` });
  assert.equal(advanced.status, 200, "推进版本应成功");
  const conflictMarker = `冲突不重试${Date.now()}`;
  await evaluate(`(() => {
    window.__novaConflictCount = 0;
    window.__novaPatch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (method === 'PATCH' && url.includes('/api/scenes/')) { window.__novaConflictCount += 1; }
      return window.__novaPatch(input, init);
    };
    return true;
  })()`);
  await appendText(conflictMarker);
  await until(() => evaluate(draftAlert), "409 后出现提示", 300);
  await wait(3000);
  const conflictCalls = await evaluate("window.__novaConflictCount ?? 0");
  assert.ok(conflictCalls <= 2, `409 不应持续重试，实际请求 ${conflictCalls} 次`);
  const conflictText = await evaluate("document.querySelector('.inline-note.error[role=\"alert\"]')?.textContent ?? ''");
  assert.ok(/其他操作更新|最新版本|草稿/.test(conflictText), `409 提示应可操作，实际：${conflictText.slice(0, 80)}`);
  checks.push(`409 停止自动重试（${conflictCalls} 次请求）`);
  await evaluate(clearFetchPatch);
  // 409 场景收尾：先走两步确认把草稿写入，确保后续步骤不再有提示阻挡
  await evaluate(`(() => { const s = document.querySelector('.inline-note.error[role="alert"]'); const b = s && [...s.querySelectorAll('button')].find(x => x.textContent.includes('读取最新版本')); if (b) b.click(); })()`);
  await wait(1500);
  await evaluate(`(() => { const s = document.querySelector('.inline-note.error[role="alert"]'); if (!s) return; const b = [...s.querySelectorAll('button')].find(x => x.textContent.includes('确认保存本地草稿')); if (b) b.click(); })()`);
  await until(() => evaluate(`!document.querySelector('.inline-note.error[role="alert"]')`), "409 草稿处理完毕", 200);

  // 3) 切作品后旧响应不覆盖当前界面
  const created = await call("/api/projects", "POST", { title: `竞态目标${Date.now()}`, premise: "竞态验收" });
  assert.equal(created.status, 201, "创建作品应成功");
  const targetProjectId = created.body.activeProject.projectId;
  // 外部 API 创建作品后显式重载权威快照，不依赖其他保存操作附带的后台刷新。
  await evaluate("location.reload(); true");
  await wait(1800);
  await until(() => evaluate("Boolean(document.querySelector('.app-shell') || document.querySelector('.start-view'))"), "作品创建后重新挂载");
  await navigate("创作起步", ".start-view");
  await until(() => evaluate(`(() => { const s = document.querySelector('select[aria-label="切换作品"]'); return Boolean(s && [...s.options].some(o => o.value === ${JSON.stringify(targetProjectId)})); })()`), "新作品出现在切换器", 200);
  const switched = await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="切换作品"]');
    if (!select) return false;
    select.value = ${JSON.stringify(targetProjectId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(switched, true, "找不到作品切换器");
  await until(async () => {
    const state = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]')?.value");
    return state === targetProjectId;
  }, "切换到新作品", 300);
  await wait(800);
  const activeNow = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]')?.value");
  assert.equal(activeNow, targetProjectId, "切作品后界面不应被旧响应改回");
  checks.push("切作品后界面归属正确");

  // 4) 输入法组合输入期间 Enter 不触发检索
  await navigate("资料", ".context-page");
  await evaluate(`(() => {
    window.__novaSearches = 0;
    window.__novaPatch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/context/query')) window.__novaSearches += 1;
      return window.__novaPatch(input, init);
    };
    return true;
  })()`);
  await evaluate(`(() => {
    const input = document.querySelector('#context-query');
    input.focus();
    input.value = '收据';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }));
    return true;
  })()`);
  await wait(900);
  const composingSearches = await evaluate("window.__novaSearches ?? 0");
  assert.equal(composingSearches, 0, `组合输入期间不应检索，实际 ${composingSearches} 次`);
  await evaluate(`(() => {
    const input = document.querySelector('#context-query');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`);
  await until(async () => (await evaluate("window.__novaSearches ?? 0")) >= 1, "真正 Enter 触发一次检索");
  const finalSearches = await evaluate("window.__novaSearches ?? 0");
  assert.equal(finalSearches, 1, `真实 Enter 应只检索一次，实际 ${finalSearches}`);
  checks.push("组合输入不检索，真实 Enter 只检索一次");
  await evaluate(clearFetchPatch);

  // 5) 外观保存失败：显示未保存并可重试，预览保留
  // 设置入口是左下角状态按钮，不在主导航列表里。
  const openedSettings = await evaluate(`(() => { const b = document.querySelector('.local-status'); if (!b) return false; b.click(); return true; })()`);
  assert.equal(openedSettings, true, "找不到设置入口");
  await until(() => evaluate("Boolean(document.querySelector('.settings-section-tabs'))"), "设置页渲染", 300);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.settings-section-tabs button')].find(x => x.textContent.includes('界面与字体')); if (!b) return false; b.click(); return true; })()`);
  await until(() => evaluate("Boolean(document.querySelector('.appearance-page'))"), "外观页渲染", 300);
  await until(() => evaluate("Boolean(document.querySelector('select[aria-label=\"界面字体\"]'))"), "外观字体选择器就绪", 300);
  await evaluate(`(() => {
    window.__novaPatch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (method === 'PUT' && url.includes('/api/appearance')) return Promise.reject(new TypeError('Failed to fetch'));
      return window.__novaPatch(input, init);
    };
    return true;
  })()`);
  const appearanceChanged = await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="界面字体"]');
    if (!select) return false;
    select.value = select.value === 'system' ? 'builtin' : 'system';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(appearanceChanged, true, "找不到界面字体选择器");
  await until(() => evaluate(`(() => { const el = document.querySelector('.appearance-page .badge, .appearance-page [class*="badge"]'); return Boolean(el && /尚未保存/.test(el.textContent || '')); })()`), "外观显示尚未保存", 150).catch(async () => {
    // 兼容不同的状态展示位置：退而检查页面上是否出现错误提示
    await until(() => evaluate("document.body.innerText.includes('尚未保存')"), "外观显示尚未保存");
  });
  const appearanceRetry = await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.includes('重试保存'))");
  assert.equal(appearanceRetry, true, "外观保存失败应提供重试入口");
  checks.push("外观保存失败显示未保存并提供重试");
  await evaluate(clearFetchPatch);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('重试保存')); if (b) b.click(); })()`);
  await until(() => evaluate("document.body.innerText.includes('已保存在本机')"), "外观重试后保存成功", 150);
  checks.push("外观重试后真正保存");

  // 6) 便签保存失败时不转为场景
  await navigate("便签", ".notes-page");
  const noteTitle = `回归便签${Date.now()}`;
  await evaluate(`(() => {
    const title = document.querySelector('input[aria-label="新便签标题"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, ${JSON.stringify(noteTitle)});
    title.dispatchEvent(new Event('input', { bubbles: true }));
    const body = document.querySelector('textarea[aria-label="新便签内容"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(body, '用于验证保存失败不转场景。');
    body.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('收下便签')); if (b) b.click(); })()`);
  // 便签标题渲染在 input 里，不在 innerText 中，按输入框的值判断。
  await until(() => evaluate(`[...document.querySelectorAll('.note-title-input')].some(el => el.value === ${JSON.stringify(noteTitle)})`), "便签创建成功", 200);
  await evaluate(`(() => {
    window.__novaPatchCount = 0;
    window.__novaPromote = 0;
    window.__novaPatch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (method === 'PATCH' && url.includes('/api/notes/')) { window.__novaPatchCount += 1; return Promise.reject(new TypeError('Failed to fetch')); }
      if (method === 'POST' && url.includes('/promote')) window.__novaPromote += 1;
      return window.__novaPatch(input, init);
    };
    return true;
  })()`);
  const promoteClicked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.note-card')];
    const card = cards.find(c => { const input = c.querySelector('.note-title-input'); return input && input.value === ${JSON.stringify(noteTitle)}; });
    if (!card) return false;
    const b = [...card.querySelectorAll('button')].find(x => x.textContent.includes('转为场景'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  assert.equal(promoteClicked, true, "找不到转为场景按钮");
  await until(() => evaluate("document.body.innerText.includes('Failed to fetch') || document.body.innerText.includes('便签保存失败') || Boolean(document.querySelector('.note-card .inline-note.error'))"), "便签保存失败提示出现", 150);
  const promoteCalls = await evaluate("window.__novaPromote ?? 0");
  assert.equal(promoteCalls, 0, `保存失败时不应调用转为场景，实际 ${promoteCalls} 次`);
  const notePatchCalls = await evaluate("window.__novaPatchCount ?? 0");
  assert.equal(notePatchCalls, 1, `便签保存应只尝试一次，实际 ${notePatchCalls} 次`);
  checks.push("便签保存失败时不转为场景");
  await evaluate(clearFetchPatch);

  // 7) 结构保存失败：显示持久错误、保留输入、可再次保存
  // 先切回起始作品，结构测试必须作用在同一个作品上。
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="切换作品"]');
    if (!select) return false;
    select.value = ${JSON.stringify(originProjectId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await until(async () => (await evaluate("document.querySelector('select[aria-label=\"切换作品\"]')?.value")) === originProjectId, "切回起始作品", 300);
  await navigate("故事", ".scene-structure-editor");
  // 记录本次操作所属作品，后面按它断言，避免受前面切作品影响。
  const structureProjectId = await evaluate("document.querySelector('select[aria-label=\"切换作品\"]')?.value ?? ''");
  assert.equal(structureProjectId, originProjectId, "结构保存测试应在起始作品上进行");
  await evaluate(`(() => {
    window.__novaStructurePatch = 0;
    window.__novaPatch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (method === 'PATCH' && url.includes('/api/scenes/')) { window.__novaStructurePatch += 1; return Promise.reject(new TypeError('Failed to fetch')); }
      return window.__novaPatch(input, init);
    };
    return true;
  })()`);
  const structureTitle = `结构失败${Date.now()}`;
  await evaluate(`(() => {
    const input = document.querySelector('.scene-structure-editor input[aria-label="场景标题"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(structureTitle)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const b = [...document.querySelectorAll('.scene-structure-editor button')].find(x => x.textContent.includes('保存标题'));
    if (b) b.click();
    return true;
  })()`);
  await until(() => evaluate("Boolean(document.querySelector('.scene-structure-editor .inline-note.error'))"), "结构保存错误显示", 150);
  const structureError = await evaluate("document.querySelector('.scene-structure-editor .inline-note.error')?.textContent ?? ''");
  assert.ok(/保留|重试|尚未保存/.test(structureError), `结构错误应说明可重试且输入保留，实际：${structureError.slice(0, 60)}`);
  const titleKept = await evaluate(`document.querySelector('.scene-structure-editor input[aria-label="场景标题"]')?.value === ${JSON.stringify(structureTitle)}`);
  assert.equal(titleKept, true, "结构保存失败后应保留已输入标题");
  checks.push("结构保存失败保留输入并显示可重试错误");
  await evaluate(clearFetchPatch);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.scene-structure-editor button')].find(x => x.textContent.includes('保存标题')); if (b) b.click(); })()`);
  await until(() => evaluate("!document.querySelector('.scene-structure-editor .inline-note.error')"), "结构重试后错误消失", 150);
  // 保存请求到快照刷新之间有延迟，轮询直到服务端出现新标题。
  const structureSaved = await until(async () => {
    const state = await call(`/api/bootstrap?projectId=${encodeURIComponent(structureProjectId)}`);
    return (state.body?.scenes ?? []).some((scene) => scene.title === structureTitle) ? state : null;
  }, `结构重试后标题写入（作品 ${structureProjectId}）`, 200);
  assert.ok(structureSaved, "重试后标题应真正保存");
  checks.push("结构重试后标题真正保存");

  // 第 2 段刻意制造了版本冲突，浏览器会把 409 记为网络错误；第 5–7 段刻意制造了网络失败。均属预期内。
  const unexpected = consoleErrors.filter((entry) => !/409 \(Conflict\)/.test(entry) && !/Failed to load resource/.test(entry));
  assert.deepEqual(unexpected, [], `控制台不应有预期外错误：${unexpected.slice(0, 3).join(" | ")}`);
  await writeFile(`${root}/report.json`, JSON.stringify({ checks, consoleErrors, conflictCalls, attempts }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, conflictCalls, attempts }, null, 2));
} catch (error) {
  await writeFile(`${root}/report.json`, JSON.stringify({ ok: false, checks, consoleErrors, error: String(error?.message ?? error) }, null, 2));
  console.error(`失败：${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  try { await evaluate(clearFetchPatch); } catch { /* 页面可能已卸载 */ }
  ws.close();
}
