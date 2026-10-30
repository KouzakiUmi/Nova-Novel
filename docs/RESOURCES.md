# 调研与资源清单 · Nova Novel（Nova Novel）

> 配套文档：[产品与交互设计](<../DESIGN.md>)｜[可视化剧情与工作流](<CANVAS-WORKFLOW.md>)｜[元素数据库与 RAG](<ELEMENTS-RAG.md>)｜[技术架构与 Pi 集成](<ARCHITECTURE.md>)
>
> 本清单登记外部来源，含"已读原文"与"待补"两类。每条给出来源 URL、可借鉴内容、建议采用方式、许可与限制；以机制和采用决策为主，不复述产品套餐、定价与内部数值。

## 0. 状态标记

| 标记 | 含义 |
| --- | --- |
| 已读原文 | 已打开该页面并读到相关原文，结论可引用 |
| 许可待核 | 来源已确认存在，但许可条款需查官方 LICENSE 或采购条款后才能确定 |
| 实现待验证 | 机制已确认可用，但中文场景下的实际效果需在 M0 用本作品语料评测 |

---

## 1. Pi 生态（默认核心）

### 1.1 Pi Desktop —— 现成桌面 GUI 的设计参照

- 来源（已读原文）：<https://github.com/FaqFirebase/pi-desktop>；官网 <https://pi-desktop.com/>
- 可借鉴 / 建议采用：Apache-2.0、处于 alpha 的开源桌面 GUI，技术栈为 Electron + electron-vite + TypeScript，CodeMirror 6 作为代码查看器，i18next 提供界面本地化（已内置简体中文），node-pty 承载终端。可借鉴的设计：右侧工具栏统一承载 Review 面板、文件树、差异查看器与终端；Review 面板汇总权限模式、待批准项、变更文件与会话状态，变更文件按 NEW / MOD / DEL / ADD / STG / REN 分类；每个会话跑独立 Agent 进程，切换标签后仍在运行，侧栏活动点与桌面通知提示完成、失败或等待批准；新任务可在隔离的 Git worktree 中启动；权限分 Plan（只读）、Ask before edits、Ask before commands、Trusted 四档，allow / deny 规则按"deny 优先于 allow、allow 优先于档位默认"匹配，可分全局与工作区两级；设置内提供诊断视图，排查安装与 PATH 解析、模型与供应商配置、权限与近期错误；会话支持 fork / branch 树、标签与一键上下文压缩；工作流运行视图支持中止与恢复。本平台提取其会话进程、RPC 事件和 Review 面板的集成思路，独立设计小说领域宿主；接口依据 Pi 官方版本文档。
- 许可与限制：Apache-2.0，可读源码与设计；官方自述处于 alpha，Windows 构建未签名，macOS 为 ad-hoc 签名；其权限规则为防误操作护栏而非安全沙箱。

### 1.2 Pi 官方仓库与 RPC 契约

- 来源（已读原文）：仓库 <https://github.com/earendil-works/pi>（旧 badlogic/pi-mono 路径重定向至此）；RPC 文档按 v1.4.0 标签读取 <https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md>
- 可借鉴 / 建议采用：MIT 的 Agent 工具箱 monorepo，含 pi-ai（多供应商 LLM API）、pi-agent-core（工具调用与状态）、pi-durable（会话、任务与文档运行时）、pi-coding-agent（交互式 CLI）、pi-tui、pi-telemetry 等包。RPC 契约（以 v1.4.0 为准）：`pi --mode rpc --no-session` 把 Pi 作为长驻子进程，stdin / stdout 上跑严格 JSONL 记录，分为 Command（stdin）、response、Session event、Extension UI record 四类；命令可带 id，响应回带同一 id，命令处理异步，客户端须按 id 关联而非按到达顺序；`prompt` 响应的 disposition 只表示提示被接受、排队或处理，不代表模型工作已完成，须继续消费事件，`agent_end` 表示一次底层运行结束而 `agent_settled` 才表示 Pi 不会自行继续；stdout 专用于协议记录，诊断与日志走 stderr；读取须只按 LF 分帧，不能把 Unicode 换行分隔符当作记录边界；关闭 stdin 请求有序退出。文档另提供进程内 SDK（Node / Bun）与导出的 TypeScript RpcClient 两种形态。建议本平台按“子进程 + JSONL 命令/事件 + ID 关联”集成；agent_settled 只表示运行静止，任务成功还须核验中断状态、错误和产物。
- 许可与限制：MIT。仓库说明 Pi 本身不含内置的文件系统、进程、网络与凭据权限系统，需要更强边界时应自行容器化或沙箱化；本平台的权限与审批由宿主实现承担。本机可获取的版本元数据为 1.4.0，本文所引 RPC 契约即取自该版本标签，其他版本契约须重新核对，不以最新版代替。

### 1.3 Provider 插件元数据与额度语义

- 来源（已读本机实现与声明）：[dsh-codex-connect](<https://github.com/franksong2702/dsh-codex-connect>)（Apache-2.0）、[dsh-opendesign-corouter](<https://github.com/KouzakiUmi/dsh-opendesign-corouter>)（MIT）、[dsh-subusage](<https://github.com/KouzakiUmi/dsh-subusage>)（MIT）、[dsh-volcengine-provider](<https://github.com/KouzakiUmi/dsh-volcengine-provider>)（MIT）。
- 采用方式：参考 Command Code 的模型注册、OpenDesign 的 plan/paid 目录与额度端点、火山方舟双套餐模型快照/ArkCli 命令与 AK/SK 签名，以及各提供商的只读额度窗口/余额表达，独立实现 `provider-metadata.ts`、`volcengine/` 和 `AgentUsageService`。不嵌入 DSH Host，不读取这些插件、桌面端或 Codex CLI 的凭据；模型元数据按所读版本记录，真实上游能力与套餐仍需另行验证。

---

## 2. 竞品机制（产品文档）

### 2.1 Novelcrafter —— Codex 条目、上下文注入与设定演进

- 来源（已读原文）：<https://www.novelcrafter.com/help/docs/codex/anatomy-codex-entry>、<https://www.novelcrafter.com/help/docs/plan/plan-actions-menu>、<https://www.novelcrafter.com/help/docs/codex/progressions-additions>
- 可借鉴 / 建议采用：Codex 条目按类型组织，内容分为 Details / Research / Relations / Mentions / Tracking；Tracking 页控制条目是否进入模型上下文（始终 / 仅被提及时 / 从不）；Mentions 页统计条目在正文、场景摘要、其他条目、片段、对话中的出现位置；别名用于匹配，可区分大小写并设排除词；Relations 支持条目嵌套互引；条目描述带历史快照。Plan 视图按幕 / 章 / 场组织，场可设自定义 POV，场级操作含"从 AI 上下文排除"、AI 摘要、Detect Characters、与该场对话、场内容与摘要的版本历史、归档而非删除。Progressions 把设定变更绑定到具体场景，只有在该场景之后才进入上下文，可切换为替换或追加，用于中途出现的重大变化。建议采纳条目级注入三态、采纳"归档而非删除"、采纳"设定变更绑定场景位置"作为时态元素的基础表达。
- 许可与限制：官方帮助中心，属商业产品，仅可借鉴机制，不可复制文案与视觉。

### 2.2 Sudowrite —— Story Bible 字段依赖、Rewrite 候选卡片、Feedback 批注

- 来源（已读原文）：[Story Bible](<https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC>)、[角色](<https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/characters/a7tdE1ZB8KvAwMD3Mopwpd>)、[Rewrite](<https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/rewrite/9hkeezeUsCiUCG4dRdEqjS>)、[Feedback](<https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/feedback/7Ew1KgpEwabQSgvijq8QNr>)。
- 可借鉴 / 建议采用：Story Bible 是有向依赖的阶段结构，官方逐项写明字段影响范围（Synopsis 为空时下游回落 Braindump）；角色卡字段可改名、可按角色类型定制默认值、可单独生成或重写、带历史版本；支持从文本或文件智能导入，CSV 走结构化通道不经模型；Characters 可单独导出 CSV，而普通项目导出不含 Story Bible。Rewrite 作用于选区，结果以卡片形式进入侧边历史栏，接受后替换选区。Feedback 在边栏留下"观察 + 下一步建议"式批注，内置发展性 / 行文 / 对白 / 文字编辑等类型与自定义类型，可逐条应用、忽略、标记已解决，并能在批注内继续追问。建议采纳统一的"候选 → 差异 → 逐项接受"交互契约并套用到设定字段、场景摘要、正文改写三类生成；采纳"批注即对象、带状态、可在批注内追问"的审阅模型。
- 许可与限制：官方文档，商业订阅产品；其页面自述 Rewrite 对较短选区会读取 Synopsis、更长则不读，而同页视频字幕称 Rewrite 不使用 Story Bible，两处表述不一致，本平台不据此下结论。

### 2.3 Scrivener —— 快照、索引卡与元数据

- 来源（已读原文）：<https://www.literatureandlatte.com/scrivener/overview>；手册快照章节 <https://www.literatureandlatte.com/docs/Scrivener_Manual-v2-Mac.pdf>
- 可借鉴 / 建议采用：Snapshots 提供"重大修订前先拍点、可随时回到早期版本"并配 Compare 展示差异；Corkboard 中每个 section 绑定一张虚拟索引卡，拖动卡片即同时重排稿件，可沿彩色轨道并行追踪多条故事线；Outliner 以表格呈现层级与元数据；Collections 可按标签生成"闪回场景"一类智能列表；Metadata 支持自定义字段与状态字段追踪修订阶段；Templates 可作新 section 基底。建议采纳"卡片即结构单元、正文挂在卡上"使剧情画布与正文编辑共用结构模型；采纳自定义元数据与集合视图，使"按 POV / 时间线 / 修订状态筛选"成为一等能力。
- 许可与限制：商业软件，页面为厂商概览加官方手册，功能点以官方表述为准，未实机验证；其自有产品推荐类内容不作为事实采信。快照粒度按文档 / section 提供，本平台的段落级恢复点需求另作设计。

### 2.4 novelWriter —— 标签与引用词表

- 来源（已读原文）：<https://novelwriter.io/docs/usage/tags_and_references.html>、<https://novelwriter.io/docs/>
- 可借鉴 / 建议采用：不用表单定义人物地点，而在根目录文档中用 `@tag: TagName`（可带 `| Display Name`）给标题打标，正文用 `@keyword` 引用；官方关键词含 `@pov`、`@focus`、`@char`、`@plot`、`@time`、`@location`、`@object`、`@entity`、`@custom`、`@mention`、`@story`，其中 `@mention` 专用于"提及但未出场"并被说明用于一致性检查；标签全局唯一且绑定标题，合法引用高亮、非法引用加波浪线，可对尚不存在的标签一键建卡；项目以可读纯文本文件存储。建议把这套词表作为本平台的关系表达层与显式引用层，表达在场与仅提及的区别；本平台的取数走结构化查询 + 关键词 + 向量的混合检索，这套词表是其中一路而非唯一通道。
- 许可与限制：开源项目，**许可待核**：第三方包索引列有 "GPL-3.0-or-later AND CC-BY-SA-4.0"（<https://repology.org/project/novelwriter/information>），代码与文档授权不同，未逐文件复核官方 LICENSE 与文档授权头。

### 2.5 Plottr —— 时间线、泳道与场景卡

- 来源（已读原文）：<https://docs.plottr.com/article/54-timeline-overview>、<https://docs.plottr.com/article/56-timeline-plotlines>、<https://docs.plottr.com/article/149-custom-timeline-templates>
- 可借鉴 / 建议采用：Timeline 为视觉中枢，含章标题、Plotline 与场景卡；Plotline 纵向铺开，用于主冲突、副线、角色弧、结构节拍，可命名、拖拽排序、自定义颜色、折叠展开；场景卡可带描述、图片、超链接、自定义属性并关联 Characters / Places / Tags，可按角色、地点、标签、颜色、自定义属性过滤；`Save as Template` 把 Plotline 与场景卡结构存为模板，模板是保存时刻的快照，后续修改不自动同步。建议采纳"泳道 × 卡片"作为剧情画布信息结构（叙事顺序为轴，角色线与伏笔为泳道），采纳模板即结构快照且带版本化命名；画布可经统一元素服务新建或关联实体，画布只持有引用。其 Flip 功能是时间线横向 / 纵向的方向翻转；本平台的故事时间与叙述顺序按两条独立轴另行定义。
- 许可与限制：商业订阅产品，官方文档可读，模板商店为付费商品，内置模板文案仅作结构参考。官方 Known Limitations：不能在场景卡内新建 Characters / Places / Tags、不能复制章节与 plotline 与场景卡、不能按原样打印 Timeline。

### 2.6 Reedsy Studio —— 模板化大纲

- 来源（已读原文）：<https://reedsy.com/studio/templates/fantasy-novel-outline/>
- 可借鉴 / 建议采用：多块看板（Outline / Characters / Places / Worldbuilding）互相引用；节拍卡采用"解释 + 草图 + 引导问题 + checkpoint"分段式引导；卡片用 `@` 互链且被引用对象就近可取。建议借鉴节拍卡分段式引导与跨看板引用结构，据此设计本平台场景卡字段与跳转。
- 许可与限制：在线模板服务，需账号；引导问题与示例文本的再分发条款未核，**许可待核**，按结构参考使用。

### 2.7 n8n —— 编排范式与许可边界

- 来源（已读原文）：许可 FAQ <https://docs.n8n.io/n8n-community-license/community-license/license-faq.md>；故事模板 <https://n8n.io/workflows/3153-generate-complete-stories-with-gpt-4o-and-save-them-in-google-drive/>
- 可借鉴 / 建议采用：成熟的节点化编排范式——节点类型化、端口明确、执行记录可回看、模板可复用、失败可重试；故事模板链路（灵感 → 角色 → 大纲 → 审校）与本平台的流程创作场景同构，可借鉴其阶段划分并以自有节点重新实现。本平台执行层自建，见 [CANVAS-WORKFLOW.md](<CANVAS-WORKFLOW.md>)。
- 许可与限制：社区许可为 Sustainable Use License，明确禁止在社区许可下让外部用户通过自己的 UI / API / AI 编排 n8n 引擎，因此不内嵌其引擎、不把它作为编排后端；个人内部使用与对外提供服务的边界不同，若平台对外提供编排能力须先读 FAQ 原文确认范围；模板仅作阶段划分参考，不导入、不连其付费服务账号。

### 2.8 小说场景写作方法 —— 行动、反应、结果与对话目的

- 来源（2026-10-28 已读原文）：Randy Ingermanson 的 [Scenes, Sequels, and Chapters](<https://www.advancedfictionwriting.com/blog/2009/05/25/scenes-sequels-and-chapters/>)。文中把 Dwight Swain 的结构概括为“目标 / 冲突 / 挫折”和“反应 / 两难 / 决定”。
- 可借鉴 / 建议采用：转成作者可选择的“推进事件”和“反应与决定”两种生成意图，让决定可以成为后续场景的构思线索。不要把挫折理解为每场必须有灾难；该页评论也显示不同作者对公式适用性的争议，因此只作可选工具。
- 来源（2026-10-28 已读原文）：K. M. Weiland 的 [A New Way to Think About Scene Structure](<https://www.helpingwritersbecomeauthors.com/scene-structure/>)。文中以场景问题、冲突过程和结尾答案检查同一条因果线，并明确讨论严格套公式的问题。
- 可借鉴 / 建议采用：场景卡显示“目标 → 阻碍 → 预期结果／摘要”，复盘时比较开头意图与正文实际结果；允许结果未知或留空，不用结构完整度给正文评分。
- 来源（2026-10-28 已读原文）：Story Grid 的 [The Five Commandments of Storytelling](<https://storygrid.com/writing-scenes-work/>)。其结构包括激励事件、渐进复杂、危机选择、高潮行动和结果，并以价值变化审视故事单元。
- 可借鉴 / 建议采用：只把“选择产生结果、场景可能发生变化”作为复盘视角，不把五部分变成新手必填表，不宣称所有成功场景都必须符合同一公式。
- 来源（2026-10-28 已读原文）：Writing Excuses 的 [15.15: Dialog](<https://writingexcuses.com/15-15-dialog/>)。节目建议区分人物的物理目标与谈话／情绪目标，并区分作者场景意图和人物说话目的。
- 可借鉴 / 建议采用：提供“对话与行动”生成意图，保留正在做的事和想从谈话中得到的东西，允许回避、停顿与行动表达。节目自身的定位是“工具，不是规则”；删减对白等练习不转成自动修改。
- 许可与限制：以上仅总结方法并链接原文，不复制课程、模板或示例文本；方法是否改善中文新手作品仍需真实作者与阅读体验验证。

### 2.9 人机协同写作的交互证据

- 来源（已读原文）：Microsoft [Human-AI Interaction Guidelines](<https://learn.microsoft.com/en-us/training/modules/introduction-to-microsofts-responsible-ai-approach/3-use-guidelines-for-human-ai-interaction>)；[CoAuthor](<https://arxiv.org/abs/2201.06796>)；[Wordcraft 专业作者研究](<https://arxiv.org/abs/2211.05030>)；[Sparks](<https://ar5iv.labs.arxiv.org/html/2110.07640>)；[TaleBrush](<https://dlnext.acm.org/doi/fullHtml/10.1145/3491102.3501819>)。
- 采用方式：AI 输出以短建议和可丢弃候选为主，作者可忽略、局部纠正和查看后果；长候选可折叠，退回修改须能说明保留项与调整方向；优先使用场景卡和行动线而不是要求提示词。交互评估应记录建议打开、忽略、采用和修改过程，不能只看最终文本或采用率。
- 落地位置：写作页下一步行动条、人工审阅的退回说明、交互大纲子集采用与影响预览。研究样本与模型年代各不相同，这些资料用于交互设计依据，不当作当前模型写作质量或中文用户体验已验证的结论。

### 2.10 想法整理、场景组织与分层修订

- 来源（已读原文）：Randy Ingermanson 的 [Snowflake Method](<https://www.advancedfictionwriting.com/articles/snowflake-method/>)；[Campfire 写作与组织功能](<https://www.campfirewriting.com/write>)；Dabble 的 [Organizing Your Story](<https://help.dabblewriter.com/en/articles/3426284-organizing-your-story>)；Scrivener 的 [Inspector](<https://www.literatureandlatte.com/blog/get-to-know-the-scrivener-inspector>)；[Plot Factory](<https://plotfactory.com/faq>)；[AutoCrit Story Analyzer](<https://www.autocrit.com/autocrit-story-analyzer-book-editing-ai-manuscript-analysis-lifetime-fb/>)；Reedsy 的 [Copy Editing](<https://reedsy.com/editing/copy-editing/>)。
- 采用方式：正文之外需要独立的便签空间，想法可以先收集、后关联，不能自动变成事实或正文；场景列表和角色/情节大纲允许逐步扩展并回修，不把一种结构方法强制给所有作者；分析应先结构后语言，保留作者声音，避免把“检查”直接变成自动重写。
- 落地位置：`notes` 表与创作便签页、场景卡和行动线、分级复盘、人工审阅与退回说明。Snowflake、AutoCrit 等方法和产品描述只作设计参照，不宣称其结构公式、分析维度或商业文案已经验证适用于中文作品。

---

## 3. 可复用源码与组件

### 3.1 React Flow（`@xyflow/react` 12）

- 来源（已读原文）：<https://github.com/xyflow/xyflow>；官方文档 <https://reactflow.dev>
- 可借鉴 / 建议采用：两套领域画布共用一套交互底座——节点、端口、连接、缩放平移、小地图、选择与框选、键盘可访问性操作；节点模型可直接映射到"画布提供节点列表等价视图"的要求。建议引入为画布渲染层，自建节点语义与持久化。
- 许可与限制：MIT。不是工作流持久化引擎，不负责版本、恢复与幂等。

### 3.2 shadcn/ui 与 Blocks

- 来源（已读原文）：<https://ui.shadcn.com/blocks>；<https://github.com/shadcn-ui/ui/blob/main/LICENSE.md>
- 可借鉴 / 建议采用：可复制进仓库的组件源码模式，适合本平台侧栏、对话框、抽屉、表格与表单；Blocks 提供成套界面组合可作布局起点。建议直接采用其源码与 Blocks 作为界面骨架，按 [DESIGN.md](<../DESIGN.md>) 第 9 章的纸面配色与对比度要求二次定制。
- 许可与限制：MIT；Blocks 为免费资源，需替换默认配色与品牌视觉。

### 3.3 Tiptap

- 来源（已读原文）：<https://tiptap.dev/docs/editor/introduction>；持久化 <https://tiptap.dev/docs/editor/core-concepts/persistence>
- 可借鉴 / 建议采用：可定制的 ProseMirror 编辑器，支持自定义节点与标记，适合承载正文、批注锚点与结构化片段。官方 Persistence 文档推荐以 JSON 而非 HTML 持久化编辑器状态，理由是更易解析、便于外部编辑，无需额外解析 HTML；示例用 `editor.getJSON()` / `editor.setContent()` 配合本地存储或后端接口。建议以 Tiptap 为编辑器内核、以 JSON 为存储格式，自建修订号、差异展示与合并层。
- 许可与限制：核心 MIT；Comments、Version history、AI 等为商业扩展、单独付费，首版不依赖。深度页抓取偶发超时，实施阶段再核。

### 3.4 Novel 仓库（steven-tey/novel）

- 来源（已读原文）：<https://github.com/steven-tey/novel>
- 可借鉴 / 建议采用：AI 编辑器的结构参考——模型侧栏、选区操作、命令式生成入口、流式候选呈现。建议只作交互结构参考，不引入其运行时依赖；生成契约以 [DESIGN.md](<../DESIGN.md>) 第 5 章为准。
- 许可与限制：Apache-2.0，以仓库当前声明为依据；本方案将其作为交互参考，未选择其发布包作为运行依赖。

### 3.5 LanceDB（OSS）

- 来源（已读原文）：<https://github.com/lancedb/lancedb/blob/main/LICENSE>；混合检索 <https://docs.lancedb.com/search/hybrid-search.md>；元数据过滤 <https://docs.lancedb.com/search/filtering.md>
- 可借鉴 / 建议采用：向量与关键词的混合检索及元数据过滤，配合 SQLite FTS5 构成 [DESIGN.md](<../DESIGN.md>) 第 10 章的检索候选。官方文档说明预过滤默认开启、后过滤可能返回少于 limit 的结果；混合查询中同一 `where(...)` 条件同时作用于向量与全文两半；建议对常用过滤列建标量索引；过滤表达式中含点号的字段名不支持。建议作为可重建的向量索引层，索引滞后时降级为结构化与关键词检索。
- 许可与限制：Apache-2.0。原生依赖与嵌入模型需专项验证。

### 3.6 SQLite —— FTS5 与在线备份

- 来源（已读原文）：FTS5 <https://www.sqlite.org/fts5.html>；在线备份 <https://www.sqlite.org/backup.html>
- 可借鉴 / 建议采用：FTS5 提供内置全文检索，unicode61 分词器按连续字符类切分——连续的 token 字符视为一个 token，标点与空白为分隔符，可配置 tokenchars / separators / categories；trigram 分词器按连续三字符建索引，少于 3 个 Unicode 字符的子串用 MATCH 不命中任何行；支持短语、前缀、NEAR 邻近、布尔组合、列过滤与 BM25 排序，可配外部内容表与 contentless 表以减少重复存储。在线备份 API 可把一个数据库增量复制到另一个文件，源库仅在实际读取时短暂加锁，完成后目标库是位级一致快照，可分批推进并上报进度、休眠期间不持锁；官方另提供 `VACUUM INTO` 与 `sqlite3_rsync`。建议以 FTS5 实现中文关键词召回并把分词器选择与降级策略写进检索层；以在线备份 API 实现运行中项目的备份与"恢复到新位置再验证"，对应 [DESIGN.md](<../DESIGN.md>) 第 6 章 F 旅程。
- 许可与限制：SQLite 交付代码与文档的公共领域声明见[官方版权说明](<https://www.sqlite.org/copyright.html>)。**实现待验证**：unicode61 对中文的召回效果须评测；trigram 的 MATCH 有三字符下限，短名称须走其他索引或查询策略。

---

## 4. 在线模板（结构参考）

### 4.1 n8n 故事生成工作流模板

- 来源（已读原文）：<https://n8n.io/workflows/3153-generate-complete-stories-with-gpt-4o-and-save-them-in-google-drive/>
- 可借鉴 / 建议采用：链路的阶段划分与"每阶段一个产物"的串联方式——灵感 → 角色 → 大纲 → 审校。
- 许可与限制：不直接导入。模板含外部账号与付费服务调用，模板自身许可未逐文件核验。

### 4.2 React Flow Pro 工作流编辑器模板

- 来源（已读原文）：<https://reactflow.dev/ui/templates/workflow-editor>
- 可借鉴 / 建议采用：节点面板、画布布局与属性侧栏的组合方式，可作界面布局参考。
- 许可与限制：Pro 收费模板，可按其条款采购后使用；能否复制进本仓库以其条款为准。

### 4.3 Reedsy 题材启动包与 Plottr 模板

- 来源（已读原文）：<https://reedsy.com/studio/templates/fantasy-novel-outline/>、<https://docs.plottr.com/article/149-custom-timeline-templates>
- 可借鉴 / 建议采用：模板即"某时点的结构快照"，命名带版本号，模板内可嵌引导问题占位；节拍卡分段式引导；跨看板引用。
- 许可与限制：在线模板服务，需账号或订阅；其引导问题与示例文本的再分发条款未核，按结构参考使用。

### 4.4 公有领域语料

- 来源（已读原文）：<https://www.gutenberg.org/policy/permission.html>
- 可借鉴 / 建议采用：可作人物卡、场景卡、大纲的示例正文语料与检索测试样本，建议引入为仅本地测试语料。
- 许可与限制：公有领域判定以美国法为准，其他法域需另核；"Project Gutenberg" 为注册商标，不可用于商业标识。

---

## 5. 其他 CLI 与协议（可选适配器）

> Pi 为默认核心；以下条目按可选扩展登记，不与核心平级。适配器只统一任务与产物，不假定各工具能力相同。

### 5.1 Agent Client Protocol v1

- 来源（已读原文）：<https://agentclientprotocol.com/get-started/introduction>、v1 协议页 <https://agentclientprotocol.com/protocol/v1/overview>
- 可借鉴 / 建议采用：ACP 标准化编辑器与编码 Agent 之间的通信，定位类似 LSP。官方说明：本地 Agent 作为编辑器子进程、经 stdio 上的 JSON-RPC 通信；远程 Agent 经 HTTP 或 WebSocket，远程支持仍在推进。协议尽量复用 MCP 的 JSON 表示，并为差异展示等 Agent UX 元素定义专用类型，用户可读文本默认 Markdown。v1 覆盖初始化、鉴权、会话建立与列表、提示回合、内容、工具调用、征询、文件系统、取消、终端、Agent 计划、会话模式、斜杠命令、传输、错误与 schema。建议作为 GUI 与 CLI 之间的一种可选承载协议，用于流式内容、工具调用、取消与差异呈现。
- 许可与限制：开放协议，所读页面未标注授权条款，**许可待核**；远程 Agent 场景官方标注为进行中。

### 5.2 Claude Code（headless 路径）

- 来源（已读原文）：[CLI headless](<https://code.claude.com/docs/en/headless>)、[Agent SDK](<https://docs.claude.com/en/docs/claude-code/sdk>)。
- 可借鉴 / 建议采用：官方对照表说明，从 Python / TypeScript 以外的语言驱动同一 Agent 循环的方式是把 CLI 作为子进程运行，配合 `-p` 与 `--output-format json`。SDK 侧能力包括内置工具、Hooks、子 Agent、MCP、权限、会话、技能与命令、插件。建议以"子进程 + 结构化输出"作为非 Python/TS 适配器的接入形态参考，并对权限与审批机制单独建模。
- 许可与限制：嵌入式 Agent SDK 受 Anthropic 商业条款及第三方登录限制约束，产品化接入须单独核验授权方式。平台不会为适配 CLI 自动迁移用户登录、复制凭据或切换付费 API 身份。

### 5.3 Gemini CLI（headless）

- 来源（已读原文）：<https://geminicli.com/docs/cli/headless/>、自动化教程 <https://geminicli.com/docs/cli/tutorials/automation/>
- 可借鉴 / 建议采用：headless 模式在非 TTY 环境或提供 `-p` / `--prompt` 时触发。`--output-format json` 返回单个 JSON 对象，含 response、stats（token 用量与延迟）、可选 error；JSONL 形式按事件流返回 init、message、tool_use、tool_result、error、result。退出码有语义：0 成功、1 一般错误或 API 失败、42 输入错误、53 超出回合上限。建议适配器按事件类型归一化流式产物，并把退出码映射到平台的失败分类而非笼统的"失败"。
- 许可与限制：官方文档，所读页面未标注授权条款，**许可待核**；实际可用模型与速率取决于本机账号与配置。

### 5.4 OpenCode（ACP 适配）

- 来源（已读原文）：<https://opencode.ai/docs/acp/>
- 可借鉴 / 建议采用：以 `opencode acp` 启动后作为 ACP 子进程，经 stdio 上的 JSON-RPC 与编辑器通信；官方称经 ACP 与终端内行为一致，支持内置工具、自定义工具与斜杠命令、配置中的 MCP 服务器、项目级规则文件、自定义格式化与检查器，以及 Agent 与权限体系。建议作为"支持 ACP 的一类 CLI"样本，用于验证适配器抽象是否覆盖真实实现。
- 许可与限制：官方文档，所读页面未标注授权条款，**许可待核**。

### 5.5 Codex CLI

- 来源：仅登记官方文档入口 <https://developers.openai.com/codex/cli/reference>；本轮抓取不稳定（多次返回 404 或重定向），实施阶段再核。
- 可借鉴 / 建议采用：核验后再补机制要点。
- 许可与限制：**许可待核**。

---

## 6. 字体与模型写作参考

### 6.1 内置开源字体

- Inter：官方仓库 <https://github.com/rsms/inter>；许可证为 SIL Open Font License 1.1，全文随包保存于 `packages/web/public/fonts/INTER-LICENSE.txt`。随包只有 Regular（400）静态字重，因此在 UI 字体栈中排在 Noto Sans CJK 之后，仅在缺失拉丁字形时兜底，不承担 500/600 字重。
- Noto Sans CJK：官方仓库 <https://github.com/notofonts/noto-cjk>；许可证为 SIL Open Font License 1.1，保存于 `NOTO-SANS-LICENSE.txt`。本机可变字体（100–900）同时覆盖中文与拉丁，作为 UI 字体的首选，使 400/500/600 字重在两种文字上粗细一致。Noto Serif CJK 不随包分发。
- LXGW 文楷：官方仓库 <https://github.com/lxgw/LxgwWenKai>；许可证为 SIL Open Font License 1.1，保存于 `LXGW-LICENSE.txt`。随包提供 Regular（400）与 Medium（500）两个字重文件（`lxgw-wenkai-regular.ttf`、`lxgw-wenkai-medium.ttf`），正文默认 Medium、可选 Regular；不引用运行时 CDN，保留 Reserved Font Name 条款与许可文本。

### 6.2 本机阅读字体（只引用，不再分发）

- 本机已核实的内部 family 名称：`LXGW Neo XiHei Screen`（霞鹜新晰黑屏幕阅读版）与 `Sarasa UI SC`（更纱黑体 UI SC）。两者只在本机已安装时作为正文备选，缺省时回退到内置文楷或黑体，不复制字体文件到应用包。
- 新晰黑字体内嵌许可指向 IPA Font License（<https://opensource.org/licenses/IPA/>）。更纱黑体仅按本机系统字体引用，不据此作再分发或许可断言。

### 6.3 模型写作初筛参考

- 2026-10-29 检索了 [Claude 写作模型比较](<https://www.inkfluenceai.com/blog/best-claude-model-for-writing-2026#1>)、[创意写作榜单汇总](<https://www.benchleader.com/benchmarks/lmarena_text_creative>)、[中文短篇科幻生成评估](<https://openurl.ebsco.com/EPDB%3Agcd%3A3%3A40695507/detailv2?sid=ebsco%3Aplink%3Aresult-item&id=ebsco%3Adoi%3A10.1093%2Fllc%2Ffqag078&bquery=AU%20Chen%2C%20Xing&page=1&link_origin=none&searchDescription=Chen%2C%20Xing&crl=f)和[中文剧本实测](<https://m.thepaper.cn/newsDetail_forward_34318871>)。
- 采用方式：模型旁只显示“写作推荐 / 暂不优先”的初筛建议，并明确最终由作者的短场景试写决定。4.6、Gemini、DeepSeek 等作为优先试写方向；5.5 暂不优先，不把版本号当作质量排名。上述来源用于提供比较视角，不视为官方写作承诺，也不替代中文语料和兼容性测试。

---

## 7. 实施前必须确认的事项

1. Pi 1.4.0 的实际进程/RPC 回归；版本升级重新验证命令、事件与扩展 UI，Pi Desktop 的 alpha 状态不代表本平台已经具有相同运行能力。
2. novelWriter 与 Manuskript 的官方 LICENSE 与文档 / 模板授权头（<https://github.com/olivierkes/manuskript>）。
3. ACP 协议仓库、OpenCode、Gemini CLI、Claude Agent SDK 的授权条款；Claude Agent SDK 另受 Anthropic 商业条款约束。
4. Tiptap 各付费扩展的功能边界，用于确认自建与采购的界线；若采用商业扩展或 Tiptap Cloud，需评估其数据流向与本机优先原则是否冲突。
5. 在线模板（Reedsy、Plottr、React Flow Pro）的再分发条款与采购条款。
6. SQLite FTS5 中文分词方案在本作品语料上的召回与误召回评测（M0）。
7. 平台若对外提供编排能力，需先确认 n8n 社区许可的可用范围。

---

## 8. 与其他文档的对应

[DESIGN.md](<../DESIGN.md>) 提供产品定位、功能全景与版本模型；[CANVAS-WORKFLOW.md](<CANVAS-WORKFLOW.md>) 取用 2.5 泳道模型、2.7 编排范式、3.1 画布底座、5.1 协议承载与 n8n 许可边界；[ELEMENTS-RAG.md](<ELEMENTS-RAG.md>) 取用 2.1 注入三态与设定演进、2.2 字段依赖、2.4 引用词表、3.5 与 3.6 检索候选；[ARCHITECTURE.md](<ARCHITECTURE.md>) 取用 1.1 与 1.2 的 Pi 接入形态、3.1–3.6 组件、3.6 备份路径、5.1–5.5 适配器与第 6 章清单。

## 9. 核验范围

调研日期为 2026-10-27。产品能力依据公开官网与帮助文档，组件许可依据官方仓库声明；未实机评测竞品。Pi 安装元数据与 1.4.0 随包的命令、事件、扩展 UI、CLI 资源选项已核对，未运行模型调用。

Context7 当时返回月度配额耗尽，技术资料改读官方页面和同版本随包文档。Codex 部分页面未能稳定抓取，保留为实施期核验项。设计指标、接口契约核对和运行测试是不同证据，本文不将文档描述当作本机测试结果。
