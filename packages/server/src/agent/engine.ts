import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, VERSION, type AgentSession, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { GenerationProgress, PiConnection, ProviderApi, ProviderTestResult } from "@nova-novel/shared";
import type { KnowledgeService, PiGenerationInput, PiGenerationResult, PiHost } from "../contracts.js";
import type { DomainStore } from "../store.js";
import { DomainError } from "../domain.js";
import { AgentSettings } from "./settings.js";
import { composePrompt, NOVEL_SYSTEM_PROMPT, parseOutput } from "./prompts.js";
import { novelTools, type WorkflowCatalog } from "./tools.js";

export function novelResourceLoader(): ResourceLoader {
  return { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => NOVEL_SYSTEM_PROMPT, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} };
}
interface Run { progress: GenerationProgress; cancelled: boolean; session?: AgentSession; done: Promise<void>; finish(): void }
export class EmbeddedAgentHost implements PiHost {
  private runs = new Map<string, Run>();
  private cancelled = new Set<string>();
  private workflowCatalog?: WorkflowCatalog;
  private closed = false;
  private constructor(readonly settings: AgentSettings, readonly store: DomainStore, readonly knowledge: KnowledgeService) {}
  static async create(options: { dataDir: string; store: DomainStore; knowledge: KnowledgeService }) {
    return new EmbeddedAgentHost(await AgentSettings.create(options.dataDir), options.store, options.knowledge);
  }
  setWorkflowCatalog(catalog: WorkflowCatalog): void { this.workflowCatalog = catalog; }
  getConnection(): PiConnection {
    const available = this.settings.resolveModel("scene");
    return { mode: "embedded", version: VERSION, state: available ? "connected" : "unconfigured", detail: available ? "内置小说 Agent 已就绪" : "请先在设置中添加模型；写作、保存与版本功能可正常使用", sendsDataTo: available ? `任务上下文发送至所选服务 ${available.provider}` : "尚未选择模型服务" };
  }
  progress(key: string): GenerationProgress {
    const task = this.store.taskByKey(key);
    const running = task ? this.runs.get(task.taskId) : undefined;
    if (running) return { ...running.progress, state: task!.state, tools: [...running.progress.tools] };
    const result = task?.result as { text?: string } | undefined;
    return { ...(task ? { taskId: task.taskId } : {}), state: task?.state ?? "unknown", text: result?.text ?? "", tools: [] };
  }
  async generate(input: PiGenerationInput): Promise<PiGenerationResult> {
    if (this.closed) throw new DomainError(503, "AGENT_CLOSED", "Agent 已关闭");
    const { task, request } = input;
    let finish = () => {};
    const done = new Promise<void>(resolveDone => { finish = resolveDone; });
    const run: Run = { progress: { taskId: task.taskId, state: "running", text: "", tools: [] }, cancelled: this.cancelled.delete(task.taskId), done, finish };
    this.runs.set(task.taskId, run);
    const output = { ideas: "ideas", rehearsal: "rehearsal", scene: "continuation", polish: "replacement", consistency: "report", guide: "guide" }[request.kind] as NonNullable<PiGenerationResult["output"]>;
    let timer: NodeJS.Timeout | undefined;
    let sessionId: string | undefined;
    let disposeTools: (() => void) | undefined;
    try {
      if (run.cancelled) return { output, text: "", completeness: "partial" };
      // Keep this runtime/model pair even if provider settings change while the task is in flight.
      const runtime = this.settings.runtime;
      const route = this.settings.route(request.kind);
      if (!route.model) throw new DomainError(503, "AGENT_UNCONFIGURED", "请先在设置中添加模型");
      const model = runtime.getModel(route.model.provider, route.model.modelId);
      if (!model) throw new DomainError(503, "AGENT_UNCONFIGURED", "请先在设置中添加模型");
      const frozen = this.store.generationContext(task.taskId);
      const localIssues = request.kind === "consistency" && frozen.novel?.scene ? this.knowledge.checkConsistency(frozen.novel.scene, request.range?.baseText ?? frozen.novel.scene.body) : [];
      const toolScope = novelTools(this.store, this.knowledge, task.taskId, this.workflowCatalog);
      disposeTools = toolScope.dispose;
      const tools = toolScope.tools;
      const cwd = resolve(this.settings.agentDir, "workspace");
      const sessionDir = resolve(this.settings.agentDir, "sessions", request.projectId);
      mkdirSync(sessionDir, { recursive: true });
      const manager = SessionManager.create(cwd, sessionDir);
      sessionId = manager.getSessionId();
      const { session } = await createAgentSession({ cwd, agentDir: this.settings.agentDir, model, thinkingLevel: route.thinkingLevel, modelRuntime: runtime, resourceLoader: novelResourceLoader(), noTools: "builtin", tools: ["novel_*"], customTools: tools, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } }) });
      run.session = session;
      if (run.cancelled) return { output, text: "", completeness: "partial", sessionId };
      let settled = false;
      let interrupted = false;
      let toolError = false;
      let stopReason: string | undefined;
      let currentText = "";
      session.subscribe(event => {
        if (event.type === "message_start" && event.message.role === "assistant") currentText = "";
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { currentText += event.assistantMessageEvent.delta; run.progress.text = currentText; }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const authoritative = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          if (authoritative) run.progress.text = authoritative;
          stopReason = event.message.stopReason;
        }
        if (event.type === "tool_execution_start") run.progress.tools.push(event.toolName);
        if (event.type === "tool_execution_end" && event.isError) toolError = true;
        if (event.type === "agent_settled") { settled = true; interrupted = event.aborted; }
      });
      timer = setTimeout(() => { run.cancelled = true; void session.abort(); }, 600_000);
      await session.prompt(composePrompt(request, frozen, toolScope.isVisible));
      const text = session.getLastAssistantText() || run.progress.text;
      if (run.cancelled || interrupted || !settled || toolError || ["length", "error", "aborted", "deferred"].includes(stopReason ?? "")) {
        return { output, text, completeness: "partial", sessionId };
      }
      const result = parseOutput(request.kind, text);
      if (result.report && frozen.novel?.scene) {
        const issues = [...localIssues.map(({ severity, title, detail, evidence }) => ({ severity, title, detail, evidence })), ...result.report.issues];
        result.report.issues = issues.filter((issue, index) => issues.findIndex(item => item.title === issue.title && item.detail === issue.detail) === index);
      }
      return { ...result, completeness: "complete", sessionId, ...(manager.getLeafId() ? { leafId: manager.getLeafId()! } : {}) };
    } catch (error) {
      if (run.cancelled) return { output, text: run.progress.text, completeness: "partial", ...(sessionId ? { sessionId } : {}) };
      const message = error instanceof DomainError ? error.message : "模型生成失败，请检查服务配置或稍后重试";
      if (!(error instanceof DomainError)) console.warn("Nova Novel generation failed:", this.settings.redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
      this.store.preserveFailedOutput(task.taskId, { output, text: run.progress.text, ...(sessionId ? { sessionId } : {}) }, message);
      throw error instanceof DomainError ? error : new DomainError(502, "AGENT_GENERATION_FAILED", message);
    } finally {
      if (timer) clearTimeout(timer);
      try { run.session?.dispose(); }
      finally { try { disposeTools?.(); } finally { run.finish(); this.runs.delete(task.taskId); } }
    }
  }
  async cancel(taskId: string): Promise<void> {
    const run = this.runs.get(taskId);
    if (!run) { this.cancelled.add(taskId); return; }
    run.cancelled = true;
    if (run.session) await run.session.abort();
    await run.done;
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.runs.keys()].map(taskId => this.cancel(taskId))); }
  async testProvider(id: string, modelId?: string): Promise<ProviderTestResult> {
    const provider = this.settings.provider(id);
    const runtime = this.settings.runtime;
    const model = runtime.getModel(id, modelId ?? provider.models[0]!.id);
    if (!model) throw new DomainError(400, "MODEL_NOT_FOUND", "模型不存在");
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: "只回复：连接成功", timestamp: Date.now() }] }, { signal: controller.signal, maxTokens: 32 });
      if (["error", "aborted"].includes(response.stopReason)) return { ok: false, latencyMs: Date.now() - start, message: "连接失败，请检查地址、模型和 API Key" };
      return { ok: true, latencyMs: Date.now() - start, message: "连接成功", sample: this.settings.redact(response.content.filter(block => block.type === "text").map(block => block.text).join("").slice(0, 160)) };
    } catch { return { ok: false, latencyMs: Date.now() - start, message: controller.signal.aborted ? "连接超时（15 秒）" : "连接失败，请检查地址、模型和 API Key" }; }
    finally { clearTimeout(timer); }
  }
  async discoverProvider(id: string, input: Record<string, unknown>) {
    // 添加表单中尚未保存的 provider 只使用本次请求提供的地址与密钥。
    const provider: { api?: unknown; baseUrl?: unknown; apiKey?: unknown } = this.settings.hasProvider(id) ? this.settings.provider(id) : {};
    const api = input.api ?? provider.api;
    if (!["openai-completions", "openai-responses"].includes(api as ProviderApi)) throw new DomainError(400, "DISCOVERY_UNSUPPORTED", "仅 OpenAI 兼容服务支持读取模型列表");
    let url: URL;
    try { url = new URL(String(input.baseUrl ?? provider.baseUrl)); } catch { throw new DomainError(400, "INVALID_BASE_URL", "服务地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DomainError(400, "INVALID_BASE_URL", "服务地址无效");
    const key = input.apiKey ?? provider.apiKey ?? "";
    if (typeof key !== "string" || /[\r\n]/.test(key)) throw new DomainError(400, "INVALID_API_KEY", "API Key 格式无效");
    try {
      const response = await fetch(`${url.href.replace(/\/$/, "")}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000), redirect: "error" });
      if (!response.ok) throw new Error("discovery failed");
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error("discovery too large");
      const data = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(data.data)) throw new Error("invalid model list");
      return { models: data.data.filter(item => typeof item.id === "string" && item.id.length <= 200 && !item.id.includes(key || "\u0000")).slice(0, 500).map(item => ({ id: item.id as string })) };
    } catch { throw new DomainError(502, "MODEL_DISCOVERY_FAILED", "读取模型列表失败，请检查服务配置"); }
  }
}
