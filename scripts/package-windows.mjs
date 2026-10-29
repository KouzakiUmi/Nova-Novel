// Windows 桌面安装包：构建 → 运行契约测试 → pnpm 独立部署 → electron-builder。
import { spawn } from "node:child_process";
import { cp, copyFile, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".release", "server");
const unpacked = process.argv.includes("--dir");
const pnpmCli = process.env.npm_execpath;

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`)));
  });
}
function runPnpm(args, cwd = root) {
  if (!pnpmCli) throw new Error("无法定位 pnpm CLI，请通过 pnpm 运行打包脚本");
  return run(process.execPath, [pnpmCli, ...args], cwd);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await runPnpm( ["-r", "build"]);
await run(process.execPath, ["scripts/test-packed-runtime.mjs"]);
await runPnpm( ["--filter", "@nova-novel/server", "--prod", "deploy", stage]);
await cp(join(root, "packages/server/dist"), join(stage, "packages/server/dist"), { recursive: true });
await cp(join(root, "packages/shared/dist"), join(stage, "node_modules/@nova-novel/shared/dist"), { recursive: true });
await cp(join(root, "electron"), join(stage, "electron"), { recursive: true });
await cp(join(root, "packages/web/dist"), join(stage, "packages/web/dist"), { recursive: true });
await cp(join(root, "electron-builder.yml"), join(stage, "electron-builder.yml"));
if (process.env.NOVA_NOVEL_ELECTRON_DIST) {
  await writeFile(join(stage, "electron-builder.yml"), `${await readFile(join(stage, "electron-builder.yml"), "utf8")}\nelectronDist: ${JSON.stringify(process.env.NOVA_NOVEL_ELECTRON_DIST)}\n`);
}
await mkdir(join(stage, "build"), { recursive: true });
await copyFile(join(root, "build/icon.ico"), join(stage, "build/icon.ico"));
await access(join(stage, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"));
const packageFile = join(stage, "package.json");
const manifest = JSON.parse(await readFile(packageFile, "utf8"));
manifest.name = "nova-novel";
manifest.productName = "Nova Novel";
manifest.description = "本机小说创作编辑室";
manifest.author = "Nova Novel contributors";
manifest.main = "electron/main.cjs";
manifest.private = true;
manifest.devDependencies = { electron: "44.7.2" };
await writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
await runPnpm( ["install"], stage);
await runPnpm( ["exec", "electron-rebuild", "-f", "-w", "better-sqlite3", "--version", "44.7.2"], stage);
await runPnpm( ["exec", "electron-builder", "--config", "electron-builder.yml", ...(unpacked ? ["--dir"] : ["--win", "--x64"])], stage);
await run(process.execPath, ["scripts/test-electron-lifecycle.mjs", join(stage, "release-packaged", "win-unpacked", "Nova Novel.exe")]);
console.log(`打包完成：${join(stage, "release-packaged")}`);
