import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotionConversation, NotionCopilotAgent, NotionCopilotSettings, NotionCopilotSettingsView } from "@nova-novel/shared";

/** Optional integration. No store, knowledge service, provider route or domain tools. */
export const NOTION_COPILOT_PLUGIN = { id: "notion-copilot", version: 1, capabilities: ["notion.agent.chat"] } as const;
const VERSION = "2026-03-11";
const ROOT = "https://api.notion.com/v1";
const MAX_BYTES = 2_000_000;
const defaults: NotionCopilotSettings = { enabled: false, apiKeyEnv: "NOTION_API_KEY", agentId: "" };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const validId = (value: string): boolean => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const active = (status: string): boolean => ["running", "stopping"].includes(status);

export class NotionCopilotError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface Turn { controller: AbortController; token: string; canceled: boolean; done: Promise<void>; cancelPromise?: Promise<void> }
interface SavedConversation extends NotionConversation { requestIds: string[] }
export class NotionCopilotPlugin {
  private settings: NotionCopilotSettings = { ...defaults };
  private sessionToken = "";
  private conversations = new Map<string, SavedConversation>();
  private runs = new Map<string, Turn>();
  private storageError = "";
  private closed = false;
  private readonly directory: string;
  constructor(dataDir: string, private readonly fetcher: typeof fetch = fetch) {
    this.directory = resolve(dataDir, "plugins", NOTION_COPILOT_PLUGIN.id);
    try {
      const settingsPath = resolve(this.directory, "settings.json");
      if (existsSync(settingsPath)) this.settings = this.validateSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
      const historyPath = resolve(this.directory, "conversations.json");
      if (existsSync(historyPath)) {
        const history: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
        if (!Array.isArray(history)) throw new Error("Invalid history");
        for (const item of history) {
          const saved = object(item);
          if (!validId(text(saved.id)) || !validId(text(saved.agentId)) || typeof saved.updatedAt !== "string" || typeof saved.createdAt !== "string" || typeof saved.title !== "string" || !["idle", "running", "stopping", "completed", "requires_action", "canceled", "failed", "interrupted"].includes(text(saved.status)) || !Array.isArray(saved.messages) || !Array.isArray(saved.requestIds) || saved.requestIds.some(id => typeof id !== "string") || saved.messages.some(raw => {
            const message = object(raw);
            return typeof message.id !== "string" || !["user", "assistant"].includes(text(message.role)) || typeof message.text !== "string" || typeof message.createdAt !== "string";
          }) || (saved.remoteSessionId !== undefined && !validId(text(saved.remoteSessionId)))) throw new Error("Invalid conversation");
          const conversation = saved as unknown as SavedConversation;
          if (active(conversation.status)) {
            conversation.status = "interrupted";
            conversation.error = "应用曾在回复过程中关闭。可在 Notion 中确认运行状态，或停止远端会话后再继续。";
          }
          conversation.partialText = "";
          this.conversations.set(conversation.id, conversation);
        }
      }
    } catch {
      this.storageError = "Notion 插件配置或会话记录无法读取，请检查插件数据目录；原文件已保留。";
      this.settings = { ...defaults };
      this.conversations.clear();
    }
  }
  private validateSettings(input: ObjectValue): NotionCopilotSettings {
    if (typeof input.enabled !== "boolean" || typeof input.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(input.apiKeyEnv) || typeof input.agentId !== "string" || (input.agentId !== "" && !validId(input.agentId))) throw new NotionCopilotError(400, "NOTION_INVALID_SETTINGS", "请检查启用状态、环境变量名和 Agent ID");
    return { enabled: input.enabled, apiKeyEnv: input.apiKeyEnv, agentId: input.agentId };
  }
  private credential(): string { return this.sessionToken || process.env[this.settings.apiKeyEnv]?.trim() || ""; }
  view(): NotionCopilotSettingsView {
    return { ...this.settings, hasToken: !!this.credential(), tokenSource: this.sessionToken ? "session" : this.credential() ? "environment" : "none", ...(this.storageError ? { error: this.storageError } : {}) };
  }
  private write(name: string, value: unknown): void {
    if (this.storageError) throw new NotionCopilotError(503, "NOTION_STORAGE_ERROR", this.storageError);
    try {
      mkdirSync(this.directory, { recursive: true });
      const target = resolve(this.directory, name);
      const temp = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, target);
    } catch { throw new NotionCopilotError(503, "NOTION_STORAGE_ERROR", "Notion 插件数据保存失败，请检查数据目录是否可写"); }
  }
  private persist(): void {
    this.write("conversations.json", [...this.conversations.values()].map(item => ({ ...item, partialText: "" })));
  }
  async configure(input: ObjectValue): Promise<NotionCopilotSettingsView> {
    const settings = this.validateSettings(input);
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length > 4096 || /[\s\x00-\x1f]/.test(input.token))) throw new NotionCopilotError(400, "NOTION_INVALID_TOKEN", "令牌格式无效");
    if (this.runs.size) throw new NotionCopilotError(409, "NOTION_BUSY", "请先停止当前回复，再修改连接设置");
    this.write("settings.json", settings);
    this.settings = settings;
    if (typeof input.token === "string") this.sessionToken = input.token;
    if (!settings.enabled) this.sessionToken = "";
    return this.view();
  }
  private assertReady(): string {
    if (this.closed || !this.settings.enabled) throw new NotionCopilotError(409, "NOTION_DISABLED", "请先启用 Notion 笔记助手");
    const token = this.credential();
    if (!token) throw new NotionCopilotError(409, "NOTION_TOKEN_REQUIRED", "请配置 Notion API 令牌；桌面应用登录不会自动授权 API");
    return token;
  }
  private safe(value: string, token: string): string {
    return (token ? value.split(token).join("[REDACTED]") : value).replace(/(?:ntn_|secret_)[a-zA-Z0-9_-]+/g, "[REDACTED]");
  }
  private async request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${ROOT}${path}`, { ...init, redirect: "error", headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json", ...init.headers }, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    } catch { throw new NotionCopilotError(502, "NOTION_NETWORK_ERROR", "Notion 连接中断或超时，请检查网络后重试"); }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = { 401: "Notion 令牌无效或已过期", 403: "Notion 权限不足或 Agent 额度不可用，请检查授权和额度", 404: "Notion Agent 或会话不可访问，请检查 Agent 授权", 409: "Notion 会话正在运行或发生冲突，请稍后刷新", 429: "Notion 请求限流，请稍后重试" };
      throw new NotionCopilotError(502, "NOTION_API_ERROR", messages[response.status] ?? `Notion 服务暂不可用（${response.status}）`);
    }
    return response;
  }
  private async json(response: Response): Promise<ObjectValue> {
    if (!response.body) throw new NotionCopilotError(502, "NOTION_INVALID_RESPONSE", "Notion 返回空响应");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BYTES) throw new Error("limit"); chunks.push(part.value); }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { await reader.cancel(); throw new NotionCopilotError(502, "NOTION_INVALID_RESPONSE", "Notion 响应格式无效或内容过大"); }
    finally { reader.releaseLock(); }
  }
  async agents(): Promise<NotionCopilotAgent[]> {
    const token = this.assertReady();
    const agents: NotionCopilotAgent[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const payload = await this.json(await this.request("/agents/query", token, { method: "POST", body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) }));
      if (!Array.isArray(payload.results)) throw new NotionCopilotError(502, "NOTION_INVALID_RESPONSE", "Notion 未返回 Agent 列表");
      for (const raw of payload.results) { const item = object(raw); if (validId(text(item.id))) agents.push({ id: text(item.id), name: this.safe(text(item.name), token), description: this.safe(text(item.description), token) }); }
      if (payload.has_more !== true) return agents;
      const next = text(payload.next_cursor);
      if (!next || next === cursor) break;
      cursor = next;
    }
    throw new NotionCopilotError(502, "NOTION_INVALID_RESPONSE", "Notion Agent 列表过大或分页无效，请稍后重试");
  }
  list(): NotionConversation[] { return [...this.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => this.publicConversation(item)); }
  private publicConversation(item: SavedConversation): NotionConversation { const { requestIds: _ids, ...view } = item; return structuredClone(view); }
  get(id: string): NotionConversation { return this.publicConversation(this.find(id)); }
  private find(id: string): SavedConversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new NotionCopilotError(404, "NOTION_CONVERSATION_NOT_FOUND", "笔记助手会话不存在");
    return conversation;
  }
  create(): NotionConversation {
    this.assertReady();
    if (!this.settings.agentId) throw new NotionCopilotError(409, "NOTION_AGENT_REQUIRED", "请先选择 Notion Agent");
    if (this.conversations.size >= 200) throw new NotionCopilotError(409, "NOTION_HISTORY_LIMIT", "本机已保存 200 个笔记会话，请继续已有会话");
    const now = new Date().toISOString();
    const conversation: SavedConversation = { id: randomUUID(), title: "新笔记对话", agentId: this.settings.agentId, createdAt: now, updatedAt: now, status: "idle", messages: [], partialText: "", requestIds: [] };
    this.conversations.set(conversation.id, conversation);
    try { this.persist(); } catch (error) { this.conversations.delete(conversation.id); throw error; }
    return this.publicConversation(conversation);
  }
  send(id: string, input: ObjectValue): NotionConversation {
    const token = this.assertReady();
    const item = this.find(id);
    const message = text(input.message).trim();
    const requestId = text(input.requestId);
    if (!message || message.length > 10_000 || !validId(requestId)) throw new NotionCopilotError(400, "NOTION_INVALID_MESSAGE", "请输入 1–10000 字的消息和有效请求标识");
    if (item.requestIds.includes(requestId)) {
      if (item.messages.find(previous => previous.id === requestId)?.text !== this.safe(message, token)) throw new NotionCopilotError(409, "NOTION_REQUEST_CONFLICT", "同一发送标识不能用于不同消息");
      return this.publicConversation(item);
    }
    if (this.runs.has(id) || item.status === "interrupted") throw new NotionCopilotError(409, "NOTION_BUSY", "请先停止或确认当前 Notion 会话的运行状态");
    if (item.status === "requires_action") throw new NotionCopilotError(409, "NOTION_REQUIRES_ACTION", "此会话需要在 Notion 侧处理操作确认，请停止后新建对话");
    if (this.runs.size >= 3 || item.messages.length >= 500) throw new NotionCopilotError(409, "NOTION_LIMIT", "同时最多运行 3 个会话，每个会话最多保存 500 条消息");
    const before = structuredClone(item);
    const now = new Date().toISOString();
    item.messages.push({ id: requestId, role: "user", text: this.safe(message, token), createdAt: now });
    item.requestIds.push(requestId);
    item.title = item.messages.length === 1 ? this.safe(message.slice(0, 40), token) : item.title;
    item.updatedAt = now; item.status = "running"; item.partialText = ""; delete item.error;
    try { this.persist(); } catch (error) { this.conversations.set(id, before); throw error; }
    const run: Turn = { controller: new AbortController(), token, canceled: false, done: Promise.resolve() };
    this.runs.set(id, run);
    run.done = this.execute(item, message, run).finally(() => this.runs.delete(id));
    void run.done.catch(() => undefined);
    return this.publicConversation(item);
  }
  private commitEvent(item: SavedConversation, raw: unknown, token: string, provisional: boolean): void {
    const event = object(raw);
    if (event.type !== "agent.message") return;
    const content = Array.isArray(event.content) ? event.content : [];
    const body = this.safe(content.map(part => { const value = object(part); return value.type === "text" ? text(value.text) : ""; }).join(""), token);
    if (provisional) { item.partialText = body.slice(0, MAX_BYTES); return; }
    const eventId = text(event.id);
    if (!eventId || !body || item.messages.some(message => message.id === eventId)) return;
    if (body.length > MAX_BYTES || item.messages.length >= 1000) throw new NotionCopilotError(502, "NOTION_REPLY_TOO_LARGE", "Notion 回复过大，请缩小问题范围");
    item.messages.push({ id: eventId, role: "assistant", text: body, createdAt: text(event.created_at) || new Date().toISOString() });
    item.partialText = ""; this.persist();
  }
  private applyStatus(item: SavedConversation, status: string): void {
    if (status === "requires_action") { item.status = "requires_action"; item.error = "Notion Agent 正在等待操作确认。本助手仅展示问答；请停止此会话并在 Notion 侧检查 Agent 权限与操作。"; }
    else if (status === "completed") item.status = "completed";
    else if (status === "canceled") item.status = "canceled";
    else if (["failed", "terminated"].includes(status)) { item.status = "failed"; item.error = "Notion Agent 运行失败或已终止，请在 Notion 中查看详情。"; }
    else if (!["queued", "in_progress"].includes(status)) throw new NotionCopilotError(502, "NOTION_UNKNOWN_STATUS", "Notion 返回未知运行状态，请停止会话后检查");
  }
  private async stream(item: SavedConversation, response: Response, run: Turn): Promise<void> {
    if (!response.body) throw new Error("Empty stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength;
        if (total > 10 * MAX_BYTES) throw new NotionCopilotError(502, "NOTION_REPLY_TOO_LARGE", "Notion 回复过大，请缩小问题范围");
        pending += decoder.decode(part.value, { stream: true });
        pending = pending.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const envelope = object(JSON.parse(data));
          if (envelope.type === "session.snapshot") {
            const remoteId = text(object(envelope.session).id);
            if (!validId(remoteId)) throw new Error("Invalid session");
            item.remoteSessionId = remoteId; this.persist();
            if (run.canceled) { await this.remoteCancel(item, run); return; }
          } else if (envelope.type === "event.provisional") this.commitEvent(item, envelope.event, run.token, true);
          else if (envelope.type === "event.committed") this.commitEvent(item, envelope.event, run.token, false);
          else if (envelope.type === "stream.end") { this.applyStatus(item, text(envelope.status)); return; }
          else if (envelope.type === "stream.timeout") return;
          else if (envelope.type === "stream.error") throw new NotionCopilotError(502, "NOTION_AGENT_ERROR", "Notion Agent 本轮运行失败，请检查 Agent 状态与额度");
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private async readEvents(item: SavedConversation, run: Turn, id: string): Promise<void> {
      let cursor = "";
      for (let page = 0; page < 100; page++) {
        const payload = await this.json(await this.request(`/sessions/${encodeURIComponent(id)}/events/query`, run.token, { method: "POST", signal: run.controller.signal, body: JSON.stringify({ filter: { property: "type", event_type: { equals: "agent.message" } }, sorts: [{ property: "sequence", direction: "ascending" }], page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) }));
        if (!Array.isArray(payload.results)) throw new Error("Invalid events");
        for (const event of payload.results) this.commitEvent(item, event, run.token, false);
        if (payload.has_more !== true) break;
        const next = text(payload.next_cursor);
        if (!next || next === cursor || page === 99) throw new Error("Invalid cursor");
        cursor = next;
      }
  }
  private async poll(item: SavedConversation, run: Turn): Promise<void> {
    const id = item.remoteSessionId;
    if (!id) throw new NotionCopilotError(502, "NOTION_SESSION_UNKNOWN", "未收到 Notion 会话标识，远端可能仍在运行；请在 Notion 中确认后新建对话");
    while (active(item.status)) {
      if (run.canceled) { await this.remoteCancel(item, run); return; }
      const session = await this.json(await this.request(`/sessions/${encodeURIComponent(id)}`, run.token, { signal: run.controller.signal }));
      await this.readEvents(item, run, id);
      this.applyStatus(item, text(session.status));
      if (active(item.status)) await new Promise<void>((resolveWait, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
        const timer = setTimeout(() => { run.controller.signal.removeEventListener("abort", abort); resolveWait(); }, 1500);
        run.controller.signal.addEventListener("abort", abort, { once: true });
        if (run.controller.signal.aborted) abort();
      });
    }
  }
  private async execute(item: SavedConversation, message: string, run: Turn): Promise<void> {
    const timer = setTimeout(() => run.controller.abort(), 600_000);
    const previousReplies = item.messages.filter(value => value.role === "assistant").length;
    try {
      const response = await this.request("/sessions", run.token, { method: "POST", headers: { Accept: "text/event-stream" }, body: JSON.stringify(item.remoteSessionId ? { session_id: item.remoteSessionId, message } : { agent_id: item.agentId, message }), signal: run.controller.signal });
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        try { await this.stream(item, response, run); }
        catch (error) { if (!item.remoteSessionId || run.controller.signal.aborted || error instanceof NotionCopilotError) throw error; }
      } else {
        const session = await this.json(response);
        if (!validId(text(session.id))) throw new Error("Invalid session");
        item.remoteSessionId = text(session.id); this.persist();
      }
      // Reconcile a dropped stream through read-only endpoints, never resend a message.
      if (!item.remoteSessionId) throw new NotionCopilotError(502, "NOTION_SESSION_UNKNOWN", "Notion 未返回会话标识，请在 Notion 中确认运行状态");
      if (active(item.status)) await this.poll(item, run);
      if (item.status === "completed" && item.messages.filter(value => value.role === "assistant").length === previousReplies) {
        if (item.remoteSessionId) await this.readEvents(item, run, item.remoteSessionId);
        if (item.messages.filter(value => value.role === "assistant").length === previousReplies) throw new NotionCopilotError(502, "NOTION_EMPTY_REPLY", "Notion 本轮没有返回可用回复，请在 Notion 中检查会话结果");
      }
    } catch (error) {
      if (run.canceled && item.status === "canceled") return;
      item.status = error instanceof NotionCopilotError && error.code === "NOTION_API_ERROR" && !item.remoteSessionId ? "failed" : "interrupted";
      item.error = error instanceof NotionCopilotError ? error.message : "Notion 回复中断，请停止远端会话后再继续；已确认的回复已保留。";
      if (!item.remoteSessionId && item.status === "interrupted") item.error += " 尚未收到远端会话标识，请在 Notion 中确认运行状态。";
      if (run.controller.signal.aborted && !run.canceled) {
        item.error = "Notion 回复已超时，正在停止远端运行。";
        try {
          if (!item.remoteSessionId) throw new Error("Unknown remote session");
          await this.remoteCancel(item, run); item.error = "Notion 回复已超时，远端会话已停止。";
        }
        catch { item.status = "interrupted"; item.error = "Notion 回复超时，远端停止未确认，请再次停止或在 Notion 中查看。"; }
      }
    } finally {
      clearTimeout(timer); item.partialText = ""; item.updatedAt = new Date().toISOString();
      try { this.persist(); } catch { item.status = "failed"; item.error = "本轮 Notion 会话保存失败，请保留当前页面并检查数据目录。"; }
    }
  }
  private async remoteCancel(item: SavedConversation, run: Turn): Promise<void> {
    if (!item.remoteSessionId) return;
    if (!run.cancelPromise) run.cancelPromise = (async () => {
      const stopped = await this.json(await this.request(`/sessions/${encodeURIComponent(item.remoteSessionId!)}/cancel`, run.token, { method: "POST", body: "{}" }));
      if (!["canceled", "completed", "failed", "terminated"].includes(text(stopped.status))) {
        run.controller.abort();
        throw new NotionCopilotError(502, "NOTION_CANCEL_UNCONFIRMED", "Notion 尚未确认停止，请重试或在 Notion 中查看");
      }
      item.status = "canceled"; item.partialText = ""; delete item.error; run.controller.abort();
    })();
    try { await run.cancelPromise; } catch (error) { delete run.cancelPromise; throw error; }
  }
  async cancel(id: string): Promise<NotionConversation> {
    const item = this.find(id);
    let run = this.runs.get(id);
    if (!run) {
      if (!["interrupted", "requires_action"].includes(item.status)) return this.publicConversation(item);
      if (!item.remoteSessionId) throw new NotionCopilotError(409, "NOTION_SESSION_UNKNOWN", "会话标识未知，请在 Notion 中检查运行状态");
      run = { token: this.assertReady(), controller: new AbortController(), canceled: true, done: Promise.resolve() };
    }
    run.canceled = true; item.status = "stopping";
    try {
      await this.remoteCancel(item, run);
      if (!item.remoteSessionId) item.error = "正在等待 Notion 返回会话标识后停止。";
      this.persist();
    } catch (error) { item.status = "interrupted"; item.error = "远端停止尚未确认，请重试或在 Notion 中查看。"; this.persist(); throw error; }
    return this.publicConversation(item);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.runs.keys()].map(id => this.cancel(id)));
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.allSettled([...this.runs.values()].map(run => run.done));
    this.sessionToken = "";
  }
}
