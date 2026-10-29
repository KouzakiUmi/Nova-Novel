import { execFile } from "node:child_process";
import { accessSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { OAuthStatusView, UsageWindowView } from "@nova-novel/shared";
import type { AgentSettings } from "../settings.js";
import { DomainError } from "../../domain.js";
import { parseVolcUsage } from "./quota.js";
import { planFromProvider, VOLC_LABELS, VOLC_ROUTES, volcBaseUrl, volcCompat, volcProviderModel, type VolcPlan } from "./models.js";

type CliRunner = (args: string[], home: string, signal?: AbortSignal) => Promise<unknown>;
interface Binding { profile: string; home: string; loggedAt: string; identity?: { name?: string; userId?: string; accountId?: string } }
interface State { bindings: Record<string, Binding> }
const PLANS: VolcPlan[] = ["agent-plan", "coding-plan"];
const ENV_NAMES: Record<VolcPlan, string> = { "agent-plan": "NOVA_VOLC_AGENT_PLAN_API_KEY", "coding-plan": "NOVA_VOLC_CODING_PLAN_API_KEY" };

function cliEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
  for (const key of Object.keys(env)) if (/^(ARK_|ARKCLI_|VOLC|AWS_)/i.test(key)) delete env[key];
  return { ...env, ARKCLI_NO_UPDATE_NOTIFIER: "1", ARKCLI_CALLER_TYPE: "ai_agent", ARKCLI_CALLER_NAME: "nova-novel" };
}
function locateCli(): string {
  const explicit = process.env.NOVA_NOVEL_ARKCLI_PATH;
  if (explicit) {
    if (!isAbsolute(explicit) || /\.(cmd|bat)$/i.test(explicit)) throw new DomainError(400, "ARKCLI_PATH", "NOVA_NOVEL_ARKCLI_PATH 必须是官方原生可执行文件绝对路径");
    accessSync(explicit);
    return explicit;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "arkcli.exe" : "arkcli");
    if (existsSync(candidate)) return candidate;
  }
  throw new DomainError(400, "ARKCLI_NOT_FOUND", "未找到官方 ArkCli，请安装后设置 NOVA_NOVEL_ARKCLI_PATH");
}
const defaultRunner: CliRunner = async (args, home, signal) => {
  const executable = locateCli();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const plain = args.includes("--plain");
  const finalArgs = args.includes("--version") || plain ? args : [...args, "--format", "json"];
  const stdout = await new Promise<string>((resolve, reject) => execFile(executable, finalArgs, { env: cliEnvironment(home), cwd: home, windowsHide: true, timeout: args[0] === "auth" && args[1] === "login" ? 300_000 : 30_000, maxBuffer: 2 * 1024 * 1024, signal, encoding: "utf8" }, (error, stdout) => error ? reject(new Error("ArkCli 操作失败，原始输出已隐藏")) : resolve(stdout)));
  if (plain || args.includes("--version")) return stdout.trim();
  try { return JSON.parse(stdout.trim()); } catch { throw new Error("ArkCli 未返回有效 JSON"); }
};

export class VolcengineService {
  private state: State = { bindings: {} };
  private runner: CliRunner;
  private login: { controller: AbortController; events: OAuthStatusView["events"] } | undefined;
  private result: OAuthStatusView = { providerId: "volcengine", status: "cancelled", events: [] };
  private constructor(readonly dataDir: string, readonly settings: AgentSettings, runner?: CliRunner) {
    this.runner = runner ?? defaultRunner;
    const path = this.statePath;
    if (existsSync(path)) {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as State;
        if (value && typeof value === "object" && value.bindings && typeof value.bindings === "object") this.state = value;
      } catch { throw new DomainError(500, "INVALID_VOLC_SETTINGS", "火山方舟设置文件无法读取"); }
    }
  }
  static async create(dataDir: string, settings: AgentSettings, runner?: CliRunner): Promise<VolcengineService> {
    const service = new VolcengineService(dataDir, settings, runner);
    for (const plan of PLANS) {
      try { await service.syncPlan(plan); } catch { /* 启动时 CLI 不可用只保留既有配置，登录/刷新时显示错误。 */ }
    }
    return service;
  }
  private get statePath(): string { return resolve(this.dataDir, "agent/volcengine.json"); }
  private save(): void {
    mkdirSync(resolve(this.dataDir, "agent"), { recursive: true });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
  hasBinding(providerId: string): boolean { return Boolean(this.state.bindings[providerId]); }
  loginStatus(): OAuthStatusView {
    return this.login ? { providerId: "volcengine", status: "pending", events: this.login.events } : this.result;
  }
  startLogin(): OAuthStatusView {
    if (process.platform !== "win32") throw new DomainError(400, "ARKCLI_PLATFORM", "当前 OAuth 流程仅支持 Windows ArkCli 1.0.37");
    if (this.login) return this.loginStatus();
    const controller = new AbortController();
    const events: OAuthStatusView["events"] = [{ type: "progress", message: "正在启动官方 ArkCli 登录；请在系统浏览器中完成授权" }];
    const home = resolve(this.dataDir, "agent/volcengine/accounts", randomUUID());
    this.login = { controller, events };
    void (async () => {
      try {
        const version = await this.runner(["--version"], home, controller.signal);
        if (!/(?:^|\s)v?1\.0\.37(?:\s|$)/.test(String(version))) throw new Error("OAuth 要求已核验的 ArkCli 1.0.37");
        events.push({ type: "progress", message: "等待官方页面授权完成" });
        await this.runner(["auth", "login", "--login-mode", "broker", "--credential-store", "encrypted-file"], home, controller.signal);
        events.push({ type: "progress", message: "正在核验身份与个人套餐 profile" });
        const identity = await this.runner(["auth", "whoami"], home, controller.signal) as { logged_in?: boolean; name?: string; user_id?: string; account_id?: string };
        if (identity.logged_in !== true) throw new Error("ArkCli 未确认登录身份");
        const status = await this.runner(["auth", "status"], home, controller.signal) as { profiles_summary?: Array<{ type?: string; name?: string }> };
        if (!Array.isArray(status.profiles_summary)) throw new Error("ArkCli 身份摘要缺少 profiles_summary");
        const bindings: Record<string, Binding> = {};
        for (const plan of PLANS) {
          const rows = status.profiles_summary.filter(profile => profile.type === plan);
          if (rows.length > 1) throw new Error("同一套餐存在多个 profile，请先在 ArkCli 中确认");
          const profile = rows[0]?.name;
          if (profile) bindings[VOLC_ROUTES[plan]] = { profile, home, loggedAt: new Date().toISOString(), identity: { ...(identity.name ? { name: identity.name } : {}), ...(identity.user_id ? { userId: identity.user_id } : {}), ...(identity.account_id ? { accountId: identity.account_id } : {}) } };
        }
        if (!Object.keys(bindings).length) throw new Error("登录身份没有可用的个人 Agent/Coding 套餐 profile");
        this.state.bindings = bindings;
        this.save();
        for (const plan of PLANS) await this.syncPlan(plan);
        this.result = { providerId: "volcengine", status: "success", events: [...events, { type: "progress", message: "登录完成，套餐模型已同步" }] };
      } catch (error) {
        this.result = { providerId: "volcengine", status: controller.signal.aborted ? "cancelled" : "error", events, ...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : "火山方舟登录失败" }) };
      } finally { this.login = undefined; }
    })();
    return this.loginStatus();
  }
  cancelLogin(): void {
    this.login?.controller.abort();
    if (this.login) this.result = { providerId: "volcengine", status: "cancelled", events: this.login.events };
    this.login = undefined;
  }
  async syncPlan(plan: VolcPlan): Promise<void> {
    const providerId = VOLC_ROUTES[plan], binding = this.state.bindings[providerId];
    if (!binding) return;
    const key = await this.runner(["profile", "apikey", "get", "--profile", binding.profile, "--plain"], binding.home);
    if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) throw new Error("ArkCli 未返回可用的套餐 API Key");
    process.env[ENV_NAMES[plan]] = key.trim();
    const catalog = await this.runner(["plans", "model-list", "--plan", plan, "--profile", binding.profile], binding.home) as { plan?: string; models?: Array<{ model_id?: unknown; model_name?: unknown; output_name?: unknown }> };
    if (catalog.plan !== plan || !Array.isArray(catalog.models)) throw new Error("火山方舟模型目录与套餐不匹配");
    const models = catalog.models.map(row => volcProviderModel(plan, row));
    const input = { name: VOLC_LABELS[plan], api: "anthropic-messages" as const, baseUrl: volcBaseUrl(plan), compat: volcCompat(plan), keySource: "environment" as const, apiKeyEnv: ENV_NAMES[plan], models };
    await this.settings.upsert(providerId, input, this.settings.hasProvider(providerId));
  }
  async usageFor(providerId: string): Promise<UsageWindowView[] | undefined> {
    const plan = planFromProvider(providerId), binding = this.state.bindings[providerId];
    if (!plan || !binding) return undefined;
    const action = plan === "agent-plan" ? "usage.get_afp_usage" : "usage.get_coding_plan_usage";
    const raw = await this.runner(["api", action, "--params", "{}", "--profile", binding.profile], binding.home);
    const payload = plan === "agent-plan" && raw && typeof raw === "object" && !("Result" in raw) ? { Result: raw } : raw;
    return parseVolcUsage(plan, payload);
  }
  close(): void { this.cancelLogin(); }
}
