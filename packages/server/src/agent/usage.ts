import type { ProviderConfigView, UsageReportView, UsageWindowView } from "@nova-novel/shared";
import { createHash } from "node:crypto";
import type { AgentSettings } from "./settings.js";
import { secretOf } from "./settings.js";
import { fetchVolcUsage } from "./volcengine/quota.js";
import { planFromProvider } from "./volcengine/models.js";
import { providerFetch } from "./proxy.js";

type UsageKind = "deepseek" | "openrouter" | "minimax" | "minimax-cn" | "zai" | "zai-cn" | "kimi" | "opendesign" | "codex" | "volc-agent" | "volc-coding" | "opencode-go" | "siliconflow" | "synthetic" | "nanogpt" | "novita" | "hyperbolic" | "deepinfra" | "chutes" | "ollama-cloud" | "vercel-ai-gateway" | "zenmux" | "litellm";
type UsageProvider = ProviderConfigView & { apiKey: string };

function classify(provider: ProviderConfigView): UsageKind | undefined {
  if (provider.authProviderId) {
    const { authProviderId: _authProviderId, ...rest } = provider;
    return classify({ ...rest, providerId: provider.authProviderId });
  }
  if (provider.providerId === "openai-codex") return "codex";
  if (provider.providerId === "opencode-go" || provider.providerId.includes("litellm")) return provider.providerId === "opencode-go" ? "opencode-go" : "litellm";
  if (provider.providerId.startsWith("opendesign-")) return "opendesign";
  let host = "";
  try { host = new URL(provider.baseUrl).hostname; } catch { return undefined; }
  if (host.endsWith("deepseek.com")) return "deepseek";
  if (host.endsWith("openrouter.ai")) return "openrouter";
  if (host === "api.minimax.io") return "minimax";
  if (host === "api.minimaxi.com") return "minimax-cn";
  if (host === "open.bigmodel.cn") return "zai-cn";
  if (host === "api.z.ai") return "zai";
  if (host === "api.kimi.com") return "kimi";
  if (host === "amr-api.open-design.ai") return "opendesign";
  if (host === "ark.cn-beijing.volces.com") return planFromProvider(provider.providerId) === "agent-plan" ? "volc-agent" : "volc-coding";
  if (host === "opencode.ai" && provider.baseUrl.includes("/go")) return "opencode-go";
  if (host === "api.siliconflow.cn") return "siliconflow";
  if (host === "api.synthetic.new") return "synthetic";
  if (host === "nano-gpt.com" || host === "api.nano-gpt.com") return "nanogpt";
  if (host === "api.novita.ai") return "novita";
  if (host === "api.hyperbolic.xyz") return "hyperbolic";
  if (host === "api.deepinfra.com") return "deepinfra";
  if (host === "api.chutes.ai") return "chutes";
  if (host === "ollama.com") return "ollama-cloud";
  if (host === "ai-gateway.vercel.sh") return "vercel-ai-gateway";
  if (host === "zenmux.ai") return "zenmux";
  return undefined;
}
function window(kind: string, percentUsed: number, resetAt?: string, detail?: Pick<UsageWindowView, "used" | "limit" | "unit">): UsageWindowView {
  return { kind, percentUsed: Math.max(0, Math.min(100, percentUsed)), ...(resetAt && Number.isFinite(Date.parse(resetAt)) ? { resetAt: new Date(resetAt).toISOString() } : {}), ...detail };
}
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined; }

export class AgentUsageService {
  private cache = new Map<string, { at: number; fingerprint: string; report: UsageReportView }>();
  private volcBackend?: { hasBinding(providerId: string): boolean; usageFor(providerId: string): Promise<UsageWindowView[] | undefined> };
  constructor(private settings: AgentSettings, private fetcher?: typeof fetch, private fetchForProvider: (provider: UsageProvider) => typeof fetch = provider => provider.proxyEnabled ? providerFetch(provider) : fetch) {}
  setVolcBackend(backend: { hasBinding(providerId: string): boolean; usageFor(providerId: string): Promise<UsageWindowView[] | undefined> }): void { this.volcBackend = backend; }
  async list(force = false): Promise<UsageReportView[]> {
    const providers: UsageProvider[] = this.settings.dataProviders().filter(provider => !provider.disabled);
    const enabledIds = new Set(providers.map(provider => provider.providerId));
    for (const id of this.cache.keys()) if (!enabledIds.has(id)) this.cache.delete(id);
    return Promise.all(providers.map(provider => this.report(provider, force)));
  }
  private async report(provider: UsageProvider, force: boolean): Promise<UsageReportView> {
    const kind = classify(provider);
    const base: UsageReportView = { providerId: provider.providerId, label: provider.name, state: kind ? "no-key" : "disabled", windows: [], coverage: "complete" };
    if (!kind) return base;
    if (provider.proxyEnabled && provider.authProviderId) return { ...base, state: "error", coverage: "partial", error: "代理模式暂不支持 OAuth 额度查询" };
    const key = provider.authProviderId ? (await this.settings.runtime.getAuth(provider.authProviderId))?.auth.apiKey ?? "" : secretOf(provider);
    const quotaKeys = kind === "volc-agent" || kind === "volc-coding" ? [process.env[provider.quotaAccessKeyEnv ?? "VOLC_ACCESSKEY"], process.env[provider.quotaSecretKeyEnv ?? "VOLC_SECRETKEY"]] : [];
    const fingerprint = createHash("sha256").update(JSON.stringify([provider, key, ...quotaKeys])).digest("hex");
    const cached = this.cache.get(provider.providerId);
    if (!force && cached && cached.fingerprint === fingerprint && Date.now() - cached.at < 60_000) return cached.report;
    try {
      if (!key) { const report = { ...base, state: "no-key" as const, error: "未配置可用凭据" }; this.cache.set(provider.providerId, { at: Date.now(), fingerprint, report }); return report; }
      const result = await this.read(kind, key, provider);
      const report: UsageReportView = { ...base, state: "ok", windows: result.windows, coverage: result.coverage ?? "complete", ...(result.balance ? { balance: result.balance } : {}) };
      this.cache.set(provider.providerId, { at: Date.now(), fingerprint, report });
      return report;
    } catch (error) {
      const report: UsageReportView = { ...base, state: "error", coverage: "partial", error: error instanceof Error ? this.settings.redact(error.message) : "额度读取失败" };
      this.cache.set(provider.providerId, { at: Date.now(), fingerprint, report });
      return report;
    }
  }
  private async get(fetcher: typeof fetch, url: string, key: string, bare = false): Promise<unknown> {
    const response = await fetcher(url, { headers: { Authorization: bare ? key : `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "凭据无效或没有额度读取权限" : `额度接口返回 HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("额度响应过大");
    try { return JSON.parse(text); } catch { throw new Error("额度接口返回格式无效"); }
  }
  private async read(kind: UsageKind, key: string, provider: UsageProvider): Promise<{ windows: UsageWindowView[]; balance?: UsageReportView["balance"]; coverage?: UsageReportView["coverage"] }> {
    if ((kind === "volc-agent" || kind === "volc-coding") && provider.proxyEnabled && this.volcBackend?.hasBinding(provider.providerId)) throw new Error("代理模式暂不支持火山方舟 ArkCli 额度查询");
    const fetcher = this.fetcher ?? this.fetchForProvider(provider);
    const get = (url: string, requestKey: string, bare = false) => this.get(fetcher, url, requestKey, bare);
    if (kind === "deepseek") {
      const body = await get("https://api.deepseek.com/user/balance", key) as { balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }> };
      const row = body.balance_infos?.find(item => typeof item.currency === "string" && typeof item.total_balance === "string");
      const value = number(row?.total_balance);
      if (!row || value === undefined) throw new Error("DeepSeek 响应没有余额信息");
      return { windows: [], balance: { value, currency: String(row.currency) } };
    }
    if (kind === "openrouter") {
      const body = await get("https://openrouter.ai/api/v1/key", key) as { data?: { limit?: unknown; limit_remaining?: unknown; limit_reset?: unknown; free_model_daily_requests?: { limit?: unknown; used?: unknown } } };
      const data = body.data;
      if (!data) throw new Error("OpenRouter 响应没有限额信息");
      const limit = number(data.limit), remaining = number(data.limit_remaining), windows: UsageWindowView[] = [];
      if (limit !== undefined && limit > 0 && remaining !== undefined) windows.push(window(data.limit_reset === "monthly" ? "month" : data.limit_reset === "weekly" ? "week" : data.limit_reset === "daily" ? "day" : "period", (limit - remaining) / limit * 100, undefined, { used: limit - remaining, limit, unit: "credits" }));
      const freeLimit = number(data.free_model_daily_requests?.limit), freeUsed = number(data.free_model_daily_requests?.used);
      if (freeLimit !== undefined && freeLimit > 0 && freeUsed !== undefined) windows.push(window("day", freeUsed / freeLimit * 100, undefined, { used: freeUsed, limit: freeLimit, unit: "requests" }));
      const credit = await get("https://openrouter.ai/api/v1/credits", key).catch(() => undefined) as { data?: { total_credits?: unknown; total_usage?: unknown } } | undefined;
      const total = number(credit?.data?.total_credits), spent = number(credit?.data?.total_usage);
      if (!windows.length && total === undefined) throw new Error("OpenRouter 响应没有可用额度");
      return { windows, ...(total !== undefined && spent !== undefined ? { balance: { value: Math.max(0, total - spent), currency: "USD" } } : {}), coverage: total === undefined && !windows.length ? "partial" : "complete" };
    }
    if (kind === "minimax" || kind === "minimax-cn") {
      const body = await get(`https://${kind === "minimax" ? "api.minimax.io" : "api.minimaxi.com"}/v1/token_plan/remains`, key) as { base_resp?: { status_code?: unknown }; model_remains?: Array<Record<string, unknown>> };
      if (body.base_resp?.status_code !== 0 || !Array.isArray(body.model_remains)) throw new Error("MiniMax 用量响应无效");
      const general = body.model_remains.filter(row => row.model_name === "general");
      const candidates = general.length ? general : body.model_remains.filter(row => typeof row.model_name === "string" && /^MiniMax-M/i.test(row.model_name));
      if (candidates.length !== 1) throw new Error("MiniMax 没有明确的编程额度池");
      const row = candidates[0]!, windows: UsageWindowView[] = [];
      for (const [prefix, label, end] of [["current_interval", "5h", "end_time"], ["current_weekly", "week", "weekly_end_time"]] as const) {
        if (row[`${prefix}_status`] === 3) continue;
        const percent = number(row[`${prefix}_remaining_percent`]);
        if (percent === undefined) continue;
        windows.push(window(label, 100 - percent, typeof row[end] === "number" ? new Date(Number(row[end]) * 1000).toISOString() : undefined));
      }
      return { windows, coverage: windows.length ? "complete" : "partial" };
    }
    if (kind === "zai" || kind === "zai-cn") {
      const body = await get(kind === "zai" ? "https://api.z.ai/api/monitor/usage/quota/limit" : "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=1", key, kind === "zai") as { data?: { limits?: Array<{ type?: unknown; unit?: unknown; percentage?: unknown; nextResetTime?: unknown; currentValue?: unknown; usage?: unknown }> } };
      if (!Array.isArray(body.data?.limits)) throw new Error("Z.ai 用量响应无效");
      const windows = body.data.limits.flatMap(row => {
        if (!["CREDIT_LIMIT", "TOKENS_LIMIT"].includes(String(row.type)) || ![3, 6].includes(Number(row.unit))) return [];
        const percent = number(row.percentage);
        if (percent === undefined) return [];
        const used = number(row.currentValue), limit = number(row.usage);
        return [window(Number(row.unit) === 3 ? "5h" : "week", percent, typeof row.nextResetTime === "string" ? row.nextResetTime : undefined, used !== undefined && limit !== undefined ? { used, limit, unit: row.type === "TOKENS_LIMIT" ? "tokens" : "credits" } : undefined)];
      });
      if (!windows.length) throw new Error("Z.ai 没有可用额度窗口");
      return { windows };
    }
    if (kind === "kimi") {
      const body = await get("https://api.kimi.com/coding/v1/usages", key) as { usages?: Record<string, { used_ratio?: unknown; reset_time?: unknown }>; usage?: Record<string, unknown>; limits?: Array<Record<string, unknown>> };
      const pools = [body.usages, body.usage, body.limits].filter(value => value && typeof value === "object" && !Array.isArray(value)) as Array<Record<string, { used_ratio?: unknown; reset_time?: unknown }>>;
      const windows: UsageWindowView[] = [];
      for (const [field, label] of [["limit_5h", "5h"], ["limit_7d", "7d"], ["limit_month_total", "month"]] as const) {
        const row = pools.map(pool => pool[field]).find(value => value !== undefined);
        const ratio = number(row?.used_ratio);
        if (ratio === undefined) continue;
        windows.push(window(label, ratio * 100, typeof row?.reset_time === "string" ? row.reset_time : undefined));
      }
      if (!windows.length) throw new Error("Kimi 没有可用额度窗口");
      return { windows };
    }
    if (kind === "codex") {
      const body = await get("https://chatgpt.com/backend-api/wham/usage", key) as { rate_limit?: { primary_window?: Record<string, unknown>; secondary_window?: Record<string, unknown> } };
      const windows: UsageWindowView[] = [];
      for (const [field, label] of [["primary_window", "primary"], ["secondary_window", "secondary"]] as const) {
        const row = body.rate_limit?.[field], percent = number(row?.used_percent), seconds = number(row?.limit_window_seconds);
        if (percent === undefined || seconds === undefined) continue;
        windows.push(window(label, percent, number(row?.reset_at) !== undefined ? new Date(Number(row?.reset_at) * 1000).toISOString() : undefined));
      }
      return { windows, coverage: windows.length ? "complete" : "partial" };
    }
    if (kind === "volc-agent" || kind === "volc-coding") {
      if (this.volcBackend?.hasBinding(provider.providerId)) {
        const windows = await this.volcBackend.usageFor(provider.providerId);
        if (windows) return { windows, coverage: windows.length ? "complete" : "partial" };
      }
      const accessKey = process.env[provider.quotaAccessKeyEnv ?? "VOLC_ACCESSKEY"] ?? "";
      const secretKey = process.env[provider.quotaSecretKeyEnv ?? "VOLC_SECRETKEY"] ?? "";
      if (!accessKey || !secretKey) throw new Error("火山方舟额度查询需要 IAM AK/SK 或套餐 OAuth 登录");
      const windows = await fetchVolcUsage(kind === "volc-agent" ? "agent-plan" : "coding-plan", accessKey, secretKey, fetcher);
      return { windows, coverage: windows.length ? "complete" : "partial" };
    }
    if (kind === "opencode-go") {
      const body = await get("https://opencode.ai/zen/go/v1/usage", key) as { usage?: Record<string, { percent?: unknown; resetsAt?: unknown }> };
      const source = body.usage ?? body as unknown as Record<string, { percent?: unknown; resetsAt?: unknown }>;
      const windows = Object.entries({ rolling: "rolling", weekly: "week", monthly: "month" }).flatMap(([field, label]) => {
        const row = source[field], percent = number(row?.percent);
        return percent === undefined ? [] : [window(label, percent, typeof row?.resetsAt === "string" ? row.resetsAt : undefined)];
      });
      if (!windows.length) throw new Error("OpenCode Go 没有可用额度窗口");
      return { windows, coverage: windows.length === 3 ? "complete" : "partial" };
    }
    if (kind === "siliconflow") {
      const body = await get("https://api.siliconflow.cn/v1/user/info", key) as { data?: { totalBalance?: unknown; balance?: unknown } };
      const value = number(body.data?.totalBalance) ?? number(body.data?.balance);
      if (value === undefined) throw new Error("SiliconFlow 响应没有可用余额");
      return { windows: [], balance: { value, currency: "CNY" } };
    }
    if (kind === "synthetic") {
      const body = await get("https://api.synthetic.new/v2/quotas", key) as { subscription?: { requests?: unknown; limit?: unknown; renewsAt?: unknown } };
      const used = number(body.subscription?.requests), limit = number(body.subscription?.limit);
      if (used === undefined || limit === undefined || limit <= 0) throw new Error("Synthetic 订阅额度响应无效");
      return { windows: [window("rolling", used / limit * 100, typeof body.subscription?.renewsAt === "string" ? body.subscription.renewsAt : undefined, { used, limit, unit: "requests" })] };
    }
    if (kind === "nanogpt") {
      const root = key.startsWith("sk-nano-mgmt-") ? "https://nano-gpt.com/api/management/v1/subscription/usage" : "https://api.nano-gpt.com/api/subscription/v1/usage";
      const body = await get(root, key) as { active?: unknown; state?: unknown; dailyInputTokens?: Record<string, unknown>; weeklyInputTokens?: Record<string, unknown>; tokens?: Record<string, unknown>; limits?: { dailyInputTokens?: unknown; weeklyInputTokens?: unknown }; tokenLimits?: { total?: unknown } };
      if (typeof body.active !== "boolean" || typeof body.state !== "string") throw new Error("NanoGPT 订阅响应无效");
      const windows: UsageWindowView[] = [];
      for (const [field, label, limitValue] of [["dailyInputTokens", "day", body.limits?.dailyInputTokens], ["weeklyInputTokens", "week", body.limits?.weeklyInputTokens], ["tokens", "period", body.tokenLimits?.total]] as const) {
        const row = body[field] as Record<string, unknown> | undefined, percent = number(row?.percentUsed), limit = number(limitValue), used = number(row?.used);
        if (percent === undefined || limit === undefined || limit <= 0 || used === undefined) continue;
        windows.push(window(label, percent * 100, number(row?.resetAt) !== undefined ? new Date(Number(row?.resetAt)).toISOString() : undefined, { used, limit, unit: "tokens" }));
      }
      return { windows, coverage: windows.length ? "complete" : "partial" };
    }
    if (kind === "novita") {
      const body = await get("https://api.novita.ai/openapi/v1/billing/balance/detail", key) as { availableBalance?: unknown };
      const value = number(body.availableBalance);
      if (value === undefined) throw new Error("Novita 余额响应无效");
      return { windows: [], balance: { value: value / 10_000, currency: "USD" } };
    }
    if (kind === "hyperbolic") {
      const body = await get("https://api.hyperbolic.xyz/v2/customer/balance", key) as { balanceCents?: unknown };
      const cents = number(body.balanceCents);
      if (cents === undefined) throw new Error("Hyperbolic 余额响应无效");
      return { windows: [], balance: { value: cents / 100, currency: "USD" } };
    }
    if (kind === "deepinfra") {
      const body = await get("https://api.deepinfra.com/payment/checklist?compute_owed=true", key) as { stripe_balance?: unknown };
      const raw = typeof body.stripe_balance === "number" && Number.isFinite(body.stripe_balance) ? body.stripe_balance : undefined;
      if (raw === undefined) throw new Error("DeepInfra 余额响应无效");
      return { windows: [], balance: { value: Math.max(0, -raw), currency: "USD" } };
    }
    if (kind === "chutes") {
      const body = await get("https://api.chutes.ai/users/me/quota_usage/me", key) as { quota?: unknown; used?: unknown };
      const quota = number(body.quota), used = number(body.used);
      if (quota === undefined || quota <= 0 || used === undefined) throw new Error("Chutes 配额响应无效");
      return { windows: [window("period", used / quota * 100, undefined, { used, limit: quota, unit: "quota" })] };
    }
    if (kind === "ollama-cloud") {
      const body = await get("https://ollama.com/api/usage", key, true) as { limits?: Record<string, { usage?: unknown }> };
      const windows = Object.entries({ session: "period", weekly: "week", monthly: "month" }).flatMap(([field, label]) => {
        const usage = body.limits?.[field]?.usage;
        return typeof usage !== "number" || !Number.isFinite(usage) || usage < 0 ? [] : [window(label, usage * 100)];
      });
      if (!windows.length) throw new Error("Ollama Cloud 没有可用额度窗口");
      return { windows };
    }
    if (kind === "vercel-ai-gateway") {
      const body = await get("https://ai-gateway.vercel.sh/v1/credits", key) as { balance?: unknown; data?: { balance?: unknown } };
      const value = number(body.balance) ?? number(body.data?.balance);
      if (value === undefined) throw new Error("Vercel AI Gateway 余额响应无效");
      return { windows: [], balance: { value, currency: "USD" } };
    }
    if (kind === "zenmux") {
      const [subscription, balanceBody] = await Promise.all([
        get("https://zenmux.ai/api/v1/management/subscription/detail", key).catch(() => undefined),
        get("https://zenmux.ai/api/v1/management/payg/balance", key).catch(() => undefined),
      ]) as [{ data?: Record<string, { usage_percentage?: unknown; used_flows?: unknown; max_flows?: unknown; resets_at?: unknown }> } | undefined, { data?: { total_credits?: unknown; currency?: unknown } } | undefined];
      const windows = Object.entries({ quota_5_hour: "5h", quota_7_day: "week" }).flatMap(([field, label]) => {
        const row = subscription?.data?.[field], ratio = number(row?.usage_percentage);
        if (ratio === undefined) return [];
        const used = number(row?.used_flows), limit = number(row?.max_flows);
        return [window(label, ratio * 100, typeof row?.resets_at === "string" ? row.resets_at : undefined, used !== undefined && limit !== undefined ? { used, limit, unit: "flows" } : undefined)];
      });
      const total = number(balanceBody?.data?.total_credits);
      if (!windows.length && total === undefined) throw new Error("ZenMux 没有可用配额或余额");
      return { windows, ...(total !== undefined ? { balance: { value: total, currency: typeof balanceBody?.data?.currency === "string" ? balanceBody.data.currency : "credits" } } : {}), coverage: windows.length && total !== undefined ? "complete" : "partial" };
    }
    if (kind === "litellm") {
      const url = new URL(provider.baseUrl);
      const root = `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
      const body = await get(`${root}/key/info`, key) as { info?: { max_budget?: unknown; spend?: unknown } };
      const limit = number(body.info?.max_budget), used = number(body.info?.spend);
      if (limit === undefined || limit <= 0 || used === undefined) throw new Error("LiteLLM 没有可用的 Key 预算");
      return { windows: [window("period", used / limit * 100, undefined, { used, limit, unit: "USD" })] };
    }
    const current = await get("https://amr-api.open-design.ai/api/v1/workspaces/current", key) as { workspaceId?: unknown; activeWorkspaceId?: unknown };
    const workspace = typeof current.activeWorkspaceId === "string" ? current.activeWorkspaceId : current.workspaceId;
    if (typeof workspace !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(workspace)) throw new Error("OpenDesign 工作区响应无效");
    const [usage, summary] = await Promise.all([
      get(`https://amr-api.open-design.ai/api/v1/workspaces/${encodeURIComponent(workspace)}/billing/coding-plan-usage`, key),
      get("https://amr-api.open-design.ai/api/v1/billing/summary", key).catch(() => undefined),
    ]) as [{ windows?: Array<Record<string, unknown>> }, { balanceUsd?: unknown; totalAvailableCreditsUsd?: unknown } | undefined];
    const windows = (Array.isArray(usage.windows) ? usage.windows : []).flatMap(row => {
      const seconds = number(row.durationSeconds), used = number(row.usedCredits), limit = number(row.limitCredits);
      if (seconds === undefined || seconds <= 0 || used === undefined || limit === undefined || limit <= 0) return [];
      return [window(`${seconds}s`, used / limit * 100, typeof row.resetsAt === "string" ? row.resetsAt : undefined, { used, limit, unit: "credits" })];
    });
    const balance = number(summary?.balanceUsd) ?? number(summary?.totalAvailableCreditsUsd);
    if (!windows.length && balance === undefined) throw new Error("OpenDesign 没有可用额度数据");
    return { windows, ...(balance !== undefined ? { balance: { value: balance, currency: "USD" } } : {}), coverage: windows.length && balance !== undefined ? "complete" : "partial" };
  }
}
