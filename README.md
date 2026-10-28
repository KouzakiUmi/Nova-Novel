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

### 添加模型服务

打开“设置 › 模型与服务”，添加 OpenAI、Anthropic 或 Google 兼容服务的地址、API Key 与模型，再为构思、试演、续写、推敲、一致性检查和交互大纲选择模型与思考强度。OpenAI 兼容服务可读取模型列表；测试连接只发送简短问候，不包含作品内容。

无需安装本机 `pi` 命令。服务在进程内运行锁定版本的 SDK，使用中文小说提示与九个只读资料工具，每个任务独立会话。API Key 明文保存在数据目录的 `agent/settings.json` 与派生的 `agent/models.json`，对外仅返回是否已配置；请保护数据目录。生成时，上下文发送至所选模型服务。

`NOVA_NOVEL_DATA_DIR` 可指定数据根目录，`NOVA_NOVEL_DB_PATH` 指定数据库，`NOVA_NOVEL_WEB_ROOT` 指定前端产物目录。未显式指定数据库且新库不存在时，会直接使用数据目录中已有的 `storyweave.sqlite`。

## 已实现的工作台

- **创作起步**：三入口、原创点子卡、选择/语义锁定/借用/手改/拒绝/撤销、不可变选择快照与采用计划双 CAS。
- **写作**：Tiptap 场景编辑、自动保存、选区任务、候选比较、原文变化提示、场景卡和可见上下文。
- **双画布**：剧情图/大纲/时间轴，工作流图/列表等价视图；布局与执行语义分离。
- **元素与检索**：稳定元素 ID、别名、事实/信念、状态事件、故事时间与叙述顺序、知识边界、FTS5 中文预分词、权威证据回查。
- **工作流**：不可变定义、严格 DAG 与端口校验、受控遍历、条件合流、人工待办、取消和重启恢复。
- **版本**：不可变清单、自动恢复点、命名版本、ChangeSet 幂等提交、恢复为新版本。
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
