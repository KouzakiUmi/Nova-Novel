# 技术架构与内置 Agent 集成

> 配套 [产品设计](<../DESIGN.md>)。画布执行语义见 [可视化剧情与工作流](<CANVAS-WORKFLOW.md>)，元素时态与检索见 [元素数据库与 RAG](<ELEMENTS-RAG.md>)，外部资料见 [调研与资源清单](<RESOURCES.md>)。
>
> v1.1 设计基线。本文描述拟建架构与正式设计契约，不表示服务或 Agent 已经运行；具体依赖版本在实施阶段锁定。
>
> 默认 Agent 内核为进程内 Pi SDK，锁定 `@earendil-works/pi-coding-agent` **1.4.0**。Provider、路由、提示、工具与 HTTP 契约统一见[内置 Agent 引擎](<AGENT-ENGINE.md>)。

## 1. 目标与职责切分

本机由**同源 Web UI**与**本机 Node 单写服务**组成。UI：Tiptap 结构化 JSON、React Flow 剧情/执行双画布、审阅与任务面板。服务独占 SQLite 权威库（含 FTS5 更新），派生 LanceDB OSS 向量索引，并以内置 Pi SDK 为默认 Agent 主通路。

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| **Pi SDK** | 模型提供方、Pi 会话、流式响应、Agent 循环、工具/扩展、压缩、重试 | 作品修订、元素账本、RAG 权威、领域工作流、人工待办 |
| **领域宿主** | 版本化 DAG、人工节点、元素/事实、混合检索、ChangeSet、任务与会话绑定 | 模型提供方协议和 Pi 内部 Agent 循环 |

不可变前提：

- 作者拥有正文最终决定权。宿主把**选定上下文快照**交给 Pi；Pi 产物只进**任务暂存**；主库仅经审阅 ChangeSet 由本服务写入。
- 作品 **revision / branch / route** 与场景 **世界时间** 分离。**项目 Pi session 树与作品版本树独立。**
- 原始 Pi session JSONL **不可盲导入** RAG。恢复旧 session 会带回**旧隐含上下文**；切换 branch / route / 知识边界时**默认新 session**，不靠新 prompt“消毒”旧记忆。
- `cwd` 不是沙箱。Pi **官方不内置**文件系统/进程/网络/凭据权限系统，进程继承启动用户权限。工具审批、`extension_ui` 确认、限制 cwd **都不是 OS 隔离**。无容器时固定显示 **兼容模式**：**不得声称原进程绝对只能读上下文包**。
- 其他编码 CLI 仅为可选工具适配，与 Pi **不平级**。

## 2. 本机组件

```text
[浏览器 UI]  React/TS · Tiptap · React Flow(剧情|执行)
      │ 同源 fetch / EventSource · Cookie+CSRF · Origin 白名单
      │ HTML/SVG 渲染前净化
      ▼
[本机 Node 单写服务]  权威库 + FTS5 同进程更新 · 领域调度 · SSE
      │                 stdout/stderr 日志脱敏
      ├─ SQLite WAL  修订/场景修订/事实/工作流运行/绑定/证据/outbox/FTS
      ├─ LanceDB OSS 可重建向量（异步，非权威）
      ├─ 任务暂存  task_id/  ContextSnapshot · 候选 · 协议记录
      └─ [内置小说 Agent]  createAgentSession
            应用自有 Provider / ModelRuntime
            小说提示 + novel_* 只读工具
            每任务独立会话 JSONL
```

UI 与服务同机、默认回环访问。React Flow 只承担画布交互，执行层见[工作流设计](<CANVAS-WORKFLOW.md>)。Pi 的隔离选项见[官方容器化文档](<https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/containerization.md>)；操作系统隔离属于独立部署能力，与业务审批分开展示。

## 3. 权威数据与派生数据

| 层级 | 存储 | 写入者 | 丢失后 |
| --- | --- | --- | --- |
| 权威 | SQLite 领域表、不可变正文/产物对象 | 仅本服务单写事务 | 不可从向量或 Pi 会话推断恢复 |
| 派生关键词 | SQLite FTS5 | 同一单写服务 | 从权威原文重建 |
| Pi 原生会话 | Pi 会话文件 | 仅绑定的 Pi SDK 会话管理 | 保留会话来源；不作为作品正文 |
| 派生向量 | LanceDB | 索引 worker（读 outbox） | 按 `knowledge_version` 重建 |
| 候选产物 | 产物对象 + `tasks`/`artifacts` | 调度器归档 | 已展示为保存的候选可恢复 |
| 临时副本 | 任务输入输出目录 | 任务宿主 | 可从快照/归档产物重建 |
| 浏览器草稿 | 未确认写入 | UI | 标暂存，RPO 不承诺 0 |

FTS 是派生数据，不因和权威表位于同一 SQLite 库就成为事实来源。增量更新通过单写服务提交；全量重建使用明确水位。向量命中须回查权威证据。远程模型/嵌入出站时显示发送范围。

## 4. 关键表与标识

标识由服务端生成。

| 表 | 主键/关键列 | 说明 |
| --- | --- | --- |
| `projects` | `project_id`, `archivedAt` | 作品容器；归档是元数据状态，不删除正文或历史 |
| `branches` | `branch_id`, `head_revision_id` | 作者修订头；CAS 目标列 |
| `story_routes` | `route_id` | 故事内假设路线，不是 Pi fork |
| `revisions` | `revision_id` **不可变** | 清单引用各 blob |
| `revision_manifests` | `revision_id`, `kind`, `blob_id` | `kind∈{body,facts,events,plot_graph,structure,writing_intent}` |
| `changesets` | `changeset_id`, `base_revision_id` | 原子提交记录；可含正文、事实、剧情、场景新增与 `structureChanges`（章节新增/重命名、场景移动） |
| `scenes` | `scene_id` | **仅稳定身份**（所属作品等）；无时间/顺序真值 |
| `scene_revisions` | `scene_id`, `revision_id`, `story_time`, `narration_order` | 场景时间与叙述顺序**随作品 revision 版本化** |
| `elements` / `element_facts` / `world_events` | 时态账本 | 见[元素数据模型](<ELEMENTS-RAG.md>) |
| `blobs` | `blob_id`, `sha256` | 不可变对象 |
| `workflow_versions` | `workflow_version_id` | 不可变流程定义 |
| `workflow_runs` | `run_id`, `workflow_version_id`, `task_id` | 一次执行 |
| `node_runs` | `node_run_id`, `run_id`, `node_id`, `state` | 节点尝试；可恢复 |
| `tasks` | `task_id`, `idempotency_key`, `state`, `generation_request_id`, `attempt_id`, `reuse_of_artifact_id` | 领域任务；区分新请求、执行尝试与显式复用 |
| `pi_session_bindings` | `node_run_id`/`task_id`, `pi_session_id`, `session_file`, `leaf_id`, `context_snapshot_id` | 同时绑定作品、路线、角色知识边界与 Pi 版本 |
| `context_snapshots` | `snapshot_id`, `task_id`, `revision_id`, `route_id`, `knowledge_version`, `base_plan_hash`, `draft_id`, `selection_version`, `selection_hash`, `intent_hash` | 交给 Pi 的只读包清单；生成冻结标识 |
| `evidence` | `evidence_id`, `source_revision_id`, `scene_id`, `block_id`, `content_hash`, `source_kind` | 可独立于任务存在的原文证据；来源种类见第 6 章 |
| `context_evidence` | `snapshot_id`, `evidence_id`, `selection_reason` | 每次检索实际使用的证据 |
| `artifacts` | `artifact_id`, `node_run_id`, `blob_id`, `completeness`, `artifact_kind` | 候选和部分输出的持久归档；卡片、批次与选择快照是不可变产物 |
| `authoring_drafts` | `draft_id`, `project_id`, `branch_id`, `base_revision_id`, `selection_version`, `selection_artifact_id` | 选择草稿协调记录，只存指针与 CAS 版本，不复制场景或事实 |
| `notes` | `note_id`, `project_id`, `status`, `scene_id`, `element_id` | 创作便签与组织关系；默认不进入修订、事实或 RAG，转为场景时复用 ChangeSet/CAS |
| `annotations` | `annotation_id`, `scene_id`, `status`, `range.from/to/baseText/textHash` | 正文批注与选区锚点；解决/重开不创建修订，原文变化只影响锚点状态 |
| `character_arcs` | `entity_id`, `project_id`, `motivation`, `goal`, `conflict`, `epiphany`, `notes` | 人物弧线计划；可编辑但不自动成为世界事实，实际事件用于对照 |
| `domain_events` | `seq`, `kind`, `json` | SSE 游标与交互回放；回放仅读取白名单事件及作品/场景、时间、操作来源和有限元数据，不保存正文或提示词 |
| `task_events` | `task_id`, `seq` | SSE 游标 |
| `outbox` / `index_jobs` | `knowledge_version` | 向量投递 |
| `adapters` / `capability_manifests` | 默认仅 Pi | 签名探测，禁止跨版本沿用 |

`story_time` / `narration_order` 从作品 revision 清单引用的场景修订读取，包含继承内容，不要求每个版本复制所有场景行。Pi `entryId`/`leafId` 只作会话游标；API 驼峰名与表字段下划线名在映射层统一。正文 `evidenceId` 按作品、修订、场景、段落与内容确定，JSON 备份恢复后的重索引复用同一 ID，保持事实/事件引用可回查；POV 在查询与恢复时统一解析为实体 ID。`GET /api/revisions/:id` 返回所选修订的真实章节、场景和事实清单，供历史预览使用。

## 5. Revision、ChangeSet 与 CAS

不可变 Revision 引用不可变内容。ChangeSet 含文本、可选元素/剧情/`scene_revisions` 提案与 `task_id`。抽取、语义检查与人工审阅在事务外针对冻结内容完成；事务内只做来源/哈希校验与数据提交，不在持有写锁时等待 Pi 或作者。提交在**同一 SQLite 事务**内：

1. 写入新 blob、revision、`scene_revisions`、facts/events、证据引用、FTS、outbox。
2. **原子条件更新**推进头，例如 `UPDATE branches SET head_revision_id=? WHERE branch_id=? AND head_revision_id=?`（期望值为 `base_revision_id`）。`changes()==1` 才提交；否则回滚并返回当前头。禁止先读后写无条件 UPDATE。
3. 每次逻辑接受动作生成并持久化唯一 `acceptanceId`，载荷绑定实际采用内容哈希、范围与基础修订；网络重试复用该 ID，新的部分接受使用新 ID。

部分采用先在事务外对实际文本重新抽取/核对，再组成待审 ChangeSet。作者也可先保存正文并把知识标为待整理；这种情况只提交正文和待办，不把未确认变化写成事实。

正文合并使用稳定段落 ID 与基础/当前/候选三方比较；跨段移动、格式、场景顺序和事实变化分别比较。多对象修改保持一个 ChangeSet；尚未确认的事实标为待整理，不伪装为已确认知识。

不把 Pi `fork`/`clone`/`new_session` 映射成作品 branch。探索结局：领域侧开 revision 分支，再绑**新** Pi session。

选定计划经同一条 ChangeSet 通路提交，其产物、并发校验与可见性规则见第 6 章。

## 6. 卡片、选定计划与生成冻结契约

> 本节是本套契约的**单一来源**，[元素数据库与 RAG](<ELEMENTS-RAG.md>) 只引用此处定义，不重复定义。卡片在工作流中的交互与节点形态见[可视化剧情与工作流](<CANVAS-WORKFLOW.md>)；本节只规定数据、并发与可见性规则。
>
> 本节为设计契约，尚未实现或实测；示例中的字段名是拟采用的命名。

### 6.1 内容状态与来源种类

材料按四种来源分类，`sourceKind` 统一为四个值。来源不等于事实真值；断言还须保留语义、审阅状态、时间和知识视角：

| `sourceKind` | 含义 | 权威载体 | 是否为已发生事实 |
| --- | --- | --- | --- |
| `candidate` | 未采用的点子卡、试演稿、候选批次 | `artifacts` 指向的不可变产物 | 否 |
| `selected_plan` | 作者已选定并写入剧情计划的决定 | 既有 `revisions` / `revision_manifests` 的剧情计划部分 | 否，标为拟发生 |
| `manuscript` | 已采用的正文 | 既有正文修订 blob | 不自动是；它是原文证据，也可能描述谣言、梦境或错误信念 |
| `author_setting` | 作者直接确认的设定或事件 | 既有事实/事件表 | 依语义与有效时点成立；可无正文锚点，不能把未来事件当作当前已发生 |

典型流转：候选 → 作者选入正式计划 → 按计划创作并采用正文 → 抽取/确认适用的事实。每步产生新对象或新修订并保留来源链，不就地改变旧候选的 sourceKind。`author_setting` 是并行入口，不需要等待 AI 抽取。

不变量：

- `candidate` 保存在可恢复产物表，但不进入正式剧情/事实表和普通 FTS/向量索引；只经显式产物引用进入获准的候选比较、组合或试演任务。
- `selected_plan` 是计划，不得作为“已经发生”的证据。它可以被规划任务与按场景目标限定的写作任务取用，规则见第 6.9 节。
- 由 `manuscript` 抽取出的断言初始为候选或待确认，作者确认后才成为已确认事实。
- ContextBundle 区分事实/原文证据、计划目标、候选输入与创作意图；每项带 sourceKind 或意图类型、源修订、用途及可见范围。候选可作为比较输入，但不能混进正文生成的事实证据清单。

### 6.2 卡片与批次：不可变产物

`IdeaCard` 与 `ProposalBatch` 都是不可变产物，保存为 `artifacts` 指向的 blob，不新增表：

| 对象 | 关键字段 |
| --- | --- |
| `IdeaCard` | `cardId`、`cardRevision`、`proposalBatchId`、`sourceRef`、`proposedFields`、`relatedEntityIds`、`dependencyRefs`、`differenceNote`、可选试演引用 |
| `ProposalBatch` | `proposalBatchId`、`parentBatchId`、`generationRequestId`、`attemptId`、`sourceTaskId`、`baseRevisionId`、`basePlanHash`、`cardRefs`、`createdAt` |

产物 JSON/API 使用驼峰字段；SQLite 列使用对应下划线名。`cardRefs`、`dependencyRefs` 和借用来源均引用 `cardId + cardRevision`，不按可变标题或单独 ID 追随最新卡。计划直接从 baseRevisionId 的作品清单投影，不存在独立 basePlanRevisionId。

- `card_revision` 单调递增。改卡产生新的卡片版本，旧版本仍是不可变 blob，可被历史选择快照引用。
- 新生成的另一种候选使用新 cardId；改同一张卡保持 ID 并增加 revision。当前/过时是相对于正在使用的选择草稿计算的状态，不修改不可变候选正文。
- 卡片只被选择快照、生成请求与产物引用；不建立“卡片本体论”新库。

### 6.3 选定计划复用既有对象

- 作者的选择、借用与改写最终形成既有 `StoryGraphPatch`，经既有 ChangeSet 审阅后进入既有 `projectRevision` 的剧情计划部分。**不新建计划版本树**：选定计划与普通剧情计划共用同一 revision 体系，用 `sourceKind=selected_plan` 区分。
- 跨卡借用：被借用字段在选择快照中记录**字段来源**（`card_id` / `card_revision` / 字段路径）与**局部三方差异**（该字段的 base、current、candidate），使审阅能区分“从另一张卡借来的”与“本卡原有”。
- **语义锁定**（保住一项创作决定，例如“主角仍会关店”）与**原文保护**（保护某段文字不被改写）是两件事：前者比较单位是决定，跨措辞成立；后者比较单位是文本片段与位置。二者分别记录、分别解除，不由模型评分解除。
- 原文保护以 blockId、范围和内容哈希核对；语义锁定同时保留结构字段与可读决定说明。无法确定新稿是否遵守语义锁时进入人工比较，不能用相似度伪装为确定性保证。

### 6.4 `authoring_drafts`：最小协调记录

新增一张协调表，只存指针与 CAS 版本，不复制场景、事实或正文：

| 列 | 说明 |
| --- | --- |
| `draft_id` | 稳定标识 |
| `project_id` / `branch_id` | 归属 |
| `base_revision_id` | 当前草稿基于的作品修订；显式合并/重定基线或提交成功后更新 |
| `selection_version` | 单调递增整数，CAS 用 |
| `selection_artifact_id` | 指向 `artifacts` 中最新一次选择快照 |

- 选卡、改卡、锁定、撤销**全部**使 `selection_version` 单调递增。每次递增写一份新的选择快照产物，`selection_artifact_id` 指向最新一份；旧快照保留以支持撤销与回溯。
- 草稿不是版本：它不产生 `revision`，随作品备份一并复制。
- 选择快照含 selectedCardRefs、lockedDecisions、protectedSpans、compositionSources 与撤销引用。更新通过 selection_version 条件写入；多标签并发修改需合并，不能最后写入覆盖。
- 同一分支可并存多个草稿（例如并行比较两套卡片组合），草稿之间互不覆盖。

### 6.5 生成冻结与执行区分

一次生成（正文、试演、组合补全、局部改写）冻结以下标识，写入 `context_snapshots` 与任务记录，使每次生成可解释、可比较、可复查：

| 标识 | 含义 |
| --- | --- |
| `base_revision_id` | 生成时的分支头 |
| `base_plan_hash` | base_revision_id 所引用的正式剧情图及场景计划投影哈希；待采用选择另由 selection_hash 描述 |
| `draft_id` / `selection_version` | 生成时的选择草稿与选择版本 |
| `selection_hash` | 已选卡版本、借用字段及锁定/保护等语义内容哈希，不含坐标、缩放与 UI 布局 |
| `intent_hash` | 作者意图与约束输入的哈希（点子文本、锁定项、作品偏好、任务目标） |
| `context_snapshot_id` | 交给 Pi 的只读上下文包 |

执行区分：

- `generation_request_id`：一次**新请求**，由作者发起。
- `attempt_id`：该请求的一次执行尝试。重试产生新的 `attempt_id`，旧尝试记录保留。
- `idempotency_key`：网络重复投递去重，返回原任务及其当前状态/已完成产物，不新建 attempt；只有调度器确认可重试的执行失败才产生新 attempt。外部调用结果未知时先对账，不承诺供应商 exactly-once。
- `reuse_of_artifact_id`：作者**显式**要求复用某次产物；为空表示新采样。显式复用与新采样在界面与日志中分别显示，不混为一谈。
- 采样配置（seed、temperature 等）只记录**可获得的部分**，不可获得时留空。不得断言已控制随机性，也不以文本编辑距离证明“更不同”。

首个点子请求也创建持久化的空 AuthoringDraft；自由写作中未使用卡片的任务可以不绑定 draftId，仍冻结正文基础版本、意图与上下文。派生哈希由宿主计算；布局变化不使创作结果过时。

### 6.6 采用前的并发校验

采用（提交 ChangeSet）在**同一 SQLite 事务**内同时校验：

1. 分支头仍等于 `base_revision_id`（CAS：`UPDATE branches SET head_revision_id=? WHERE branch_id=? AND head_revision_id=?`）；
2. 对绑定草稿的任务，选择版本与所属作品/分支仍匹配，使用条件更新递增 selection_version、更新 selection_artifact_id 和 base_revision_id；两个条件更新各自必须影响一行，否则整体回滚。

任一不匹配即回滚，并返回当前分支头与当前选择版本。**过时产物保留在 `artifacts`，不得覆盖**；界面表现为“需重算”或“可另存”，不静默采用。跨卡借用的字段来源与局部三方差异随 ChangeSet 记录；部分采用后按第 5 章规则重做受影响抽取，未采用字段不产生事实。

任务返回时先按冻结引用判定是否仍对应当前选择，只影响展示归属，不修改草稿指针。采用时再次校验，消除“收到结果后又改卡”的竞态。过时产物可通过显式三方比较重新形成基于当前版本的 ChangeSet，不要求重新付费生成。

### 6.7 Pi 会话与任务边界

- 默认使用 Pi SDK 1.4.0 的进程内会话。卡片生成、组合试演与语言推敲使用中文小说任务模板，每任务新建会话。
- 每次生成绑定作品、分支、路线、知识边界与第 6.5 节的冻结标识。语义上下文边界变化（切换路线、`knowledge_version` 改变、选定计划变更导致可见集合改变）时**重建 Pi session**，沿用第 8 章的 session 规则，不靠追加 prompt 消毒。
- 候选产物、未采用方案与旧批次不进入后续正文的上下文。

### 6.8 问题分级与不可自动跨越的决定

| 级别 | 含义 | 处理 |
| --- | --- | --- |
| 已确认约束冲突 | 与已确认事实或已确认设定冲突 | 合入前必须解决或显式声明例外 |
| 因果缺口或未知 | 缺少必要前提，或时点、数量等未知 | 允许暂缺，记为未知，不判错 |
| 审美建议 | 节奏、表达、重复等主观提醒 | 可选，作者可以忽略 |

- 三级问题**都不得以模型评分自动采纳、自动关闭或自动推进**。
- 检索、摘要、检查和候选生成可在已授权范围自动推进。批量接受是作者对可见清单作出的一次明确决定，其后的事务可以自动执行；它不是模型自行接受正文、计划或事实。
- 已确认约束冲突、版本冲突与数据出站权限是不可跳过的关卡；批量接受不得越过。
- 确认次数目标只用于研究交互负担，不作为跳过上述关卡的依据。

### 6.9 选定计划的可见性

选定计划不是一律对写作不可见。可见范围由用途决定，而不是由来源种类一刀切：

| 用途 | 选定计划可见性 |
| --- | --- |
| 总体规划、因果分析、结构补全 | 可见全部相关选定计划，标为拟发生 |
| 按当前场景目标写作、试演 | 可见与该场景目标相关的选定计划与依赖计划；标为拟发生 |
| 事实核对、已确认设定检查 | 不作为已发生证据参与判定 |
| 角色知识与读者视角检查 | 未来秘密仍按知识边界隐藏，选定计划不绕过该过滤 |

过滤顺序与既有规则一致：先按分支、路线、知识可见性与材料授权范围计算允许的源修订集合，再按用途决定 `sourceKind` 的取舍，最后回查权威证据。

本作品偏好作为 writing_intent 进入作品清单；当前任务的临时偏好只进入选择快照。保存为本书偏好必须显式决定，默认不跨书复用。intentHash 对当前有效的二者及任务目标计算，偏好不会被当作世界事实。

## 7. 任务状态、SSE 与取消

```text
queued → running → waiting_extension_ui | waiting_human
                 → cancelling → cancelled
                 → succeeded | failed | interrupted
```

`waiting_human` 是[领域工作流人工关卡](<CANVAS-WORKFLOW.md>)，待办在宿主落库后结束当前生成阶段；作者处理后再开新任务会话。`waiting_extension_ui` 为兼容预留状态，内置模式不加载交互扩展。`interrupted` 保留不完整候选。节点尝试与产物持久化，崩溃后先对账，不自动重放已成功或结果未知的模型调用。

SSE：`GET /events?task_id&cursor=`，按每个任务单调递增的 `seq` 重放。客户端记忆最后序号并去重；过期游标返回完整状态快照与新游标。Pi 原生流不是可重放事件服务，重放日志由宿主维护。映射：`turn.delta` ← `message_update`；`tool` ← `tool_execution_*`；`usage.delta` 从相同计量范围的累计字段差分。

取消整项先冻结新输入和下游调度，对任务独立会话调用 `session.abort()`；排队或尚未建立会话的任务登记取消意图，不发送提示。部分文本作为 partial 产物归档，任务进入 cancelled 或 interrupted。进度通过 `GET /api/generate/progress?key=` 查询，取消兼容任务 ID 与幂等键两种入口。

## 8. 内置 Pi SDK 引擎（v1.4.0）

完整契约见[内置 Agent 引擎](<AGENT-ENGINE.md>)。实现位于 `packages/server/src/agent/`，模型与会话均使用应用数据目录，不依赖外部 CLI 或用户全局 Pi 配置。

### 8.1 模型与凭据

Provider 配置原子写入 `<data>/agent/settings.json`，生成 `models.json` 后重建 ModelRuntime。在途任务保留旧运行时。对外仅返回 hasApiKey；测试连接不含作品内容，15 秒超时。模型列表包含自定义模型与已有可用凭据的内置模型；任务路由按照 reasoning 与 thinkingLevelMap 钳制思考强度。

### 8.2 提示与只读工具

自建 ResourceLoader 不发现扩展、技能、模板或上下文文件，系统提示为中文小说协作提示。使用 `noTools: "builtin"` 与 `tools: ["novel_*"]`，只声明 novel_search、novel_get_scene、novel_list_elements、novel_get_element、novel_world_state。所有资料绑定任务冻结的作品、分支、修订、路线、故事顺序及视角。工具数据在模型调用前捕获；人物秘密与未来证据受知识边界过滤。

### 8.3 执行、产物与会话

每任务新建 SessionManager，写入 `<data>/agent/sessions/<projectId>/`，结束后 dispose。设置使用内存存储，禁用压缩，自动重试最多一次。先订阅再 prompt；agent_end 不是领域成功，agent_settled 后还要核对终止原因、工具错误与必需输出。

ideas、polish、consistency 严格解析 JSON，允许 JSON 代码围栏。格式错误记为失败并保留原始产物；纯文本任务不把结构化结果强塞进正文。一致性报告与本地规则结果合并。所有结果仅进入候选产物，由作者决定采用；会话树不等于作品版本树。

### 8.4 运行边界

SDK 与领域服务同进程，cwd 固定为空 workspace，不构成操作系统沙箱。模型只能调用已声明的小说只读工具；服务不加载用户扩展。会话与作品内容须按数据目录备份，日志不输出密钥或作品正文。单次运行上限十分钟，HTTP requestTimeout 为 660 秒。

## 9. 可选工具适配（非默认 runtime）

仅工作流节点或扩展显式调用。失败则该节点不可用，**不回退第二套 agent loop**。最小已核入口（非参数大全）：

- ACP v1 ≠ MCP。v2 草案不作保证。
- Claude print：`--output-format json|stream-json`。`--allowedTools` 仅预批准。`--bare` 需单独 API 鉴权，禁止悄悄切付费身份。
- Codex `exec --json`。app-server 非 ACP；本轮 `developers.openai.com` `web_fetch` 不稳定，实施期再核 schema。
- Gemini `-p --output-format json|stream-json`。`--experimental-acp` 实验。
- OpenCode `run --format json` 或 `opencode acp`。`serve` 不是 ACP。

## 10. 成本、隐私与 loopback

HTTP 仅监听回环地址；Host 使用明确字面量/端口白名单，Origin 精确校验，Cookie 会话配合 CSRF 令牌。首次连接由本机启动器提供一次性配对码，换取短期 HttpOnly 会话；配对码、Cookie 与服务令牌不进作品、日志或 Pi 上下文。没有 Origin 的接口调用仍须鉴权，不能成为旁路。

扩展桥使用任务级能力句柄，只允许既定作品快照的读取和提案写入；跨分支参数、越界路径、过期令牌均拒绝。内置扩展与安装的第三方扩展属于可执行代码，版本和允许能力需分别登记。导入的小说素材或流程模板不能自动安装扩展或扩大权限。

Provider 与凭据使用应用数据目录；可用的内置模型可以沿用环境变量提供的凭据。GUI 仅展示 hasApiKey；远程模型、远程嵌入和外部 CLI 分别展示数据发送范围。

## 11. 检索一致性、缓存与备份

ChangeSet、知识修订与 outbox 同事务写入。FTS 由单写服务更新。当前 FTS 实现把每个修订的预期清单、逐场完成/失败状态持久化在 `kw_revision_indexes`；新修订优先复用父修订中正文哈希、路线、叙述顺序和故事时点均兼容的场景，其他场景仍原子重建。继承证据保留真实来源修订，查询和 ready 状态均回查实际证据与 FTS；提取入库需要重绑证据时强制重建对应场景。LanceDB 以源修订哈希、嵌入版本为索引键；旧任务不得覆盖新版本水位，但历史版本的合法索引仍可保留。当前查询按作品清单许可集合预过滤并回查，历史问答按历史快照查询，不以“全库最新版本”拒绝全部旧稿。画布只改坐标不改变语义缓存键。

备份用 [SQLite Online Backup API](<https://www.sqlite.org/backup.html>) 获取一致数据库快照，并复制其清单引用的全部不可变对象与附件，期间固定 GC 引用，完成后校验哈希。向量默认重建，可选择携带；Pi 会话单独选择并在会话静止/完整记录边界导出。恢复到新位置后重新核对 Provider 配置与模型状态；含密钥的配置须单独保护。

## 12. 实现取舍与风险

| 取舍 | 原因 | 风险 |
| --- | --- | --- |
| 进程内 Pi SDK | 去除本机 CLI 依赖与版本漂移 | 与领域服务共享进程，隔离弱于子进程 |
| 每任务知识内存快照 | 检索复用知识服务且不受在途编辑影响 | 并发任务的内存开销随数据库体积增长 |
| 切边界即新 session | 旧 session 隐含记忆无法靠 prompt 消毒 | 续写体验需作者显式续跑 |
| `scene_revisions` | 时间/顺序必须随作品版本 | 查询须 join 当前 revision |
| 原子 CAS | 并发审阅竞态 | 冲突 UI 必须可合并 |
| 卡片契约集中在第 6 章 | 避免同一契约在多文档各写一份而互相漂移 | 改动须同步引用文档 |
| `authoring_drafts` 只存指针 | 不复制场景与事实权威库 | 需防止被当作第二套版本树 |
| FTS 走单写 | 避免双写者 | 提交事务变长 |
| 扩展与 OS 隔离分开 | 领域工具约束与进程权限是不同层 | 强隔离环境下需验证 Pi 鉴权及工具代理 |
| 自建 DAG | 统一审阅/元素 | 见画布文档恢复与幂等 |

引擎回归：Provider CRUD 与密钥脱敏、模型路由钳制、先订阅再 prompt、agent_settled 后终止原因核对、只声明 novel_* 工具、JSON 解析失败归档、取消保留部分文本、独立会话与知识边界。领域回归继续覆盖人工关卡、CAS、FTS 与 SSE 重连；备份和操作系统隔离另行验收。

卡片契约另需在 M0 验证：采用前**分支头 + 选择草稿版本**双校验在同一事务内回滚；请求、执行尝试与幂等键区分，网络重投不新建任务或 attempt，结果未知不自动重放；显式复用与新采样可区分；过时产物保留而不覆盖；sourceKind 与用途过滤生效。

## 13. 实施期再核

- SDK 升级时核对 createAgentSession、ModelRuntime、ToolDefinition 与事件契约。
- 大体积数据库下每任务内存快照的性能和并发预算。
- 新增会话用量展示时，按会话与消息区分累计范围。
- 可选 CLI 与 Codex schema。
- 中文分词/嵌入/LanceDB；WAL 下 backup 锁。
