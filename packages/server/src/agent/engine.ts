import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, VERSION, type AgentSession, type ModelRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { GenerationProgress, IngestPlan, PiConnection, ProviderApi, ProviderTestResult } from "@nova-novel/shared";
import type { KnowledgeService, PiGenerationInput, PiGenerationResult, PiHost } from "../contracts.js";
import type { DomainStore } from "../store.js";
import { DomainError } from "../domain.js";
import { AgentSettings, secretOf, validateProxy } from "./settings.js";
import { providerFetch } from "./proxy.js";
import { AgentUsageService } from "./usage.js";
import { planManuscriptIngest } from "./ingest-planner.js";
import type { VolcengineService } from "./volcengine/service.js";
import { checkPromptBudget, NOVEL_SYSTEM_PROMPT, parseOutput } from "./prompts.js";
import { novelTools, type WorkflowCatalog } from "./tools.js";

export function novelResourceLoader(): ResourceLoader {
  return { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => NOVEL_SYSTEM_PROMPT, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} };
}
interface Run { progress: GenerationProgress; cancelled: boolean; session?: AgentSession; done: Promise<void>; finish(): void }
type ProxyConfig = { proxyEnabled?: boolean; proxyUrl?: string; authProviderId?: string };
function requestOptions(provider: ProxyConfig, api: string): { fetch?: typeof fetch; transport?: "sse" } {
  if (!provider.proxyEnabled) return {};
  if (provider.authProviderId) throw new DomainError(400, "PROXY_UNSUPPORTED", "OAuth 服务的凭据刷新不支持代理，请关闭代理或改用 API Key");
  if (!["openai-completions", "openai-responses", "anthropic-messages", "openai-codex-responses", "mistral-conversations", "azure-openai-responses", "pi-messages"].includes(api)) {
    throw new DomainError(400, "PROXY_UNSUPPORTED", "该模型协议不支持代理，请关闭代理或选择其他模型");
  }
  return { fetch: providerFetch(provider), ...(api === "openai-codex-responses" ? { transport: "sse" as const } : {}) };
}
/** 每个任务使用独立包装器，不修改共享 runtime 或进程全局 fetch。 */
function runtimeWithProxy(runtime: ModelRuntime, options: ReturnType<typeof requestOptions>): ModelRuntime {
  if (!options.fetch) return runtime;
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "streamSimple") return (model: Parameters<ModelRuntime["streamSimple"]>[0], context: Parameters<ModelRuntime["streamSimple"]>[1], current?: Parameters<ModelRuntime["streamSimple"]>[2]) => target.streamSimple(model, context, { ...current, ...options });
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export class EmbeddedAgentHost implements PiHost {
  private runs = new Map<string, Run>();
  private cancelled = new Set<string>();
  private workflowCatalog?: WorkflowCatalog;
  private closed = false;
  readonly usage: AgentUsageService;
  volcengine?: VolcengineService;
  private constructor(readonly settings: AgentSettings, readonly store: DomainStore, readonly knowledge: KnowledgeService) { this.usage = new AgentUsageService(settings); }
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
    let timedOut = false;
    const partial = (failureReason: NonNullable<PiGenerationResult["failureReason"]>, error: string, text = run.progress.text): PiGenerationResult => ({ output, text, completeness: "partial", failureReason, error: this.settings.redact(error), ...(sessionId ? { sessionId } : {}) });
    const providerError = (detail: string): string => {
      const safe = this.settings.redact(detail);
      if (/context.{0,30}(length|window|limit)|maximum.{0,20}(context|token)|上下文/i.test(safe)) return "模型服务错误：上下文超出服务窗口，请减少资料或选择更大窗口模型后重试";
      if (/401|unauthori[sz]ed|invalid.{0,20}(api.?key|credential)|authentication/i.test(safe)) return "模型服务错误：鉴权失败（401），请检查 API Key 或重新登录";
      if (/403|forbidden/i.test(safe)) return "模型服务错误：访问被拒绝（403），请检查模型权限与服务配置";
      if (/429|rate.?limit|quota|余额|额度/i.test(safe)) return "模型服务错误：请求限流或额度不足（429），请检查额度并稍后重试";
      if (/content.?filter|safety|moderation/i.test(safe)) return "模型服务错误：内容被服务过滤，请调整本次输入后重试";
      if (/timeout|timed.?out|超时/i.test(safe)) return "模型服务错误：服务响应超时，请稍后重试或更换服务";
      return "模型服务错误：请求失败，请检查服务地址、模型配置或稍后重试";
    };
    try {
      if (run.cancelled) return partial("cancelled", "作者已取消生成，可重新发起任务", "");
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
      const prompt = checkPromptBudget(request, frozen, toolScope.isVisible, model, tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
      const cwd = resolve(this.settings.agentDir, "workspace");
      const sessionDir = resolve(this.settings.agentDir, "sessions", request.projectId);
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const manager = SessionManager.create(cwd, sessionDir);
      sessionId = manager.getSessionId();
      const requestRuntime = runtimeWithProxy(runtime, requestOptions(this.settings.providerForModel(model.provider), model.api));
      const { session } = await createAgentSession({ cwd, agentDir: this.settings.agentDir, model, thinkingLevel: route.thinkingLevel, modelRuntime: requestRuntime, resourceLoader: novelResourceLoader(), noTools: "builtin", tools: ["novel_*"], customTools: tools, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } }) });
      run.session = session;
      if (run.cancelled) return partial("cancelled", "作者已取消生成，可重新发起任务", "");
      let settled = false;
      let interrupted = false;
      let toolError = false;
      let stopReason: string | undefined;
      let errorMessage = "";
      let finalText = "";
      let currentText = "";
      session.subscribe(event => {
        if (event.type === "message_start" && event.message.role === "assistant") { currentText = ""; finalText = ""; run.progress.text = ""; stopReason = undefined; errorMessage = ""; }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") { currentText += event.assistantMessageEvent.delta; run.progress.text = currentText; }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const authoritative = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          finalText = authoritative;
          run.progress.text = authoritative;
          stopReason = event.message.stopReason;
          errorMessage = event.message.errorMessage ?? "";
        }
        if (event.type === "tool_execution_start") run.progress.tools.push(event.toolName);
        if (event.type === "tool_execution_end" && event.isError) toolError = true;
        if (event.type === "agent_settled") { settled = true; interrupted = event.aborted; }
      });
      timer = setTimeout(() => { timedOut = true; void session.abort(); }, 600_000);
      await session.prompt(prompt);
      const text = finalText;
      if (timedOut) return partial("timeout", "生成超时（10 分钟），请减少本次生成范围或更换服务后重试");
      if (run.cancelled) return partial("cancelled", "作者已取消生成，可重新发起任务");
      if (toolError) return partial("tool_error", "资料工具调用失败，可能超出任务可见范围；请检查场景与资料范围后重试", text);
      if (stopReason === "length") return partial("truncated", "模型输出达到长度上限，产物尚未完成；请缩小本次生成范围或调整输出上限后重试", text);
      if (stopReason === "error") return partial("provider_error", providerError(errorMessage), text);
      if (!text.trim()) return partial("empty_output", "模型末轮未返回可用正文（思考内容不作为成稿），请重试或更换模型", "");
      if (interrupted || !settled || stopReason !== "stop") return partial("incomplete_response", "模型回合未正常结束，产物尚未完成；请重试或更换服务", text);
      const result = parseOutput(request.kind, text, request.input);
      if (result.report && frozen.novel?.scene) {
        const issues = [...localIssues.map(({ severity, title, detail, evidence }) => ({ severity, title, detail, evidence })), ...result.report.issues];
        result.report.issues = issues.filter((issue, index) => issues.findIndex(item => item.title === issue.title && item.detail === issue.detail) === index);
      }
      return { ...result, completeness: "complete", sessionId, ...(manager.getLeafId() ? { leafId: manager.getLeafId()! } : {}) };
    } catch (error) {
      if (timedOut) return partial("timeout", "生成超时（10 分钟），请减少本次生成范围或更换服务后重试");
      if (run.cancelled) return partial("cancelled", "作者已取消生成，可重新发起任务");
      const message = this.settings.redact(error instanceof DomainError ? error.message : providerError(error instanceof Error ? error.message : String(error)));
      const failureReason = error instanceof DomainError && error.code === "AGENT_CONTEXT_OVERFLOW" ? "context_overflow" : error instanceof DomainError && error.code === "INVALID_AGENT_OUTPUT" ? "invalid_output" : "provider_error";
      this.store.preserveFailedOutput(task.taskId, partial(failureReason, message), message);
      throw new DomainError(error instanceof DomainError ? error.status : 502, error instanceof DomainError ? error.code : "AGENT_GENERATION_FAILED", message);
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
  /** 导入预处理总控：依据客户端本地分章后的结构摘要判定处理方案与标题模式，复用 guide 路由。 */
  async planIngest(digest: { chapterCount: number; sceneCount: number; wordCount: number; titles: string[]; head: string; middle: string; tail: string; opening: string }): Promise<IngestPlan | null> {
    if (this.closed) return null;
    const route = this.settings.route("guide");
    if (!route.model) return null;
    const runtime = this.settings.runtime;
    const model = runtime.getModel(route.model.provider, route.model.modelId);
    if (!model) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const options = requestOptions(this.settings.providerForModel(model.provider), model.api);
      return await planManuscriptIngest(digest, {
        complete: async (prompt) => {
          const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal: controller.signal, maxTokens: 4096, sessionId: randomUUID(), ...options });
          if (["error", "aborted"].includes(response.stopReason)) throw new Error("ingest plan failed");
          return response.content.filter(block => block.type === "text").map(block => block.text).join("");
        },
      });
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  async close(): Promise<void> { this.closed = true; this.volcengine?.close(); await Promise.all([...this.runs.keys()].map(taskId => this.cancel(taskId))); }
  async testProvider(id: string, modelId?: string): Promise<ProviderTestResult> {
    const provider = this.settings.provider(id);
    const runtime = this.settings.runtime;
    const model = runtime.getModel(provider.authProviderId ?? id, modelId ?? provider.models[0]!.id);
    if (!model) throw new DomainError(400, "MODEL_NOT_FOUND", "模型不存在");
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: "只回复：连接成功", timestamp: Date.now() }] }, { signal: controller.signal, maxTokens: 32, sessionId: randomUUID(), ...requestOptions(provider, model.api) });
      if (["error", "aborted"].includes(response.stopReason)) return { ok: false, latencyMs: Date.now() - start, message: "连接失败，请检查地址、模型和 API Key" };
      return { ok: true, latencyMs: Date.now() - start, message: "连接成功", sample: this.settings.redact(response.content.filter(block => block.type === "text").map(block => block.text).join("").slice(0, 160)) };
    } catch (error) { return { ok: false, latencyMs: Date.now() - start, message: error instanceof DomainError ? error.message : controller.signal.aborted ? "连接超时（15 秒）" : "连接失败，请检查地址、模型和 API Key" }; }
    finally { clearTimeout(timer); }
  }
  async discoverProvider(id: string, input: Record<string, unknown>) {
    // 添加表单中尚未保存的 provider 只使用本次请求提供的地址与密钥。
    const provider: { api?: unknown; baseUrl?: unknown; apiKey?: unknown; keySource?: "manual" | "environment"; apiKeyEnv?: string; proxyEnabled?: boolean; proxyUrl?: string } = this.settings.hasProvider(id) ? this.settings.provider(id) : {};
    const api = input.api ?? provider.api;
    if (!["openai-completions", "openai-responses"].includes(api as ProviderApi)) throw new DomainError(400, "DISCOVERY_UNSUPPORTED", "仅 OpenAI 兼容服务支持读取模型列表");
    let url: URL;
    try { url = new URL(String(input.baseUrl ?? provider.baseUrl)); } catch { throw new DomainError(400, "INVALID_BASE_URL", "服务地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DomainError(400, "INVALID_BASE_URL", "服务地址无效");
    const key = input.apiKey ?? secretOf({ apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "", ...(provider.keySource ? { keySource: provider.keySource } : {}), ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}) });
    if (typeof key !== "string" || /[\r\n]/.test(key)) throw new DomainError(400, "INVALID_API_KEY", "API Key 格式无效");
    const proxy = validateProxy({ proxyEnabled: input.proxyEnabled ?? provider.proxyEnabled, proxyUrl: input.proxyUrl ?? provider.proxyUrl });
    try {
      const requestFetch = proxy.proxyEnabled ? providerFetch(proxy) : fetch;
      const response = await requestFetch(`${url.href.replace(/\/$/, "")}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000), redirect: "error" });
      if (!response.ok) throw new Error("discovery failed");
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error("discovery too large");
      const data = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(data.data)) throw new Error("invalid model list");
      return { models: data.data.filter(item => typeof item.id === "string" && item.id.length <= 200 && !item.id.includes(key || "\u0000")).slice(0, 500).map(item => ({ id: item.id as string })) };
    } catch { throw new DomainError(502, "MODEL_DISCOVERY_FAILED", "读取模型列表失败，请检查服务配置"); }
  }
}
