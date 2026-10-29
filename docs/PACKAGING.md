# Windows 桌面安装包

## 目标形态

Nova Novel 使用 Electron + electron-builder 产出 Windows x64 NSIS 安装包。桌面壳与本机服务都包含在安装目录中，用户不需要另外安装 Node.js、pnpm 或 Pi 命令。

## 运行架构

- `electron/main.cjs` 通过 Electron 的 `ELECTRON_RUN_AS_NODE=1` 子进程模式启动 `packages/server/dist/index.js`，共用 Electron 自带的 Node 运行时。
- `scripts/package-windows.mjs` 先执行项目构建和 `scripts/test-packed-runtime.mjs`，再用 `pnpm --filter @nova-novel/server --prod deploy .release/server` 生成独立部署目录，避免 pnpm workspace 链接指向开发仓库；根依赖、锁文件和部署 manifest 均固定 Electron 44.7.2，并通过 `@electron/rebuild` 按同一版本重建 `better-sqlite3`，避免 Node ABI 不匹配。
- 部署目录包含服务端、共享包、前端静态文件、Electron 主进程、生产依赖、`build/icon.ico`，以及内置开源字体和 OFL 许可证；字体随 `packages/web/dist` 一起打包，不需要运行时下载。`electron-builder.yml` 配置 Windows x64 NSIS 输出。
- 每次启动使用随机回环端口和新的随机配对令牌。API 必须带 `X-Nova-Novel-Token`，前端从 URL hash 读取令牌；令牌不写入请求 URL、数据库或日志。未设置 `NOVA_NOVEL_PAIR_TOKEN` 的开发模式保持原有行为。外观设置不依赖该端口，统一保存在应用数据目录的 `appearance.json`。
- BrowserWindow 使用 `sandbox`、`contextIsolation`、禁用 Node 集成、禁止新窗口和站外导航。默认数据目录是 `%APPDATA%/Nova Novel`，服务日志位于其 `logs/server.log`。
- 单实例锁、退出时终止服务子进程，不需要系统凭据库或外部服务。

## 命令

```bash
# 开发依赖与生产构建
pnpm install
pnpm -r typecheck
pnpm -r build
node scripts/test-packed-runtime.mjs

# 生成 unpacked 目录，用于本机启动验证
pnpm dist:win:dir

# 生成 NSIS 安装包
pnpm dist:win
```

输出位于 `.release/server/release-packaged/`。该目录和 `.release/` 均为可重建产物，不进入源码仓库。`NOVA_NOVEL_ELECTRON_DIST` 可指定本地 Electron zip 或已解包目录，用于离线或代理不可用时的构建；未指定时使用 electron-builder 的标准下载流程。

## 本机验证

`test-packed-runtime.mjs` 使用真实服务进程验证：随机端口分配、未配对 API 返回 403、配对后健康检查与 bootstrap 可用、静态页面可加载。Electron unpacked 验证通过 `NOVA_NOVEL_SHOW_WINDOW=0` 和 `NOVA_NOVEL_CAPTURE` 调用 `capturePage` 检查真实桌面页面，不依赖开发服务器；`NOVA_NOVEL_TRACE` 可记录不含令牌的启动轨迹。

`test-electron-lifecycle.mjs` 还会启动打包后的桌面应用，使用独立空闲调试端口关闭窗口，验证 `before-quit` 清理、Electron 主进程退出和本机服务不可访问；失败时清理整个进程树并输出不含令牌的诊断轨迹。该验证已纳入 `dist:win` / `dist:win:dir` 流程。

## 当前边界

- 首发目标是 Windows x64 当前用户安装，不是 per-machine 安装、自动更新或跨平台包。
- 安装包是否签名取决于本机代码签名配置；没有签名配置时不声称已签名或绕过 SmartScreen。
- 真实模型仍需用户在设置页自行接入。模型密钥仍保存在应用数据目录，未接入 Windows 凭据管理器。
