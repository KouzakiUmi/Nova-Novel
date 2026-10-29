import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const executable = process.argv[2] ? resolve(process.argv[2]) : "";
assert.ok(executable, "请传入打包后的 Nova Novel.exe 路径");
const dataDir = await mkdtemp(join(tmpdir(), "nova-novel-electron-lifecycle-"));
const traceFile = join(dataDir, "trace.log");
const debugServer = createServer();
debugServer.listen(0, "127.0.0.1");
await once(debugServer, "listening");
const debugAddress = debugServer.address();
assert.ok(debugAddress && typeof debugAddress === "object");
const debugPort = debugAddress.port;
await new Promise(resolve => debugServer.close(() => resolve(undefined)));
const env = { ...process.env, NOVA_NOVEL_SHOW_WINDOW: "0", NOVA_NOVEL_DATA_DIR: dataDir, NOVA_NOVEL_TRACE: traceFile };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], { env, stdio: "ignore", windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitForExit = async ms => {
  if (child.exitCode !== null) return;
  await Promise.race([once(child, "exit"), delay(ms)]);
};
let ws;
try {
  let port = 0;
  for (let attempt = 0; attempt < 300; attempt++) {
    const trace = await readFile(traceFile, "utf8").catch(() => "");
    const match = trace.match(/server ready: (\d+)/);
    if (match) { port = Number(match[1]); break; }
    if (child.exitCode !== null) throw new Error(`Electron 提前退出：${child.exitCode}`);
    await delay(100);
  }
  assert.ok(port > 0, "等待桌面服务启动超时");
  const healthy = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthy.status, 403, "未配对的健康检查应被拒绝");
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  if (env.NOVA_NOVEL_CAPTURE) {
    let captured = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const image = await readFile(env.NOVA_NOVEL_CAPTURE).catch(() => null);
      if (image && image.length > 1000) { captured = true; break; }
      await delay(100);
    }
    assert.ok(captured, "桌面截图未生成");
  }
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  const exited = once(child, "exit");
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  await Promise.race([exited, delay(12000).then(() => { throw new Error("关闭窗口后 Electron 未退出"); })]);
  const trace = await readFile(traceFile, "utf8");
  assert.match(trace, /before-quit begin/);
  assert.match(trace, /server stopped/);
  let serverStillRunning = false;
  try { await fetch(`http://127.0.0.1:${port}/api/health`); serverStillRunning = true; } catch { /* 服务已退出 */ }
  assert.equal(serverStillRunning, false, "桌面退出后本机服务仍可访问");
  console.log(JSON.stringify({ passed: true, electronExited: true, serverStopped: true }, null, 2));
} finally {
  if (ws) try { ws.close(); } catch { /* 已关闭 */ }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await waitForExit(5000);
  }
  if (child.exitCode === null && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await Promise.race([once(killer, "exit"), delay(5000)]);
    await waitForExit(3000);
  }
  if (child.exitCode !== 0) {
    const trace = await readFile(traceFile, "utf8").catch(() => "（无 trace）");
    console.error(`Electron 退出验证诊断，exitCode=${child.exitCode}\n${trace}`);
  }
  await rm(dataDir, { recursive: true, force: true });
}
