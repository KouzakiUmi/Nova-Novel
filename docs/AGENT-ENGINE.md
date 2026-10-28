# 内置 Agent 引擎、Provider 管理与任务路由

> 本文是 Nova Novel 的内置 Agent 设计。它取代旧方案中“启动本机 Pi CLI 子进程（RPC）”的做法。共享类型以 `packages/shared/src/index.ts` 中“内置 Agent 引擎”一节为准。

## 1. 目标

- Pi 作为 npm 依赖 `@earendil-works/pi-coding-agent@1.4.0` 在服务进程内运行（SDK `createAgentSession`），不查找、不启动用户机器上的 `pi` 命令，也不读取 `~/.pi`。
- 模型、鉴权、会话全部放在应用自己的数据目录。打包成 Windows 应用后，安装即用。
- Pi 按写小说改造：使用小说专用系统提示，禁用全部内置编码工具（read/bash/edit/write/grep/find/ls），只开放与任务绑定的只读小说资料工具。每个生成任务使用独立会话。
- 用户在“设置 › 模型与服务”里添加 OpenAI / Anthropic / Google 兼容的 provider，再为每类任务选择模型和思考强度。

## 2. 目录与环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NOVA_NOVEL_DATA_DIR` | `<仓库>/data` | 应用数据根目录；打包后指向 `%APPDATA%\Nova Novel` |
| `NOVA_NOVEL_DB_PATH` | `<数据目录>/nova-novel.sqlite` | 权威数据库。新文件不存在而旧的 `storyweave.sqlite` 存在时，直接打开旧文件，不改名也不复制 |
| `NOVA_NOVEL_WEB_ROOT` | `<仓库>/packages/web/dist` | 前端静态文件目录 |
| `NOVA_NOVEL_HOST` / `NOVA_NOVEL_PORT` | `127.0.0.1` / `43110` | 仅限回环地址 |

数据目录下的结构：

```text
<data>/agent/settings.json   provider（含密钥）与任务路由，应用自有格式，原子写入
<data>/agent/models.json     由 settings.json 生成，交给 Pi ModelRuntime 读取
<data>/agent/auth.json       Pi 凭据存储路径（应用当前不写入）
<data>/agent/sessions/<projectId>/   每个任务一份会话 JSONL
<data>/agent/workspace/      Pi 会话使用的空工作目录（cwd）
```

API Key 只保存在 `settings.json` 和生成的 `models.json` 中，不出现在任何 HTTP 响应、日志或诊断里。对外只返回 `hasApiKey`。

## 3. Provider 管理

- `providerId`：`^[a-z0-9][a-z0-9-]{1,40}$`，不能与 Pi 内置 provider 同名，避免悄悄覆盖内置配置。
- `api`：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。
- `baseUrl` 必须是 http(s) URL。`models` 至少一项；`contextWindow` 默认 128000，`maxTokens` 默认 8192，`reasoning` 默认 false。
- 修改后重新生成 `models.json` 并重建 `ModelRuntime`；正在运行的任务继续使用旧实例。
- 模型列表 `models` 包含：所有自定义模型，加上已有可用凭据的内置模型（例如通过环境变量提供 Key），后者标记 `source: "builtin"`。不列出没有凭据的内置模型。自定义模型可选 `thinkingLevelMap` 显式映射思考档位，`null` 表示不支持。
- “测试连接”：用该 provider 的指定模型（或第一个模型）发一条不含作品内容的极短请求，15 秒超时，返回耗时和截短的回复。失败时返回脱敏后的错误。
- “读取模型列表”：仅限 OpenAI 兼容类型，`GET {baseUrl}/models`，返回模型 ID 供用户勾选，不自动保存。

### HTTP 接口

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/agent/settings` | — | `AgentSettingsView` |
| `POST /api/agent/providers` | `{ providerId, ...ProviderUpsert }` | `AgentSettingsView`（201） |
| `PATCH /api/agent/providers/:id` | `Partial<ProviderUpsert>` | `AgentSettingsView` |
| `DELETE /api/agent/providers/:id` | — | `AgentSettingsView`；指向它的路由清空模型 |
| `POST /api/agent/providers/:id/test` | `{ modelId? }` | `ProviderTestResult` |
| `POST /api/agent/providers/:id/discover` | `{ baseUrl?, api?, apiKey? }`（未传的项用已存配置） | `{ models: ProviderModelInput[] }` |
| `PUT /api/agent/routes` | `{ routes: TaskRoute[] }` | `AgentSettingsView` |
| `GET /api/generate/progress?key=<idempotencyKey>` | — | `GenerationProgress` |
| `POST /api/generate/cancel` | `{ idempotencyKey }` | `{ task?: AgentTask }` |

## 4. 任务路由

`TaskRoute` 由 `kind`、`provider/modelId`、`thinkingLevel` 组成。默认思考强度：ideas `low`、rehearsal `low`、scene `medium`、polish `low`、consistency `high`、guide `low`；实际取值不超过模型支持的档位（非推理模型为 `off`）。任务没有配置模型时，退回第一个可用模型。完全没有可用模型时，连接状态为 `unconfigured`，生成返回明确的“请先在设置中添加模型”错误；写作、保存和版本功能不受影响。

## 5. 会话与执行

- 每次生成都用 `createAgentSession` 新建会话：`resourceLoader` 为应用自建（无扩展、技能、提示模板、上下文文件），系统提示为小说专用提示；`noTools: "builtin"` 加 `tools: ["novel_*"]` 与 `customTools`（只读小说工具）。SDK 1.4.0 的 `noTools: "all"` 同时禁用自定义工具，因此使用显式小说工具白名单；`SettingsManager.inMemory`，关闭压缩，自动重试最多 1 次；会话文件写入 `<data>/agent/sessions/<projectId>/`。
- 任务结束、失败或取消后释放会话（`dispose`）。会话 ID 记入生成结果。
- 运行中持续累计 `text_delta`，供 `/api/generate/progress` 查询；取消时调用 `session.abort()`，已收到的文本保留为 `partial`。
- 收到 `agent_settled` 后，再核对终止原因（aborted/length/error）、工具错误和必需产物，才把任务记为成功。
- 服务的请求超时不短于单次运行上限（10 分钟）。

## 6. 小说专用系统提示（要点）

- 身份：中文小说的合作者，只为作者提供可选的候选和提案，不替作者做决定。
- 资料的可信度从高到低：作者设定 / 已采用正文 > 选定计划（“拟发生”，不是已发生的事实） > 候选。不能把计划或候选写成既成事实。
- 遵守锁定决定、受保护原文和人物的知识边界；某个角色不知道的信息不能出现在他的视角里。
- 引入关键新事实（新人物、身份、死亡、物品易主、关系变化）时，不直接写进正文，而是放进 `proposals`。
- 资料不够时用只读工具查证；查不到就当作未知，不编造。
- 输出严格遵守任务格式，不写解释、前言或代码块。

### 各任务的输出格式

| kind | 模型输出 | `GenerationResultPayload` |
| --- | --- | --- |
| ideas | JSON `{cards:[{action,motivation,obstacle,outcome,focus,tradeoff}]}`，3 张卡，方向彼此不同 | `output:"ideas"` |
| rehearsal | 300–600 字的试写片段，纯文本 | `output:"rehearsal"` |
| scene | 接在当前正文末尾的新段落（不重复已有正文），纯文本 | `output:"continuation"`，`proposals` 可选 |
| polish | JSON `{replacement, proposals[]}`，`replacement` 只对应所选文字 | `output:"replacement"` |
| consistency | JSON `{summary, issues:[{severity,title,detail,evidence[]}]}` | `output:"report"`，与本地规则检查结果合并 |
| guide | `question` 为单道选择题 JSON；大纲 `proposal` 为三场景 JSON，工作流 `proposal` 为完整 WorkflowDefinition，均由宿主再次校验 | `output:"guide"` |

JSON 解析失败时，任务失败并保留原始产物，不把原文硬塞进正文。

## 7. 只读小说工具

工具绑定在任务冻结时的 `projectId / branch / revisionId / routeId`（以及故事顺序、视角），只能读不能写：

每次任务开始时建立数据库内存快照，工具在快照上复用知识服务检索；任务结束时关闭快照，运行中作者修改不会改变工具可见资料。

| 名称 | 作用 |
| --- | --- |
| `novel_search` | 按关键词检索可见证据、事实和选定计划（沿用 `queryContext`，受知识边界约束） |
| `novel_get_scene` | 读取当前修订中某一场的标题、目标、阻碍、预期结果／摘要和正文（长正文截断） |
| `novel_list_scenes` | 列出可见场景的顺序、目标、阻碍和预期结果／摘要，不含正文 |
| `novel_get_outline` | 读取冻结修订中的章节、可见场景、剧情节点与依赖边 |
| `novel_list_workflows` | 列出已注册的不可变工作流版本及节点类型 |
| `novel_get_workflow` | 按版本 ID 读取工作流节点、连线、输入映射与策略 |
| `novel_list_elements` | 列出元素（可按类型过滤）及摘要 |
| `novel_get_element` | 按 ID 或名称读取元素、别名和已确认事实 |
| `novel_world_state` | 读取某个故事时间点的物品持有、位置等状态 |

## 8. 取舍

- 进程内运行比子进程隔离弱：模型调用与领域服务在同一进程。好处是去掉了外部依赖和 CLI 版本漂移，且编码工具全部禁用，只留领域只读工具，暴露面更小。
- 自定义 provider 不能和内置 provider 同名，代价是不能直接改内置 provider 的地址；需要时添加一个兼容型 provider。
- API Key 以明文存放在用户自己的数据目录。这样无需系统凭据库也能使用；后续可接入 Windows 凭据管理器。

## 9. 交互式大纲

`guide` 任务只负责生成单道选择题或三场景提案。`GuidedOutlineService` 负责步骤、答案、问题缓存、恢复、取消和采用，连续性不依赖 Agent 会话历史。模型输出需通过宿主二次校验：问题必须对应当前步骤并含 2–4 个不同选项；提案必须恰好三场，字段和提案 ID 完整。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/guide/sessions` | 创建或恢复当前作品的引导会话，并生成当前步骤 |
| `POST /api/guide/sessions/:id/next` | 生成或复用当前步骤 |
| `POST /api/guide/sessions/:id/answer` | 保存选项、自定义回答或跳过，并推进 |
| `POST /api/guide/sessions/:id/back` | 返回上一步并恢复缓存问题，不重新生成 |
| `POST /api/guide/sessions/:id/cancel` | 取消会话，保留历史记录 |
| `PATCH /api/guide/sessions/:id/proposal` | 校验并持久化逐场编辑，不改变提案 ID |
| `POST /api/guide/sessions/:id/apply` | 采用提案，经 ChangeSet 与基础修订 CAS 新增场景并返回作品快照 |

`guide_sessions` 保存项目、分支、基础修订、步骤、答案、问题缓存和提案。`sceneAdditions` 是 ChangeSet 的可选部分，采用时校验场景、章节、路线与重复 ID；新增场景和剧情节点在同一修订中写入。采用使用稳定 `acceptanceId`，重复请求返回同一修订。两类会话都用 single-flight 与 revision 防止并发/迟到覆盖；迟到产物先按原任务终结归档，不写回旧会话。Agent 没有新增场景或修改工作流定义的工具。

## 10. 交互式工作流编排

`workflow_guide_sessions` 保存“写作意图 → 人工审阅方式 → 提案”的答案、问题缓存与工作流定义。Agent 只输出定义候选；`GuidedWorkflowService` 重新校验 schema、DAG、已知节点、输入映射、端口类型与必要结构，随后才能进入预览。发布与运行是两个独立动作。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/workflow-guide/sessions` | 创建或恢复编排会话 |
| `POST /api/workflow-guide/sessions/:id/next` | 生成或复用当前步骤 |
| `POST /api/workflow-guide/sessions/:id/answer` | 保存选项、自定义回答或跳过并推进 |
| `POST /api/workflow-guide/sessions/:id/back` | 返回上一步并恢复缓存 |
| `POST /api/workflow-guide/sessions/:id/cancel` | 取消编排，不注册提案 |
| `PATCH /api/workflow-guide/sessions/:id/proposal` | 校验并持久化节点名称与执行参数编辑，保持连线和版本 ID |
| `POST /api/workflow-guide/sessions/:id/publish` | 再次校验并注册不可变版本，不自动运行 |

宿主分配稳定的工作流与版本 ID，重复发布返回同一定义。缺少 `sceneId` 输入、生成、人工审阅或提交节点的提案不能注册；未知节点、端口不匹配、断开的输入和环同样拒绝。既有运行不受新发布版本影响。
