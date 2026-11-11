import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSettings } from "../src/agent/settings.js";
import { AgentUsageService } from "../src/agent/usage.js";
import type { ProviderConfigView } from "@nova-novel/shared";

const secret = "usage-secret-never-return";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

type TestProvider = ProviderConfigView & { apiKey: string };
function fakeSettings(providers: TestProvider[]): AgentSettings {
  return { dataProviders: () => providers, redact: (message: string) => message, runtime: { getAuth: async () => { throw new Error("OAuth must not be accessed"); } } } as unknown as AgentSettings;
}
function fakeProvider(providerId: string, baseUrl: string, proxyEnabled = false): TestProvider {
  return { providerId, name: providerId, api: "openai-completions", baseUrl, proxyEnabled, apiKey: secret, hasApiKey: true, models: [{ id: "writer" }], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

test("usage selects provider-scoped fetch independently during concurrent requests", async () => {
  const providers = [fakeProvider("one", "https://openrouter.ai/api/v1", true), fakeProvider("two", "https://openrouter.ai/api/v1")];
  const calls: Record<string, string[]> = { one: [], two: [] };
  const service = new AgentUsageService(fakeSettings(providers), undefined, provider => async input => {
    const id = provider.providerId;
    await Promise.resolve();
    calls[id]!.push(String(input));
    return String(input).endsWith("/key") ? json({ data: { limit: 10, limit_remaining: id === "one" ? 5 : 8 } }) : json({ data: { total_credits: 10, total_usage: 1 } });
  });
  const reports = await service.list();
  assert.equal(reports.find(report => report.providerId === "one")?.windows[0]?.percentUsed, 50);
  assert.equal(reports.find(report => report.providerId === "two")?.windows[0]?.percentUsed, 20);
  assert.equal(calls.one!.length, 2);
  assert.equal(calls.two!.length, 2);
});

test("usage preserves explicit fetch injection for proxy-enabled providers", async () => {
  const provider = fakeProvider("deepseek-proxy", "https://api.deepseek.com/v1", true);
  let calls = 0;
  const service = new AgentUsageService(fakeSettings([provider]), async () => {
    calls++;
    return json({ balance_infos: [{ currency: "CNY", total_balance: "12" }] });
  }, () => { throw new Error("injected fetch must take precedence"); });
  assert.equal((await service.list())[0]?.balance?.value, 12);
  assert.equal(calls, 1);
});

test("usage selects provider fetch for IAM quota and rejects proxy ArkCli and OAuth", async () => {
  const access = "NOVA_TEST_USAGE_AK", secretEnv = "NOVA_TEST_USAGE_SK";
  const oldAccess = process.env[access], oldSecret = process.env[secretEnv];
  process.env[access] = "test-access"; process.env[secretEnv] = "test-secret";
  try {
    const iam = { ...fakeProvider("volcengine-coding-plan", "https://ark.cn-beijing.volces.com/api/coding", true), quotaAccessKeyEnv: access, quotaSecretKeyEnv: secretEnv };
    const ark = fakeProvider("ark-bound", "https://ark.cn-beijing.volces.com/api/coding", true);
    const oauth = { ...fakeProvider("oauth-bound", "https://chatgpt.com/backend-api", true), authProviderId: "openai-codex" };
    const calls: string[] = [];
    const service = new AgentUsageService(fakeSettings([iam, ark, oauth]), undefined, provider => async input => {
      calls.push(`${provider.providerId}:${String(input)}`);
      return json({ Result: { QuotaUsage: [{ Level: "week", Percent: 25 }] } });
    });
    service.setVolcBackend({ hasBinding: id => id === "ark-bound", usageFor: async () => { throw new Error("ArkCli must not run"); } });
    const reports = await service.list();
    assert.equal(reports.find(report => report.providerId === iam.providerId)?.windows[0]?.percentUsed, 25);
    assert.match(reports.find(report => report.providerId === ark.providerId)?.error ?? "", /代理.*ArkCli/);
    assert.match(reports.find(report => report.providerId === oauth.providerId)?.error ?? "", /代理.*OAuth/);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /^volcengine-coding-plan:https:\/\/open\.volcengineapi\.com\//);
  } finally {
    if (oldAccess === undefined) delete process.env[access]; else process.env[access] = oldAccess;
    if (oldSecret === undefined) delete process.env[secretEnv]; else process.env[secretEnv] = oldSecret;
  }
});

test("usage reports normalize provider windows and balances without exposing credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nova-usage-"));
  try {
    const settings = await AgentSettings.create(directory);
    await settings.upsert("my-deepseek", { name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", keySource: "manual", apiKey: secret, models: [{ id: "deepseek-chat" }] });
    await settings.upsert("my-openrouter", { name: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", keySource: "manual", apiKey: secret, models: [{ id: "openai/gpt-4o" }] });
    await settings.upsert("my-zai", { name: "Z.ai", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", keySource: "manual", apiKey: secret, models: [{ id: "glm-5.3" }] });
    await settings.upsert("my-kimi", { name: "Kimi", api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1", keySource: "manual", apiKey: secret, models: [{ id: "kimi-k3" }] });
    await settings.upsert("opendesign-plan", { name: "OpenDesign", api: "openai-completions", baseUrl: "https://amr-api.open-design.ai/api/v1", keySource: "manual", apiKey: secret, models: [{ id: "gpt-6-luna" }] });
    settings.runtime.getAvailableSnapshot = (() => [{ provider: "openai-codex", modelId: "gpt-6-astra", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }]) as typeof settings.runtime.getAvailableSnapshot;
    settings.runtime.getAuth = (async () => { throw new Error("usage must not read ambient provider credentials"); }) as typeof settings.runtime.getAuth;
    let calls = 0;
    const usage = new AgentUsageService(settings, async (input) => {
      calls++;
      const url = String(input);
      if (url.includes("deepseek.com/user/balance")) return json({ balance_infos: [{ currency: "CNY", total_balance: "12.50" }] });
      if (url.endsWith("/api/v1/key")) return json({ data: { limit: 100, limit_remaining: 25, limit_reset: "monthly" } });
      if (url.endsWith("/api/v1/credits")) return json({ data: { total_credits: 50, total_usage: 10 } });
      if (url.includes("bigmodel.cn")) return json({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 40, currentValue: 400, usage: 1000, nextResetTime: "2026-11-01T00:00:00Z" }] } });
      if (url.includes("kimi.com")) return json({ usages: { limit_5h: { used_ratio: 0.25, reset_time: "2026-11-01T00:00:00Z" } } });
      if (url.includes("wham/usage")) return json({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1793500000 } } });
      if (url.includes("workspaces/current")) return json({ workspaceId: "ws_test" });
      if (url.includes("coding-plan-usage")) return json({ windows: [{ durationSeconds: 18000, usedCredits: 200, limitCredits: 1000, resetsAt: "2026-11-01T00:00:00Z" }] });
      if (url.includes("billing/summary")) return json({ balanceUsd: 8.5 });
      throw new Error(`unexpected ${url}`);
    });
    const reports = await usage.list();
    assert.equal(reports.length, 5);
    assert.ok(reports.every(report => report.state === "ok"));
    assert.equal(reports.find(report => report.providerId === "my-deepseek")?.balance?.value, 12.5);
    assert.equal(reports.find(report => report.providerId === "my-openrouter")?.windows[0]?.percentUsed, 75);
    assert.equal(reports.find(report => report.providerId === "my-zai")?.windows[0]?.percentUsed, 40);
    assert.equal(reports.find(report => report.providerId === "my-kimi")?.windows[0]?.percentUsed, 25);
    assert.equal(reports.find(report => report.providerId === "openai-codex"), undefined);
    assert.equal(reports.find(report => report.providerId === "opendesign-plan")?.balance?.value, 8.5);
    assert.ok(!JSON.stringify(reports).includes(secret));
    const before = calls;
    await usage.list();
    assert.equal(calls, before);
    assert.ok(!readFileSync(join(directory, "agent/settings.json"), "utf8").includes("Authorization"));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-usage-")));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("additional usage adapters preserve provider-specific units and windows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nova-usage-"));
  try {
    const settings = await AgentSettings.create(directory);
    const providers = [
      ["my-opencode-go", "https://opencode.ai/inference/go/v1"],
      ["my-siliconflow", "https://api.siliconflow.cn/v1"],
      ["my-synthetic", "https://api.synthetic.new/v1"],
      ["my-nanogpt", "https://api.nano-gpt.com/v1"],
      ["my-novita", "https://api.novita.ai/v1"],
      ["my-hyperbolic", "https://api.hyperbolic.xyz/v1"],
      ["my-deepinfra", "https://api.deepinfra.com/v1"],
      ["my-chutes", "https://api.chutes.ai/v1"],
      ["my-ollama", "https://ollama.com/v1"],
      ["my-vercel", "https://ai-gateway.vercel.sh/v1"],
      ["my-zenmux", "https://zenmux.ai/api/v1"],
      ["my-litellm", "http://127.0.0.1:41414/v1"],
    ] as const;
    for (const [providerId, baseUrl] of providers) await settings.upsert(providerId, { name: providerId, api: "openai-completions", baseUrl, keySource: "manual", apiKey: secret, models: [{ id: "writer" }] });
    const usage = new AgentUsageService(settings, async input => {
      const url = String(input);
      if (url.includes("opencode.ai/zen/go")) return json({ usage: { rolling: { percent: 20 }, weekly: { percent: 30 }, monthly: { percent: 40 } } });
      if (url.includes("siliconflow")) return json({ data: { totalBalance: 8.8 } });
      if (url.includes("synthetic")) return json({ subscription: { requests: 20, limit: 100, renewsAt: "2026-11-01T00:00:00Z" } });
      if (url.includes("nano-gpt.com/api/subscription")) return json({ active: true, state: "active", dailyInputTokens: { percentUsed: 0.4, used: 400, resetAt: 1793500000000 }, limits: { dailyInputTokens: 1000 } });
      if (url.includes("novita")) return json({ availableBalance: 125000 });
      if (url.includes("hyperbolic")) return json({ balanceCents: 1250 });
      if (url.includes("deepinfra")) return json({ stripe_balance: -9.5 });
      if (url.includes("chutes")) return json({ quota: 100, used: 25 });
      if (url.includes("ollama.com/api/usage")) return json({ limits: { session: { usage: 0.2 }, weekly: { usage: 0.3 } } });
      if (url.includes("vercel.sh")) return json({ balance: "7.25" });
      if (url.includes("subscription/detail")) return json({ data: { quota_5_hour: { usage_percentage: 0.25, used_flows: 25, max_flows: 100 } } });
      if (url.includes("payg/balance")) return json({ data: { total_credits: 18, currency: "USD" } });
      if (url.endsWith("/key/info")) return json({ info: { max_budget: 20, spend: 5 } });
      throw new Error(`unexpected ${url}`);
    });
    const reports = await usage.list();
    assert.equal(reports.length, 12);
    assert.ok(reports.every(report => report.state === "ok"));
    assert.equal(reports.find(report => report.providerId === "my-opencode-go")?.windows.length, 3);
    assert.equal(reports.find(report => report.providerId === "my-novita")?.balance?.value, 12.5);
    assert.equal(reports.find(report => report.providerId === "my-hyperbolic")?.balance?.value, 12.5);
    assert.equal(reports.find(report => report.providerId === "my-deepinfra")?.balance?.value, 9.5);
    assert.equal(reports.find(report => report.providerId === "my-chutes")?.windows[0]?.percentUsed, 25);
    assert.equal(reports.find(report => report.providerId === "my-zenmux")?.balance?.value, 18);
    assert.equal(reports.find(report => report.providerId === "my-litellm")?.windows[0]?.percentUsed, 25);
    assert.ok(!JSON.stringify(reports).includes(secret));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-usage-")));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage reports distinguish missing keys and unsupported providers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nova-usage-"));
  try {
    const settings = await AgentSettings.create(directory);
    await settings.upsert("local-ollama", { name: "Ollama", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "writer" }] });
    const usage = new AgentUsageService(settings, async () => { throw new Error("network must not be called"); });
    const [report] = await usage.list();
    assert.equal(report?.state, "disabled");
    assert.equal(report?.windows.length, 0);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-usage-")));
    rmSync(directory, { recursive: true, force: true });
  }
});
