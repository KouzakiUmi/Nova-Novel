# 实现与验收状态

> 更新于 2026-10-28。设计与验收基线为 v1.1。本文件只记录当前代码和实际验证，不替代产品、领域与协议文档。

## 当前交付形态

仓库是可运行的 pnpm monorepo：`@nova-novel/shared`、`@nova-novel/server`、`@nova-novel/web`。生产模式下，本机 Node 服务同时提供同源 Web 页面和 JSON/SSE 接口。唯一的权威写入连接使用 better-sqlite3（SQLite WAL）。

Agent 内核是进程内的 Pi SDK（`@earendil-works/pi-coding-agent` 1.4.0，npm 依赖），不再查找或启动本机 `pi` 命令，也不读取 `~/.pi`。设计见[内置 Agent 引擎](<AGENT-ENGINE.md>)。

### 运行目录

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NOVA_NOVEL_DATA_DIR` | `<仓库>/data` | 数据根目录；打包后可指向 `%APPDATA%\Nova Novel` |
| `NOVA_NOVEL_DB_PATH` | `<数据目录>/nova-novel.sqlite` | 新库不存在而旧的 `storyweave.sqlite` 存在时，直接打开旧库 |
| `NOVA_NOVEL_WEB_ROOT` | `<仓库>/packages/web/dist` | 前端静态文件 |
| `NOVA_NOVEL_HOST` / `NOVA_NOVEL_PORT` | `127.0.0.1` / `43110` | 只允许回环地址 |

Agent 的配置、密钥、生成的 `models.json` 和会话 JSONL 都放在 `<数据目录>/agent/` 下。

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
- 自动保存、命名版本、分支、ChangeSet 和“恢复为新版本”；旧产物和迟到结果都保留。
- 创建作品时可同时提交第一场正文；作品、分支、选择草稿、场景与粘贴正文在同一个 SQLite 事务和初始修订中建立。
- `guide_sessions` 持久化交互大纲的步骤、答案、问题缓存与提案。ChangeSet 支持可选 `sceneAdditions`，采用大纲时校验作品头、章节、路线与重复 ID，场景和剧情节点在同一新修订中加入，稳定 `acceptanceId` 保证重复采用不重复创建。两类引导会话均有 next single-flight 与 revision 复核，取消、返回或新操作不会被迟到生成覆盖；生成失败后前端同步真实状态，未保存编辑由 dirty 标记保护。
- `workflow_guide_sessions` 持久化工作流编排的回答、缓存和定义提案。发布前再次校验定义并注册不可变版本，版本 ID 由宿主稳定分配；重复发布返回同一定义，既有运行不被修改或自动启动。
- 生成冻结：作品头、场景、计划、选择、写作意图与上下文快照；区分请求、执行尝试、网络幂等重投和显式复用。
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
- Provider 设置原子写入。没有密钥的本机服务写入占位密钥后，才能被分配为可用模型。错误信息会脱敏。
- 接口：`/api/agent/settings`、`/api/agent/providers[/:id[/test|/discover]]`、`/api/agent/routes`、`/api/generate/progress`、`/api/generate/cancel`、`/api/guide/sessions[/:id/next|answer|back|cancel|apply|proposal]`、`/api/workflow-guide/sessions[/:id/next|answer|back|cancel|publish|proposal]`。服务请求超时 660 秒，不短于单次运行上限。

## 已执行验证

### 静态检查与构建

- `pnpm -r typecheck`：通过。
- `pnpm -r build`：通过。

### 自动化测试

`pnpm --filter @nova-novel/server test`：**76/76 通过**。旧的 RPC 子进程协议测试已随 RPC 宿主一起移除。

| 范围 | 覆盖摘要 |
| --- | --- |
| 领域与 HTTP | 首次启动、正文 CAS、双 CAS 回滚、幂等采用、选择撤销、迟到结果、恢复、同源保护、SSE、生成冻结、作品与粘贴正文同事务创建 |
| 元素与检索 | K02–K07、K09、K14、K21–K23、二字人名/别名、FTS 派生索引、冲突分级 |
| 工作流 | DAG/类型/未知节点、布局哈希、人工恢复、输入变化、取消、条件合流、幂等决定、遍历与失败阻断 |
| Agent（14 项） | Provider CRUD 与密钥不外泄、清除密钥后本机模型仍可用、`models.json` 生成、思考档位钳制、本地假 OpenAI SSE 全回合（含工具调用，声明的工具恰为 9 个 `novel_*`）、JSON 成功/失败归档、两种取消接口保留部分文本、length/工具错误、未配置时写作正常、点子接口、知识快照与秘密过滤、WAL 文件库快照 |
| 交互大纲（2 项） | 选择题/custom/跳过、关闭后恢复、返回与缓存复用、逐场编辑持久化、三场景提案采用与幂等、ChangeSet 重复采用和过时提案拒绝 |
| 交互式工作流（2 项） | 回答与提案恢复、节点参数编辑持久化、不可变发布与重复发布、发布不自动运行、缺少人工审阅时拒绝注册 |

### 实际应用与浏览器

以临时数据目录、临时端口启动生产构建，配合本机假 OpenAI 兼容服务（`scripts/fake-openai.mjs`），用无头 Chrome 1440×1000 执行 `scripts/ui-smoke.mjs` 与补充脚本，结果如下：

- 设置页：provider 卡片可见，页面不含密钥；测试连接成功；编辑中文名称后保存；新增 provider 时读取模型列表并勾选；任务分配保存后写入 `settings.json`。
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

## 尚未完成或未实测

以下是当前交付边界，不能由上述测试推断为已通过：

1. 没有调用真实的外部模型服务；生成质量、费用、各家兼容细节（思考参数、工具调用格式）都还没有实测。所有生成验证都基于本地假服务。
2. Windows 安装包（Electron 或其他套壳、单实例、随机端口、配对令牌）尚未实现；数据目录环境变量已经就绪。
3. API Key 以明文存放在本机数据目录，尚未接入系统凭据库。
4. 语义向量通道未配置，当前是结构化查询加关键词检索，界面不冒充混合语义召回。
5. 作品重命名、归档与复制，章节和场景的新建/重命名等日常管理，把复盘决定直接转为下一场计划，TXT/Markdown/DOCX 导入导出，备份恢复，在工作流画布上自由增删节点或改连线：仍未形成用户闭环。可选的外部 CLI 适配器尚未交付。
6. 尚未实现 launcher 配对码、HttpOnly 会话和 CSRF 令牌；安全边界仍是回环监听、Host/Origin 校验和同源部署。
7. 性能目标、百万字数据集、完整 A01–A20/N01–N14/K01–K24、用户研究和可访问性全量审计尚未执行。任务开始时的数据库内存快照在大库上的内存开销尚未测量。

后续修改应优先保持不可变版本、候选与事实隔离、双 CAS、知识边界和人工提交语义，不以界面完成度替代上述验证。
