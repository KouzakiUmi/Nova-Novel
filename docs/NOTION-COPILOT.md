# Notion 外部笔记 Copilot

> 当前状态：已实现可选集成模块，随应用构建并按需启用。Notion 官方 Agent API 为公开 Beta；本地模拟 API 与真实浏览器验证和真实账户调用分别记录。

## 1. 目的与边界

在 Nova Novel 中提供独立的 Notion 笔记问答面板，用于查询资料、总结笔记和梳理灵感。Notion 负责 Agent 和笔记权限，Nova 负责外部对话界面、请求状态和本地会话记录。

- 面板不接收作品快照、场景、正文或设定；用户输入的消息是唯一发送内容。
- 插件服务不依赖 DomainStore、KnowledgeService、PiHost 或工作流，不接入小说模型路由、`novel_*`、ChangeSet 和 RAG。
- 插件只请求 Agent 列表、会话、会话事件和取消接口，不提供将回复写入小说或导入便签的操作。作者可复制回复。
- Notion Agent 自身的笔记读写能力由 Notion 配置决定。只需要问答时，应将其配置为相应的只读笔记助手。出现 `requires_action` 时只显示提示，不自动批准操作。
- 模块默认关闭；关闭时不发出 Notion 请求。插件读取或保存失败只影响插件。

当前形态是应用注册的独立可选模块，前端按需加载；不是可从任意目录热加载第三方代码的通用插件系统。后者不属于本次实现范围。

## 2. 实现入口

| 部分 | 文件与职责 |
| --- | --- |
| 服务模块 | [notion-copilot.ts](../packages/server/src/integrations/notion-copilot.ts)：配置、凭据解析、Agent 发现、SSE 消费、会话与停止 |
| 公共类型 | [notion-copilot.ts](../packages/shared/src/notion-copilot.ts)：仅外部会话字段，不含小说领域 ID |
| HTTP 注册 | [app.ts](../packages/server/src/app.ts)：`/api/plugins/notion-copilot/*`，沿用本机配对和同源校验 |
| 生命周期 | [index.ts](../packages/server/src/index.ts)：注册模块，服务关闭时停止运行并释放凭据 |
| 前端 | [NotionCopilotView.tsx](../packages/web/src/components/NotionCopilotView.tsx)：配置、历史、对话和停止，懒加载 |
| 前端请求 | [notion-copilot.ts](../packages/web/src/lib/notion-copilot.ts)：仅插件路由，沿用配对请求头 |

仓库原有的 [notion-sync.ts](../packages/server/src/integrations/notion-sync.ts) 是 Notion 页面转 Novel 便签的同步实现，本模块不注册或调用它。

## 3. 使用流程

1. 在 Notion 中准备已有的 Custom Agent，配置它可访问的笔记范围。
2. 提供官方支持的个人访问令牌（PAT）或连接令牌。连接令牌需开启 `View sessions and interact with agents` 并授权目标 Agent。Notion 桌面端登录不会自动提供 API 授权。
3. 打开侧栏「Notion 笔记 → 连接设置」，开启笔记助手。配置环境变量引用，或输入仅本次应用运行有效的令牌；保存。
4. 点击「验证连接并读取 Agent」，选择目标 Agent，再保存。也可以直接填写 Agent ID。
5. 新建对话并发送问题。后续消息复用该对话的 Notion session；可随时停止远端会话。
6. 回复可以复制。离开面板不会丢失服务端正在运行的对话，重新打开会恢复记录。

Agent 调用可能消耗 Notion 额度。首次验证连接只查询可访问 Agent 列表，不发起模型问答。

## 4. 配置与存储

数据位置由应用的 `NOVA_NOVEL_DATA_DIR` 决定：

```text
<data>/plugins/notion-copilot/settings.json
<data>/plugins/notion-copilot/conversations.json
```

配置文件仅保存：

```json
{
  "enabled": false,
  "apiKeyEnv": "NOTION_API_KEY",
  "agentId": ""
}
```

- 凭据解析顺序：本次运行令牌 → 配置引用的服务进程环境变量。
- 手动令牌仅存服务内存；关闭插件、清除本次令牌或退出应用后清除。配置与会话文件不保存令牌。
- 环境变量只保存变量名，不复制变量值。应用在启动时继承环境；修改系统环境后需由用户重新启动应用。
- 响应只返回 `hasToken` 与 `tokenSource`，错误分类不转发上游原始错误正文；对话中的当前令牌与常见令牌格式被脱敏。
- 会话记录独立于作品 SQLite、作品备份和 Pi 会话，包括本地 ID、目标 Agent ID、远端 session ID、已提交消息、发送去重 ID 与状态。
- JSON 原子写入；损坏文件保留并在插件面板报错，不静默覆盖或从空记录继续。

## 5. 官方 API 与会话契约

固定请求官方 `https://api.notion.com/v1`，使用 `Notion-Version: 2026-03-11`；无界面可配置的代理地址，HTTP 重定向被拒绝。

| 操作 | 官方接口 |
| --- | --- |
| 可访问 Agent 列表 | `POST /v1/agents/query`，支持分页 |
| 新建和继续对话 | `POST /v1/sessions`，新对话传 `agent_id + message`，继续传 `session_id + message` |
| 回复流 | 同一会话接口，`Accept: text/event-stream` |
| 读取状态 | `GET /v1/sessions/:id` |
| 已提交回复 | `POST /v1/sessions/:id/events/query`，按 sequence 升序与分页读取 `agent.message` |
| 停止 | `POST /v1/sessions/:id/cancel` |

SSE 按 `session.snapshot`、`event.provisional`、`event.committed`、`stream.end`、`stream.timeout`、`stream.error` 处理。临时文字仅展示；已提交回复按事件 ID 去重并保存。界面通过短轮询获取当前回复，不把 Notion 临时消息当成最终记录。

断流或非 SSE 响应退回状态／事件读取，不自动重新发送用户消息。每次发送带本地 `requestId`；相同请求重投幂等，复用同一标识发送不同内容会拒绝。

单次网络请求 30 秒上限，单轮总时限 10 分钟；远端标识已知时，超时尝试取消。标识未知或停止失败明确标为待确认，不宣称远端已停止。应用重启后，在途记录标为 interrupted，禁止自动续发；作者可先停止远端会话。并发上限 3 个对话，本地最多 200 个对话；每次消息上限 10000 字符，每个对话最多接受 500 条历史内的新发送。

## 6. 本机 HTTP 接口

统一前缀：`/api/plugins/notion-copilot`。

| 方法与后缀 | 输入／结果 |
| --- | --- |
| `GET /settings` | 脱敏连接状态 |
| `PUT /settings` | `{enabled, apiKeyEnv, agentId, token?}`；token 仅内存 |
| `POST /agents` | 空对象；返回可访问 Agent 列表 |
| `GET /conversations` | 本地会话列表 |
| `POST /conversations` | 空对象；创建本地会话 |
| `GET /conversations/:id` | 会话、已提交回复、临时文字与状态 |
| `POST /conversations/:id/messages` | `{message, requestId}`；202，后台消费回复 |
| `POST /conversations/:id/cancel` | 空对象；停止远端运行 |

请求按白名单校验字段；作品 ID、场景 ID 等额外字段直接拒绝。修改配置前须停止在途回复。插件路由使用现有回环地址、Host、Origin 和 `X-Nova-Novel-Token` 校验。

## 7. 验证与限制

自动化用例：[notion-copilot.test.ts](../packages/server/test/notion-copilot.test.ts)。覆盖默认关闭、环境引用与临时凭据不落盘、权限错误脱敏、Agent 分页、连续会话、发送去重、中文分片与 CRLF、临时／已提交消息分离、断流回查、远端停止、快照前停止、重启恢复、损坏文件保留、空回复拒绝、JSON 回退和事件分页。HTTP 测试比对前后 bootstrap 快照及 SQLite `total_changes()`，要求小说库零写入。

真实浏览器脚本：[test-notion-copilot-ui.mjs](../scripts/test-notion-copilot-ui.mjs)。先构建后运行：

```sh
pnpm build
node scripts/test-notion-copilot-ui.mjs
```

脚本使用独立临时数据库、固定的模拟 Notion 响应及隔离的 Chromium 用户目录；验证配置、发现、发送、停止、刷新恢复与窄窗口，截图保存至 `artifacts/notion-copilot-ui.png`。本机可用的 Chromium 由脚本发现，也可通过 `NOVA_BROWSER` 指定。

真实 Notion 账户调用、账户 Agent 可见性、生成质量和实际额度消耗仍需有效 API 授权后验证。本次未读取或迁移桌面端 Cookie；桌面登录状态和官方 API 授权属于不同接入条件。

## 8. 官方来源

- [Notion Agent APIs 概览与访问权限](https://developers.notion.com/guides/notion-agent-apis/overview)
- [Custom Agent 接入流程](https://developers.notion.com/guides/notion-agent-apis/quickstart)
- [创建或更新会话](https://developers.notion.com/reference/notion-agent-apis/update-session)
- [公开 Beta 迁移与 SSE 事件](https://developers.notion.com/guides/notion-agent-apis/upgrading-to-public-beta)
- [会话事件查询](https://developers.notion.com/reference/notion-agent-apis/query-session-events)
