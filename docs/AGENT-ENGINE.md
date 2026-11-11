# 内置 Agent 引擎、Provider 管理与任务路由

> 本文是 Nova Novel 的内置 Agent 设计。它取代旧方案中“启动本机 Pi CLI 子进程（RPC）”的做法。共享类型以 `packages/shared/src/index.ts` 中“内置 Agent 引擎”一节为准。

## 1. 目标

- Pi 作为 npm 依赖 `@earendil-works/pi-coding-agent@1.4.0` 在服务进程内运行（SDK `createAgentSession`），不查找、不启动用户机器上的 `pi` 命令，也不读取 `~/.pi`。
- 模型、鉴权、会话全部放在应用自己的数据目录。打包成 Windows 应用后，安装即用。
- Pi 按写小说改造：使用小说专用系统提示，禁用全部内置编码工具（read/bash/edit/write/grep/find/ls），只开放与任务绑定的只读小说资料工具。每个生成任务使用独立会话。
- 用户在“设置 › 模型与服务”里添加 OpenAI / Anthropic / Google 兼容的 provider，再为每类任务选择模型和思考强度。

## 2. 目录与环境变量

Pi 目录给出 provider/model 元数据，Nova 另为每个可单 API Key 使用的预设提供 `envRefs` 和可选默认 `apiKeyEnv`。OpenCode Zen 使用 `OPENCODE_API_KEY`，OpenCode Go 使用 `OPENCODE_GO_API_KEY`，MiniMax CN 使用 `MINIMAX_CN_API_KEY`；其他服务使用各自标准变量名，未知 ID 回退为大写下划线加 `_API_KEY`。OAuth-only、Cookie/Session 或需要多项凭据的服务不硬套单 Key 候选。

`view.detectedProviders` 只返回 `{ preset, apiKeyEnv, hasApiKey }`，不返回变量值。检测按 provider 身份、URL 和已引用变量名排除重复项，候选必须由作者显式启用后才进入配置、模型路由和用量。

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
<data>/agent/auth.json       Pi OAuth/API Key 凭据存储路径
<data>/agent/volcengine.json 火山方舟套餐 profile 与公开身份摘要，不含密钥
<data>/agent/volcengine/accounts/<id>/ 每次登录独立的 ArkCli 身份目录
<data>/agent/sessions/<projectId>/   每个任务一份会话 JSONL
<data>/agent/workspace/      Pi 会话使用的空工作目录（cwd）
```

手动填写的 API Key 保存在 `settings.json` 和生成的 `models.json` 中；选择环境变量时只保存变量名，生成的 `models.json` 使用 `$ENV_VAR` 引用。两者都不出现在任何 HTTP 响应、日志或诊断里，对外只返回 `hasApiKey`、`keySource` 与 `apiKeyEnv`。

## 3. Provider 管理

- `providerId`：`^[a-z0-9][a-z0-9-]{1,40}$`，不能与 Pi 内置 provider 同名，避免悄悄覆盖内置配置。
- `api`：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`、`openai-codex-responses`、`mistral-conversations`、`bedrock-converse-stream`、`google-vertex`、`azure-openai-responses`、`pi-messages`。Pi provider 缺少顶层 `baseUrl` 时，从模型目录回退；Azure 使用带 `{resource}` 的可编辑占位地址。
- `baseUrl` 必须是 http(s) URL。`models` 至少一项；`contextWindow` 默认 128000，`maxTokens` 默认 8192，`reasoning` 默认 false。
- `keySource` 支持 `manual` 与 `environment`；环境变量名只接受大写字母、数字和下划线，值在使用时解析，不复制进设置文件。`disabled` 可持久化，禁用项保留在 providers 供恢复，但不进入 `models.json`、公开模型、任务路由或用量。
- 设置页通过 `builtinProviders()` 展示 Pi 自带 provider/model 目录。`agent/provider-metadata.ts` 独立保存 Pi 没有的插件元数据，目前合并 Command Code 模型扩展以及 OpenDesign CoRouter 的 plan/paid 模型目录、模态、容量和思考档位；这些分组是插件视图，不是上游计费承诺。
- 支持 OAuth 的内置 provider 直接调用 `ModelRuntime.login`；授权链接、设备码、手动授权码、取消和完成状态经本机接口交互，凭据由 Pi 写入 `auth.json`，不进入页面响应或日志。
- 修改后重新生成 `models.json` 并重建 `ModelRuntime`；正在运行的任务继续使用旧实例。
- 模型列表 `models` 只包含未禁用的显式配置；环境候选不会隐式变成可用模型。自定义模型可选 `thinkingLevelMap` 显式映射思考档位，`null` 表示不支持。内置目录的 `maxTokens` 按 `contextWindow` 归一化，避免上游输出上限大于上下文而阻止启用。OAuth 成功后创建 `my-*` 配置并写入 `authProviderId`，该自定义 ID 不进入 `models.json`，运行时沿用内置 OAuth 身份与模型；禁用配置会同时关闭其用量。
- “测试连接”：用该 provider 的指定模型（或第一个模型）发一条不含作品内容的极短请求，15 秒超时，返回耗时和截短的回复。失败时返回脱敏后的错误。
- 测试连接与导入协助的直接模型请求分别生成会话 ID；Pi 对 OpenCode 地址据此添加 `x-opencode-session`。常规生成使用任务会话的 ID。
- 服务商可独立开启代理并填写无凭据的 HTTP(S) 代理地址；留空读取服务进程的 `http_proxy` / `HTTP_PROXY`、`https_proxy` / `HTTPS_PROXY` 和 `no_proxy` / `NO_PROXY`。显式地址优先且不受环境 `NO_PROXY` 影响；环境代理未配置时请求失败，不静默直连。代理传输要求 Node.js 24.5 或更高版本，按请求隔离，不修改全局代理。
- 代理作用于模型推理、连接测试、模型发现和受支持的额度查询。Pi 的 Google、Vertex、Bedrock 适配器不支持注入传输，OAuth 凭据刷新也不受注入传输控制，因此这些模型开启代理时明确拒绝调用；ArkCli 额度查询在代理开启时拒绝执行。OAuth 登录本身不受此设置控制。关闭服务商代理时沿用进程默认网络行为；若进程另启用了全局代理，关闭开关不保证直连。
- “读取模型列表”：仅限 OpenAI 兼容类型，`GET {baseUrl}/models`，返回模型 ID 供用户勾选，不自动保存。

### 火山方舟双套餐

- `volcengine-agent-plan` 与 `volcengine-coding-plan` 使用独立模型快照和 `/api/plan`、`/api/coding` Anthropic Messages 端点。模型模态、上下文、输出、思考映射以及 `forceAdaptiveThinking`、`allowEmptySignature` 等兼容参数会写入 `models.json`。
- 可手动填写套餐 API Key，或使用环境变量。OAuth 复用官方 ArkCli `auth login --login-mode broker --credential-store encrypted-file`，当前仅开放 Windows ArkCli 1.0.37；CLI 启动系统默认浏览器，Nova 核验 `whoami/status` 后分别绑定个人套餐 profile，不读取其他应用的登录态。
- 每次登录使用 `agent/volcengine/accounts/<uuid>` 隔离 HOME/USERPROFILE/XDG_CONFIG_HOME，并清除继承的 Ark/Volc/AWS 凭据变量。`volcengine.json` 只保存 profile、目录和公开身份摘要，不保存 token。
- 同步模型时，Nova 在内存中执行 `profile apikey get`，将值放入当前进程的 `NOVA_VOLC_*_API_KEY`，settings/models 文件只保存变量引用。官方 CLI 自己负责其加密身份存储。
- OAuth 额度通过 `arkcli api usage.get_afp_usage/get_coding_plan_usage`；手动/环境变量模式通过 IAM AK/SK 签名 `GetAFPUsage/GetCodingPlanUsage`。推理 API Key 不用于管控面签名。Coding 保留 0–100 已用百分比，Agent 保留 AFP used/limit 与文本/全能力/日窗口分组。
- `NOVA_NOVEL_ARKCLI_PATH` 可指定官方原生可执行文件绝对路径；未配置时只在 PATH 查找，不自动安装 CLI。

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
| `POST /api/agent/oauth/:id` | — | 启动 OAuth，返回 `OAuthStatusView` |
| `GET /api/agent/oauth/:id` | — | 查询授权事件与状态 |
| `POST /api/agent/oauth/:id/code` | `{ code }` | 提交手动授权码 |
| `DELETE /api/agent/oauth/:id` | — | 取消登录 |
| `GET /api/agent/usage?refresh=true` | `refresh` 可选 | 脱敏的订阅窗口/余额；普通结果缓存 60 秒 |
| `GET /api/generate/progress?key=<idempotencyKey>` | — | `GenerationProgress` |
| `POST /api/generate/cancel` | `{ idempotencyKey }` | `{ task?: AgentTask }` |

### 只读订阅用量

`AgentUsageService` 只从未禁用的显式 provider 配置及其实际凭据读取 DeepSeek、OpenRouter、MiniMax、Z.ai、Kimi、OpenDesign、Codex、火山方舟 Agent/Coding Plan、OpenCode Go、SiliconFlow、Synthetic、NanoGPT、Novita、Hyperbolic、DeepInfra、Chutes、Ollama Cloud、Vercel AI Gateway、ZenMux 与 LiteLLM 的额度窗口/余额。不会从运行时环境额外补内置卡片，也不会借内置身份给无 Key 配置补额度；OAuth 配置通过 `authProviderId` 使用对应内置身份。仅返回脱敏的 `UsageReportView`，60 秒缓存，配置或实际凭据指纹变化即失效；禁用后立即从列表移除。没有凭据、接口不支持或读取失败只影响额度卡片，不改变模型路由。它不读取 DSH、Codex CLI、OpenDesign 桌面端或其他应用的凭据文件。

## 4. 任务路由

`TaskRoute` 由 `kind`、`provider/modelId`、`thinkingLevel` 组成。默认思考强度：ideas `low`、rehearsal `low`、scene `medium`、polish `low`、consistency `high`、guide `low`；实际取值不超过模型支持的档位（非推理模型为 `off`）。任务没有配置模型时，退回第一个可用模型，设置页和写作助手都显示该默认模型的实际名称。完全没有可用模型时，连接状态为 `unconfigured`，生成返回明确的“请先在设置中添加模型”错误；写作、保存和版本功能不受影响。

写作助手可为续写、推敲/扩写、检查/复盘直接切换模型；选择仍写入对应 `TaskRoute`，不是另一套临时路由。模型分配与正文共用生成前等待队列，路由保存未完成或失败时不会发起生成；在设置页重新成功保存后可继续。

全流程 AI 协助子任务默认**复用现有 6 类路由槽位**，不增加用户的模型配置负担：`element_design`（角色/世界观/秘密快速共创）与 `note_incubate`（便签孵化）复用 `ideas`；`element_design`（问答引导模式）、`arc_assist`（人物弧线推演与诊断）与 `plot_ideate`（局部情节推演）复用 `guide`；`extract_ledger`（正文反向抽取元素与状态事件）复用 `consistency`。

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
| `POST /api/guide/sessions/:id/apply` | 采用全部或指定 `proposalIds`，经同一 ChangeSet 与基础修订 CAS 新增场景并返回快照 |

`guide_sessions` 保存项目、分支、基础修订、步骤、答案、问题缓存和提案。采用可只选部分场景，至少一场；未选提案不进入作品。`sceneAdditions` 是 ChangeSet 的可选部分，采用时校验场景、章节、路线与重复 ID；新增场景和剧情节点在同一修订中写入。采用使用稳定 `acceptanceId`，重复请求返回同一修订。两类会话都用 single-flight 与 revision 防止并发/迟到覆盖；迟到产物先按原任务终结归档，不写回旧会话。Agent 没有新增场景或修改工作流定义的工具。

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

## 11. 人工审阅与退回说明

人工节点默认提供 `accept / revise / reject`。`POST /api/workflow-runs/:id/decision` 除 `todoId / answer / inputHash` 外可携带 `reviewNote`；退回修改说明随 `DecisionRecord` 持久化。`agent.generate` 新增可选 `decision` 输入，连接后可读取该说明，未连接时行为不变。接受提交仍必须通过真实人工决定、同源 candidate/draft、文本哈希和 decisionId 校验；退回或拒绝不会提交正文。

## 12. 全流程 AI 创作助手扩展契约（补充设计）

> 本节定义角色/世界观共创、人物弧线推演、全周期局部情节推演、便签孵化与正文反向抽取的引擎及接口契约。所有任务均在进程内 Pi SDK 独立会话中运行，只声明 9 个 `novel_*` 只读工具，默认复用既有 6 类 `TaskRoute` 槽位。

### 12.1 角色与世界观设定共创（`element_design` · 双模式）

支持 `character`、`location`、`organization`、`rule`、`item`、`secret` 六类元素的 AI 协助构思，提供两种可切换模式：

1. **快速卡片共创模式（默认，复用 `ideas` 路由）**：
   - 输入：`{ projectId, type?, targetEntityId?, prompt, roleHint?, relatedEntityIds? }`。
   - 模型输出：JSON `{ cards: ElementDesignCard[] }`（2–3 张在动机、代价或冲突方向上有实质差异的方案卡；宿主解析不接受 `candidates` 字段名）。
2. **一步步问答引导模式（复用 `guide` 路由，`element_guide_sessions`）**：
   - 由宿主状态机按元素类型推进 2–3 道结构化选择题（例如角色：`驱动力与欲望 → 核心弱点或秘密 → 与既有角色的关系张力 → 方案卡提案`；世界观规则：`核心机制 → 触发代价与限制 → 引发的社会/剧情困境 → 方案卡提案`）。
   - 每轮只生成一道选择题 JSON（含 2–4 个具体选项，支持自定义回答、跳过与返回上一步复用缓存），最后一步生成 `{ cards: ElementDesignCard[] }`。

`ElementDesignCard` 按类型包含可独立勾选、跨卡借用与手改的结构化字段：
- 通用字段：`proposalId`、`name`、`aliases[]`、`summary`、`differenceNote`、`proposedFacts[]`（`{ predicate, value, semanticType }`；`value` 可为文本或 `{ entityName }` 引用）。
- `character` 专属：`arc`（`{ motivation, goal, conflict, epiphany }`），采用时可同步写入 `character_arcs`。
- `rule` / `location` / `organization` / `item` 专属：`constraints[]`（限制与代价）、`sensoryDetails[]`（场景感官细节）、`storyHooks[]`（潜在剧情冲突钩子）。
- `secret` 专属：`truth`（`world_fact`）、`falseBelief`（表面假象/误信 `belief`）、`initialHolders[]`（写入 `known_by` 事件与边界事实，从 storyOrder 1 起对相应视角可见）、`revealCondition`（写入 `revealed` 事件与边界事实，对全部视角可见）。知识边界只有 `known_by`/`revealed` **事实**才会被检索消费，事件仅作时间线展示。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/assist/element-design` | 快速模式：直接生成 2–3 张元素设定方案卡并归档为 `candidate` 产物 |
| `POST /api/element-guide/sessions` | 引导模式：创建或恢复元素共创引导会话并生成当前步骤 |
| `POST /api/element-guide/sessions/:id/answer` | 保存选项、自定义回答或跳过并推进下一步 |
| `POST /api/element-guide/sessions/:id/back` | 返回上一步并恢复缓存问题，不重复调用模型 |
| `POST /api/assist/element-design/apply` | 采用选定方案（前端按「生成批次 artifactId + proposalId」生成确定性 `acceptanceId`），在同一 SQLite 事务中创建/更新元素（重名命中时合并到既有实体，保留原简介与来源）、`character_arcs` 与 `kw_facts`（`author_setting`）；方案卡的手改与跨卡借用由前端在提交前编辑，服务端不做独立 PATCH 持久化 |

### 12.2 人物弧线推演与进度诊断（`arc_assist` · 复用 `guide` 路由）

- **补全模式（`mode: "propose"`）**：针对已有角色简介或出场正文，生成 2 组不同走向的 `{ motivation, goal, conflict, epiphany, notes }` 弧线方案供作者选择或混搭。
- **对照诊断模式（`mode: "diagnose"`）**：对比角色在 `character_arcs` 中的预期计划与知识库中已发生的 `world_events` / 已写场景，输出结构化诊断 JSON `{ progressSummary, unfulfilledConflicts[], nextDilemmaProposals[] }`，作者可将两难建议一键转为便签或下一场计划。

### 12.3 全周期局部情节推演（`plot_ideate` · 复用 `guide` 路由）

在故事画布与写作页场景卡提供 4 种局部推演模式，均输出结构化场景提案 JSON `{ proposals: SceneProposalCard[] }`，产物保存为 `candidate`：

| `mode` | 输入上下文 | 产出与采用行为 |
| --- | --- | --- |
| `next_scene` | 基准 `sceneId`（含正文与可选复盘结论） | 生成 2–3 张承接前场的下一场计划卡；采用后经 `ChangeSet.sceneAdditions` 插入到基准场景之后 |
| `bridge_scenes` | `fromSceneId`、`toSceneId` | 分析两场之间的状态与因果缺口，生成 1–2 场过渡场景提案并插入中间 |
| `scene_brainstorm` | `sceneId`、锁定的已知字段、目标字段（`goal` / `conflict` / `summary`） | 针对单个缺失或卡壳的场景卡字段生成 3 个实质差异方案；采用后通过场景 CAS 更新 |
| `chapter_breakdown` | `chapterId`、章节构想摘要 | 将单章构想拆解为 2–4 场连续场景提案，支持逐场编辑与子集采用 |

### 12.4 创作便签 AI 孵化器（`note_incubate` · 复用 `ideas` 路由）

- `POST /api/notes/incubate`：接收 `{ noteIds: string[], targetKind: "character" | "world" | "scenes", hint? }`。
- 宿主读取所选便签标题、内容与标签，调用模型整合生成对应类型的结构化提案（复用 `ElementDesignCard[]` 或 `SceneProposalCard[]`）。
- 便签在采用前仍不进入正文、事实或 RAG；作者显式采用孵化提案后，对应便签状态更新为 `linked` 并绑定生成的元素或场景 ID。

### 12.5 正文反向抽取与时态账本同步（`extract_ledger` · 复用 `consistency` 路由）

- `POST /api/assist/extract-ledger`：针对指定 `sceneId`（或章节内已采用正文），扫描并输出 JSON `{ newElements[], factProposals[], eventProposals[] }`，每项必须携带正文原句 `quote`。
- **宿主防幻觉校验**：宿主在目标场景当前修订的正文段落中精确核对 `quote`，计算确定性 `evidenceId`；若 `quote` 在正文中不存在，则拒绝作为有效证据入库。
- `POST /api/assist/extract-ledger/apply`：请求必须携带 `{ projectId, sceneId, artifactId, selectedProposalIds, proposalEdits?, acceptanceId }`。宿主从冻结 `extracted_ledger` 产物取回提案，按选中项和允许字段编辑合并；`proposalId`、`quote`、`evidenceId` 不可由客户端改写。可分批采用同一产物，acceptanceId 与选集和修改内容绑定。元素、事实（`manuscript` 来源 + `evidenceId`）与状态事件在同一 SQLite 事务中写入；为关联元素推进修订时，证据与事实/事件引用同步重绑到新修订，并重建该修订索引，保证入库事实立即进入检索与一致性检查。仅换修订但正文未变时按区块与原句重绑，正文变化后拒绝旧提案。
