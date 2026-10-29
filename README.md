# Nova Novel

一间本机小说编辑室：从一句话、点子卡或直接写作开始，把正文、剧情、元素证据和版本取舍放在同一套作品对象中。内置 Pi SDK 小说 Agent；未添加模型时仍可写作、保存、检索和恢复版本。

## 运行

要求：Node.js 24+、pnpm 11+。Windows 构建 `better-sqlite3` 时若没有匹配预编译包，需要可用的 C++ 构建工具。

```bash
pnpm install
pnpm build
pnpm start
```

打开 `http://127.0.0.1:43110`。权威数据默认写入 `data/nova-novel.sqlite`，不会上传到云端账户。

开发模式：

```bash
pnpm dev
```

开发页面位于 `http://127.0.0.1:43111`，API 由 Vite 同源代理到本机服务。

### Windows 安装包

```bash
pnpm dist:win:dir   # unpacked，用于本机验证
pnpm dist:win       # Windows x64 NSIS 安装包
```

打包流程包括生产构建、随机端口/配对令牌测试、独立部署和 Electron 原生模块重建，详见[桌面安装包文档](<docs/PACKAGING.md>)。

### 添加模型服务

打开“设置 › 模型与服务”，从 Pi 内置或插件目录选择服务，也可手动添加 OpenAI、Anthropic 或 Google 兼容服务。支持手动 API Key、环境变量引用和 OAuth 登录，再为构思、试演、续写、推敲、一致性检查和交互大纲选择模型与思考强度。订阅用量区按已接入服务显示支持的额度窗口与余额。

火山方舟 Agent Plan / Coding Plan 使用各自模型快照和套餐凭据。手动模式可分别设置推理 Key 与额度 IAM AK/SK 环境变量；官方 OAuth 需要 Windows ArkCli 1.0.37，可用 `NOVA_NOVEL_ARKCLI_PATH` 指定原生可执行文件。登录身份保存在 Nova 数据目录的独立 ArkCli 账户目录，不读取 DSH 的账号配置。

无需安装本机 `pi` 命令。服务在进程内运行锁定版本的 SDK，使用中文小说提示与九个只读资料工具，每个任务独立会话。手动 API Key 保存在数据目录的 `agent/settings.json` 与派生的 `agent/models.json`；环境变量方式只保存变量名，OAuth 凭据由 Pi 写入 `agent/auth.json`，均不在页面或日志回显。生成时，上下文发送至所选模型服务。

`NOVA_NOVEL_DATA_DIR` 可指定数据根目录，`NOVA_NOVEL_DB_PATH` 指定数据库，`NOVA_NOVEL_WEB_ROOT` 指定前端产物目录。未显式指定数据库且新库不存在时，会直接使用数据目录中已有的 `storyweave.sqlite`。

## 已实现的工作台

- **创作起步**：三入口、原创点子卡、选择/语义锁定/借用/手改/拒绝/撤销、不可变选择快照与采用计划双 CAS；支持作品重命名、归档/恢复和独立副本。
- **创作便签**：收集想法、疑问、对白和资料，支持标签、搜索、场景/元素关联、归档和由作者明确转为场景；便签本身不进入正文或 RAG。
- **写作**：Tiptap 场景编辑、自动保存、选区任务、候选比较、原文变化提示、场景卡和可见上下文；支持选区批注与原文变化锚点提示，以及结构/语言分层修订。
- **双画布**：剧情图/大纲/时间轴，工作流图/列表等价视图；布局与执行语义分离。支持章节新建/重命名、场景新建/重命名、跨章移动与叙述顺序调整。
- **元素与检索**：稳定元素 ID、别名、事实/信念、状态事件、故事时间与叙述顺序、知识边界、FTS5 中文预分词、权威证据回查；人物弧线可单独编辑并与实际事件对照。
- **工作流**：不可变定义、严格 DAG 与端口校验、受控遍历、条件合流、人工待办、取消和重启恢复。
- **版本**：不可变清单、自动恢复点、命名版本、ChangeSet 幂等提交、恢复为新版本；支持 Markdown/TXT 导入导出、不含模型凭据的 JSON 备份、恢复后证据可回查的新作品恢复和交互过程回放。
- **内置小说 Agent**：Provider 管理、任务模型路由、独立会话、流式进度、取消保留部分文本、结构化推敲与一致性报告。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

当前服务端套件覆盖领域事务、元素/RAG、工作流和本地模拟模型服务的 SDK 完整回合。引擎设计见 [内置 Agent 引擎](docs/AGENT-ENGINE.md)。产品设计基线见 [DESIGN.md](DESIGN.md)。

## 目录

```text
packages/shared   前后端共享领域类型
packages/server   SQLite 单写服务、HTTP API、检索、工作流、内置小说 Agent
packages/web      React/Tiptap/React Flow 本机 Web 界面
scripts           本机浏览器验收脚本
artifacts         实际页面截图与验收结果
```
