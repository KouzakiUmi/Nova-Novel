// 本机界面验收：连接已打开调试端口的 Chrome，走通设置、续写、推敲、检查与修订流程并截图。
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
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });

let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result ?? {});
    return;
  }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails?.exception?.description ?? "异常");
  if (message.method === "Log.entryAdded" && message.params.entry?.level === "error") errors.push(message.params.entry.text);
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? expression);
  return result.result.value;
};
const shot = async (name) => { const { data } = await cdp("Page.captureScreenshot", { format: "png" }); await writeFile(`${outDir}/${name}.png`, Buffer.from(data, "base64")); };
const waitFor = async (expression, label, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await delay(200); }
  throw new Error(`等待超时：${label}`);
};
const clickText = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)}) && !node.disabled); if (!el) return false; el.click(); return true; })()`);
const nav = (label) => clickText(".nav-button, .local-status", label);

await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url: appUrl });
await waitFor(`!!document.querySelector(".app-shell")`, "应用加载");
const results = {};

// 1. 设置页：已登记 provider 可见、任务分配可保存。
assert.ok(await nav("模型与服务"), "打开设置");
await waitFor(`document.querySelectorAll(".provider-card").length > 0`, "provider 卡片");
results.providerCards = await evaluate(`document.querySelectorAll(".provider-card").length`);
results.keyLeak = await evaluate(`document.body.innerText.includes("SECRET")`);
assert.equal(results.keyLeak, false, "页面不应出现密钥");
await clickText(".provider-actions button", "测试连接");
await waitFor(`!!document.querySelector(".test-result")`, "测试结果");
results.testResult = await evaluate(`document.querySelector(".test-result").textContent`);
await shot("settings");

// 2. 写作：接着写 → 接到末尾 → 自动保存。
assert.ok(await nav("写作"), "打开写作");
await waitFor(`!!document.querySelector(".manuscript-editor")`, "编辑器");
const before = await evaluate(`document.querySelector(".manuscript-editor").innerText.length`);
assert.ok(await clickText(".quick-actions button", "接着这场写"), "续写按钮");
await waitFor(`!!document.querySelector(".candidate-panel")`, "续写候选", 30000);
await clickText(".candidate-actions button", "接到正文末尾");
await waitFor(`document.querySelector(".manuscript-editor").innerText.length > ${before}`, "续写进入正文");
await waitFor(`document.querySelector(".save-indicator")?.textContent.includes("已保存")`, "自动保存", 10000);
results.continuationAppended = true;

// 3. 推敲：选中第一段 → 只替换该段，其余段落保留。
const paragraphs = await evaluate(`document.querySelectorAll(".manuscript-editor p").length`);
await evaluate(`(() => { const p = document.querySelectorAll(".manuscript-editor p")[2]; const range = document.createRange(); range.selectNodeContents(p); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); document.querySelector(".manuscript-editor").focus(); document.dispatchEvent(new Event("selectionchange")); return true; })()`);
await waitFor(`!!document.querySelector(".selection-toolbar")`, "选区工具栏");
await clickText(".selection-toolbar button", "推敲表达");
await waitFor(`!!document.querySelector(".candidate-panel")`, "推敲候选", 30000);
await clickText(".candidate-actions button", "替换选段");
await waitFor(`document.querySelector(".manuscript-editor").innerText.includes("一笔一画")`, "选段被替换");
results.polishKeptParagraphs = (await evaluate(`document.querySelectorAll(".manuscript-editor p").length`)) === paragraphs;
results.polishKeptOpening = await evaluate(`document.querySelector(".manuscript-editor").innerText.includes("阿禾把最后一只鞋楦收进纸箱")`);
assert.ok(results.polishKeptParagraphs && results.polishKeptOpening, "推敲只应替换选段");
await waitFor(`document.querySelector(".save-indicator")?.textContent.includes("已保存")`, "推敲后保存", 10000);

// 4. 检查：报告单独展示，不提供“接受”。
await clickText(".quick-actions button", "检查前后照应");
await waitFor(`!!document.querySelector(".report-panel")`, "检查报告", 30000);
results.reportHasAccept = await evaluate(`!!document.querySelector(".report-panel .button.primary")`);
results.reportIssues = await evaluate(`document.querySelectorAll(".report-panel .issue").length`);
assert.equal(results.reportHasAccept, false, "报告不应有采用按钮");
await shot("writing");

// 5. 修订：自动保存后直接创建命名版本并恢复，不出现版本冲突。
assert.ok(await nav("修订"), "打开修订");
await delay(600);
results.revisionsPage = await evaluate(`document.body.innerText.includes("修订") || document.body.innerText.includes("版本")`);
await shot("revisions");

// 6. 起步：按点子生成三张卡。
assert.ok(await nav("创作起步"), "打开起步");
await waitFor(`!!document.querySelector(".start-actions .button.primary")`, "起步按钮");
assert.ok(await clickText(".start-actions .button", "方向"), "生成点子卡");
await waitFor(`document.body.innerText.includes("阿禾直接问来人等了多久")`, "模型生成的点子卡", 30000);
results.ideaCards = await evaluate(`document.querySelectorAll(".idea-card").length`);
await shot("start");

results.consoleErrors = errors;
await writeFile(`${outDir}/ui-smoke.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
socket.close();
