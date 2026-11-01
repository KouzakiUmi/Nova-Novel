# 实现与验收状态

> 更新于 2026-11-02。设计与验收基线为 v1.1。本文件只记录当前代码和实际验证，不替代产品、领域与协议文档。

## 当前交付形态

仓库是可运行的 pnpm monorepo：`@nova-novel/shared`、`@nova-novel/server`、`@nova-novel/web`（作者元信息统一为 `KouzakiUmi`，与 electron-builder `copyright` 及打包脚本一致）。生产模式下，本机 Node 服务同时提供同源 Web 页面和 JSON/SSE 接口。唯一的权威写入连接使用 better-sqlite3（SQLite WAL）。Windows 桌面版使用 Electron + electron-builder，支持 unpacked 和 NSIS x64 安装包。

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
- 图标系统「N² · 新星」：参考 Pi 标志由同尺寸方格、直角和分块上色构成的做法。品牌记号是 5×5 方格拼成的 N（N 占一个正方形，即 N 的平方），左竖、阶梯对角、右竖三块分别上色，右上角指数位是一颗暖金新星。功能图标为 24 网格、1.75 描边，主体里有一块实心方砖，新星固定在右上角指数位。图形数据唯一来源是 `packages/web/src/components/iconGeometry.ts`；React 组件在 `icons.tsx`（导航 8 项含便签、模型与服务、provider、品牌记号），独立 SVG、`favicon.svg`（深绿底应用图标）、预览图 `icons/preview.svg` 与 `build/icon.ico` 由 `node scripts/build-icons.mjs --ico` 生成（ICO 用本机 Chrome/Edge 无头渲染，可用 `NOVA_BROWSER` 指定）。已核对：16–256px 的 ICO 帧、预览图与本机应用侧栏渲染；尚未做安装包内的实机核对。

### 前端

- 视觉方向是“安静的编辑室”：内置字体、纸面正文、细线工具区、绿色主操作，不依赖在线字体服务。
- 首屏与导航（2026-11-02 UX 收敛）：作品已有正文时，起步页顶部显示「继续创作」面板，主按钮回到最近编辑（`updatedAt` 最新）的场景，次按钮进入故事画布；四步新手流程只在尚未写出正文时显示，点子区转为探索新方向。左侧导航分「创作」（起步、写作、故事、便签）与默认收起的「创作工具」（元素、资料、工作流、修订），工具按钮常驻 DOM、以 CSS 折叠，当前视图在工具组时自动展开；状态栏只显示版本名称，不外露修订 ID。已用本机 Chrome CDP 实测：继续写直达最近场景、工具组手动展开与激活自动展开、收起状态下工具视图仍可脚本导航；全仓 typecheck 与 web 生产构建通过，截图在 `artifacts/ux-review/`。
- 起步：默认进入可跳过的创作起步。四步引导“起点 → 方向 → 可选试写 → 第一场”与真实卡片、试写和保存状态联动，并逐步说明作者决定与 AI 协助范围。新建作品支持模糊点子、粘贴片段和空白直接写，左侧可以切换作品；创建作品与粘贴正文在同一初始事务中保存。空白第一场显示三个可留空的问题。
- 点子卡：AI 已接入时，“找方向 / 换一组 / 只换”都按点子调用模型，并把已选和锁定的方向告诉模型；未接入时只提供示例卡，并引导去接入模型。卡片支持选择、锁定、借用、编辑、拒绝、撤销，以及采用为计划。试写显示进行中和失败状态，不会因关闭试写而丢失流程完成状态。
- 交互式大纲：创作起步和故事画布均可打开。Agent 每轮生成一道选择题，作者可选择、自己回答、跳过或返回；回答和问题缓存持久化，关闭后恢复，返回不重复生成。三张场景卡可逐场编辑并保存，采用时先保存当前编辑，再通过 ChangeSet 新增场景。
- 交互式工作流：工作流页可让 Agent 按写作意图和人工审阅方式生成节点与连线提案。应用强制校验 sceneId 输入、生成、人工审阅、提交、DAG 和端口类型；提案以画布预览，节点名称、任务类型、生成要求、人工审阅问题和检索提示均可逐个编辑并持久化，发布前再次校验。作者独立发布为不可变版本，发布不自动运行。
- 写作：
  - 场景卡可编辑目标、阻碍、预期结果／摘要、视角（`pov`）与故事时间（`storyTime`），并显示“目标 → 阻碍 → 结果／变化”的拟发生行动线；支持单字段「AI 帮我想目标 / 阻碍 / 结果」局部脑暴。复用现有 `Scene.summary`，没有新增永久场景类型。
  - 每次续写可选择“推进事件 / 反应与决定 / 对话与行动”，分别对应当次任务指令；选择不作为场景固定属性。场景复盘使用同一分级报告，讨论正文实际结果与可能的下一步，没有“采用”按钮或质量评分，但提供「据此构思下一场」按钮直接带入复盘摘要推演下一场场景卡。
  - 助手侧栏支持「从本场提取设定与状态 (`extract_ledger`)」：自动扫描当前场景正文，展示带原文原句引用（`quote`）的新元素、属性事实与状态事件提案，幻觉引用自动过滤；当前以整单「全部确认入库」入账，逐项勾选尚未提供。入库在事务中写入并重建修订索引，事实立即进入检索与一致性检查。
  - 选区位置按与正文保存相同的纯文本口径计算。推敲和扩写只替换所选的一段；原文变化导致找不到或无法唯一定位时，不应用并给出提示。
  - 续写只把新段落接到正文末尾。
  - 一致性检查单独显示为分级报告（冲突 / 未知 / 审美建议），没有“采用”按钮。
  - “再试一稿”沿用上一次的任务类型、要求和选区。
  - 生成过程中显示流式文字和调用过的资料工具，可以随时停止，已收到的文字保留为不完整候选。进度、候选和采用操作绑定发起场景；切换场景后，迟到结果仍在服务端归档，但不会显示或应用到另一场。
  - 场景列表支持搜索和章节折叠。
- 保存与版本：自动保存串行执行，并始终以最新分支头为基础；切换场景或离开写作页时，尚未进入请求的修改会先进入同一保存队列。场景卡保存同时携带编辑器当前正文，不会用快照旧正文覆盖未落库修改。保存后同步更新分支头和各场景基线。命名版本、恢复、采用计划、运行工作流和发起生成前，会先等待在途保存与模型路由写入完成，再读取作品头或冻结生成上下文，避免 409 版本冲突及基于旧正文生成。顶栏显示真实的保存状态和当前分支名。保存失败时，未确认的正文与场景卡字段按作品和场景保留为本地草稿：提示条显示具体原因，可查看、复制，或「读取最新版本→比较→确认」后再写入；恢复重试保留整张场景卡。409 不自动重试，网络类错误最多重试 3 次；任一场失败优先于其他场成功显示。所有快照提交统一校验激活序号、请求序号与作品归属，切作品后旧响应不会覆盖当前界面。写作页正文按纯文本保存，格式按钮已禁用并说明。资料检索按作品与场景重建状态，中文输入法组合输入期间不触发检索。
- 工作流：画布和列表两种等价视图；运行中自动刷新；人工节点打开审阅对话框，显示草稿正文和检查结果，可接受或拒绝；可以取消运行。“检查连接”在本地校验节点和连线，节点可搜索，“查看全部”可用。
- 模型与服务：添加、编辑、删除 provider（OpenAI Chat Completions / Responses、Anthropic Messages、Gemini），内置 DeepSeek、OpenRouter、Ollama、LM Studio 预设；从 OpenAI 兼容服务读取模型列表并勾选；测试连接；为点子、试演、续写、推敲、检查、交互大纲六类任务分别选择模型和思考强度（档位范围取决于模型能力）。写作助手也可直接为续写、推敲/扩写、检查/复盘切换模型，复用并保存同一路由；默认项显示实际模型名，生成前等待路由写入。密钥不会回显，页面说明了模型能做什么、密钥存在哪里、会发送什么。
- 剧情画布、大纲、时间轴；元素概览、关系、时间线和证据。资料页可按来源筛选，“查看原文”跳转到对应场景；命令面板可直接打开场景和元素，并支持回车打开首个结果。故事画布内嵌「AI 局部情节推演」面板（承接前场生成下一场、两场之间过渡桥接、单场字段急救、单章拆解细纲），场景结构编辑抽屉支持直接编辑 `pov` 与 `storyTime`，场景状态按计划、写作、待审阅和定稿正确显示。
- 元素账本可新建角色、物品、地点、规则、组织与秘密，填写名称、简介和别名；选中元素后可在概览页修改名称、简介与别名（编辑框全量同步，删除别名保存后生效），并在详情页可视化新增属性事实（含关系事实）、秘密知情区间（`known_by` / `revealed`）与状态事件（`WorldEvent`）；秘密的 `known_by` / `revealed` 录入（含 AI 秘密卡的初始知情者与揭示条件）会同时写入边界事实与展示事件，「查询时点」知识边界真实生效，故事时点支持纯数字序号。支持双模式「AI 元素共创」：默认快速生成 2–3 张可跨卡借用字段的方案卡，也可切换 3 步问答引导模式生成并审阅入库。人物弧线面板支持 AI 推演弧线方案卡（可跨卡借用）与「计划 vs 实际事件」对照诊断（支持一键存为便签）。创作便签页支持勾选多条便签进行「多便签 AI 孵化」（整合为角色设定卡、世界观设定卡或串联场景卡）。

### Notion 外部笔记 Copilot

- 侧栏「Notion 笔记」提供默认关闭的独立可选模块，前端按需加载；连接设置、Agent 发现、连续对话、临时回复、历史恢复、复制与远端停止均已实现。
- 服务只访问 Notion 官方 Agent 会话接口，固定 API 版本 `2026-03-11`，不接入小说任务路由、Pi 工具、作品 SQLite 或 RAG。配置和对话 JSON 单独保存于 `<data>/plugins/notion-copilot/`，环境变量仅保留引用名，手动令牌仅存服务内存。
- SSE 临时文字不落盘；已提交回复按事件 ID 去重。断流回查状态和事件，不自动重发消息。未确认远端停止时显示 interrupted，重启后的在途会话也不自动续发。Notion 所需操作确认只展示提示，不自动批准。
- 本模块随应用构建和注册，尚无通用第三方插件包安装、热加载机制。原有 `notion-sync.ts` 未注册，笔记不会导入 Novel 便签。
- 接入前提、接口与操作说明见 [Notion 外部笔记 Copilot](<NOTION-COPILOT.md>)。真实 Notion Agent、API 授权和额度消耗仍未实测；桌面应用登录不等于 API 授权。

### 领域宿主

- 不可变 blob、revision manifest、scene revision、artifact 与 context snapshot；SQLite 触发器阻止覆盖历史对象。
- 分支头与选择草稿双 CAS，任一项失败整体回滚；`acceptanceId` 绑定内容哈希并去重。
- 选卡、锁定、借用、编辑、拒绝和撤销都产生新的不可变选择快照，`selectionVersion` 与 `cardRevision` 单调递增。
- 自动保存、命名版本、分支、ChangeSet 和“恢复为新版本”；旧产物和迟到结果都保留。切作品、复制、导入、采用计划、运行工作流和发起生成前显式 flush 编辑器并等待保存队列及模型路由写入，保存头按作品维护，离场保存使用最新场景元数据；草稿重试保留正文与场景卡字段。
- 创建作品时可同时提交第一场正文；作品、分支、选择草稿、场景与粘贴正文在同一个 SQLite 事务和初始修订中建立。
- `guide_sessions` 持久化交互大纲的步骤、答案、问题缓存与提案。ChangeSet 支持可选 `sceneAdditions`，采用大纲时校验作品头、章节、路线与重复 ID，场景和剧情节点在同一新修订中加入，稳定 `acceptanceId` 保证重复采用不重复创建。两类引导会话均有 next single-flight 与 revision 复核，取消、返回或新操作不会被迟到生成覆盖；生成失败后前端同步真实状态，未保存编辑由 dirty 标记保护。
- `workflow_guide_sessions` 持久化工作流编排的回答、缓存和定义提案。发布前再次校验定义并注册不可变版本，版本 ID 由宿主稳定分配；重复发布返回同一定义，既有运行不被修改或自动启动。
- 生成冻结：作品头、场景、计划、选择、写作意图与上下文快照；区分请求、执行尝试、网络幂等重投和显式复用。
- 作品可重命名、归档/恢复和复制。归档只修改项目元数据，不删除正文或历史，并阻止归档最后一个未归档作品；复制保留当前章节、场景计划、正文、路线和剧情节点，使用全新 ID 与独立初始修订，不复制元素事实、批注、便签或历史版本。
- 修订页提供交互过程回放：按白名单记录建议打开、候选呈现/关闭/采用、审阅打开/关闭和决定，只保存作品/场景、时间、操作来源与有限元数据，不保存正文或提示词。回放可筛选、打开来源场景并导出；采用率不作为写作质量指标。SQL 先过滤交互事件再分页，界面与导出可读取完整记录。原有 `/api/events` SSE 快照重连保持兼容。
- 支持 Markdown/TXT 导入与导出，以及不含 provider 设置、API Key、配对令牌或 OAuth 凭据的 JSON 备份。导入按多章节/场景切分并在一个初始修订中创建：除 `#`/`##`/`---` 标记外识别“第X章/卷/节（场）、Chapter N、楔子/序章/番外”等标题，章内 `---`/`***` 分场；`/api/import` 兼容原 text 直传与预览后的 chapters 确认两种输入，相关端点 body 上限 20 MiB（文本仍限 1 MiB 字符、500 场）。可选「AI 协助分章」（`EmbeddedAgentHost.assistImport`，复用 guide 路由、`completeSimple`、不建作品任务）：本地收集疑似标题行（分隔行除外），模型只判断章/场边界并命名，正文由本机按行号切片，模型不接触全文、不改写正文，幻觉行号直接丢弃；失败或未接入时回退本地规则并在预览中提示。起步页与修订页共用导入对话框：先预览章/场/字数与分章来源、可编辑章标题，作者确认后才创建新作品并切换到首场。JSON 备份可恢复为新作品，重映射正文、路线、元素、事实、事件、证据、便签、批注和人物弧线，不覆盖原作品。恢复范围是当前快照，不恢复历史修订、任务运行、旧选择批次或工作流定义；不支持项会明确提示。全局工作流不随单作品备份导出。正文证据按作品、修订、场景、段落与内容生成确定 ID，恢复后的重索引保持事实/事件引用可回查；POV 兼容实体 ID、名称与别名。
- 作者可经 `POST /api/elements` 与 `PATCH /api/elements/:id` 录入与修改元素，也可经 `POST /api/elements/:id/facts` 与 `POST /api/elements/:id/events` 直接追加属性事实、关系、秘密知情区间（`known_by` / `revealed`）及状态事件：类型与故事路线按当前作品校验，跨作品或不存在返回 404，名称与简介长度受限，别名最多 20 个。元素与事实作为作者设定写入知识库并立即进入检索与一致性检查。ChangeSet 提交的已确认事实由作者设定事实同步写入 `kw_facts`，重复提交幂等。
- `CreativeAssistService` 与 `ElementGuideService`（`packages/server/src/assist.ts`）提供全流程 AI 创作助手能力：
  - 元素共创：快速方案卡模式（`POST /api/assist/element-design` + `/apply`）与持久化 3 步问答引导模式（`element_guide_sessions` 表，支持 `next` single-flight、问题缓存、`back`、`custom`/`skip` 与幂等 `apply`）。
  - 人物弧线推演与对照诊断（`POST /api/assist/arc`，`mode: "propose" | "diagnose"`）。
  - 局部情节推演（`POST /api/assist/plot-ideate` + `/apply`，覆盖 `next_scene`、`bridge_scenes`、`scene_brainstorm`、`chapter_breakdown`）：采用时支持 `afterSceneId` 定点插入与单字段局部更新。
  - 多便签孵化（`POST /api/notes/incubate` + `/apply`，支持孵化为 `character`、`world` 或 `scenes` 并自动标记源便签 `linked`）。
  - 正文反向抽取（`POST /api/assist/extract-ledger` + `/apply`）：强制在目标场景正文段落中精确子串核验 `quote`，匹配后按确定性算法绑定 `evidenceId` 写入新元素、事实与事件，幻觉引用自动标记为不可入账。
- 人物弧线单独保存抽象欲望、具体目标、核心阻碍、预期变化和笔记，作为可修改计划，不自动成为世界事实；元素详情展示实际事件与来源场景供对照。
- 修订工作区分结构与语言两层：结构层处理目标、阻碍、实际结果和下一步决定；语言层显示句子长度、短段比例和重复开头，支持带当次意图的选区推敲。文本观察只作提示，不给正文评分。
- 正文批注支持评论、疑问和待办，绑定场景或选区原文锚点与哈希；解决/重开不创建修订，原文变化时保留批注并提示“锚点已变化”。
- 故事画布支持章节新建/重命名、场景新建/重命名（含 `pov`、`storyTime` 与 `afterSceneId` 定点插入）、跨章移动与叙述顺序调整；结构操作通过 `structureChanges` 进入同一不可变清单，按目标位置插入并重排，旧修订 CAS 拒绝覆盖。
- 创作便签保存想法、疑问、对白和资料，支持标签、搜索、场景/元素关联、归档与恢复；便签编辑不创建修订，也不进入事实或 RAG。`POST /api/notes/:id/promote` 先保存编辑，再经 ChangeSet/CAS 创建计划场景，稳定 `note_<id>` 幂等。
- 写作页按当前正文、计划、候选和最近操作显示下一步行动条；行动条不调用模型。交互式大纲支持逐场编辑、选择加入或暂不加入、显示新增数量，至少选择一场后采用。人工审阅支持接受、退回修改和拒绝，退回说明随决定保存并可输入后续生成节点；不接受或退回不会提交正文。
- Provider 预设提供区分的默认环境变量名，检测本机变量后生成可启用的候选项；启用/禁用仅影响显式配置，模型路由与用量只跟随已启用 provider，不隐式启用环境里的其他服务。OAuth 登录创建 `my-*` 配置并以 `authProviderId` 复用内置身份，模型、路由和用量均可用。内置目录在添加 provider 编辑器中选择，模型旁显示写作初筛建议。
- 设置包含“界面与字体”：UI 与正文分别提供完整字体选择。UI 默认 Noto Sans CJK（可变字重，Inter 只在缺拉丁字形时兜底），正文默认随包霞鹜文楷 Medium（500，另可选 Regular），均可选文楷、本机霞鹜新晰黑、更纱黑体 UI SC 与等线/系统黑体；缺字体时回退到内置文楷或黑体，不使用宋体。导航、按钮、设置项、面板标题与可编辑输入框使用 UI 字体，正文、候选与证据引文等渲染内容以及创作内容标题使用阅读字体；字重收敛为 400/500/600，默认辅助字 13px、控件 14px、导航 15px；正文默认 18px，候选、试写与证据使用正文字号倍率。UI 字号（90%–130%）与正文字号（90%–120%）独立设置，内置字体与许可随应用打包，本机阅读字体只引用不复制。外观设置持久化到应用数据目录的 `appearance.json`，跨随机端口重启可恢复；写入只保留四个已知字段，旧文件中的未知字体值回退为内置；删除/启停用量卡片按当前配置过滤，旧慢响应不会回写。
- 人物、场景和作品表单按对象 ID 重建，异步响应按作品归属与独立序号验收。历史版本预览读取所选修订的真实清单。桌面导出统一携带配对令牌；作品管理提供未归档作品列表，窄窗口也能切换作品；故事结构、助手、画布检查器和节点详情使用可开合侧栏，宽屏检查器与节点详情同样可收起，任务分配网格在窄窗口换行而不裁剪模型选择。弹窗支持初始焦点、Tab 圈定、Escape 关闭与焦点归还。
- 同源与回环 Host/Origin 校验，1 MiB 请求体限制，统一的 JSON 错误格式，SSE 快照重连。

### 元素、检索与工作流

- SQLite 元素/别名/事实/事件/证据/场景引用/计划表；事实与角色信念分开存放。
- FTS5 只索引已采用的正文，中文按字预分词；二字人名与别名与普通词同样经 FTS 召回，证据行另记录提及到的实体 ID 供知识边界判断，但不参与检索排序。
- 按作品修订、路线、故事时间、叙述顺序和知识可见性过滤，命中后回查权威证据。
- 不可变工作流定义，严格的 DAG/端口/输入校验，受控遍历，条件合流，人工待办，取消，幂等决定，重启恢复；人工接受之前不会提交正文。提交决定必须来自真实人工节点并绑定同源候选及文本哈希，runInput 不能伪造；只有场景续写候选可提交，且在原正文末尾追加，报告等只读产物不能提交。审阅框按待办 candidate 输入显示。

### 内置 Agent

- 小说专用系统提示（`packages/server/src/agent/prompts.ts`）和六类任务模板（并支持按 `assistantTask` 扩展协议生成元素共创、问答引导、弧线推演/诊断、局部情节推演、多便签孵化与正文反向抽取，复用既有 6 类任务路由槽位）。上下文以中文结构化分节呈现：作者设定、证据、拟发生的计划、锁定、受保护原文、场景卡（含预期结果／摘要）、正文、选区。场景任务会遵循单次行动／反应／对话意图，不被结构公式强制生成灾难或反转；交互大纲与元素问答引导任务由宿主再次校验选择题步骤与提案结构。
- 声明给模型的工具只有 9 个只读工具：`novel_search`、`novel_get_scene`、`novel_list_scenes`、`novel_get_outline`、`novel_list_workflows`、`novel_get_workflow`、`novel_list_elements`、`novel_get_element`、`novel_world_state`。read/bash/edit/write 等编码工具不声明。工具从任务开始时的内存数据库快照读取，并按 project、branch、revision、route、故事顺序和视角限定范围，隐藏秘密。
- 每个任务使用独立会话，会话文件在 `<数据目录>/agent/sessions/<projectId>/`；任务结束后释放会话。
- ideas、polish、consistency 的产物严格按 JSON 解析（允许外面包着 ```json），解析失败时任务失败并保留原始产物。一致性报告会合并本地规则检查的结果；交给工作流的检查节点时，以结构化 JSON 传递。
- Provider 使用 Pi 内置目录和独立插件元数据扩展；支持手动密钥、环境变量引用、OAuth 登录、模型能力/思考档位和按任务路由。`provider-metadata.ts` 合并 Command Code 与 OpenDesign plan/paid 目录，`volcengine/` 实现火山方舟双套餐模型、ArkCli OAuth、模型同步和 AK/SK 或 OAuth 额度。环境变量值不写入设置文件或响应，手动密钥不回显。
- `AgentUsageService` 按已接入服务读取 DeepSeek、OpenRouter、MiniMax、Z.ai、Kimi、OpenDesign、Codex、火山方舟 Agent/Coding Plan、OpenCode Go、SiliconFlow、Synthetic、NanoGPT、Novita、Hyperbolic、DeepInfra、Chutes、Ollama Cloud、Vercel AI Gateway、ZenMux 与 LiteLLM 的订阅窗口/余额，普通结果缓存 60 秒；查询失败只影响额度卡片，不影响模型路由。
- 接口：`/api/agent/settings`、`/api/agent/providers[/:id[/test|/discover]]`、`/api/agent/routes`、`/api/agent/oauth/:id[/code]`、`/api/agent/usage`、`/api/generate/progress`、`/api/generate/cancel`、`/api/guide/sessions[/:id/next|answer|back|cancel|apply|proposal]`、`/api/workflow-guide/sessions[/:id/next|answer|back|cancel|publish|proposal]`、`/api/element-guide/sessions[/:id/next|answer|back|cancel|apply|proposal]`、`/api/assist/element-design[/apply]`、`/api/assist/arc`、`/api/assist/plot-ideate[/apply]`、`/api/notes/incubate[/apply]`、`/api/assist/extract-ledger[/apply]`。服务请求超时 660 秒，不短于单次运行上限。

## 已执行验证

### 静态检查与构建

- `pnpm -r typecheck`：通过。
- `pnpm -r build`：通过。

### 自动化测试

`pnpm test`：**167/167 服务端测试通过**，其中新增 15 条 Notion Copilot 测试；共享包与前端包的 Node 测试入口当前没有测试用例，前端流程另由真实 Chromium 脚本验证。`pnpm build`（含三个包的 TypeScript 编译）、`node scripts/test-notion-copilot-ui.mjs` 和 `node scripts/test-packed-runtime.mjs` 均通过。既有服务端基线为 152 条；旧的 RPC 子进程协议测试已随 RPC 宿主一起移除，全流程 AI 创作助手闭环测试位于 `packages/server/test/assist.test.ts`。

| 范围 | 覆盖摘要 |
| --- | --- |
| 领域与 HTTP | 首次启动、正文 CAS、双 CAS 回滚、幂等采用、选择撤销、迟到结果、恢复、同源保护、SSE、生成冻结、作品与粘贴正文同事务创建 |
| 元素与检索 | K02–K07、K09、K14、K21–K23、二字人名/别名、FTS 派生索引、冲突分级；秘密 `known_by`/`revealed` 只在生效区间可见（过去、到期、时点未知均不泄漏）；正文来源事实须有当前修订有效证据；事实/证据通道校验作品与路线归属；`indexScene` 失败整体回滚；修订索引状态只在完整清单全部成功时为 ready；分段索引不再出现段落×实体数的 SQL 放大；作者录入元素立即可见、跨作品修改被拒绝、非法类型/路线/空名不写入；ChangeSet 已确认事实同步保持值类型且重复提交幂等 |
| 工作流 | DAG/类型/未知节点、布局哈希、人工恢复、输入变化、取消、条件合流、幂等决定、遍历与失败阻断、退回说明持久化 |
| Agent（32 项） | Pi/插件目录与模型元数据、Provider CRUD、手动/环境变量密钥不外泄、OAuth 交互状态、清除密钥后本机模型仍可用、`models.json` 生成、思考档位钳制、本地假 OpenAI SSE 全回合（9 个 `novel_*`）、JSON 成功/失败归档、两种取消、length/工具错误、未配置时写作正常、点子接口、知识快照与秘密过滤、WAL 快照、额度窗口/余额解析与缓存、火山方舟签名/双套餐 OAuth/独立 IAM 回退；工具轮后仅思考的末轮不得复用上一轮前言、思考内容不成稿、只有正常 `stop` 才算成功；截断/鉴权/过滤/超时/取消/工具错误分类与脱敏原因写入任务；长正文上下文预检失败并点明超限类别 |
| 交互大纲（3 项） | 选择题/custom/跳过、关闭后恢复、返回与缓存复用、逐场编辑持久化、子集采用与幂等、ChangeSet 重复采用和过时提案拒绝 |
| 交互式工作流（2 项） | 回答与提案恢复、节点参数编辑持久化、不可变发布与重复发布、发布不自动运行、缺少人工审阅时拒绝注册 |
| 下一步行动（1 项） | 空白场景、有计划未写、候选、过期候选、采用后复盘、报告后继续的状态映射 |
| 创作便签（2 项） | 创建/编辑不创建修订、场景关联与清空、归档恢复、转场景幂等、真实 HTTP 与 bootstrap 快照 |
| 结构管理（1 项） | 章节新增/重命名、场景创建、跨章插入移动与顺序归一化、旧修订 CAS 拒绝 |
| 正文批注（1 项） | 选区锚点与哈希、解决/重开、原文变化标记、批注不创建修订 |
| 分层修订（1 项） | 段落/句子/平均句长/短段比例、重复开头识别、空文本处理、观察不转为评分 |
| 人物弧线（1 项） | 弧线计划创建/更新不创建修订、实际知识库表名一致、人物与作品归属正确 |
| 导入导出（4 项） | Markdown 多章解析与往返、中文标题分章与分场、正文疑似标题不误判、AI 行号切片与幻觉行号容错、单初始修订、备份不含凭据字段 |
| 交互回放（2 项） | 白名单事件、场景范围、顺序游标、决定元数据、不写入正文；SQL 先过滤再分页，超过 500 条域事件仍可完整导出；SSE 无 `projectId` 请求保持原协议 |
| 作品管理（2 项） | 重命名、归档/恢复、最后一个未归档作品保护、副本 ID/正文/修订独立，副本修改不污染原稿 |
| 备份恢复（1 项） | 恢复为新作品、场景/章节/路线/元素/事实/事件/证据引用重映射、便签/批注/人物弧线、POV 与重索引后证据 ID 保持、重复恢复、原作品不变 |
| POV HTTP（3 项） | 真实生成 HTTP 请求中，视角实体 ID、名称“阿禾”和别名“小禾”均解析为同一实体 ID；任务成功且 queryContext 作品/修订正确 |
| Provider 环境与用量（5 项） | Zen/Go/CN 默认变量名、检测安全与排重、启停和路由持久化、用量仅随启用配置、凭据变化缓存失效与错误脱敏、预设 token 上限归一化 |
| 写作建议（1 项） | 4.6/Gemini/DeepSeek 推荐、5.5 暂不优先、未知模型不绝对排名 |
| OAuth 配置（1 项） | 登录创建 `my-openai-codex` 与 `authProviderId`、内置模型可路由、身份用量、配置文件不含令牌 |
| 外观设置（1 项） | 默认 UI/正文字体与字号、UI 120% 与正文 110% 跨服务重启持久化、非法 UI/正文字号 400 且原设置不变 |
| AI 创作助手扩展（4 项） | 元素快速方案卡共创与采用入库、手动追加事实/状态事件/秘密 `known_by` 区间；元素 3 步问答引导持久化、`back` 缓存复用与幂等 `apply`；人物弧线推演/诊断、局部情节推演（`next_scene` 定点插入与 `scene_brainstorm` 单字段更新）、多便签孵化与 `linked` 状态联动；`extract_ledger` 正文原句精确核验、确定性 `evidenceId` 绑定与幻觉引用过滤拒绝 |

### 实际应用与浏览器

- Notion 外部笔记 Copilot：`node scripts/test-notion-copilot-ui.mjs` 使用隔离临时数据和本机真实 Chromium，模拟 Notion Agent API，已验证保存连接设置、读取 Agent 列表、发送问答、远端停止、刷新后历史恢复和 900px 窄窗口无横向溢出。SQLite `total_changes()` 在整个流程前后相同。截图位于 `artifacts/notion-copilot-ui.png`；该验证不代表调用了真实 Notion 账户。

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
- 整本小说导入（2026-11-02）：隔离数据目录实测本地规则与 AI 协助两条路径——无 Markdown 的中文样例（第X章 + `***` 分场）预览 3 章 4 场，确认后新作品章节标题与叙述顺序正确；AI 路径经 fake-openai 全链路（`assistImport` → 行号决策 → 本地切片）预览显示「AI 协助分章」并正确入库，测试脚本与截图在 `artifacts/ux-review/`（`import-e2e.mjs`、`ai-import-e2e.mjs`）。真实模型服务的分章质量未验证；AI 输出仅决定边界与标题，正文不经模型。
- 交互回放：真实候选生成与采用、工作流审阅退回后，回放按顺序显示“打开建议 → 出现候选 → 采用候选 → 打开审阅 → 退回修改”；导出 5 条事件，控制台错误 0。用例在 `scripts/interaction-smoke.mjs`，结果在 `artifacts/interaction-run/report.json`，截图 `interaction-replay.png`。
- 长书与分批导入（2026-11-02 续）：新增 `ch-XX` 标题识别；AI 候选行改为高置信标题全量、宽松短行限量，修复长书后半部分被截出候选导致 31 万字堆一章的问题。超过 2 万字的堆积章标为异常，可先落盘首个异常章之前的正常章节，剩余文本继续分析并经 `/api/import/append`（分支头 CAS）追加到同一作品，未入库剩余文字关闭前必须作为一章入库或明确丢弃。隔离实例 E2E（`artifacts/ux-review/batch-import-e2e.mjs`）：fake 首次只认 3 个标题 → 落盘 2 章 → 继续分追加 4 章 → 最终 6 章顺序正确、2 个修订、对话框自动关闭。思考档位规则改为 `off`/`minimal` 仅在模型元数据显式声明时可选，未声明映射的思考模型从 low 起，避免强制思考模型被分配“关闭”（`agent.test.ts` 覆盖）。
- 作品管理：重命名当前作品、创建只有一个初始修订的独立副本，再归档并恢复副本；界面当前作品与归档列表同步更新，控制台错误 0。用例在 `scripts/project-management-smoke.mjs`，结果在 `artifacts/project-management-run/report.json`，截图 `project-manager.png`。
- 备份恢复：使用应用实际导出的 JSON 备份恢复为新作品，正文、4 个元素、2 条事实、1 条便签、1 条批注和人物弧线均保留，原作品未改变；所有事实/事件证据 ID 均可在恢复后的知识库回查，备份不含全局工作流，控制台错误 0。用例在 `scripts/backup-restore-smoke.mjs`，结果在 `artifacts/backup-restore-run/report.json`，截图 `backup-restored.png`。真实文件输入恢复也已通过：`scripts/backup-ui-smoke.mjs` 选择 JSON 文件后激活新作品并显示范围提示，结果在 `artifacts/backup-ui-run/report.json`，截图 `backup-ui-restored.png`。
- 对象与版本状态：阿禾/父亲切换时弧线表单互不串写，历史版本显示命名时正文而非现稿，故事页切作品后可新建场景，控制台错误 0。用例在 `scripts/object-state-smoke.mjs`，结果在 `artifacts/object-state-run/report.json`，截图 `object-state.png`。
- 保存屏障：正文输入后立即切作品仍完整落库，保存新计划后立即离页不回退，复制包含最近正文和计划，控制台错误 0。用例在 `scripts/save-barrier-smoke.mjs`，结果在 `artifacts/save-barrier-run/report.json`，截图 `save-barrier.png`。
- 保存可靠性：注入 PATCH 失败后正文保留为本地草稿且提示可操作，网络错误恰好重试 3 次不无界循环；制造版本冲突后仅在 1 次请求内停止自动重试；草稿经「读取最新版本→确认保存」后真正写入服务端；切换作品后界面不被旧响应改回；中文输入法组合输入期间按 Enter 不检索、真实 Enter 只检索 1 次；外观保存失败显示「尚未保存」并可重试成功；便签保存失败时不调用转为场景；结构保存失败保留输入并显示可重试错误，重试后标题真正写入且正文未被覆盖。用例在 `scripts/reliability-smoke.mjs`，结果在 `artifacts/reliability-run/report.json`。
- 桌面与 UX：配对模式下 Markdown、JSON 备份和回放导出成功；1000px 窗口可打开助手和画布检查器；弹窗初始焦点、Escape 关闭与焦点归还通过，控制台错误 0。用例在 `scripts/desktop-ux-smoke.mjs`，本轮复测结果在 `artifacts/desktop-ux-typography/report.json`。
- 基础功能回归：`scripts/foundation-smoke.mjs` 在 1426×953、1000px 与 760px 视口验证 21 项：写作页模型分配落库、未保存正文在生成前写入、错误 Toast、场景卡完整恢复、脑暴失败提示、宽屏两类检查器开关、元素搜索与回车打开、元素表单不溢出、默认文楷 Medium 实际可用且无宋体回退、UI 字体独立可选与统一、默认字号字重层级、本机新晰黑与更纱黑体可用、UI 缩放与字体解耦、可编辑输入框与界面字体一致、窄窗作品切换和故事结构入口、任务分配不裁剪。结果在 `artifacts/foundation-smoke/report.json`，截图包括 `writing-typography.png`、`story-typography.png`、`elements-typography.png`、`notes-typography.png`、`appearance-default-font.png`、`appearance-sarasa.png` 与 `appearance-ui-scale.png`，浏览器未处理异常 0。
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
5. DOCX 导入导出，在工作流画布上自由增删节点或改连线：仍未形成用户闭环。JSON 备份恢复仅覆盖当前快照，不恢复历史修订、任务运行、旧选择批次或工作流定义。可选的外部 CLI 适配器尚未交付。
6. 桌面启动已实现随机端口与配对令牌；HttpOnly 会话和 CSRF 令牌尚未实现，安全边界仍是回环监听、Host/Origin 校验和同源部署。
7. 性能目标、百万字数据集、完整 A01–A20/N01–N14/K01–K24、用户研究和可访问性全量审计尚未执行。任务开始时的数据库内存快照在大库上的内存开销尚未测量。
8. 元素账本已支持新建与修改元素、追加属性事实/关系/秘密知情区间与状态事件，但已有单条属性事实或状态事件的逐条修改/删除界面尚未实现。
9. 全流程 AI 创作助手扩展（角色/世界观双模式 AI 共创、人物弧线推演与事件对照诊断、故事画布与写作页 4 类局部情节推演及复盘转下一场、多便签 AI 孵化器、正文反向抽取 `extract_ledger`）已完成前后端实现并通过本地假 OpenAI 契约与集成测试（`packages/server/test/assist.test.ts`），尚未在真实外部模型服务上进行生成质量与长文抽取准确率评测。
10. 索引状态的完整清单登记由宿主在启动与每次索引前显式调用；状态保存在进程内存，重启后未登记的修订回到 pending，不跨进程持久化。恢复入口为 `POST /api/knowledge/rebuild`（按作品内已有修订 ID，正文取权威清单），尚未接入界面按钮。
11. 本轮修复尚未覆盖：真实模型服务下的末轮空文本、上下文超限与各类提供商错误分类。`scripts/reliability-smoke.mjs` 已覆盖保存失败、版本冲突、切换作品竞态、组合输入、外观保存失败、便签保存失败与结构保存失败共 10 项；`scripts/foundation-smoke.mjs` 另行覆盖生成前保存、场景卡完整恢复和宽窄窗口交互；仍未覆盖离线重连与多次并发保存的交互。

后续修改应优先保持不可变版本、候选与事实隔离、双 CAS、知识边界和人工提交语义，不以界面完成度替代上述验证。
