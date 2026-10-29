const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { createWriteStream, mkdirSync, appendFileSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { once } = require("node:events");

let serverProcess;
let mainWindow;
let quitting = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = message => { if (process.env.NOVA_NOVEL_TRACE) appendFileSync(process.env.NOVA_NOVEL_TRACE, `${message}\n`); };
trace("main loaded");

async function waitForServer(child, log, startup) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const match = startup.output.match(/Nova Novel ready at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) throw new Error("本机服务提前退出，请查看日志");
    await delay(100);
  }
  throw new Error("本机服务启动超时，请查看日志");
}

async function start() {
  trace("start begin");
  app.setAppUserModelId("com.novanovel.studio");
  const dataDir = process.env.NOVA_NOVEL_DATA_DIR ?? join(app.getPath("appData"), "Nova Novel");
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, "server.log"), { flags: "a" });
  const pairToken = randomBytes(24).toString("hex");
  const startup = { output: "" };
  const serverEntry = app.isPackaged ? join(process.resourcesPath, "app.asar", "packages/server/dist/index.js") : resolve(__dirname, "../packages/server/dist/index.js");
  const webRoot = app.isPackaged ? join(process.resourcesPath, "app.asar", "packages/web/dist") : resolve(__dirname, "../packages/web/dist");
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NOVA_NOVEL_DATA_DIR: dataDir,
      NOVA_NOVEL_WEB_ROOT: webRoot,
      NOVA_NOVEL_HOST: "127.0.0.1",
      NOVA_NOVEL_PORT: "0",
      NOVA_NOVEL_PAIR_TOKEN: pairToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", chunk => { log.write(chunk); startup.output += String(chunk); });
  serverProcess.stderr.on("data", chunk => { log.write(chunk); });
  serverProcess.on("error", error => { log.write(`Server launch error: ${error.message}\n`); });
  trace("server spawned");
  const port = await waitForServer(serverProcess, log, startup);
  trace(`server ready: ${port}`);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: process.env.NOVA_NOVEL_SHOW_WINDOW !== "0",
    backgroundColor: "#f4f2ec",
    title: "Nova Novel",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", event => {
    try {
      const target = new URL(event.url);
      if (target.hostname !== "127.0.0.1" || target.port !== String(port)) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  mainWindow.on("closed", () => { mainWindow = null; app.quit(); });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/#pair=${pairToken}`);
  if (process.env.NOVA_NOVEL_CAPTURE) {
    await delay(2000);
    const image = await mainWindow.webContents.capturePage();
    await writeFile(process.env.NOVA_NOVEL_CAPTURE, image.toPNG());
  }
}

const hasLock = app.requestSingleInstanceLock();
trace(`single instance lock: ${hasLock}`);
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start).catch(error => {
    trace(`start error: ${error instanceof Error ? error.stack : String(error)}`);
    if (!quitting) {
      dialog.showErrorBox("Nova Novel 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
}

app.on("before-quit", event => {
  trace("before-quit begin");
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await Promise.race([once(serverProcess, "exit"), delay(3000)]);
    }
    trace("server stopped");
    app.exit(0);
  })();
});
