// 桌面运行契约：随机回环端口、配对令牌、静态页面与真实进程退出。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "nova-novel-runtime-"));
const pairToken = "runtime-test-token";
const child = spawn(process.execPath, ["packages/server/dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NOVA_NOVEL_DATA_DIR: dataDir, NOVA_NOVEL_PORT: "0", NOVA_NOVEL_PAIR_TOKEN: pairToken },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let errorOutput = "";
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`服务启动超时：${output}\n${errorOutput}`)), 20000);
  child.stdout.on("data", chunk => {
    output += String(chunk);
    const match = output.match(/Nova Novel ready at (http:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  child.stderr.on("data", chunk => { errorOutput += String(chunk); });
  child.once("error", reject);
  child.once("exit", code => { if (!output.includes("Nova Novel ready")) { clearTimeout(timer); reject(new Error(`服务提前退出 ${code}：${errorOutput}`)); } });
});
try {
  const base = await ready;
  const port = Number(new URL(base).port);
  assert.ok(port > 0 && port <= 65535, "应分配可用的随机端口");
  const unpaired = await fetch(`${base}/api/health`);
  assert.equal(unpaired.status, 403, "未带令牌不得调用 API");
  const headers = { "X-Nova-Novel-Token": pairToken };
  const health = await fetch(`${base}/api/health`, { headers });
  assert.equal(health.status, 200);
  const bootstrap = await fetch(`${base}/api/bootstrap`, { headers });
  assert.equal(bootstrap.status, 200);
  const snapshot = await bootstrap.json();
  assert.ok(snapshot.activeProject.projectId);
  const page = await fetch(base);
  assert.equal(page.status, 200, "静态页面无需令牌即可加载，数据 API 仍受保护");
  assert.match(await page.text(), /Nova Novel/);
  console.log(JSON.stringify({ ok: true, randomPort: true, pairTokenRequired: true, staticPage: true }));
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await rm(dataDir, { recursive: true, force: true });
}
