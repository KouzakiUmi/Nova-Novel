import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSettings } from "../src/agent/settings.js";
import { AgentUsageService } from "../src/agent/usage.js";
import { VolcengineService } from "../src/agent/volcengine/service.js";
import { fetchVolcUsage, parseVolcUsage, signVolcRequest } from "../src/agent/volcengine/quota.js";

const inferenceSecret = "volc-inference-secret";
const accessKey = "VOLC_TEST_ACCESS_KEY";
const secretKey = "volc-secret-never-return";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
function temporary() { return mkdtempSync(join(tmpdir(), "nova-volc-")); }
function cleanup(directory: string) { assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-volc-"))); rmSync(directory, { recursive: true, force: true }); }

test("Volcengine AK/SK signing and usage parsing preserve exact percent semantics", async () => {
  const signed = signVolcRequest(accessKey, secretKey, "GetCodingPlanUsage", Date.UTC(2026, 9, 29, 1, 2, 3));
  assert.ok(signed.url.startsWith("https://open.volcengineapi.com/?Action=GetCodingPlanUsage"));
  assert.ok(signed.headers.authorization.includes(accessKey));
  assert.ok(!signed.headers.authorization.includes(secretKey));
  assert.equal(signed.headers["x-date"], "20261029T010203Z");
  const coding = parseVolcUsage("coding-plan", { Result: { QuotaUsage: [{ Level: "session", Percent: "0.39", ResetTimestamp: 1793500000 }] } });
  assert.equal(coding[0]?.percentUsed, 0.39);
  const agent = parseVolcUsage("agent-plan", { Result: { AFPFiveHour: { Quota: "100", Used: "25", ResetTime: 1793500000000 }, AFPDaily: { Quota: 200, Used: 50 } } });
  assert.equal(agent[0]?.percentUsed, 25);
  assert.equal(agent[0]?.used, 25);
  const windows = await fetchVolcUsage("coding-plan", accessKey, secretKey, async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    assert.ok(!String(init?.headers && JSON.stringify(init.headers)).includes(secretKey));
    return json({ Result: { QuotaUsage: [{ Level: "weekly", Percent: 12.5 }] } });
  });
  assert.equal(windows[0]?.percentUsed, 12.5);
});

test("Volcengine OAuth binds both plans, syncs models and keeps CLI secrets out of Nova files", async () => {
  const directory = temporary();
  const previous = { agent: process.env.NOVA_VOLC_AGENT_PLAN_API_KEY, coding: process.env.NOVA_VOLC_CODING_PLAN_API_KEY };
  try {
    const settings = await AgentSettings.create(directory);
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "--version") return "arkcli version 1.0.37";
      if (args[0] === "auth" && args[1] === "login") return {};
      if (args[0] === "auth" && args[1] === "whoami") return { logged_in: true, name: "测试用户", user_id: "user-test", account_id: "account-test" };
      if (args[0] === "auth" && args[1] === "status") return { profiles_summary: [{ type: "agent-plan", name: "agent-profile" }, { type: "coding-plan", name: "coding-profile" }] };
      if (args[0] === "profile" && args[1] === "apikey") return inferenceSecret;
      if (args[0] === "plans" && args[1] === "model-list") return { plan: args[3], models: [{ model_id: args[3] === "agent-plan" ? "doubao-seed-evolving" : "doubao-seed-2-1-pro", output_name: args[3] === "agent-plan" ? "doubao-seed-evolving" : "doubao-seed-2-1-pro", model_name: "豆包测试模型" }] };
      if (args[0] === "api") return args[1] === "usage.get_afp_usage" ? { AFPFiveHour: { Quota: 100, Used: 20 } } : { Result: { QuotaUsage: [{ Level: "weekly", Percent: 30 }] } };
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const service = await VolcengineService.create(directory, settings, runner);
    assert.equal(service.startLogin().status, "pending");
    for (let index = 0; index < 50 && service.loginStatus().status === "pending"; index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.loginStatus().status, "success");
    const view = settings.view();
    for (const providerId of ["volcengine-agent-plan", "volcengine-coding-plan"]) {
      const provider = view.providers.find(item => item.providerId === providerId);
      assert.equal(provider?.keySource, "environment");
      assert.equal(provider?.compat?.forceAdaptiveThinking, true);
      assert.equal(provider?.compat?.allowEmptySignature, true);
      assert.ok(provider?.models.length);
      assert.ok(provider?.models[0]?.contextWindow);
    }
    const modelsFile = readFileSync(join(directory, "agent/models.json"), "utf8");
    assert.ok(modelsFile.includes("$NOVA_VOLC_AGENT_PLAN_API_KEY"));
    assert.ok(modelsFile.includes("$NOVA_VOLC_CODING_PLAN_API_KEY"));
    assert.ok(modelsFile.includes("forceAdaptiveThinking"));
    assert.ok(modelsFile.includes("allowEmptySignature"));
    assert.ok(!modelsFile.includes(inferenceSecret));
    assert.ok(!readFileSync(join(directory, "agent/settings.json"), "utf8").includes(inferenceSecret));
    assert.ok(!readFileSync(join(directory, "agent/volcengine.json"), "utf8").includes(inferenceSecret));
    const usage = new AgentUsageService(settings);
    usage.setVolcBackend(service);
    const reports = await usage.list();
    assert.equal(reports.find(report => report.providerId === "volcengine-agent-plan")?.windows[0]?.percentUsed, 20);
    assert.equal(reports.find(report => report.providerId === "volcengine-coding-plan")?.windows[0]?.percentUsed, 30);
    assert.ok(!JSON.stringify(reports).includes(inferenceSecret));
    service.close();
  } finally {
    for (const [key, value] of [["NOVA_VOLC_AGENT_PLAN_API_KEY", previous.agent], ["NOVA_VOLC_CODING_PLAN_API_KEY", previous.coding]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    cleanup(directory);
  }
});

test("Volcengine usage falls back to independent IAM environment references", async () => {
  const directory = temporary();
  const previousAk = process.env.VOLC_TEST_ACCESS, previousSk = process.env.VOLC_TEST_SECRET;
  process.env.VOLC_TEST_ACCESS = accessKey;
  process.env.VOLC_TEST_SECRET = secretKey;
  try {
    const settings = await AgentSettings.create(directory);
    await settings.upsert("volcengine-coding-plan", { name: "火山方舟", api: "anthropic-messages", baseUrl: "https://ark.cn-beijing.volces.com/api/coding", keySource: "manual", apiKey: inferenceSecret, quotaAccessKeyEnv: "VOLC_TEST_ACCESS", quotaSecretKeyEnv: "VOLC_TEST_SECRET", models: [{ id: "doubao-seed-2-1-pro" }] });
    const usage = new AgentUsageService(settings, async () => json({ Result: { QuotaUsage: [{ Level: "monthly", Percent: "0.39" }] } }));
    const [report] = await usage.list();
    assert.equal(report?.state, "ok");
    assert.equal(report?.windows[0]?.percentUsed, 0.39);
    assert.ok(!JSON.stringify(report).includes(secretKey));
  } finally {
    if (previousAk === undefined) delete process.env.VOLC_TEST_ACCESS; else process.env.VOLC_TEST_ACCESS = previousAk;
    if (previousSk === undefined) delete process.env.VOLC_TEST_SECRET; else process.env.VOLC_TEST_SECRET = previousSk;
    cleanup(directory);
  }
});
