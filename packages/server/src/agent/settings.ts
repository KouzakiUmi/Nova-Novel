import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { TASK_KINDS, THINKING_LEVELS, type AgentSettingsView, type ModelOption, type ProviderUpsert, type ProviderConfigView, type TaskKind, type TaskRoute, type ThinkingLevel } from "@nova-novel/shared";
import { DomainError, requiredString } from "../domain.js";

type Provider = ProviderConfigView & { apiKey: string };
interface Settings { providers: Provider[]; routes: TaskRoute[] }
const defaults: Record<TaskKind, ThinkingLevel> = { ideas: "low", rehearsal: "low", scene: "medium", polish: "low", consistency: "high", guide: "low" };
const apis = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
function invalid(message: string): never { throw new DomainError(400, "INVALID_AGENT_SETTINGS", message); }
export function thinkingLevels(model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, unknown>> }): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null && (THINKING_LEVELS.indexOf(level) <= 4 || model.thinkingLevelMap?.[level] !== undefined));
}
export function clampThinking(level: ThinkingLevel, supported: ThinkingLevel[]): ThinkingLevel {
  return [...supported].reverse().find(item => THINKING_LEVELS.indexOf(item) <= THINKING_LEVELS.indexOf(level)) ?? supported[0] ?? "off";
}
function atomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
export class AgentSettings {
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly settingsPath: string;
  runtime!: ModelRuntime;
  private data: Settings;
  private builtins = new Set<string>();
  private models: ModelOption[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly dataDir: string) {
    this.agentDir = resolve(dataDir, "agent");
    mkdirSync(resolve(this.agentDir, "workspace"), { recursive: true });
    this.modelsPath = resolve(this.agentDir, "models.json");
    this.settingsPath = resolve(this.agentDir, "settings.json");
    try { this.data = existsSync(this.settingsPath) ? JSON.parse(readFileSync(this.settingsPath, "utf8")) as Settings : { providers: [], routes: TASK_KINDS.map(kind => ({ kind, thinkingLevel: defaults[kind] })) }; }
    catch { throw new DomainError(500, "INVALID_AGENT_SETTINGS", "模型设置文件无法读取，请检查数据目录"); }
  }
  static async create(dataDir: string): Promise<AgentSettings> {
    const settings = new AgentSettings(dataDir);
    const builtin = await ModelRuntime.create({ authPath: resolve(settings.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    settings.builtins = new Set(builtin.getProviders().map(provider => provider.id));
    if (!Array.isArray(settings.data.providers) || !Array.isArray(settings.data.routes)) invalid("模型设置格式无效");
    settings.data.routes = TASK_KINDS.map(kind => settings.data.routes.find(route => route.kind === kind) ?? { kind, thinkingLevel: defaults[kind] });
    settings.data.providers = settings.data.providers.map(provider => { const clean = settings.validate(provider.providerId, provider); return { providerId: provider.providerId, ...clean, apiKey: clean.apiKey ?? "", hasApiKey: Boolean(clean.apiKey), createdAt: provider.createdAt, updatedAt: provider.updatedAt }; });
    await settings.reload();
    return settings;
  }
  private validate(id: string, input: ProviderUpsert): ProviderUpsert {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id) || this.builtins.has(id) || ["__proto__", "constructor", "prototype"].includes(id)) invalid("providerId 无效或与内置服务同名");
    if (!apis.includes(input.api)) invalid("api 类型无效");
    let url: URL;
    try { url = new URL(input.baseUrl); } catch { return invalid("baseUrl 必须是 HTTP(S) 地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid("baseUrl 必须是无凭据与查询参数的 HTTP(S) 地址");
    const apiKey = input.apiKey;
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 16000 || /^[!$]/.test(apiKey) || /[\r\n]/.test(apiKey))) invalid("API Key 格式无效");
    if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 500) invalid("请至少添加一个模型");
    const ids = new Set<string>();
    const models = input.models.map(model => {
      if (!model || typeof model !== "object") invalid("模型格式无效");
      const modelId = requiredString(model.id, "模型 ID", 200);
      if (ids.has(modelId)) invalid("模型 ID 重复");
      ids.add(modelId);
      if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") invalid("reasoning 必须是布尔值");
      const contextWindow = model.contextWindow ?? 128000;
      const maxTokens = model.maxTokens ?? 8192;
      if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || contextWindow < maxTokens) invalid("模型 token 上限无效");
      if (model.input !== undefined && (!Array.isArray(model.input) || model.input.length === 0 || model.input.some(item => !["text", "image"].includes(item)))) invalid("模型输入类型无效");
      if (model.thinkingLevelMap !== undefined && (!model.thinkingLevelMap || typeof model.thinkingLevelMap !== "object" || Array.isArray(model.thinkingLevelMap) || Object.entries(model.thinkingLevelMap).some(([level, value]) => !THINKING_LEVELS.includes(level as ThinkingLevel) || (value !== null && (typeof value !== "string" || value.length > 100))))) invalid("思考强度映射无效");
      return { id: modelId, name: model.name === undefined ? modelId : requiredString(model.name, "模型名称", 200), reasoning: model.reasoning ?? false, contextWindow, maxTokens, input: model.input ?? ["text" as const], ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}) };
    });
    return { name: requiredString(input.name, "服务名称", 200), api: input.api, baseUrl: url.href.replace(/\/$/, ""), ...(apiKey !== undefined ? { apiKey } : {}), models };
  }
  private async reload(): Promise<void> {
    // 无密钥的服务（Ollama、LM Studio 等本机模型）写入占位值，Pi 才会把它视为可用；占位值不会回显给页面。
    const providers = Object.fromEntries(this.data.providers.map(({ providerId, name, baseUrl, api, apiKey, models }) => [providerId, { name, baseUrl, api, apiKey: apiKey ? apiKey.split("$").join("$$") : "no-key", models }]));
    atomic(this.modelsPath, { providers });
    const runtime = await ModelRuntime.create({ authPath: resolve(this.agentDir, "auth.json"), modelsPath: this.modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    if (runtime.getError()) throw new DomainError(400, "INVALID_AGENT_SETTINGS", "模型配置无法加载");
    const available = await runtime.getAvailable();
    const custom = new Set(this.data.providers.map(provider => provider.providerId));
    this.models = runtime.getModels().filter(model => custom.has(model.provider) || available.some(item => item.provider === model.provider && item.id === model.id)).map(model => ({ provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning, thinkingLevels: thinkingLevels(model), contextWindow: model.contextWindow, maxTokens: model.maxTokens, costInput: model.cost.input, costOutput: model.cost.output, available: available.some(item => item.provider === model.provider && item.id === model.id), source: custom.has(model.provider) ? "custom" : "builtin" }));
    this.runtime = runtime;
  }
  view(): AgentSettingsView {
    return { providers: this.data.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: Boolean(apiKey) })), models: structuredClone(this.models), routes: this.data.routes.map(route => { const model = this.resolveModel(route.kind); return { ...route, thinkingLevel: model ? clampThinking(route.thinkingLevel, model.thinkingLevels) : route.thinkingLevel }; }), engine: { name: "Pi", version: VERSION, mode: "embedded" }, dataDir: this.dataDir };
  }
  resolveModel(kind: TaskKind): ModelOption | undefined {
    const route = this.data.routes.find(item => item.kind === kind);
    return this.models.find(model => model.available && model.provider === route?.provider && model.modelId === route.modelId) ?? this.models.find(model => model.available);
  }
  route(kind: TaskKind) { const model = this.resolveModel(kind); return { model, thinkingLevel: model ? clampThinking(this.data.routes.find(item => item.kind === kind)?.thinkingLevel ?? defaults[kind], model.thinkingLevels) : "off" as const }; }
  hasProvider(id: string): boolean { return this.data.providers.some(item => item.providerId === id); }
  provider(id: string): Provider { const provider = this.data.providers.find(item => item.providerId === id); if (!provider) throw new DomainError(404, "PROVIDER_NOT_FOUND", "服务不存在"); return structuredClone(provider); }
  redact(text: string): string {
    for (const provider of this.data.providers) if (provider.apiKey) text = text.split(provider.apiKey).join("[已隐藏]");
    return text.replace(/Bearer\s+\S+|\b(?:sk|pk|rk)-[\w-]+/gi, "[已隐藏]").slice(0, 400);
  }
  private mutate(action: () => void): Promise<AgentSettingsView> {
    const operation = this.tail.then(async () => { const previous = structuredClone(this.data); try { action(); await this.reload(); atomic(this.settingsPath, this.data); return this.view(); } catch (error) { this.data = previous; await this.reload(); throw error; } });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  upsert(id: string, input: ProviderUpsert, patch = false): Promise<AgentSettingsView> {
    return this.mutate(() => {
      const current = this.data.providers.find(item => item.providerId === id);
      if (patch && !current) this.provider(id);
      if (!patch && current) throw new DomainError(409, "PROVIDER_EXISTS", "服务 ID 已存在");
      const clean = this.validate(id, { ...current, ...input });
      const date = new Date().toISOString();
      const provider: Provider = { providerId: id, ...clean, apiKey: clean.apiKey ?? current?.apiKey ?? "", hasApiKey: Boolean(clean.apiKey ?? current?.apiKey), createdAt: current?.createdAt ?? date, updatedAt: date };
      this.data.providers = [...this.data.providers.filter(item => item.providerId !== id), provider];
    });
  }
  delete(id: string) { return this.mutate(() => { this.provider(id); this.data.providers = this.data.providers.filter(item => item.providerId !== id); this.data.routes = this.data.routes.map(route => route.provider === id ? { kind: route.kind, thinkingLevel: route.thinkingLevel } : route); }); }
  routes(routes: TaskRoute[]) { return this.mutate(() => {
    if (!Array.isArray(routes) || routes.length > TASK_KINDS.length || routes.some(route => !route || typeof route !== "object" || Array.isArray(route)) || new Set(routes.map(route => route.kind)).size !== routes.length) invalid("任务路由无效");
    for (const route of routes) {
      if (!TASK_KINDS.includes(route.kind) || !THINKING_LEVELS.includes(route.thinkingLevel) || Boolean(route.provider) !== Boolean(route.modelId)) invalid("任务路由无效");
      if (route.provider && !this.models.some(model => model.provider === route.provider && model.modelId === route.modelId)) invalid("路由模型不存在");
    }
    this.data.routes = TASK_KINDS.map(kind => { const route = routes.find(item => item.kind === kind) ?? this.data.routes.find(item => item.kind === kind)!; const model = this.models.find(item => item.provider === route.provider && item.modelId === route.modelId); return { kind, ...(route.provider ? { provider: route.provider, modelId: route.modelId! } : {}), thinkingLevel: model ? clampThinking(route.thinkingLevel, model.thinkingLevels) : route.thinkingLevel }; });
  }); }
}
