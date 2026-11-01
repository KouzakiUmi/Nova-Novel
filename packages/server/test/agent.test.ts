import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { GenerationReceipt, GenerationRequest, AgentSettingsView } from "@nova-novel/shared";
import { DomainStore } from "../src/store.js";
import { SqliteKnowledgeService } from "../src/knowledge/index.js";
import { EmbeddedAgentHost } from "../src/agent/engine.js";
import { AgentSettings, thinkingLevels, clampThinking } from "../src/agent/settings.js";
import { parseOutput, composePrompt, checkPromptBudget } from "../src/agent/prompts.js";
import { novelTools } from "../src/agent/tools.js";
import { createApp } from "../src/app.js";
import type { WorkflowService } from "../src/contracts.js";

const workflow: WorkflowService = { listDefinitions: () => [], listRuns: () => [], startRun: () => { throw new Error("unused"); }, decide: () => { throw new Error("unused"); }, cancel: () => { throw new Error("unused"); } };
const secret = "test-secret-never-in-response";
type WireRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nova-agent-"));
  const db = new Database(":memory:");
  const store = new DomainStore(db);
  const knowledge = new SqliteKnowledgeService(db);
  const project = store.getProject();
  const branch = store.getBranch(project.activeBranchId);
  const scene = store.listScenes(project.projectId)[0]!;
  knowledge.indexScene(scene, branch.headRevisionId);
  const host = await EmbeddedAgentHost.create({ dataDir: directory, store, knowledge });
  const requests: WireRequest[] = [];
  let answer = "门外传来了脚步声。";
  let useTool = false;
  let toolError = false;
  let finishReason = "stop";
  let slow = false;
  let failure = false;
  let thinkingOnly = false;
  const sockets = new Set<ServerResponse>();
  const fake = createServer((request, response) => {
    if (failure) { response.writeHead(401, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: `invalid api key ${secret}` } })); return; }
    if (request.url === "/v1/models") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data: [{ id: "writer" }] })); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body) as WireRequest;
      requests.push(input);
      sockets.add(response);
      response.on("close", () => sockets.delete(response));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const block = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fake-completion", object: "chat.completion.chunk", created: 1, model: "writer", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      block({ role: "assistant", content: "" });
      if (useTool && !input.messages.some(message => message.role === "tool")) {
        if (thinkingOnly) block({ content: "我先核对一下收据。" });
        block({ tool_calls: [{ index: 0, id: "call_novel", type: "function", function: toolError ? { name: "novel_get_scene", arguments: '{"sceneId":"outside-task"}' } : { name: "novel_search", arguments: '{"query":"收据"}' } }] });
        block({}, "tool_calls");
      } else {
        block(thinkingOnly ? { reasoning_content: "仅在思考里的续写，不是成稿。" } : { content: answer });
        if (slow) return;
        block({}, finishReason);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  fake.listen(0, "127.0.0.1"); await once(fake, "listening");
  const fakeAddress = fake.address(); assert.ok(fakeAddress && typeof fakeAddress === "object");
  const api = createApp({ store, knowledge, workflow, pi: host });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const address = api.address(); assert.ok(address && typeof address === "object");
  const root = `http://127.0.0.1:${address.port}`;
  async function call(path: string, method = "GET", input?: unknown) {
    const response = await fetch(`${root}${path}`, { method, ...(input !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}) });
    const text = await response.text();
    assert.ok(!text.includes(secret), `密钥不得出现在 ${path} 响应中`);
    return { status: response.status, value: JSON.parse(text) };
  }
  async function configure() { return call("/api/agent/providers", "POST", { providerId: "local-test", name: "本地测试", api: "openai-completions", baseUrl: `http://127.0.0.1:${fakeAddress.port}/v1`, apiKey: secret, models: [{ id: "writer", maxTokens: 1024 }] }); }
  const request = (kind: GenerationRequest["kind"], key = `test-${kind}`): GenerationRequest => ({ projectId: project.projectId, sceneId: scene.sceneId, kind, input: "继续当前场景", idempotencyKey: key, ...(kind === "polish" ? { range: { from: 5, to: 9, baseText: "原来如此" } } : {}) });
  return { directory, db, store, knowledge, host, project, scene, requests, fakePort: fakeAddress.port, call, configure, request, setAnswer(value: string) { answer = value; }, setTool() { useTool = true; }, setToolError() { useTool = true; toolError = true; }, setLength() { finishReason = "length"; }, setFinishReason(value: string) { finishReason = value; }, setThinkingOnly() { useTool = true; thinkingOnly = true; }, setSlow() { slow = true; }, setFailure() { failure = true; }, async close() {
    await host.close();
    for (const response of sockets) response.end();
    api.closeAllConnections(); fake.closeAllConnections();
    await Promise.all([new Promise<void>(done => api.close(() => done())), new Promise<void>(done => fake.close(() => done()))]);
    db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "nova-agent-")));
    rmSync(directory, { recursive: true, force: true });
  } };
}

test("provider HTTP CRUD, secret retention, models.json, routes and discovery", async () => {
  const f = await fixture();
  try {
    const created = await f.configure(); assert.equal(created.status, 201);
    const view = created.value as AgentSettingsView;
    assert.equal(view.providers[0]!.hasApiKey, true);
    assert.equal(view.models.find(model => model.provider === "local-test")!.source, "custom");
    const models = JSON.parse(readFileSync(join(f.directory, "agent/models.json"), "utf8"));
    assert.equal(models.providers["local-test"].apiKey, secret);
    assert.equal(models.providers["local-test"].models[0].contextWindow, 128000);
    assert.equal((await f.call("/api/agent/providers/local-test", "PATCH", { name: "改名" })).status, 200);
    assert.equal(f.host.settings.provider("local-test").apiKey, secret);
    const routes = await f.call("/api/agent/routes", "PUT", { routes: [{ kind: "scene", provider: "local-test", modelId: "writer", thinkingLevel: "max" }] });
    assert.equal(routes.value.routes.find((route: { kind: string }) => route.kind === "scene").thinkingLevel, "off");
    assert.deepEqual((await f.call("/api/agent/providers/local-test/discover", "POST", {})).value.models, [{ id: "writer" }]);
    const testConnection = await f.call("/api/agent/providers/local-test/test", "POST", {});
    assert.equal(testConnection.value.ok, true);
    assert.ok(!JSON.stringify(f.requests[0]).includes(f.scene.body));
    const keyless = (await f.call("/api/agent/providers/local-test", "PATCH", { apiKey: "" })).value;
    assert.equal(keyless.providers[0].hasApiKey, false);
    // 本机模型常无需密钥：清除密钥后模型仍可分配，且占位值不出现在页面数据中。
    assert.equal(keyless.models.find((model: { modelId: string }) => model.modelId === "writer").available, true);
    assert.ok(!JSON.stringify(keyless).includes("no-key"));
    const deleted = await f.call("/api/agent/providers/local-test", "DELETE");
    assert.equal(deleted.status, 200); assert.deepEqual(deleted.value.providers, []);
    assert.equal(deleted.value.routes.find((route: { kind: string }) => route.kind === "scene").modelId, undefined);
  } finally { await f.close(); }
});

test("provider rejects invalid URL, reserved ID, shell key and malformed routes", async () => {
  const f = await fixture();
  try {
    await f.configure();
    for (const patch of [{ baseUrl: "file:///private" }, { baseUrl: "https://user:pass@example.invalid" }, { apiKey: "!execute" }, { models: [] }, { models: [{ id: "bad", maxTokens: 500, contextWindow: 2 }] }]) assert.equal((await f.call("/api/agent/providers/local-test", "PATCH", patch)).status, 400);
    assert.equal((await f.call("/api/agent/providers", "POST", { ...f.host.settings.provider("local-test"), providerId: "openai" })).status, 400);
    assert.equal((await f.call("/api/agent/routes", "PUT", { routes: [{ kind: "scene", thinkingLevel: "bogus" }] })).status, 400);
  } finally { await f.close(); }
});

test("Pi and plugin provider catalogs preserve model metadata", async () => {
  const f = await fixture();
  try {
    const view = (await f.call("/api/agent/settings")).value as AgentSettingsView;
    assert.ok(view.builtinProviders.some(provider => provider.providerId === "deepseek" && provider.models.length > 0));
    assert.ok(view.builtinProviders.some(provider => provider.providerId === "openrouter" && provider.models.length > 0));
    assert.ok(view.builtinProviders.some(provider => provider.providerId === "opencode-go" && provider.baseUrl.includes("/go")));
    assert.ok(view.builtinProviders.some(provider => provider.providerId === "mistral" && provider.api === "mistral-conversations"));
    assert.ok(view.builtinProviders.some(provider => provider.providerId === "azure" && provider.api === "azure-openai-responses"));
    const codex = view.builtinProviders.find(provider => provider.providerId === "openai-codex");
    assert.equal(codex?.oauth, true);
    assert.ok(codex?.models.some(model => model.id === "gpt-6.1-terra" && model.input?.includes("image")));
    const plan = view.builtinProviders.find(provider => provider.providerId === "opendesign-plan");
    const paid = view.builtinProviders.find(provider => provider.providerId === "opendesign-paid");
    assert.equal(plan?.source, "plugin");
    assert.equal(paid?.source, "plugin");
    assert.ok(plan?.models.some(model => model.id === "gpt-6-luna"));
    assert.ok(paid?.models.some(model => model.id === "gpt-6.1-sol"));
  } finally { await f.close(); }
});

test("environment API keys are resolved at runtime without persisting the secret", async () => {
  const f = await fixture();
  const previous = process.env.NOVA_TEST_PROVIDER_KEY;
  process.env.NOVA_TEST_PROVIDER_KEY = secret;
  try {
    const created = await f.call("/api/agent/providers", "POST", { providerId: "env-test", name: "环境变量测试", api: "openai-completions", baseUrl: `http://127.0.0.1:${f.fakePort}/v1`, keySource: "environment", apiKeyEnv: "NOVA_TEST_PROVIDER_KEY", models: [{ id: "writer" }] });
    assert.equal(created.status, 201);
    assert.equal(created.value.providers[0].keySource, "environment");
    assert.equal(created.value.providers[0].apiKeyEnv, "NOVA_TEST_PROVIDER_KEY");
    assert.equal(created.value.providers[0].hasApiKey, true);
    const models = readFileSync(join(f.directory, "agent/models.json"), "utf8");
    const settings = readFileSync(join(f.directory, "agent/settings.json"), "utf8");
    assert.ok(models.includes("$NOVA_TEST_PROVIDER_KEY"));
    assert.ok(!models.includes(secret));
    assert.ok(!settings.includes(secret));
    assert.ok(!JSON.stringify(created.value).includes(secret));
  } finally {
    if (previous === undefined) delete process.env.NOVA_TEST_PROVIDER_KEY; else process.env.NOVA_TEST_PROVIDER_KEY = previous;
    await f.close();
  }
});

test("OAuth login exposes only interaction events and accepts a manual code", async () => {
  const f = await fixture();
  try {
    const runtime = f.host.settings.runtime;
    const originalGetProvider = runtime.getProvider.bind(runtime);
    const originalLogin = runtime.login.bind(runtime);
    runtime.getProvider = ((id: string) => id === "anthropic" ? { auth: { oauth: {} } } : originalGetProvider(id)) as typeof runtime.getProvider;
    runtime.login = (async (_id: string, _type: "oauth", interaction: { notify(event: { type: "auth_url"; url: string } | { type: "progress"; message: string }): void; prompt(prompt: { type: "manual_code"; message: string }): Promise<string> }) => {
      interaction.notify({ type: "auth_url", url: "https://example.invalid/oauth" });
      const code = await interaction.prompt({ type: "manual_code", message: "code" });
      assert.equal(code, "test-oauth-code");
      interaction.notify({ type: "progress", message: "done" });
      return { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
    }) as typeof runtime.login;
    const started = await f.call("/api/agent/oauth/anthropic", "POST", {});
    assert.equal(started.status, 200);
    assert.equal(started.value.status, "pending");
    for (let index = 0; index < 20; index++) {
      const status = await f.call("/api/agent/oauth/anthropic");
      if (status.value.events.length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await f.call("/api/agent/oauth/anthropic/code", "POST", { code: "test-oauth-code" })).status, 200);
    for (let index = 0; index < 30; index++) {
      const status = await f.call("/api/agent/oauth/anthropic");
      if (status.value.status !== "pending") { assert.equal(status.value.status, "success"); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    runtime.getProvider = originalGetProvider;
    runtime.login = originalLogin;
  } finally { await f.close(); }
});

test("thinking levels follow model reasoning and explicit unsupported levels", () => {
  assert.deepEqual(thinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(thinkingLevels({ reasoning: true, thinkingLevelMap: { low: null, xhigh: "extra", max: null } }), ["medium", "high", "xhigh"]);
  assert.deepEqual(thinkingLevels({ reasoning: true, thinkingLevelMap: { off: "off", minimal: "minimal" } }), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(thinkingLevels({ reasoning: true }), ["low", "medium", "high"], "未声明映射的思考模型从 low 起，不允许关闭");
  assert.equal(clampThinking("off", thinkingLevels({ reasoning: true })), "low");
  assert.equal(clampThinking("max", ["off", "low", "high"]), "high");
});

test("embedded SSE full turn declares only novel tools and persists independent sessions", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setTool();
    const generated = await f.call("/api/generate", "POST", f.request("scene"));
    const receipt = generated.value as GenerationReceipt;
    assert.equal(receipt.task.state, "succeeded");
    assert.ok(receipt.task.result && typeof receipt.task.result === "object" && !("failureReason" in receipt.task.result)); assert.equal(receipt.task.error, undefined);
    assert.equal((receipt.task.result as { output: string }).output, "continuation");
    assert.ok((receipt.task.result as { artifactId: string }).artifactId);
    assert.equal(f.requests.length, 2);
    const names = f.requests[0]!.tools!.map(tool => tool.function.name);
    assert.deepEqual(names.sort(), ["novel_get_element", "novel_get_outline", "novel_get_scene", "novel_get_workflow", "novel_list_elements", "novel_list_scenes", "novel_list_workflows", "novel_search", "novel_world_state"]);
    assert.ok(names.every(name => name.startsWith("novel_")));
    const prompt = JSON.stringify(f.requests[0]!.messages);
    assert.match(prompt, /中文小说/); assert.match(prompt, /选定计划/); assert.match(prompt, /当前场景卡/);
    assert.match(prompt, /预期结果／场景摘要/); assert.match(prompt, /阿禾准备关掉父亲留下的修鞋铺/);
    await f.call("/api/generate", "POST", f.request("rehearsal"));
    const sessions = readdirSync(join(f.directory, "agent/sessions", f.project.projectId)).filter(name => name.endsWith(".jsonl"));
    assert.equal(sessions.length, 2);
    const progress = await f.call("/api/generate/progress?key=test-scene");
    assert.equal(progress.value.state, "succeeded"); assert.equal(progress.value.text, "门外传来了脚步声。");
    assert.equal(f.host.getConnection().mode, "embedded"); assert.equal(f.host.getConnection().version, "1.4.0");
  } finally { await f.close(); }
});

test("polish JSON and consistency report merge local checks; invalid JSON preserves artifact", async () => {
  const f = await fixture();
  try {
    await f.configure();
    f.setAnswer('```json\n{"replacement":"他停下脚步。","proposals":["建议检查动机"]}\n```');
    const polished = (await f.call("/api/generate", "POST", f.request("polish"))).value;
    assert.equal(polished.task.state, "succeeded"); assert.equal(polished.task.result.text, "他停下脚步。"); assert.deepEqual(polished.task.result.proposals, ["建议检查动机"]);
    f.knowledge.checkConsistency = () => [{ issueId: "local", severity: "conflict", title: "本地冲突", detail: "物品状态不符", evidence: ["原文"], certainty: "confirmed" }];
    f.setAnswer('{"summary":"有两项提醒","issues":[{"severity":"unknown","title":"动机未知","detail":"缺少前提","evidence":[]}]}');
    const report = (await f.call("/api/generate", "POST", f.request("consistency"))).value;
    assert.equal(report.task.result.output, "report"); assert.equal(report.task.result.report.issues.length, 2);
    f.setAnswer("不是 JSON 的原始产物");
    const failed = (await f.call("/api/generate", "POST", f.request("polish", "bad-polish"))).value;
    assert.equal(failed.task.state, "failed"); assert.equal(failed.task.result.text, "不是 JSON 的原始产物"); assert.ok(failed.task.result.artifactId);
    assert.equal(f.store.getScene(f.scene.sceneId).body, f.scene.body);
    const failedReport = (await f.call("/api/generate", "POST", f.request("consistency", "bad-consistency"))).value;
    assert.equal(failedReport.task.state, "failed"); assert.equal(failedReport.task.result.text, "不是 JSON 的原始产物");
  } finally { await f.close(); }
});

test("cancellation aborts stream and preserves partial text via both cancellation endpoints", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setSlow(); f.setAnswer("写到一半的文字");
    for (const byTask of [false, true]) {
      const key = `cancel-${byTask}`;
      const generating = f.call("/api/generate", "POST", f.request("scene", key));
      let progress: { taskId?: string; text: string } = { text: "" };
      for (let i = 0; i < 100 && !progress.text; i++) { await new Promise(done => setTimeout(done, 20)); progress = (await f.call(`/api/generate/progress?key=${key}`)).value; }
      assert.equal(progress.text, "写到一半的文字");
      const cancelled = await f.call(byTask ? `/api/tasks/${progress.taskId}/cancel` : "/api/generate/cancel", "POST", byTask ? {} : { idempotencyKey: key });
      assert.equal(cancelled.value.task.state, "cancelled");
      const receipt = (await generating).value;
      assert.equal(receipt.task.state, "cancelled"); assert.equal(receipt.task.completeness, "partial"); assert.equal(receipt.task.result.text, "写到一半的文字");
      assert.equal(receipt.task.result.failureReason, "cancelled"); assert.match(receipt.task.error, /作者已取消/);
    }
  } finally { await f.close(); }
});

test("unconfigured agent keeps writing APIs usable and reports clear generation error", async () => {
  const f = await fixture();
  try {
    assert.equal(f.host.getConnection().state, "unconfigured");
    const failed = (await f.call("/api/generate", "POST", f.request("scene"))).value;
    assert.equal(failed.task.state, "failed"); assert.match(failed.task.error, /设置中添加模型/);
    const saved = await f.call(`/api/scenes/${f.scene.sceneId}`, "PATCH", { baseRevisionId: f.store.getBranch(f.project.activeBranchId).headRevisionId, body: "作者继续写作。" });
    assert.equal(saved.status, 200); assert.equal(saved.value.scene.body, "作者继续写作。");
    assert.equal((await f.call("/api/generate/progress?key=missing")).value.state, "unknown");
    assert.deepEqual((await f.call("/api/generate/cancel", "POST", { idempotencyKey: "missing" })).value, {});
  } finally { await f.close(); }
});

test("ideas endpoint accepts pi and agent modes with parsed cards and session metadata", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const cards = [1, 2, 3].map(number => ({ action: `行动${number}`, motivation: "动机", obstacle: "阻碍", outcome: "结果", focus: "聚焦", tradeoff: "取舍" }));
    f.setAnswer(JSON.stringify({ cards }));
    for (const mode of ["pi", "agent"]) {
      const response = await f.call(`/api/projects/${f.project.projectId}/ideas`, "POST", { mode, input: "新的方向", idempotencyKey: `ideas-${mode}` });
      assert.equal(response.status, 200); assert.equal(response.value.batch.cards.length, 3);
      assert.equal(response.value.receipt.task.result.output, "ideas"); assert.ok(response.value.receipt.task.result.sessionId);
    }
  } finally { await f.close(); }
});

test("provider failures redact echoed keys and cancellation before session creation sends no prompt", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setFailure();
    assert.equal((await f.call("/api/agent/providers/local-test/test", "POST", {})).value.ok, false);
    assert.equal((await f.call("/api/agent/providers/local-test/discover", "POST", {})).status, 502);
    const request = f.request("scene", "pre-cancel");
    const project = f.store.getProject(); const branch = f.store.getBranch(project.activeBranchId);
    const context = f.knowledge.queryContext({ projectId: project.projectId, branchId: branch.branchId, routeId: project.activeRouteId, revisionId: branch.headRevisionId, query: "", purpose: "scene_writing" });
    const receipt = f.store.beginGeneration(request, context);
    f.store.requestCancellation(receipt.task.taskId);
    await f.host.cancel(receipt.task.taskId);
    const result = await f.host.generate({ task: receipt.task, request, systemContext: "" });
    const cancelled = f.store.finishGeneration(receipt.task.taskId, result, result.completeness);
    assert.equal(cancelled.task.state, "cancelled"); assert.equal(cancelled.task.completeness, "partial"); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("length and tool failures retain partial output instead of succeeding", async () => {
  for (const failure of ["length", "tool"]) {
    const f = await fixture();
    try {
      await f.configure(); if (failure === "length") f.setLength(); else f.setToolError();
      const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
      assert.equal(receipt.task.state, "interrupted"); assert.equal(receipt.task.completeness, "partial");
      assert.equal(receipt.task.result.text, "门外传来了脚步声。");
      assert.equal(receipt.task.result.failureReason, failure === "length" ? "truncated" : "tool_error");
      assert.match(receipt.task.error, failure === "length" ? /长度上限/ : /资料工具调用失败/);
    } finally { await f.close(); }
  }
});

test("successful tool round followed by thinking-only final turn never reuses its preface", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setThinkingOnly();
    const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests[1]!.messages.some(message => message.role === "tool"));
    assert.equal(receipt.task.state, "interrupted"); assert.equal(receipt.task.completeness, "partial");
    assert.equal(receipt.task.result.text, ""); assert.equal(receipt.task.result.failureReason, "empty_output");
    assert.match(receipt.task.error, /末轮未返回可用正文/);
    const progress = (await f.call("/api/generate/progress?key=test-scene")).value;
    assert.equal(progress.text, ""); assert.equal(f.store.getScene(f.scene.sceneId).body, f.scene.body);
    assert.equal(f.store.getArtifact(receipt.task.result.artifactId).completeness, "partial");
  } finally { await f.close(); }
});

test("starting a thinking-only tool follow-up clears live progress from the previous assistant turn", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setThinkingOnly(); f.setSlow();
    const generating = f.call("/api/generate", "POST", f.request("scene"));
    // 第二轮请求到达不等于新回合已经开始：只等 requests.length === 2 会在负载较高时
    // 读到上一轮尚未清空的进度。这里等到新回合清空文本后再断言。
    let progress: { text: string; tools: string[] } = { text: "", tools: [] };
    let cleared = false;
    for (let i = 0; i < 200; i++) {
      await new Promise(done => setTimeout(done, 20));
      progress = (await f.call("/api/generate/progress?key=test-scene")).value;
      if (f.requests.length === 2 && progress.tools.length && progress.text === "") { cleared = true; break; }
    }
    assert.equal(f.requests.length, 2); assert.deepEqual(progress.tools, ["novel_search"]);
    assert.ok(cleared, "新回合开始后应清空上一轮的实时进度文本，而不是继续显示上一轮前言");
    assert.equal(progress.text, "");
    await f.call("/api/generate/cancel", "POST", { idempotencyKey: "test-scene" });
    assert.equal((await generating).value.task.state, "cancelled");
  } finally { await f.close(); }
});

test("whitespace-only final text cannot become a complete continuation", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setAnswer(" \n\t");
    const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
    assert.equal(receipt.task.state, "interrupted"); assert.equal(receipt.task.result.failureReason, "empty_output");
    assert.equal(receipt.task.result.text, ""); assert.match(receipt.task.error, /未返回可用正文/);
  } finally { await f.close(); }
});

test("provider authentication errors expose a redacted actionable task reason", async () => {
  const f = await fixture();
  try {
    await f.configure(); f.setFailure();
    const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
    assert.notEqual(receipt.task.state, "succeeded"); assert.equal(receipt.task.completeness, "partial");
    assert.equal(receipt.task.result.failureReason, "provider_error"); assert.match(receipt.task.error, /鉴权失败.*401/);
    assert.ok(!JSON.stringify(f.store.getArtifact(receipt.task.result.artifactId)).includes(secret));
    assert.ok(!receipt.task.error.includes("invalid api key"));
  } finally { await f.close(); }
});

test("filtered and unknown provider finish reasons cannot succeed with otherwise valid text", async () => {
  for (const reason of ["content_filter", "unrecognized_finish"]) {
    const f = await fixture();
    try {
      await f.configure(); f.setFinishReason(reason);
      const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
      assert.notEqual(receipt.task.state, "succeeded"); assert.equal(receipt.task.completeness, "partial");
      assert.equal(receipt.task.result.failureReason, "provider_error");
      assert.match(receipt.task.error, reason === "content_filter" ? /过滤/ : /模型服务错误/);
    } finally { await f.close(); }
  }
});

test("thrown provider errors keep only safe classified summaries in tasks and artifacts", async t => {
  const f = await fixture();
  try {
    await f.configure();
    t.mock.method(f.host.settings.runtime, "getModel", () => { throw new Error(`upstream-private-body ${secret}: context length exceeded`); });
    const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
    assert.equal(receipt.task.state, "failed"); assert.equal(receipt.task.result.failureReason, "provider_error");
    assert.match(receipt.task.error, /上下文超出服务窗口.*重试/);
    const artifact = f.store.getArtifact(receipt.task.result.artifactId);
    assert.ok(!JSON.stringify(artifact).includes(secret)); assert.ok(!JSON.stringify(artifact).includes("upstream-private-body"));
    assert.ok(!JSON.stringify(receipt).includes("upstream-private-body"));
  } finally { await f.close(); }
});

test("ten-minute generation timeout is distinct from author cancellation", async t => {
  const f = await fixture();
  const original = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 600_000) expire = () => callback(...args);
    return original(callback, delay, ...args);
  });
  try {
    await f.configure(); f.setSlow(); f.setAnswer("超时前的半段正文");
    const generating = f.call("/api/generate", "POST", f.request("scene"));
    let text = "";
    for (let i = 0; i < 100 && !text; i++) { await new Promise(done => setTimeout(done, 20)); text = (await f.call("/api/generate/progress?key=test-scene")).value.text; }
    assert.equal(text, "超时前的半段正文"); assert.ok(expire); expire();
    const receipt = (await generating).value;
    assert.equal(receipt.task.state, "interrupted"); assert.equal(receipt.task.result.failureReason, "timeout");
    assert.equal(receipt.task.result.text, text); assert.match(receipt.task.error, /生成超时（10 分钟）/);
  } finally { await f.close(); }
});

test("oversized scene fails before contacting the provider without truncating author text", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const body = "长篇正文".repeat(15000);
    f.store.saveScene(f.scene.sceneId, { baseRevisionId: f.store.getBranch(f.project.activeBranchId).headRevisionId, body });
    const receipt = (await f.call("/api/generate", "POST", f.request("scene"))).value;
    assert.equal(receipt.task.state, "failed"); assert.equal(receipt.task.result.failureReason, "context_overflow");
    assert.match(receipt.task.error, /上下文超限.*当前正文/); assert.match(receipt.task.error, /模型窗口 128000/);
    assert.equal(f.requests.length, 0); assert.equal(f.store.getScene(f.scene.sceneId).body, body);
  } finally { await f.close(); }
});

test("prompt budget names oversized evidence and marks an unknown model window conservatively", async () => {
  const f = await fixture();
  try {
    const request = f.request("scene");
    const branch = f.store.getBranch(f.project.activeBranchId);
    const context = f.knowledge.queryContext({ projectId: f.project.projectId, branchId: branch.branchId, routeId: f.project.activeRouteId, revisionId: branch.headRevisionId, query: "收据", purpose: "scene_writing" });
    const receipt = f.store.beginGeneration(request, context);
    const frozen = f.store.generationContext(receipt.task.taskId);
    assert.equal(checkPromptBudget(request, frozen, () => true, { contextWindow: 128000, maxTokens: 1024 }, []), composePrompt(request, frozen));
    assert.ok(frozen.context.evidence.length);
    frozen.context.evidence[0]!.quote = "证据原文".repeat(5000);
    assert.throws(() => checkPromptBudget(request, frozen, () => true, { maxTokens: 1024 }, []), /上下文超限.*原文证据.*模型窗口未知，按保守默认 32768/);
    assert.equal(frozen.novel!.scene!.body, f.scene.body);
    assert.ok(composePrompt(request, frozen).includes(frozen.context.evidence[0]!.quote));
  } finally { await f.close(); }
});

test("tool queries hide unknown secrets and freeze knowledge before later edits", async () => {
  const f = await fixture();
  try {
    const project = f.store.getProject(); const branch = f.store.getBranch(project.activeBranchId);
    const hidden = f.knowledge.addEntity({ projectId: project.projectId, routeId: project.activeRouteId, entityId: "hidden-secret", type: "secret", name: "不可见谜底", summary: "凶手是父亲", sourceKind: "author_setting", reviewState: "confirmed" });
    f.knowledge.addFact({ projectId: project.projectId, routeId: project.activeRouteId, subjectId: hidden, predicate: "identity", value: "凶手是父亲", semanticType: "world_fact", sourceKind: "author_setting", reviewState: "confirmed" });
    const request = f.request("scene");
    const context = f.knowledge.queryContext({ projectId: project.projectId, branchId: branch.branchId, routeId: project.activeRouteId, revisionId: branch.headRevisionId, query: "", purpose: "scene_writing" });
    const receipt = f.store.beginGeneration(request, context);
    const scope = novelTools(f.store, f.knowledge, receipt.task.taskId);
    try {
      const late = f.knowledge.addEntity({ projectId: project.projectId, routeId: project.activeRouteId, entityId: "later-character", type: "character", name: "后来的人物", summary: "任务开始之后添加", sourceKind: "author_setting", reviewState: "confirmed" });
      f.knowledge.addFact({ projectId: project.projectId, routeId: project.activeRouteId, subjectId: late, predicate: "identity", value: "后来才有的事实", semanticType: "world_fact", sourceKind: "author_setting", reviewState: "confirmed" });
      const search = scope.tools.find(tool => tool.name === "novel_search")!;
      const result = await search.execute("test", { query: "不可见谜底 后来的人物" }, undefined, undefined, {} as never);
      assert.ok(!JSON.stringify(result).includes("凶手是父亲")); assert.ok(!JSON.stringify(result).includes("后来才有的事实"));
      const element = scope.tools.find(tool => tool.name === "novel_get_element")!;
      assert.match(JSON.stringify(await element.execute("test", { idOrName: hidden }, undefined, undefined, {} as never)), /unknown/);
      const scene = scope.tools.find(tool => tool.name === "novel_get_scene")!;
      await assert.rejects(() => scene.execute("test", { sceneId: "other-project-scene" }, undefined, undefined, {} as never));
    } finally { scope.dispose(); }
  } finally { await f.close(); }
});

test("task parsers reject missing fields and tolerate JSON fences", () => {
  assert.throws(() => parseOutput("consistency", '{"summary":"x","issues":[{"severity":"bad"}]}'));
  assert.throws(() => parseOutput("polish", '{"replacement":"x"}'));
  assert.throws(() => parseOutput("ideas", '{"cards":[]}'));
  assert.equal(parseOutput("polish", '```json\n{"replacement":"正文","proposals":[]}\n```').text, "正文");
});

test("settings reopen preserves secret and tools stay frozen on original revision", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const reopened = await AgentSettings.create(f.directory);
    assert.equal(reopened.provider("local-test").apiKey, secret);
    const request = f.request("scene");
    const project = f.store.getProject(); const branch = f.store.getBranch(project.activeBranchId);
    const context = f.knowledge.queryContext({ projectId: project.projectId, branchId: branch.branchId, routeId: project.activeRouteId, revisionId: branch.headRevisionId, query: "收据", purpose: "scene_writing" });
    const receipt = f.store.beginGeneration(request, context);
    const toolScope = novelTools(f.store, f.knowledge, receipt.task.taskId);
    const tools = toolScope.tools;
    f.store.saveScene(f.scene.sceneId, { baseRevisionId: branch.headRevisionId, body: "之后修改的新正文" });
    const getScene = tools.find(tool => tool.name === "novel_get_scene")!;
    const output = await getScene.execute("test", { sceneId: f.scene.sceneId }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(output), /阿禾/); assert.ok(!JSON.stringify(output).includes("之后修改的新正文"));
    const prompt = composePrompt(request, f.store.generationContext(receipt.task.taskId));
    assert.ok(prompt.includes(f.scene.body));
    toolScope.dispose();
  } finally { await f.close(); }
});

test("tool snapshot opens from a WAL file database without touching the source", () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-novel-wal-"));
  try {
    const db = new Database(join(dir, "wal.sqlite"));
    db.pragma("journal_mode = WAL");
    const store = new DomainStore(db);
    const knowledge = new SqliteKnowledgeService(db);
    const project = store.listProjects()[0]!;
    const head = store.getBranch(project.activeBranchId).headRevisionId;
    const scene = store.listScenes(project.projectId, head)[0]!;
    const request: GenerationRequest = { projectId: project.projectId, sceneId: scene.sceneId, kind: "scene", input: "续写", idempotencyKey: "wal-snapshot" };
    const receipt = store.beginGeneration(request, knowledge.queryContext({ projectId: project.projectId, branchId: project.activeBranchId, routeId: project.activeRouteId, revisionId: head, query: "", purpose: "scene_writing" }));
    const scope = novelTools(store, knowledge, receipt.task.taskId);
    assert.equal(scope.tools.length, 9);
    scope.dispose();
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
