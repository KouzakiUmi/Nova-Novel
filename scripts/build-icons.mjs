/**
 * 生成独立图标资源：packages/web/public/icons/*.svg、favicon.svg、预览图，
 * 以及（加 --ico）用 Edge/Chrome 无头渲染 build/icon.ico。
 *
 * 几何数据唯一来源是 packages/web/src/components/iconGeometry.ts，
 * React 组件读同一份数据，所以修改图标只改那一个文件，再运行：
 *   node scripts/build-icons.mjs          # 只生成 SVG
 *   node scripts/build-icons.mjs --ico    # 同时生成 build/icon.ico
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const geometry = await import(pathToFileURL(join(root, "packages/web/src/components/iconGeometry.ts")).href);
const {
  ICONS, ICON_STROKE, MARK_PARTS, MARK_NOVA, MARK_COLOR, MARK_ON_DARK, APP_TILE, MARK_VIEWBOX, MARK_CELL, MARK_GRID, MARK_ORIGIN,
} = geometry;

const INK = "#292d29";
const MUTED = "#626a60";
const GOLD = "#c8923a";
const iconsDir = join(root, "packages/web/public/icons");
const writeText = (path, text) => writeFile(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");

/** 24 网格功能图标的内部元素。 */
function iconInner(name, { ink, nova }) {
  return ICONS[name].parts
    .map((part) => {
      const opacity = part.opacity === undefined ? "" : ` opacity="${part.opacity}"`;
      if (part.kind === "stroke") return `<path d="${part.d}"${opacity}/>`;
      if (part.kind === "block") return `<path d="${part.d}" fill="${ink}" stroke="none"${opacity}/>`;
      return `<path d="${part.d}" fill="${nova}" stroke="none"/>`;
    })
    .join("");
}

function iconSvg(name, { ink = INK, nova = GOLD } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round">` +
    `${iconInner(name, { ink, nova })}</svg>`
  );
}

/** 品牌记号内部元素（48 画布）。 */
function markInner(palette, mono = false) {
  const fill = (key) => (mono ? "currentColor" : palette[key]);
  const diagonalOpacity = mono ? ' opacity=".6"' : "";
  const rightOpacity = mono ? ' opacity=".85"' : "";
  return (
    `<path d="${MARK_PARTS.left}" fill="${fill("left")}"/>` +
    `<path d="${MARK_PARTS.diagonal}" fill="${fill("diagonal")}"${diagonalOpacity}/>` +
    `<path d="${MARK_PARTS.right}" fill="${fill("right")}"${rightOpacity}/>` +
    `<path d="${MARK_NOVA}" fill="${fill("nova")}"/>`
  );
}

const markSvg = (palette, mono = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}">${markInner(palette, mono)}</svg>`;

/** 应用图标：深绿圆角底板，N² 记号略放大并居中。 */
function appIconSvg() {
  // 记号包围盒约 x 4–47.6、y 1.2–44，居中到 48 画布后整体缩放 0.86。
  const scale = 0.92;
  const cx = (4 + 47.6) / 2;
  const cy = (1.2 + 44) / 2;
  const tx = (24 - cx * scale).toFixed(2);
  const ty = (24 - cy * scale).toFixed(2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="${APP_TILE.radius}" fill="${APP_TILE.fill}"/>` +
    `<g transform="translate(${tx} ${ty}) scale(${scale})">${markInner(MARK_ON_DARK)}</g></svg>`
  );
}

function wordmarkSvg() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 224 48"><g>${markInner(MARK_COLOR)}</g>` +
    `<text x="62" y="31" font-family="Georgia, 'Songti SC', serif" font-size="24" font-weight="700" letter-spacing="1.5" fill="${INK}">Nova Novel</text>` +
    `<text x="63" y="43" font-family="Inter, 'Segoe UI', sans-serif" font-size="7.5" font-weight="600" letter-spacing="2.6" fill="${MUTED}">STORIES THAT IGNITE</text></svg>`
  );
}

/** 构造图：N 所占的 5×5 方格外框，右上角留出指数位。 */
function constructionInner() {
  const { x, y } = MARK_ORIGIN;
  const size = MARK_CELL * MARK_GRID;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="#b9c2b4" stroke-width=".4" stroke-dasharray="1.2 1.2"/>`;
}
function previewSvg() {
  const names = Object.keys(ICONS);
  const cell = 96;
  const left = 40;
  const top = 214;
  const cols = 5;
  const tiles = names
    .map((name, i) => {
      const gx = left + (i % cols) * (cell + 18);
      const gy = top + Math.floor(i / cols) * (cell + 40);
      return (
        `<g transform="translate(${gx} ${gy})"><rect width="${cell}" height="${cell}" rx="18" fill="#fdfcf9" stroke="#e4e2da"/>` +
        `<g transform="translate(18 18) scale(2.5)" fill="none" stroke="${INK}" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round">${iconInner(name, { ink: INK, nova: GOLD })}</g>` +
        `<text x="${cell / 2}" y="${cell + 18}" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="${MUTED}">${name}</text></g>`
      );
    })
    .join("");
  const small = [16, 18, 24]
    .map((size, i) => {
      const gx = 40 + i * 60;
      return `<g transform="translate(${gx} 522)">${names
        .slice(0, 1)
        .map(() => `<g transform="scale(${size / 24})" fill="none" stroke="${INK}" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round">${iconInner("quill", { ink: INK, nova: GOLD })}</g>`)
        .join("")}<text x="${size / 2}" y="${size + 16}" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" fill="${MUTED}">${size}px</text></g>`;
    })
    .join("");
  const construction = `<g transform="translate(40 40) scale(3.4)">${constructionInner()}${markInner(MARK_COLOR)}</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 620"><rect width="640" height="620" fill="#f4f2ec"/>` +
    `${construction}` +
    `<text x="214" y="82" font-family="Georgia, serif" font-size="34" font-weight="700" fill="${INK}">Nova Novel</text>` +
    `<text x="216" y="106" font-family="Inter, sans-serif" font-size="11" letter-spacing="3" fill="${MUTED}">ICON SYSTEM · N² · 24 GRID</text>` +
    `<text x="216" y="134" font-family="Inter, sans-serif" font-size="12" fill="${MUTED}">N 由 5×5 方格拼成（N 的平方），新星在指数位。</text>` +
    `<text x="216" y="154" font-family="Inter, sans-serif" font-size="12" fill="${MUTED}">功能图标沿用：主体在方格区，新星固定右上角。</text>` +
    `<g transform="translate(540 40)"><g transform="scale(1.5)">${appIconSvg().replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g></g>` +
    `${tiles}${small}</svg>`
  );
}

/** 找一个可用的 Chromium 内核浏览器。 */
function findBrowser() {
  const candidates = [
    process.env.NOVA_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path));
}

/** 用无头浏览器（DevTools 协议）把 SVG 渲染成透明背景 PNG。 */
async function rasterize(browser, svgText, sizes, workDir) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${join(workDir, "profile")}`, "about:blank"], { stdio: "ignore" });
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  try {
    let page;
    for (let attempt = 0; attempt < 60 && !page; attempt += 1) {
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((target) => target.type === "page");
      } catch {
        /* 浏览器尚未就绪 */
      }
      if (!page) await delay(250);
    }
    if (!page) throw new Error("无头浏览器没有启动");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", fail, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((done) => {
        sequence += 1;
        pending.set(sequence, done);
        socket.send(JSON.stringify({ id: sequence, method, params }));
      });
    const frames = [];
    for (const size of sizes) {
      await send("Emulation.setDeviceMetricsOverride", { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}">`;
      await send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
      await delay(400);
      const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      frames.push({ size, data: Buffer.from(shot.result.data, "base64") });
    }
    socket.close();
    return frames;
  } finally {
    child.kill();
  }
}
/** 打包多帧 PNG 的 ICO。 */
function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = Buffer.alloc(16 * frames.length);
  let offset = 6 + entries.length;
  frames.forEach(({ size, data }, i) => {
    const at = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, at);
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1);
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, entries, ...frames.map((frame) => frame.data)]);
}

await mkdir(iconsDir, { recursive: true });
for (const name of Object.keys(ICONS)) await writeText(join(iconsDir, `${name}.svg`), iconSvg(name));
await writeText(join(iconsDir, "nova-mark.svg"), markSvg(MARK_COLOR));
await writeText(join(iconsDir, "nova-mark-mono.svg"), markSvg(MARK_COLOR, true));
await writeText(join(iconsDir, "nova-wordmark.svg"), wordmarkSvg());
await writeText(join(iconsDir, "preview.svg"), previewSvg());
await writeText(join(root, "packages/web/public/favicon.svg"), appIconSvg());
console.log(`已生成 ${Object.keys(ICONS).length} 个功能图标、品牌记号、应用图标和预览图`);

if (process.argv.includes("--ico")) {
  const browser = findBrowser();
  if (!browser) throw new Error("找不到 Edge/Chrome；可用 NOVA_BROWSER 指定浏览器路径");
  const workDir = await mkdtemp(join(tmpdir(), "nova-ico-"));
  try {
    const frames = await rasterize(browser, appIconSvg(), [16, 24, 32, 48, 64, 128, 256], workDir);
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build/icon.ico"), packIco(frames));
    console.log(`已生成 build/icon.ico（${frames.map((f) => f.size).join("/")}）`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
