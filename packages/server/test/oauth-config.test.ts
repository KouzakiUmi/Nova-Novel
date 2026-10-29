import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentSettings } from "../src/agent/settings.js";
import { AgentUsageService } from "../src/agent/usage.js";

test("OAuth login creates an enabled configuration with routable builtin models and identity-scoped usage", async t => {
  const directory = mkdtempSync(join(tmpdir(), "nova-oauth-config-"));
  const accessToken = "oauth-test-access-not-in-provider-settings";
  const refreshToken = "oauth-test-refresh-not-in-provider-settings";
  let loggedIn = false;
  const authRequests: string[] = [];
  const create = ModelRuntime.create.bind(ModelRuntime);
  t.mock.method(ModelRuntime, "create", async (...args: Parameters<typeof ModelRuntime.create>) => {
    const runtime = await create(...args);
    t.mock.method(runtime, "login", async (providerId: string, method: string) => {
      assert.equal(providerId, "openai-codex");
      assert.equal(method, "oauth");
      loggedIn = true;
      return { type: "oauth", access: accessToken, refresh: refreshToken, expires: Date.now() + 60_000 };
    });
    t.mock.method(runtime, "getAvailable", async () => loggedIn ? runtime.getModels().filter(model => model.provider === "openai-codex") : []);
    t.mock.method(runtime, "getAuth", async (providerId: string) => {
      authRequests.push(providerId);
      assert.equal(providerId, "openai-codex");
      return { auth: { apiKey: accessToken } };
    });
    return runtime;
  });
  try {
    const settings = await AgentSettings.create(directory);
    assert.deepEqual(settings.view().providers, []);
    assert.equal(settings.resolveModel("scene"), undefined);
    assert.equal(settings.startOAuth("openai-codex").status, "pending");
    for (let attempt = 0; attempt < 100 && settings.oauthStatus("openai-codex").status === "pending"; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    assert.equal(settings.oauthStatus("openai-codex").status, "success");
    const configured = settings.view().providers.find(provider => provider.providerId === "my-openai-codex");
    assert.ok(configured);
    assert.equal(configured.authProviderId, "openai-codex");
    assert.equal(configured.disabled, false);
    assert.equal(configured.hasApiKey, true);
    const model = settings.view().models.find(model => model.provider === "openai-codex" && model.available);
    assert.ok(model, "OAuth success must expose a usable model, not merely a success status");
    await settings.routes([{ kind: "scene", provider: model.provider, modelId: model.modelId, thinkingLevel: "off" }]);
    assert.equal(settings.resolveModel("scene")?.provider, "openai-codex");
    assert.equal(settings.resolveModel("scene")?.modelId, model.modelId);
    const modelsText = readFileSync(settings.modelsPath, "utf8");
    const persistedModels = JSON.parse(modelsText) as { providers: Record<string, unknown> };
    assert.equal(persistedModels.providers["my-openai-codex"], undefined, "OAuth aliases must not become placeholder-key custom providers");
    const settingsText = readFileSync(settings.settingsPath, "utf8");
    assert.equal(JSON.parse(settingsText).providers[0].authProviderId, "openai-codex");
    for (const text of [modelsText, settingsText, JSON.stringify(settings.view())]) {
      assert.ok(!text.includes(accessToken));
      assert.ok(!text.includes(refreshToken));
    }
    let usageCalls = 0;
    const usage = new AgentUsageService(settings, async (url, init) => {
      usageCalls++;
      assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${accessToken}`);
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } }), { status: 200 });
    });
    const reports = await usage.list();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.providerId, "my-openai-codex");
    assert.equal(reports[0]?.state, "ok");
    assert.equal(reports[0]?.windows[0]?.percentUsed, 30);
    assert.equal(usageCalls, 1);
    assert.deepEqual(authRequests, ["openai-codex"]);
    assert.ok(!JSON.stringify(reports).includes(accessToken));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-oauth-config-")));
    rmSync(directory, { recursive: true, force: true });
  }
});
