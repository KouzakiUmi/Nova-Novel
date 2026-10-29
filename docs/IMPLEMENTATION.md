# 实现与验收状态

> 更新于 2026-10-29。设计与验收基线为 v1.1。本文件只记录当前代码和实际验证，不替代产品、领域与协议文档。

## 当前交付形态

仓库是可运行的 pnpm monorepo：`@nova-novel/shared`、`@nova-novel/server`、`@nova-novel/web`。生产模式下，本机 Node 服务同时提供同源 Web 页面和 JSON/SSE 接口。唯一的权威写入连接使用 better-sqlite3（SQLite WAL）。Windows 桌面版使用 Electron + electron-builder，支持 unpacked 和 NSIS x64 安装包。

Agent 内核是进程内的 Pi SDK（`@earendil-works/pi-coding-agent` 1.4.0，npm 依赖），不再查找或启动本机 `pi` 命令，也不读取 `~/.pi`。设计见[内置 Agent 引擎](<AGENT-ENGINE.md>)。

### 运行目录

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NOVA_NOVEL_DATA_DIR` | `<仓库>/data` | 数据根目录；打包后可指向 `%APPDATA%\Nova Novel` |
| `NOVA_NOVEL_DB_PATH` | `<数据目录>/nova-novel.sqlite` | 新库不存在而旧的 `storyweave.sqlite` 存在时，直接打开旧库 |
| `NOVA_NOVEL_WEB_ROOT` | `<仓库>/packages/web/dist` | 前端静态文件 |
| `NOVA_NOVEL_HOST` / `NOVA_NOVEL_PORT` | `127.0.0.1` / `43110` | 只允许回环地址；设为 `0` 时分配随机端口 |
| `NOVA_NOVEL_PAIR_TOKEN` | 未设置 | 桌面启动时生成；设置后 API 必须携带 `X-Nova-Novel-Token`，静态页面仍可加载 |

Agent 的配置、密钥、生成的 `models.json` 和会话 JSONL 都放在 `<数据目录>/agent/` 下。

### Windows 桌面安装包

- `electron/main.cjs` 使用单实例锁，以 `ELECTRON_RUN_AS_NODE=1` 启动本机服务，BrowserWindow 使用 sandbox/contextIsolation 并禁止站外导航；服务端口每次随机，配对令牌每次重新生成。退出时终止服务子进程。
- `scripts/package-windows.mjs` 负责构建、运行契约测试、`pnpm deploy --prod` 独立部署、Electron 原生模块重建和 electron-builder 打包。`dist:win:dir` 生成 unpacked，`dist:win` 生成 NSIS x64 安装包；`NOVA_NOVEL_ELECTRON_DIST` 可指定本地 Electron zip 或目录以支持离线构建。
- 桌面数据默认在 `%APPDATA%/Nova Novel`，也可由 `NOVA_NOVEL_DATA_DIR` 覆盖。令牌仅通过 URL hash 传给页面并写入 API 请求头，不进入日志或数据库。服务日志在数据目录 `logs/server.log`。
- 详见[Windows 桌面安装包](<PACKAGING.md>)。

### 品牌与图标

- 产品名为 Nova Novel。品牌记号是“从书页中升起的新星”：四芒星配暖金强调色 `--nova-accent`，书页使用主色绿。
- 图标集统一为 24 网格、1.6 描边、圆角端点，以四芒星作为共同记号。React 组件在 `packages/web/src/components/icons.tsx`（导航 7 项、模型与服务、provider、品牌记号）；独立 SVG 在 `packages/web/public/icons/`，`favicon.svg` 为深绿底应用图标，预览图为 `icons/preview.svg`。

### 前端

- 视觉方向是“安静的编辑室”：系统字体、纸面正文、细线工具区、绿色主操作，不下载字体。
- 起步：默认进入可跳过的创作起步。四步引导“起点 → 方向 → 可选试写 → 第一场”与真实卡片、试写和保存状态联动，并逐步说明作者决定与 AI 协助范围。新建作品支持模糊点子、粘贴片段和空白直接写，左侧可以切换作品；创建作品与粘贴正文在同一初始事务中保存。空白第一场显示三个可留空的问题。
- 点子卡：AI 已接入时，“找方向 / 换一组 / 只换”都按点子调用模型，并把已选和锁定的方向告诉模型；未接入时只提供示例卡，并引导去接入模型。卡片支持选择、锁定、借用、编辑、拒绝、撤销，以及采用为计划。试写显示进行中和失败状态，不会因关闭试写而丢失流程完成状态。
- 交互式大纲：创作起步和故事画布均可打开。Agent 每轮生成一道选择题，作者可选择、自己回答、跳过或返回；回答和问题缓存持久化，关闭后恢复，返回不重复生成。三张场景卡可逐场编辑并保存，采用时先保存当前编辑，再通过 ChangeSet 新增场景。
- 交互式工作流：工作流页可让 Agent 按写作意图和人工审阅方式生成节点与连线提案。应用强制校验 sceneId 输入、生成、人工审阅、提交、DAG 和端口类型；提案以画布预览，节点名称、任务类型、生成要求、人工审阅问题和检索提示均可逐个编辑并持久化，发布前再次校验。作者独立发布为不可变版本，发布不自动运行。
- 写作：
  - 场景卡可编辑目标、阻碍与预期结果／摘要，并显示“目标 → 阻碍 → 结果／变化”的拟发生行动线；复用现有 `Scene.summary`，没有新增永久场景类型。
  - 每次续写可选择“推进事件 / 反应与决定 / 对话与行动”，分别对应当次任务指令；选择不作为场景固定属性。场景复盘使用同一分级报告，讨论正文实际结果与可能的下一步，没有“采用”按钮或质量评分。
  - 选区位置按与正文保存相同的纯文本口径计算。推敲和扩写只替换所选的一段；原文变化导致找不到或无法唯一定位时，不应用并给出提示。
  - 续写只把新段落接到正文末尾。
  - 一致性检查单独显示为分级报告（冲突 / 未知 / 审美建议），没有“采用”按钮。
  - “再试一稿”沿用上一次的任务类型、要求和选区。
  - 生成过程中显示流式文字和调用过的资料工具，可以随时停止，已收到的文字保留为不完整候选。进度、候选和采用操作绑定发起场景；切换场景后，迟到结果仍在服务端归档，但不会显示或应用到另一场。
  - 场景列表支持搜索和章节折叠。
- 保存与版本：自动保存串行执行，并始终以最新分支头为基础；切换场景或离开写作页时，尚未进入请求的修改会先进入同一保存队列。场景卡保存同时携带编辑器当前正文，不会用快照旧正文覆盖未落库修改。保存后同步更新分支头和各场景基线。命名版本、恢复、采用计划和运行工作流前，会先等待在途保存完成，再重新读取作品头，避免 409 版本冲突。顶栏显示真实的保存状态和当前分支名。
- 工作流：画布和列表两种等价视图；运行中自动刷新；人工节点打开审阅对话框，显示草稿正文和检查结果，可接受或拒绝；可以取消运行。“检查连接”在本地校验节点和连线，节点可搜索，“查看全部”可用。
- 模型与服务：添加、编辑、删除 provider（OpenAI Chat Completions / Responses、Anthropic Messages、Gemini），内置 DeepSeek、OpenRouter、Ollama、LM Studio 预设；从 OpenAI 兼容服务读取模型列表并勾选；测试连接；为点子、试演、续写、推敲、检查、交互大纲六类任务分别选择模型和思考强度（档位范围取决于模型能力）。密钥不会回显，页面说明了模型能做什么、密钥存在哪里、会发送什么。
- 剧情画布、大纲、时间轴；元素概览、关系、时间线和证据。资料页可按来源筛选，“查看原文”跳转到对应场景；命令面板可直接打开场景。

### 领域宿主

- 不可变 blob、revision manifest、scene revision、artifact 与 context snapshot；SQLite 触发器阻止覆盖历史对象。
- 分支头与选择草稿双 CAS，任一项失败整体回滚；`acceptanceId` 绑定内容哈希并去重。
- 选卡、锁定、借用、编辑、拒绝和撤销都产生新的不可变选择快照，`selectionVersion` 与 `cardRevision` 单调递增。
- 自动保存、命名版本、分支、ChangeSet 和“恢复为新版本”；旧产物和迟到结果都保留。切作品、复制、导入、采用计划和运行工作流前显式 flush 编辑器并等待保存队列，保存头按作品维护，离场保存使用最新场景元数据。
- 创建作品时可同时提交第一场正文；作品、分支、选择草稿、场景与粘贴正文在同一个 SQLite 事务和初始修订中建立。
- `guide_sessions` 持久化交互大纲的步骤、答案、问题缓存与提案。ChangeSet 支持可选 `sceneAdditions`，采用大纲时校验作品头、章节、路线与重复 ID，场景和剧情节点在同一新修订中加入，稳定 `acceptanceId` 保证重复采用不重复创建。两类引导会话均有 next single-flight 与 revision 复核，取消、返回或新操作不会被迟到生成覆盖；生成失败后前端同步真实状态，未保存编辑由 dirty 标记保护。
- `workflow_guide_sessions` 持久化工作流编排的回答、缓存和定义提案。发布前再次校验定义并注册不可变版本，版本 ID 由宿主稳定分配；重复发布返回同一定义，既有运行不被修改或自动启动。
- 生成冻结：作品头、场景、计划、选择、写作意图与上下文快照；区分请求、执行尝试、网络幂等重投和显式复用。
- 作品可重命名、归档/恢复和复制。归档只修改项目元数据，不删除正文或历史，并阻止归档最后一个未归档作品；复制保留当前章节、场景计划、正文、路线和剧情节点，使用全新 ID 与独立初始修订，不复制元素事实、批注、便签或历史版本。
- 修订页提供交互过程回放：按白名单记录建议打开、候选呈现/关闭/采用、审阅打开/关闭和决定，只保存作品/场景、时间、操作来源与有限元数据，不保存正文或提示词。回放可筛选、打开来源场景并导出；采用率不作为写作质量指标。SQL 先过滤交互事件再分页，界面与导出可读取完整记录。原有 `/api/events` SSE 快照重连保持兼容。
- 支持 Markdown/TXT 导入与导出，以及不含 provider 设置、API Key、配对令牌或 OAuth 凭据的 JSON 备份。导入按章节/场景切分并在一个初始修订中创建；JSON 备份可恢复为新作品，重映射正文、路线、元素、事实、事件、证据、便签、批注和人物弧线，不覆盖原作品。恢复范围是当前快照，不恢复历史修订、任务运行、旧选择批次或工作流定义；不支持项会明确提示。全局工作流不随单作品备份导出。正文证据按作品、修订、场景、段落与内容生成确定 ID，恢复后的重索引保持事实/事件引用可回查；POV 兼容实体 ID、名称与别名。
- 人物弧线单独保存抽象欲望、具体目标、核心阻碍、预期变化和笔记，作为可修改计划，不自动成为世界事实；元素详情展示实际事件与来源场景供对照。
- 修订工作区分结构与语言两层：结构层处理目标、阻碍、实际结果和下一步决定；语言层显示句子长度、短段比例和重复开头，支持带当次意图的选区推敲。文本观察只作提示，不给正文评分。
- 正文批注支持评论、疑问和待办，绑定场景或选区原文锚点与哈希；解决/重开不创建修订，原文变化时保留批注并提示“锚点已变化”。
- 故事画布支持章节新建/重命名、场景新建/重命名、跨章移动与叙述顺序调整；结构操作通过 `structureChanges` 进入同一不可变清单，按目标位置插入并重排，旧修订 CAS 拒绝覆盖。
- 创作便签保存想法、疑问、对白和资料，支持标签、搜索、场景/元素关联、归档与恢复；便签编辑不创建修订，也不进入事实或 RAG。`POST /api/notes/:id/promote` 先保存编辑，再经 ChangeSet/CAS 创建计划场景，稳定 `note_<id>` 幂等。
- 写作页按当前正文、计划、候选和最近操作显示下一步行动条；行动条不调用模型。交互式大纲支持逐场编辑、选择加入或暂不加入、显示新增数量，至少选择一场后采用。人工审阅支持接受、退回修改和拒绝，退回说明随决定保存并可输入后续生成节点；不接受或退回不会提交正文。
- Provider 预设提供区分的默认环境变量名，检测本机变量后生成可启用的候选项；启用/禁用仅影响显式配置，模型路由与用量只跟随已启用 provider，不隐式启用环境里的其他服务。OAuth 登录创建 `my-*` 配置并以 `authProviderId` 复用内置身份，模型、路由和用量均可用。内置目录在添加 provider 编辑器中选择，模型旁显示写作初筛建议。
- 设置包含“界面与字体”：UI 默认内置 Inter + Noto Sans CJK，正文默认 Noto Serif CJK，可选 LXGW 文楷与正文字号；字体和 OFL 许可证随应用打包。外观设置持久化到应用数据目录的 `appearance.json`，跨随机端口重启可恢复；删除/启停用量卡片按当前配置过滤，旧慢响应不会回写。
- 人物、场景和作品表单按对象 ID 重建，异步响应按作品归属与独立序号验收。历史版本预览读取所选修订的真实清单。桌面导出统一携带配对令牌；窄窗口的助手、画布检查器和节点详情使用可开合侧栏，弹窗支持初始焦点、Tab 圈定、Escape 关闭与焦点归还。
- 同源与回环 Host/Origin 校验，1 MiB 请求体限制，统一的 JSON 错误格式，SSE 快照重连。

### 元素、检索与工作流

- SQLite 元素/别名/事实/事件/证据/场景引用/计划表；事实与角色信念分开存放。
- FTS5 只索引已采用的正文，中文按字预分词，并提供别名精确匹配。
- 按作品修订、路线、故事时间、叙述顺序和知识可见性过滤，命中后回查权威证据。
- 不可变工作流定义，严格的 DAG/端口/输入校验，受控遍历，条件合流，人工待办，取消，幂等决定，重启恢复；人工接受之前不会提交正文。提交决定必须来自真实人工节点并绑定同源候选及文本哈希，runInput 不能伪造；只有场景续写候选可提交，且在原正文末尾追加，报告等只读产物不能提交。审阅框按待办 candidate 输入显示。

### 内置 Agent

- 小说专用系统提示（`packages/server/src/agent/prompts.ts`）和六类任务模板。上下文以中文结构化分节呈现：作者设定、证据、拟发生的计划、锁定、受保护原文、场景卡（含预期结果／摘要）、正文、选区。场景任务会遵循单次行动／反应／对话意图，不被结构公式强制生成灾难或反转；交互大纲任务由宿主再次校验选择题步骤与提案结构。
- 声明给模型的工具只有 9 个只读工具：`novel_search`、`novel_get_scene`、`novel_list_scenes`、`novel_get_outline`、`novel_list_workflows`、`novel_get_workflow`、`novel_list_elements`、`novel_get_element`、`novel_world_state`。read/bash/edit/write 等编码工具不声明。工具从任务开始时的内存数据库快照读取，并按 project、branch、revision、route、故事顺序和视角限定范围，隐藏秘密。
- 每个任务使用独立会话，会话文件在 `<数据目录>/agent/sessions/<projectId>/`；任务结束后释放会话。
- ideas、polish、consistency 的产物严格按 JSON 解析（允许外面包着 ```json），解析失败时任务失败并保留原始产物。一致性报告会合并本地规则检查的结果；交给工作流的检查节点时，以结构化 JSON 传递。
- Provider 使用 Pi 内置目录和独立插件元数据扩展；支持手动密钥、环境变量引用、OAuth 登录、模型能力/思考档位和按任务路由。`provider-metadata.ts` 合并 Command Code 与 OpenDesign plan/paid 目录，`volcengine/` 实现火山方舟双套餐模型、ArkCli OAuth、模型同步和 AK/SK 或 OAuth 额度。环境变量值不写入设置文件或响应，手动密钥不回显。
- `AgentUsageService` 按已接入服务读取 DeepSeek、OpenRouter、MiniMax、Z.ai、Kimi、OpenDesign、Codex、火山方舟 Agent/Coding Plan、OpenCode Go、SiliconFlow、Synthetic、NanoGPT、Novita、Hyperbolic、DeepInfra、Chutes、Ollama Cloud、Vercel AI Gateway、ZenMux 与 LiteLLM 的订阅窗口/余额，普通结果缓存 60 秒；查询失败只影响额度卡片，不影响模型路由。
- 接口：`/api/agent/settings`、`/api/agent/providers[/:id[/test|/discover]]`、`/api/agent/routes`、`/api/agent/oauth/:id[/code]`、`/api/agent/usage`、`/api/generate/progress`、`/api/generate/cancel`、`/api/guide/sessions[/:id/next|answer|back|cancel|apply|proposal]`、`/api/workflow-guide/sessions[/:id/next|answer|back|cancel|publish|proposal]`。服务请求超时 660 秒，不短于单次运行上限。

## 已执行验证

### 静态检查与构建

- `pnpm -r typecheck`：通过。
- `pnpm -r build`：通过。

### 自动化测试

`pnpm --filter @nova-novel/server test`：**112/112 通过**。旧的 RPC 子进程协议测试已随 RPC 宿主一起移除。

| 范围 | 覆盖摘要 |
| --- | --- |
| 领域与 HTTP | 首次启动、正文 CAS、双 CAS 回滚、幂等采用、选择撤销、迟到结果、恢复、同源保护、SSE、生成冻结、作品与粘贴正文同事务创建 |
| 元素与检索 | K02–K07、K09、K14、K21–K23、二字人名/别名、FTS 派生索引、冲突分级 |
| 工作流 | DAG/类型/未知节点、布局哈希、人工恢复、输入变化、取消、条件合流、幂等决定、遍历与失败阻断、退回说明持久化 |
| Agent（23 项） | Pi/插件目录与模型元数据、Provider CRUD、手动/环境变量密钥不外泄、OAuth 交互状态、清除密钥后本机模型仍可用、`models.json` 生成、思考档位钳制、本地假 OpenAI SSE 全回合（9 个 `novel_*`）、JSON 成功/失败归档、两种取消、length/工具错误、未配置时写作正常、点子接口、知识快照与秘密过滤、WAL 快照、额度窗口/余额解析与缓存、火山方舟签名/双套餐 OAuth/独立 IAM 回退 |
| 交互大纲（3 项） | 选择题/custom/跳过、关闭后恢复、返回与缓存复用、逐场编辑持久化、子集采用与幂等、ChangeSet 重复采用和过时提案拒绝 |
| 交互式工作流（2 项） | 回答与提案恢复、节点参数编辑持久化、不可变发布与重复发布、发布不自动运行、缺少人工审阅时拒绝注册 |
| 下一步行动（1 项） | 空白场景、有计划未写、候选、过期候选、采用后复盘、报告后继续的状态映射 |
| 创作便签（2 项） | 创建/编辑不创建修订、场景关联与清空、归档恢复、转场景幂等、真实 HTTP 与 bootstrap 快照 |
| 结构管理（1 项） | 章节新增/重命名、场景创建、跨章插入移动与顺序归一化、旧修订 CAS 拒绝 |
| 正文批注（1 项） | 选区锚点与哈希、解决/重开、原文变化标记、批注不创建修订 |
| 分层修订（1 项） | 段落/句子/平均句长/短段比例、重复开头识别、空文本处理、观察不转为评分 |
| 人物弧线（1 项） | 弧线计划创建/更新不创建修订、实际知识库表名一致、人物与作品归属正确 |
| 导入导出（1 项） | Markdown 解析与空白分隔、单初始修订、Markdown 往返、备份不含凭据字段 |
| 交互回放（2 项） | 白名单事件、场景范围、顺序游标、决定元数据、不写入正文；SQL 先过滤再分页，超过 500 条域事件仍可完整导出；SSE 无 `projectId` 请求保持原协议 |
| 作品管理（2 项） | 重命名、归档/恢复、最后一个未归档作品保护、副本 ID/正文/修订独立，副本修改不污染原稿 |
| 备份恢复（1 项） | 恢复为新作品、场景/章节/路线/元素/事实/事件/证据引用重映射、便签/批注/人物弧线、POV 与重索引后证据 ID 保持、重复恢复、原作品不变 |
| POV HTTP（3 项） | 真实生成 HTTP 请求中，视角实体 ID、名称“阿禾”和别名“小禾”均解析为同一实体 ID；任务成功且 queryContext 作品/修订正确 |
| Provider 环境与用量（5 项） | Zen/Go/CN 默认变量名、检测安全与排重、启停和路由持久化、用量仅随启用配置、凭据变化缓存失效与错误脱敏、预设 token 上限归一化 |
| 写作建议（1 项） | 4.6/Gemini/DeepSeek 推荐、5.5 暂不优先、未知模型不绝对排名 |
| OAuth 配置（1 项） | 登录创建 `my-openai-codex` 与 `authProviderId`、内置模型可路由、身份用量、配置文件不含令牌 |
| 外观设置（1 项） | 默认字体、文楷与 110% 跨服务重启持久化、非法字号 400 且原设置不变 |

### 实际应用与浏览器

以临时数据目录、临时端口启动生产构建，配合本机假 OpenAI 兼容服务（`scripts/fake-openai.mjs`），用无头 Chrome 1440×1000 执行 `scripts/ui-smoke.mjs` 与补充脚本，结果如下：

- 设置页：provider 卡片可见，页面不含密钥；测试连接成功；编辑中文名称后保存；新增 provider 时读取模型列表并勾选；任务分配保存后写入 `settings.json`。
- 环境与外观：Zen/Go/MiniMax CN 默认变量名正确；Mistral 检测仅显示变量名，启用后用量只有 `my-mistral`，禁用消失、重新启用恢复；文楷与 110% 正文字号即时生效，控制台错误 0。用例在 `scripts/provider-appearance-smoke.mjs`，结果在 `artifacts/provider-appearance-run/report.json`，截图 `provider-settings.png` 与 `appearance-settings.png`。
- Provider 目录与额度：内置选择器含 45 个 Pi/插件 provider（另加默认选项共 46 项），覆盖 OpenCode Go、Mistral、Azure、Bedrock、火山方舟双套餐等；火山方舟编辑器提供 OAuth 和独立 AK/SK 字段。选择 DeepSeek 后保留模型元数据，切换环境变量密钥并成功保存和分配模型，假模型连接测试通过；`models.json` 只含 `$FAKE_API_KEY`，脱敏额度响应显示“剩余 75% / 12.50 CNY”，控制台错误 0。用例在 `scripts/provider-catalog-smoke.mjs`，结果在 `artifacts/provider-catalog-run/report.json`。
- 人机交互闭环：采用候选后行动条切换为“看看实际写出了什么”；交互大纲只加入两个场景，初始场景加采用场景共 3 个；工作流退回说明完整落库且修订数不变，审阅框问题优先、候选可折叠。用例在 `scripts/hci-workflow-smoke.mjs`，结果在 `artifacts/hci-workflow-run/report.json`，截图 `workflow-review-note.png`。
- 创作便签：无模型时创建、搜索、关联场景、归档和恢复均可使用；另一条便签由作者明确转为场景，初始场景加新场景共 2 个，便签状态为 linked。用例在 `scripts/notes-smoke.mjs`，结果在 `artifacts/notes-run/report.json`，截图 `notes-workspace.png`。
- 结构管理：在故事画布新建并重命名章节、创建场景，将既有场景移动到第二章第 2 位；最终两章、两个场景顺序正确，控制台错误 0。用例在 `scripts/structure-smoke.mjs`，结果在 `artifacts/structure-run/report.json`，截图 `story-structure.png`。
- 正文批注：真实选区创建批注、解决后重新打开；随后修改原文，面板显示“原文已变化，请重新确认这段批注”，控制台错误 0。用例在 `scripts/annotations-smoke.mjs`，结果在 `artifacts/annotations-run/report.json`，截图 `annotation-stale.png`。
- 分层修订：结构层修改场景目标并保存；语言层显示平均句长、短段比例和重复开头，设置表达意图后对真实选区生成推敲候选，控制台错误 0。用例在 `scripts/revision-smoke.mjs`，结果在 `artifacts/revision-run/report.json`，截图 `revision-language.png`。
- 人物弧线：编辑抽象欲望、具体目标、核心阻碍、预期变化和笔记并保存；元素详情显示实际事件对照，控制台错误 0。用例在 `scripts/character-arc-smoke.mjs`，结果在 `artifacts/character-arc-run/report.json`，截图 `character-arc.png`。
- 作品迁移：真实 Markdown 导入创建两个场景且只有一个初始修订；切换到导入作品后，Markdown 与 JSON 备份导出均成功，备份不含 API Key，控制台错误 0。用例在 `scripts/transfer-smoke.mjs`，结果在 `artifacts/transfer-run/report.json`，截图 `transfer-workspace.png`。
- 交互回放：真实候选生成与采用、工作流审阅退回后，回放按顺序显示“打开建议 → 出现候选 → 采用候选 → 打开审阅 → 退回修改”；导出 5 条事件，控制台错误 0。用例在 `scripts/interaction-smoke.mjs`，结果在 `artifacts/interaction-run/report.json`，截图 `interaction-replay.png`。
- 作品管理：重命名当前作品、创建只有一个初始修订的独立副本，再归档并恢复副本；界面当前作品与归档列表同步更新，控制台错误 0。用例在 `scripts/project-management-smoke.mjs`，结果在 `artifacts/project-management-run/report.json`，截图 `project-manager.png`。
- 备份恢复：使用应用实际导出的 JSON 备份恢复为新作品，正文、4 个元素、2 条事实、1 条便签、1 条批注和人物弧线均保留，原作品未改变；所有事实/事件证据 ID 均可在恢复后的知识库回查，备份不含全局工作流，控制台错误 0。用例在 `scripts/backup-restore-smoke.mjs`，结果在 `artifacts/backup-restore-run/report.json`，截图 `backup-restored.png`。真实文件输入恢复也已通过：`scripts/backup-ui-smoke.mjs` 选择 JSON 文件后激活新作品并显示范围提示，结果在 `artifacts/backup-ui-run/report.json`，截图 `backup-ui-restored.png`。
- 对象与版本状态：阿禾/父亲切换时弧线表单互不串写，历史版本显示命名时正文而非现稿，故事页切作品后可新建场景，控制台错误 0。用例在 `scripts/object-state-smoke.mjs`，结果在 `artifacts/object-state-run/report.json`，截图 `object-state.png`。
- 保存屏障：正文输入后立即切作品仍完整落库，保存新计划后立即离页不回退，复制包含最近正文和计划，控制台错误 0。用例在 `scripts/save-barrier-smoke.mjs`，结果在 `artifacts/save-barrier-run/report.json`，截图 `save-barrier.png`。
- 桌面与 UX：配对模式下 Markdown、JSON 备份和回放导出成功；1000px 窗口可打开助手和画布检查器；弹窗初始焦点、Escape 关闭与焦点归还通过，控制台错误 0。用例在 `scripts/desktop-ux-smoke.mjs`，结果在 `artifacts/desktop-ux-run/report.json`，截图 `desktop-ux.png`。
- 写作：续写候选接到正文末尾并自动保存；选中第三段推敲后只替换该段，段落数和开头不变；检查报告分级显示且没有采用按钮。
- 自动保存后立即“恢复为新版本”：成功，没有 409。
- 工作流：运行到人工节点，审阅框显示草稿正文与检查发现；“不接受”后运行结束且不提交，“接受并提交”后运行完成。
- 起步：按点子生成 3 张模型卡片。
- 取消：慢速流生成期间进度接口返回累计文字；取消后任务为 `cancelled / partial`，部分文字保留。
- 离开写作页回归：在 1.4 秒自动保存延迟内输入并立即切换页面，返回后正文仍在，且 `/api/bootstrap` 能读到已落库内容。该用例已加入 `scripts/browser-smoke.mjs`，脚本可自行导航到应用，不再要求预先打开页面。
- 双场景与场景卡回归：第一场慢速生成时切到第二场，旧进度与旧候选均不出现，第二场正文不变；场景卡保存会同时写入最新正文和场景目标。用例在 `scripts/editor-lifecycle-smoke.mjs`，结果在 `artifacts/editor-lifecycle-smoke.json`。
- 新手完整流程：无模型时从模糊点子创建自己的作品，查看四步人机分工，生成示例方向、选择并进入空白第一场，手写一句话并落库；再粘贴片段创建第二部作品内容，确认初始修订只有一个，并切回第一部作品验证正文保留。用例在 `scripts/onboarding-smoke.mjs`，结果在 `artifacts/onboarding-smoke.json`，截图包括 `onboarding-new-project.png`、`onboarding-flow.png` 和 `onboarding-blank-scene.png`。
- 场景级循环：编辑预期结果／摘要并落库；选择“反应与决定”后，假模型只有收到对应任务指令才返回特定候选，验证不是仅换按钮文案；场景复盘单独显示且没有采用按钮，候选和报告均未改动正文。用例在 `scripts/scene-workflow-smoke.mjs`，结果在 `artifacts/scene-workflow-smoke.json`，截图包括 `scene-workflow-card.png`、`scene-workflow-reaction.png` 和 `scene-workflow-review.png`。
- 交互式大纲：动态生成三道选择题，自定义第一题、修改第二题、跳过第三题，逐场编辑并保存后关闭恢复，采用后作品新增恰好三个场景且修改后的场景标题在画布可见。用例在 `scripts/guided-outline-smoke.mjs`，结果在 `artifacts/guided-outline-smoke.json`，截图包括 `guided-outline-proposal.png` 和 `guided-outline-applied.png`。
- 交互式工作流：选择写作意图和人工审阅方式，预览六节点七连线，修改生成节点的提示并保存后关闭恢复；发布为不可变版本时运行数不变，发布定义保留编辑提示，随后显式运行并生成对应的反应场文本，人工接受后产生新修订。用例在 `scripts/guided-workflow-smoke.mjs`，结果在 `artifacts/guided-workflow-smoke.json`，截图包括 `guided-workflow-proposal.png` 和 `guided-workflow-run.png`。
- 浏览器控制台无错误。截图在 `artifacts/`（settings、writing、start、revisions、workflow-review、story、elements、context）；结果在 `artifacts/ui-smoke.json`；图标预览在 `artifacts/icons-preview.png`。

验收期间发现并修复两个问题：一是 WAL 文件库序列化后无法在内存中打开（工具快照现在会改写日志模式标志）；二是没有密钥的本机 provider 不可分配。

### Windows 桌面验证

- `node scripts/test-packed-runtime.mjs`：真实进程分配随机回环端口，未配对 API 返回 403，配对后健康检查和 bootstrap 通过，静态页面可加载。
- 根依赖、锁文件、部署 manifest 与原生模块重建统一为 Electron 44.7.2。使用本地缓存生成 unpacked 后，真实桌面启动与未配对 403、配对健康检查和页面加载通过；`scripts/test-electron-lifecycle.mjs` 使用独立空闲调试端口关闭窗口，验证 `before-quit`、Electron 退出和服务停止，失败时清理进程树。当前页面截图在 `artifacts/final-provider-appearance-desktop.png`。
- `pnpm dist:win` 已生成 `Nova Novel Setup 0.1.0.exe`（178,874,704 bytes，x64 NSIS，SHA-256 `d97fbb30e39dd4f013ec704292f908b17526710d61e0fb45bc109c31a7e6f9a0`）。本机未配置代码签名证书，日志明确标记 signing is skipped；未声称安装包已签名或已运行安装向导。

## 尚未完成或未实测

以下是当前交付边界，不能由上述测试推断为已通过：

1. 没有调用真实的外部模型服务；生成质量、费用、各家兼容细节（思考参数、工具调用格式）都还没有实测。所有生成验证都基于本地假服务。OAuth 使用模拟登录交互验证，真实授权流程未执行；额度解析使用本地伪响应，未读取真实账户。
2. Windows 安装包已实现 unpacked 与 NSIS x64 输出；代码签名、自动更新、per-machine 安装和其他操作系统安装包尚未实现。
3. 手动填写的 API Key 以明文存放在本机数据目录，尚未接入系统凭据库；环境变量方式只保存变量名。
4. 语义向量通道未配置，当前是结构化查询加关键词检索，界面不冒充混合语义召回。
5. 把复盘决定直接转为下一场计划，DOCX 导入导出，在工作流画布上自由增删节点或改连线：仍未形成用户闭环。JSON 备份恢复仅覆盖当前快照，不恢复历史修订、任务运行、旧选择批次或工作流定义。可选的外部 CLI 适配器尚未交付。
6. 桌面启动已实现随机端口与配对令牌；HttpOnly 会话和 CSRF 令牌尚未实现，安全边界仍是回环监听、Host/Origin 校验和同源部署。
7. 性能目标、百万字数据集、完整 A01–A20/N01–N14/K01–K24、用户研究和可访问性全量审计尚未执行。任务开始时的数据库内存快照在大库上的内存开销尚未测量。

后续修改应优先保持不可变版本、候选与事实隔离、双 CAS、知识边界和人工提交语义，不以界面完成度替代上述验证。
