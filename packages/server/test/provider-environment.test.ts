import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSettings, builtinProviderPresets } from "../src/agent/settings.js";
import { providerEnvironmentMetadata } from "../src/agent/provider-metadata.js";
import { AgentUsageService } from "../src/agent/usage.js";

const secret = "provider-environment-secret-not-for-responses";
const secondSecret = "provider-environment-replacement-secret";
const input = { name: "MiniMax 国内", api: "openai-completions" as const, baseUrl: "https://api.minimaxi.com/v1", keySource: "environment" as const, models: [{ id: "writer" }] };

function environment(values: Record<string, string | undefined>) {
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nova-provider-environment-"));
  return {
    directory,
    text(name: "settings.json" | "models.json") { return readFileSync(join(directory, "agent", name), "utf8"); },
    close() {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-provider-environment-")));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("provider environment defaults distinguish Zen, Go and MiniMax CN without inventing single-key OAuth credentials", () => {
  const presets = builtinProviderPresets();
  for (const [id, name] of [["opencode", "OPENCODE_API_KEY"], ["opencode-go", "OPENCODE_GO_API_KEY"], ["minimax-cn", "MINIMAX_CN_API_KEY"], ["minimax", "MINIMAX_API_KEY"], ["google", "GEMINI_API_KEY"]]) {
    const preset = presets.find(preset => preset.providerId === id);
    assert.ok(preset, id);
    assert.equal(preset.apiKeyEnv, name);
    assert.ok(preset.envRefs.includes(name!));
  }
  for (const id of ["openai-codex", "opendesign-plan", "opendesign-paid", "amazon-bedrock", "google-vertex", "cloudflare-ai-gateway", "volcengine-agent-plan"]) {
    const preset = presets.find(preset => preset.providerId === id);
    assert.ok(preset, id);
    assert.equal(preset.apiKeyEnv, undefined, id);
    assert.ok(Array.isArray(preset.envRefs));
  }
  assert.deepEqual(providerEnvironmentMetadata("new-provider"), { envRefs: ["NEW_PROVIDER_API_KEY"], apiKeyEnv: "NEW_PROVIDER_API_KEY" });
});

test("environment detection exposes only safe candidates and excludes missing, configured and duplicate variables", async () => {
  const restore = environment({ OPENCODE_API_KEY: secret, OPENCODE_GO_API_KEY: secondSecret, MINIMAX_CN_API_KEY: secret, MINIMAX_API_KEY: undefined, OPEN_DESIGN_COOKIE: secret, OPEN_DESIGN_SESSION: secret, MOONSHOT_API_KEY: secret });
  const f = fixture();
  try {
    const settings = await AgentSettings.create(f.directory);
    const view = settings.view();
    for (const id of ["opencode", "opencode-go", "minimax-cn"]) assert.ok(view.detectedProviders.some(candidate => candidate.preset.providerId === id && candidate.hasApiKey));
    assert.ok(!view.detectedProviders.some(candidate => ["minimax", "openai-codex", "opendesign-plan", "opendesign-paid"].includes(candidate.preset.providerId)));
    assert.equal(new Set(view.detectedProviders.map(candidate => candidate.apiKeyEnv)).size, view.detectedProviders.length);
    assert.ok(view.detectedProviders.every(candidate => Object.keys(candidate).sort().join(",") === "apiKeyEnv,hasApiKey,preset"));
    assert.ok(!JSON.stringify(view).includes(secret));
    assert.ok(!JSON.stringify(view).includes(secondSecret));
    assert.deepEqual(view.providers, []);
    assert.deepEqual(view.models, [], "ambient environment variables are candidates, not implicitly enabled models");
    assert.equal(settings.resolveModel("scene"), undefined);
    await settings.upsert("my-minimax-cn", input);
    assert.equal(settings.provider("my-minimax-cn").apiKeyEnv, "MINIMAX_CN_API_KEY");
    assert.ok(!settings.view().detectedProviders.some(candidate => candidate.preset.providerId === "minimax-cn"));
    await settings.upsert("shared-env-reference", { ...input, baseUrl: "http://127.0.0.1:41414/v1", apiKeyEnv: "OPENCODE_API_KEY" });
    assert.ok(!settings.view().detectedProviders.some(candidate => candidate.apiKeyEnv === "OPENCODE_API_KEY"));
    assert.ok(!f.text("settings.json").includes(secret));
    assert.ok(!f.text("models.json").includes(secret));
    assert.ok(f.text("models.json").includes("$MINIMAX_CN_API_KEY"));
  } finally { restore(); f.close(); }
});

test("provider disable and re-enable preserve configuration while controlling model routing and persistence", async () => {
  const restore = environment({ MINIMAX_CN_API_KEY: secret });
  const f = fixture();
  try {
    const settings = await AgentSettings.create(f.directory);
    await settings.upsert("my-minimax-cn", input);
    await settings.routes([{ kind: "scene", provider: "my-minimax-cn", modelId: "writer", thinkingLevel: "off" }]);
    assert.equal(settings.resolveModel("scene")?.provider, "my-minimax-cn");
    await settings.upsert("my-minimax-cn", { ...settings.provider("my-minimax-cn"), disabled: true }, true);
    assert.equal(settings.view().providers[0]?.disabled, true);
    assert.deepEqual(settings.view().models, []);
    assert.equal(settings.resolveModel("scene"), undefined);
    assert.ok(!("my-minimax-cn" in JSON.parse(f.text("models.json")).providers));
    await settings.upsert("my-minimax-cn", { ...settings.provider("my-minimax-cn"), name: "改名但保持停用" }, true);
    assert.equal(settings.provider("my-minimax-cn").disabled, true);
    const reopened = await AgentSettings.create(f.directory);
    assert.equal(reopened.provider("my-minimax-cn").disabled, true);
    assert.equal(reopened.resolveModel("scene"), undefined);
    assert.ok(!reopened.view().detectedProviders.some(candidate => candidate.preset.providerId === "minimax-cn"));
    await reopened.upsert("my-minimax-cn", { ...reopened.provider("my-minimax-cn"), disabled: false }, true);
    assert.equal(reopened.resolveModel("scene")?.provider, "my-minimax-cn");
    assert.ok(reopened.view().models.every(model => model.provider === "my-minimax-cn"));
    await assert.rejects(reopened.upsert("my-minimax-cn", { ...reopened.provider("my-minimax-cn"), disabled: "yes" as unknown as boolean }, true), /停用状态/);
    await reopened.delete("my-minimax-cn");
    assert.ok(reopened.view().detectedProviders.some(candidate => candidate.preset.providerId === "minimax-cn"));
  } finally { restore(); f.close(); }
});

test("usage follows only enabled configured credentials, not ambient providers, and invalidates changed credentials", async () => {
  const restore = environment({ MINIMAX_CN_API_KEY: secret });
  const f = fixture();
  try {
    const settings = await AgentSettings.create(f.directory);
    let calls = 0;
    let failure = false;
    const usage = new AgentUsageService(settings, async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${process.env.MINIMAX_CN_API_KEY}`);
      if (failure) throw new Error(`request failed with ${process.env.MINIMAX_CN_API_KEY}`);
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 80 }] }), { status: 200 });
    });
    assert.deepEqual(await usage.list(), []);
    await settings.upsert("my-minimax-cn", { ...input, keySource: "manual", apiKey: "" });
    settings.runtime.getAvailableSnapshot = (() => { throw new Error("usage must not enumerate ambient runtime models"); }) as typeof settings.runtime.getAvailableSnapshot;
    settings.runtime.getAuth = (async () => { throw new Error("usage must not use ambient runtime auth"); }) as typeof settings.runtime.getAuth;
    const missing = await usage.list();
    assert.deepEqual(missing.map(report => [report.providerId, report.state]), [["my-minimax-cn", "no-key"]]);
    assert.equal(calls, 0);
    await settings.upsert("my-minimax-cn", { ...input, apiKey: "" }, true);
    const configured = await usage.list();
    assert.deepEqual(configured.map(report => [report.providerId, report.state]), [["my-minimax-cn", "ok"]]);
    assert.equal(calls, 1);
    await usage.list();
    assert.equal(calls, 1);
    process.env.MINIMAX_CN_API_KEY = secondSecret;
    await usage.list();
    assert.equal(calls, 2, "changing the referenced environment credential invalidates cached account usage");
    await settings.upsert("my-minimax-cn", { ...settings.provider("my-minimax-cn"), disabled: true }, true);
    assert.deepEqual(await usage.list(), []);
    assert.equal(calls, 2);
    await settings.upsert("my-minimax-cn", { ...settings.provider("my-minimax-cn"), disabled: false }, true);
    assert.equal((await usage.list())[0]?.providerId, "my-minimax-cn");
    assert.equal(calls, 3);
    failure = true;
    const error = await usage.list(true);
    assert.equal(error[0]?.state, "error");
    assert.ok(!JSON.stringify(error).includes(secondSecret));
    assert.ok(!f.text("settings.json").includes(secondSecret));
    assert.ok(!f.text("models.json").includes(secondSecret));
  } finally { restore(); f.close(); }
});

test("every built-in preset has output tokens within its context window", () => {
  for (const preset of builtinProviderPresets()) for (const model of preset.models) {
    assert.ok(model.maxTokens <= model.contextWindow, `${preset.providerId}/${model.id}: ${model.maxTokens} > ${model.contextWindow}`);
  }
});
