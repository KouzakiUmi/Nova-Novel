import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { extraProviderPresets, providerEnvironmentMetadata } from "./provider-metadata.js";
import { VOLC_LABELS, VOLC_ROUTES, volcBaseUrl, volcCompat, volcSnapshotModels, type VolcPlan } from "./volcengine/models.js";
import { TASK_KINDS, THINKING_LEVELS, type AgentSettingsView, type ModelOption, type ProviderUpsert, type ProviderConfigView, type TaskKind, type TaskRoute, type ThinkingLevel, type BuiltinProviderPreset, type OAuthStatusView, type OAuthEventView, type ProviderApi, type ProviderCompat } from "@nova-novel/shared";
import { DomainError, requiredString } from "../domain.js";

type Provider = ProviderConfigView & { apiKey: string };
interface Settings { providers: Provider[]; routes: TaskRoute[] }
const defaults: Record<TaskKind, ThinkingLevel> = { ideas: "low", rehearsal: "low", scene: "medium", polish: "low", consistency: "high", guide: "low" };
const apis: ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "openai-codex-responses", "mistral-conversations", "bedrock-converse-stream", "google-vertex", "azure-openai-responses", "pi-messages"];
const BUILTIN_BASE_URLS: Record<string, string> = { azure: "https://{resource}.openai.azure.com/openai/v1" };
const PREFERRED_APIS: Record<string, ProviderApi> = { azure: "azure-openai-responses", "openai-codex": "openai-codex-responses" };
export function builtinProviderPresets(): BuiltinProviderPreset[] {
  const presets: BuiltinProviderPreset[] = builtinProviders().flatMap(provider => {
    const models = provider.getModels();
    const baseUrl = provider.baseUrl || models.find(model => model.baseUrl)?.baseUrl || BUILTIN_BASE_URLS[provider.id];
    if (!baseUrl || models.length === 0) return [];
    const api = PREFERRED_APIS[provider.id] ?? apis.find(candidate => models.some(model => model.api === candidate));
    if (!api) return [];
    return [{ providerId: provider.id, name: provider.name, baseUrl, api, oauth: Boolean(provider.auth.oauth), ...providerEnvironmentMetadata(provider.id, Boolean(provider.auth.apiKey)), source: "pi" as const, models: models.map(model => ({ id: model.id, ...(model.name !== model.id ? { name: model.name } : {}), reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: Math.min(model.maxTokens, model.contextWindow), input: [...model.input], ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}) })) }];
  });
  for (const extra of extraProviderPresets()) {
    const existing = presets.find(preset => preset.providerId === extra.providerId);
    if (existing) {
      const models = new Map(existing.models.map(model => [model.id, model]));
      for (const model of extra.models) models.set(model.id, model);
      existing.models = [...models.values()];
      existing.source = "plugin";
      existing.name = extra.name;
      existing.oauth ||= extra.oauth;
      existing.envRefs = extra.envRefs;
      if (extra.apiKeyEnv) existing.apiKeyEnv = extra.apiKeyEnv;
      else delete existing.apiKeyEnv;
    } else presets.push(extra);
  }
  for (const plan of ["agent-plan", "coding-plan"] as VolcPlan[]) {
    const providerId = VOLC_ROUTES[plan];
    if (!presets.some(preset => preset.providerId === providerId)) presets.push({ providerId, name: VOLC_LABELS[plan], api: "anthropic-messages", baseUrl: volcBaseUrl(plan), compat: volcCompat(plan), oauth: true, ...providerEnvironmentMetadata(providerId), source: "plugin", models: volcSnapshotModels(plan) });
  }
  return presets;
}
export function secretOf(provider: { apiKey: string; keySource?: "manual" | "environment"; apiKeyEnv?: string }): string {
  return provider.keySource === "environment" && provider.apiKeyEnv ? process.env[provider.apiKeyEnv] ?? "" : provider.apiKey;
}
function invalid(message: string): never { throw new DomainError(400, "INVALID_AGENT_SETTINGS", message); }
function validateCompat(input: ProviderCompat | undefined): ProviderCompat | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("兼容参数格式无效");
  for (const key of ["allowEmptySignature", "forceAdaptiveThinking", "supportsTemperature"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") invalid("兼容参数必须是布尔值");
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => ["allowEmptySignature", "forceAdaptiveThinking", "supportsTemperature"].includes(key) && value !== undefined));
}
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
  private oauthRuns = new Map<string, { controller: AbortController; events: OAuthEventView[]; resolveCode: ((code: string) => void) | undefined; done: Promise<OAuthStatusView> }>();
  private oauthResults = new Map<string, OAuthStatusView>();
  private constructor(readonly dataDir: string) {
    this.agentDir = resolve(dataDir, "agent");
    mkdirSync(resolve(this.agentDir, "workspace"), { recursive: true, mode: 0o700 });
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
    settings.data.providers = settings.data.providers.map(provider => { const clean = settings.validate(provider.providerId, provider); return { providerId: provider.providerId, ...clean, apiKey: clean.apiKey ?? "", hasApiKey: clean.keySource === "environment" ? Boolean(process.env[clean.apiKeyEnv!]) : Boolean(clean.apiKey), createdAt: provider.createdAt, updatedAt: provider.updatedAt }; });
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
    const keySource = input.keySource ?? "manual";
    if (!["manual", "environment"].includes(keySource)) invalid("密钥来源无效");
    if (input.disabled !== undefined && typeof input.disabled !== "boolean") invalid("停用状态必须是布尔值");
    const presets = builtinProviderPresets();
    const preset = presets.find(preset => id === preset.providerId || id === `my-${preset.providerId}`)
      ?? presets.find(preset => preset.api === input.api && preset.baseUrl.replace(/\/$/, "") === url.href.replace(/\/$/, ""));
    const apiKeyEnv = input.apiKeyEnv ?? (preset ? preset.apiKeyEnv : providerEnvironmentMetadata(id).apiKeyEnv);
    if (keySource === "environment" && (typeof apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{1,80}$/.test(apiKeyEnv))) invalid("环境变量名必须是 2–81 位大写字母、数字或下划线，且以字母开头");
    if (keySource === "environment" && apiKey) invalid("使用环境变量时不能同时填写密钥");
    for (const [field, value] of [["quotaAccessKeyEnv", input.quotaAccessKeyEnv], ["quotaSecretKeyEnv", input.quotaSecretKeyEnv]] as const) if (value !== undefined && (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,80}$/.test(value))) invalid(`${field} 环境变量名无效`);
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
      const compat = validateCompat(model.compat);
      return { id: modelId, name: model.name === undefined ? modelId : requiredString(model.name, "模型名称", 200), reasoning: model.reasoning ?? false, contextWindow, maxTokens, input: model.input ?? ["text" as const], ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}), ...(compat ? { compat } : {}) };
    });
    const compat = validateCompat(input.compat);
    return { name: requiredString(input.name, "服务名称", 200), api: input.api, baseUrl: url.href.replace(/\/$/, ""), ...(compat ? { compat } : {}), disabled: input.disabled ?? false, keySource, ...(keySource === "environment" ? { apiKeyEnv: apiKeyEnv!, apiKey: "" } : apiKey !== undefined ? { apiKey } : {}), ...(input.authProviderId ? { authProviderId: input.authProviderId } : {}), ...(input.quotaAccessKeyEnv !== undefined ? { quotaAccessKeyEnv: input.quotaAccessKeyEnv } : {}), ...(input.quotaSecretKeyEnv !== undefined ? { quotaSecretKeyEnv: input.quotaSecretKeyEnv } : {}), models };
  }
  private async reload(): Promise<void> {
    // 无密钥的服务（Ollama、LM Studio 等本机模型）写入占位值，Pi 才会把它视为可用；占位值不会回显给页面。
    const enabledProviders = this.data.providers.filter(provider => !provider.disabled);
    const modelProviders = enabledProviders.filter(provider => !provider.authProviderId);
    const providers = Object.fromEntries(modelProviders.map(({ providerId, name, baseUrl, api, apiKey, keySource, apiKeyEnv, models, compat }) => [providerId, { name, baseUrl, api, ...(compat ? { compat } : {}), apiKey: keySource === "environment" ? `$${apiKeyEnv}` : apiKey ? apiKey.split("$").join("$$") : "no-key", models }]));
    atomic(this.modelsPath, { providers });
    const runtime = await ModelRuntime.create({ authPath: resolve(this.agentDir, "auth.json"), modelsPath: this.modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    if (runtime.getError()) throw new DomainError(400, "INVALID_AGENT_SETTINGS", "模型配置无法加载");
    const available = await runtime.getAvailable();
    const custom = new Set(modelProviders.map(provider => provider.providerId));
    const oauthProviders = new Set(enabledProviders.flatMap(provider => provider.authProviderId ? [provider.authProviderId] : []));
    this.models = runtime.getModels().filter(model => custom.has(model.provider) || oauthProviders.has(model.provider)).map(model => ({ provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning, thinkingLevels: thinkingLevels(model), contextWindow: model.contextWindow, maxTokens: Math.min(model.maxTokens, model.contextWindow), costInput: model.cost.input, costOutput: model.cost.output, available: custom.has(model.provider) ? available.some(item => item.provider === model.provider && item.id === model.id) : available.some(item => item.provider === model.provider && item.id === model.id), source: custom.has(model.provider) ? "custom" : "builtin" }));
    this.runtime = runtime;
  }
  oauthStatus(id: string): OAuthStatusView {
    const run = this.oauthRuns.get(id);
    return run ? { providerId: id, status: "pending", events: run.events } : this.oauthResults.get(id) ?? { providerId: id, status: "cancelled", events: [] };
  }
  startOAuth(id: string): OAuthStatusView {
    if (!this.builtins.has(id)) throw new DomainError(400, "INVALID_PROVIDER", "OAuth 只支持 Pi 内置服务");
    const existing = this.oauthRuns.get(id);
    if (existing) return { providerId: id, status: "pending", events: existing.events };
    this.oauthResults.delete(id);
    const provider = this.runtime.getProvider(id);
    if (!provider?.auth.oauth) throw new DomainError(400, "OAUTH_UNSUPPORTED", "该服务不支持 OAuth 登录");
    const controller = new AbortController();
    const events: OAuthEventView[] = [];
    let resolveCode: ((code: string) => void) | undefined;
    const run = { controller, events, resolveCode, done: undefined as unknown as Promise<OAuthStatusView> };
    run.done = (async () => {
      try {
        await this.runtime.login(id, "oauth", {
          signal: controller.signal,
          prompt: async prompt => {
            if (prompt.type === "manual_code") return new Promise<string>(resolve => { run.resolveCode = resolve; });
            if (prompt.type === "select") return prompt.options[0]?.id ?? "";
            return "";
          },
          notify: event => {
            if (event.type === "auth_url") events.push({ type: event.type, url: event.url, ...(event.instructions ? { message: event.instructions } : {}) });
            else if (event.type === "device_code") events.push({ type: event.type, url: event.verificationUri, userCode: event.userCode });
            else events.push({ type: event.type, message: event.message });
          },
        });
        const preset = builtinProviderPresets().find(item => item.providerId === id);
        if (preset) {
          const providerId = `my-${id}`;
          const clean = this.validate(providerId, { name: preset.name, api: preset.api, baseUrl: preset.baseUrl, keySource: "manual", ...(preset.compat ? { compat: preset.compat } : {}), models: preset.models });
          const current = this.data.providers.find(item => item.providerId === providerId);
          const date = new Date().toISOString();
          const configured: Provider = { providerId, ...clean, authProviderId: id, apiKey: "", hasApiKey: true, createdAt: current?.createdAt ?? date, updatedAt: date };
          this.data.providers = [...this.data.providers.filter(item => item.providerId !== providerId), configured];
          atomic(this.settingsPath, this.data);
        }
        await this.reload();
        this.oauthRuns.delete(id);
        const result: OAuthStatusView = { providerId: id, status: "success", events };
        this.oauthResults.set(id, result);
        return result;
      } catch (error) {
        this.oauthRuns.delete(id);
        const message = this.redact(error instanceof Error ? error.message : String(error));
        const result: OAuthStatusView = { providerId: id, status: "error", events, error: message };
        this.oauthResults.set(id, result);
        return result;
      }
    })();
    this.oauthRuns.set(id, run);
    void run.done;
    return { providerId: id, status: "pending", events };
  }
  oauthCode(id: string, code: string): void {
    const run = this.oauthRuns.get(id);
    if (!run?.resolveCode) throw new DomainError(409, "OAUTH_STATE", "当前没有等待授权码的登录");
    run.resolveCode(code);
  }
  oauthCancel(id: string): void {
    const run = this.oauthRuns.get(id);
    if (!run) return;
    run.controller.abort();
    this.oauthRuns.delete(id);
    this.oauthResults.set(id, { providerId: id, status: "cancelled", events: run.events });
  }
  view(): AgentSettingsView {
    const presets = builtinProviderPresets();
    const configuredEnvs = new Set(this.data.providers.flatMap(provider => provider.apiKeyEnv ? [provider.apiKeyEnv] : []));
    const detectedProviders: AgentSettingsView["detectedProviders"] = [];
    for (const preset of presets) {
      if (!preset.apiKeyEnv || this.data.providers.some(provider => provider.providerId === preset.providerId || provider.providerId === `my-${preset.providerId}` || (provider.api === preset.api && provider.baseUrl.replace(/\/$/, "") === preset.baseUrl.replace(/\/$/, "")))) continue;
      const apiKeyEnv = preset.envRefs.find(name => Boolean(process.env[name]) && !configuredEnvs.has(name));
      if (!apiKeyEnv) continue;
      detectedProviders.push({ preset, apiKeyEnv, hasApiKey: true });
      configuredEnvs.add(apiKeyEnv);
    }
    return { providers: this.data.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: provider.authProviderId ? true : provider.keySource === "environment" ? Boolean(process.env[provider.apiKeyEnv!]) : Boolean(apiKey) })), models: structuredClone(this.models), routes: this.data.routes.map(route => { const model = this.resolveModel(route.kind); return { ...route, thinkingLevel: model ? clampThinking(route.thinkingLevel, model.thinkingLevels) : route.thinkingLevel }; }), builtinProviders: presets, detectedProviders, engine: { name: "Pi", version: VERSION, mode: "embedded" }, dataDir: this.dataDir };
  }
  resolveModel(kind: TaskKind): ModelOption | undefined {
    const route = this.data.routes.find(item => item.kind === kind);
    return this.models.find(model => model.available && model.provider === route?.provider && model.modelId === route.modelId) ?? this.models.find(model => model.available);
  }
  route(kind: TaskKind) { const model = this.resolveModel(kind); return { model, thinkingLevel: model ? clampThinking(this.data.routes.find(item => item.kind === kind)?.thinkingLevel ?? defaults[kind], model.thinkingLevels) : "off" as const }; }
  hasProvider(id: string): boolean { return this.data.providers.some(item => item.providerId === id); }
  provider(id: string): Provider { const provider = this.data.providers.find(item => item.providerId === id); if (!provider) throw new DomainError(404, "PROVIDER_NOT_FOUND", "服务不存在"); return structuredClone(provider); }
  dataProviders(): Provider[] { return this.data.providers; }
  redact(text: string): string {
    for (const provider of this.data.providers) {
      if (provider.apiKey) text = text.split(provider.apiKey).join("[已隐藏]");
      if (provider.keySource === "environment" && provider.apiKeyEnv) {
        const secret = process.env[provider.apiKeyEnv];
        if (secret) text = text.split(secret).join("[已隐藏]");
      }
      for (const name of [provider.quotaAccessKeyEnv, provider.quotaSecretKeyEnv]) {
        const secret = name ? process.env[name] : undefined;
        if (secret) text = text.split(secret).join("[已隐藏]");
      }
    }
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
      const provider: Provider = { providerId: id, ...clean, apiKey: clean.apiKey ?? current?.apiKey ?? "", hasApiKey: clean.keySource === "environment" ? Boolean(process.env[clean.apiKeyEnv!]) : Boolean(clean.apiKey ?? current?.apiKey), createdAt: current?.createdAt ?? date, updatedAt: date };
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
