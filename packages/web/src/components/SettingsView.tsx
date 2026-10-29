import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentSettingsView, ModelOption, ProviderApi, ProviderConfigView, ProviderModelInput, ProviderTestResult, TaskKind, TaskRoute, ThinkingLevel, BuiltinProviderPreset, OAuthStatusView, UsageReportView, ProviderCompat } from "@nova-novel/shared";
import { TASK_KINDS } from "@nova-novel/shared";
import { Check, CircleAlert, CloudDownload, KeyRound, LoaderCircle, Pencil, Plus, Save, ShieldCheck, Trash2, X, Zap } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";
import { IconBeacon, IconCore, IconFacet, IconLens, IconQuill, IconSpark, type IconProps } from "./icons";

const API_OPTIONS: Array<{ value: ProviderApi; label: string; hint: string; placeholder: string }> = [
  { value: "openai-completions", label: "OpenAI 兼容（Chat Completions）", hint: "适用于大多数国内外服务、OpenRouter、Ollama、LM Studio、vLLM", placeholder: "https://api.example.com/v1" },
  { value: "openai-responses", label: "OpenAI Responses", hint: "OpenAI 官方 Responses 接口或兼容网关", placeholder: "https://api.openai.com/v1" },
  { value: "anthropic-messages", label: "Anthropic 兼容（Messages）", hint: "Claude 官方或兼容 Messages 协议的服务", placeholder: "https://api.anthropic.com" },
  { value: "google-generative-ai", label: "Google Gemini", hint: "Gemini API（Generative Language）", placeholder: "https://generativelanguage.googleapis.com/v1beta" },
  { value: "openai-codex-responses", label: "OpenAI Codex / Command Code", hint: "ChatGPT OAuth 与 Codex Responses 接口", placeholder: "https://chatgpt.com/backend-api" },
  { value: "mistral-conversations", label: "Mistral Conversations", hint: "Mistral 官方 Conversations 接口", placeholder: "https://api.mistral.ai" },
  { value: "bedrock-converse-stream", label: "Amazon Bedrock", hint: "AWS Bedrock Converse 流式接口", placeholder: "https://bedrock-runtime.us-east-1.amazonaws.com" },
  { value: "google-vertex", label: "Google Vertex AI", hint: "Vertex AI 项目、区域与凭据由运行环境提供", placeholder: "https://us-central1-aiplatform.googleapis.com" },
  { value: "azure-openai-responses", label: "Azure OpenAI Responses", hint: "将 {resource} 替换为你的 Azure 资源名", placeholder: "https://{resource}.openai.azure.com/openai/v1" },
  { value: "pi-messages", label: "Pi Messages / Radius", hint: "Pi 原生消息协议", placeholder: "https://radius.pi.dev/v1" },
];

const TASK_META: Record<TaskKind, { label: string; hint: string; icon: (props: IconProps) => React.ReactElement }> = {
  ideas: { label: "点子卡", hint: "方向要多样，速度快、成本低的模型就够用", icon: IconSpark },
  rehearsal: { label: "试演", hint: "短片段试写，看一个方向写出来什么样", icon: IconSpark },
  scene: { label: "续写场景", hint: "正文质量最关键，优先选中文文笔最好的模型", icon: IconQuill },
  polish: { label: "推敲与扩写", hint: "要听话、改动克制，只改选中的一段", icon: IconLens },
  consistency: { label: "一致性检查", hint: "需要推理能力和结构化输出，思考可以开高", icon: IconFacet },
  guide: { label: "交互大纲", hint: "每轮只出一道选择题，要求选项具体、结构稳定", icon: IconSpark },
};

const THINKING_LABEL: Record<ThinkingLevel, string> = { off: "关闭", minimal: "极少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

interface Draft {
  providerId: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  compat?: ProviderCompat;
  keySource: "manual" | "environment";
  apiKey: string;
  apiKeyEnv: string;
  quotaAccessKeyEnv: string;
  quotaSecretKeyEnv: string;
  keepKey: boolean;
  models: ProviderModelInput[];
}

const emptyDraft = (): Draft => ({ providerId: "", name: "", api: "openai-completions", baseUrl: "", keySource: "manual", apiKey: "", apiKeyEnv: "", quotaAccessKeyEnv: "", quotaSecretKeyEnv: "", keepKey: false, models: [{ id: "" }] });

function draftFrom(provider: ProviderConfigView): Draft {
  return { providerId: provider.providerId, name: provider.name, api: provider.api, baseUrl: provider.baseUrl, ...(provider.compat ? { compat: provider.compat } : {}), keySource: provider.keySource ?? "manual", apiKey: "", apiKeyEnv: provider.apiKeyEnv ?? "", quotaAccessKeyEnv: provider.quotaAccessKeyEnv ?? "", quotaSecretKeyEnv: provider.quotaSecretKeyEnv ?? "", keepKey: provider.hasApiKey, models: provider.models.length ? provider.models.map((model) => ({ ...model })) : [{ id: "" }] };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function SettingsView({ onChanged, onToast }: { onChanged: () => void; onToast: (message: string) => void }) {
  const [settings, setSettings] = useState<AgentSettingsView | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; draft: Draft; oauthProviderId?: string } | null>(null);
  const [routes, setRoutes] = useState<TaskRoute[]>([]);
  const [routesDirty, setRoutesDirty] = useState(false);
  const [tests, setTests] = useState<Record<string, ProviderTestResult | "running">>({});
  const [oauth, setOauth] = useState<OAuthStatusView | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [usage, setUsage] = useState<UsageReportView[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  const apply = useCallback((next: AgentSettingsView) => {
    setSettings(next);
    setRoutes(next.routes);
    setRoutesDirty(false);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.agentSettings());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取模型设置");
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);
  const loadUsage = useCallback(async (refresh = false) => {
    setUsageLoading(true);
    try { setUsage((await api.usageReports(refresh)).reports); }
    catch (cause) { onToast(cause instanceof Error ? cause.message : "额度读取失败"); }
    finally { setUsageLoading(false); }
  }, [onToast]);
  useEffect(() => { void loadUsage(); }, [loadUsage]);
  useEffect(() => {
    if (oauth?.status !== "pending") return;
    const timer = window.setInterval(() => {
      void api.oauthStatus(oauth.providerId).then(setOauth).catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [oauth]);

  const startOAuth = async (providerId: string) => {
    try {
      setOauthCode("");
      setOauth(await api.startOAuth(providerId));
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : "OAuth 启动失败");
    }
  };
  const submitCode = async () => {
    if (!oauth) return;
    try {
      await api.submitOAuthCode(oauth.providerId, oauthCode.trim());
      setOauthCode("");
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : "授权码提交失败");
    }
  };
  const cancelOAuth = async () => {
    if (!oauth) return;
    await api.cancelOAuth(oauth.providerId);
    setOauth(null);
  };
  const choosePreset = (preset: BuiltinProviderPreset) => {
    setEditing({ mode: "create", draft: { ...emptyDraft(), providerId: `my-${preset.providerId}`, name: preset.name, api: preset.api, baseUrl: preset.baseUrl, ...(preset.compat ? { compat: preset.compat } : {}), models: preset.models.length ? preset.models : [{ id: "" }] }, ...(preset.oauth ? { oauthProviderId: preset.providerId } : {}) });
  };

  const availableModels = useMemo(() => (settings?.models ?? []).filter((model) => model.available), [settings]);
  useEffect(() => { if (oauth?.status === "success") onChanged(); }, [oauth?.status]);

  const testProvider = async (providerId: string) => {
    setTests((value) => ({ ...value, [providerId]: "running" }));
    try {
      const result = await api.testProvider(providerId);
      setTests((value) => ({ ...value, [providerId]: result }));
    } catch (cause) {
      setTests((value) => ({ ...value, [providerId]: { ok: false, message: cause instanceof Error ? cause.message : "测试失败" } }));
    }
  };

  const removeProvider = async (provider: ProviderConfigView) => {
    if (!window.confirm(`删除“${provider.name}”？使用它的任务会改回默认模型。作品内容不受影响。`)) return;
    try {
      apply(await api.deleteProvider(provider.providerId));
      onChanged();
      onToast(`已删除 ${provider.name}`);
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : "删除未完成");
    }
  };

  const saveRoutes = async () => {
    try {
      apply(await api.saveRoutes(routes));
      onChanged();
      onToast("任务分配已保存");
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : "保存未完成");
    }
  };

  const updateRoute = (kind: TaskKind, patch: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; clearModel?: boolean }) => {
    setRoutes((current) => {
      const existing = current.find((route) => route.kind === kind) ?? { kind, thinkingLevel: "medium" as ThinkingLevel };
      const next: TaskRoute = { kind, thinkingLevel: patch.thinkingLevel ?? existing.thinkingLevel };
      const provider = patch.clearModel ? undefined : patch.provider ?? existing.provider;
      const modelId = patch.clearModel ? undefined : patch.modelId ?? existing.modelId;
      if (provider && modelId) { next.provider = provider; next.modelId = modelId; }
      return [...current.filter((route) => route.kind !== kind), next];
    });
    setRoutesDirty(true);
  };

  if (!settings) {
    return (
      <div className="settings-page page-scroll">
        <header className="page-toolbar"><div><p className="eyebrow">MODELS & SERVICES</p><h1>模型与服务</h1><p>{error || "正在读取…"}</p></div>{error && <button className="button primary" onClick={() => void load()}>重试</button>}</header>
      </div>
    );
  }

  return (
    <div className="settings-page page-scroll">
      <header className="page-toolbar">
        <div><p className="eyebrow">MODELS & SERVICES</p><h1>模型与服务</h1><p>接入你自己的模型服务，再为每类写作任务挑选合适的模型。作品始终保存在本机。</p></div>
        <div className="engine-chip"><IconCore size={20} /><div><strong>内置 Agent 引擎</strong><small>{settings.engine.name} {settings.engine.version} · 进程内运行，无需另装命令行</small></div></div>
      </header>

      <div className="settings-layout">
        <main>
          <section className="settings-section">
            <div className="settings-section-head">
              <div><h2>Provider</h2><p>可以添加任意 OpenAI、Anthropic 或 Gemini 兼容的服务，包括本机运行的模型。</p></div>
              <button className="button primary" onClick={() => setEditing({ mode: "create", draft: emptyDraft() })}><Plus size={15} />添加 provider</button>
            </div>
            <div className="provider-catalog-bar"><label className="filter-select">Pi 与插件服务<select id="builtin-provider-select" defaultValue="" onChange={(event) => { const preset = settings.builtinProviders.find(item => item.providerId === event.target.value); if (preset) choosePreset(preset); event.target.value = ""; }}><option value="">选择内置或插件服务…</option>{settings.builtinProviders.map(preset => <option key={preset.providerId} value={preset.providerId}>{preset.name}{preset.source === "plugin" ? " · 插件" : ""}{preset.oauth ? " · OAuth" : ""}</option>)}</select></label></div>
            {settings.providers.length === 0 && !editing && (
              <div className="provider-empty">
                <IconBeacon size={30} />
                <h3>还没有接入模型</h3>
                <p>从上方选择 Pi 或插件服务，也可以手动填写地址。没有模型时，写作、保存和版本功能照常可用。</p>
              </div>
            )}

            {oauth && (
              <div className="oauth-panel">
                <div className="editor-panel-head"><div><h3>{oauth.providerId} · OAuth 登录</h3><p>授权完成后，Pi 会把凭据保存在本机应用数据目录。</p></div><button className="icon-button" aria-label="取消 OAuth" onClick={() => void cancelOAuth()}><X size={16} /></button></div>
                {oauth.events.map((event, index) => <div className="oauth-event" key={`${event.type}:${index}`}>{event.message && <p>{event.message}</p>}{event.userCode && <p><strong>设备码：</strong><code>{event.userCode}</code></p>}{event.url && <div className="oauth-url"><input aria-label="授权地址" readOnly value={event.url} /><button className="button ghost small" onClick={() => { void navigator.clipboard.writeText(event.url!); onToast("授权地址已复制"); }}>复制地址</button></div>}</div>)}
                {oauth.status === "pending" && <div className="oauth-code-row"><input aria-label="OAuth 授权码" value={oauthCode} onChange={event => setOauthCode(event.target.value)} placeholder="如果页面显示授权码，粘贴到这里" /><button className="button primary" disabled={!oauthCode.trim()} onClick={() => void submitCode()}>提交授权码</button></div>}
                {oauth.status === "success" && <p className="inline-note success"><Check size={14} />登录成功，模型目录已更新。</p>}
                {oauth.status === "error" && <p className="inline-note error"><CircleAlert size={14} />{oauth.error}</p>}
              </div>
            )}

            {editing && (
              <ProviderEditor
                key={`${editing.mode}:${editing.draft.providerId}`}
                mode={editing.mode}
                initial={editing.draft}
                existingIds={settings.providers.map((provider) => provider.providerId)}
                {...(editing.oauthProviderId ? { oauthProviderId: editing.oauthProviderId } : {})}
                onOAuth={(providerId) => { setEditing(null); void startOAuth(providerId); }}
                onCancel={() => setEditing(null)}
                onSaved={(next, name) => { apply(next); setEditing(null); onChanged(); void loadUsage(true); onToast(`已保存 ${name}`); }}
              />
            )}

            <div className="provider-list">
              {settings.providers.map((provider) => {
                const test = tests[provider.providerId];
                const apiLabel = API_OPTIONS.find((option) => option.value === provider.api)?.label ?? provider.api;
                return (
                  <article key={provider.providerId} className="provider-card">
                    <div className="provider-card-main">
                      <span className="provider-glyph"><IconBeacon size={18} /></span>
                      <div>
                        <div className="provider-title"><strong>{provider.name}</strong><code>{provider.providerId}</code>{provider.keySource === "environment" ? <Badge tone="green"><KeyRound size={10} />环境变量</Badge> : provider.hasApiKey ? <Badge tone="green"><KeyRound size={10} />已存密钥</Badge> : <Badge tone="amber">未设密钥</Badge>}</div>
                        <p>{apiLabel} · {provider.baseUrl}</p>
                        <div className="model-chips">{provider.models.map((model) => <span key={model.id}>{model.name || model.id}{model.reasoning && <i title="支持思考">✦</i>}</span>)}</div>
                      </div>
                    </div>
                    <div className="provider-actions">
                      <button className="button ghost small" disabled={test === "running"} onClick={() => void testProvider(provider.providerId)}>{test === "running" ? <LoaderCircle size={13} className="spin" /> : <Zap size={13} />}测试连接</button>
                      <button className="icon-button" aria-label="编辑" title="编辑" onClick={() => setEditing({ mode: "edit", draft: draftFrom(provider) })}><Pencil size={15} /></button>
                      <button className="icon-button danger" aria-label="删除" title="删除" onClick={() => void removeProvider(provider)}><Trash2 size={15} /></button>
                    </div>
                    {test && test !== "running" && (
                      <p className={`test-result ${test.ok ? "ok" : "fail"}`}>{test.ok ? <Check size={13} /> : <CircleAlert size={13} />}{test.message}{test.latencyMs !== undefined && ` · ${test.latencyMs} ms`}{test.sample && <em>“{test.sample}”</em>}</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head"><div><h2>订阅用量</h2><p>只读显示已接入服务的额度窗口和余额；查询失败不会影响模型路由。</p></div><button className="button ghost" disabled={usageLoading} onClick={() => void loadUsage(true)}><CloudDownload size={15} />{usageLoading ? "读取中…" : "刷新用量"}</button></div>
            {usage.length === 0 ? <p className="quiet-empty">保存 provider 后，这里会显示支持查询的额度。</p> : <div className="usage-grid">{usage.map(report => <article className="usage-card" key={report.providerId}><div className="usage-card-head"><strong>{report.label}</strong><code>{report.providerId}</code></div>{report.state === "ok" ? <>{report.windows.map((item, index) => <div className="usage-window" key={`${item.kind}:${index}`}><div><span>{item.kind}</span><strong>剩余 {Math.max(0, 100 - item.percentUsed).toFixed(0)}%</strong></div><progress max={100} value={Math.max(0, 100 - item.percentUsed)} /></div>)}{report.balance && <p className="usage-balance">余额 <strong>{report.balance.value.toFixed(2)} {report.balance.currency}</strong></p>}{!report.windows.length && !report.balance && <p className="quiet-empty">当前没有可用额度窗口</p>}</> : <p className="usage-error">{report.state === "no-key" ? "未配置可用凭据" : report.state === "disabled" ? "该服务暂不支持额度读取" : report.error}</p>}</article>)}</div>}
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div><h2>任务分配</h2><p>不同任务的要求不一样：点子要快和多样，续写要文笔，检查要推理。没有指定时使用第一个可用模型。</p></div>
              <button className="button primary" disabled={!routesDirty} onClick={() => void saveRoutes()}><Save size={15} />保存分配</button>
            </div>
            {availableModels.length === 0 ? <p className="quiet-empty route-empty">添加并保存一个带密钥（或本机）的 provider 后，就可以在这里分配模型。</p> : (
              <div className="route-table">
                {TASK_KINDS.map((kind) => {
                  const meta = TASK_META[kind];
                  const route = routes.find((item) => item.kind === kind) ?? { kind, thinkingLevel: "medium" as ThinkingLevel };
                  const model = availableModels.find((item) => item.provider === route.provider && item.modelId === route.modelId);
                  const levels = model?.thinkingLevels ?? ["off"];
                  return (
                    <div className="route-row" key={kind}>
                      <span className="route-icon"><meta.icon size={18} /></span>
                      <div className="route-label"><strong>{meta.label}</strong><small>{meta.hint}</small></div>
                      <select aria-label={`${meta.label}使用的模型`} value={model ? `${model.provider}\u0000${model.modelId}` : ""} onChange={(event) => {
                        const [provider, modelId] = event.target.value.split("\u0000");
                        const picked = availableModels.find((item) => item.provider === provider && item.modelId === modelId);
                        const level = picked && !picked.thinkingLevels.includes(route.thinkingLevel) ? picked.thinkingLevels.at(-1) ?? "off" : route.thinkingLevel;
                        updateRoute(kind, event.target.value && provider && modelId ? { provider, modelId, thinkingLevel: level } : { clearModel: true });
                      }}>
                        <option value="">默认（第一个可用模型）</option>
                        {groupModels(availableModels).map(([group, models]) => <optgroup key={group} label={group}>{models.map((item) => <option key={`${item.provider}:${item.modelId}`} value={`${item.provider}\u0000${item.modelId}`}>{item.name}{costLabel(item)}</option>)}</optgroup>)}
                      </select>
                      <select aria-label={`${meta.label}的思考强度`} value={levels.includes(route.thinkingLevel) ? route.thinkingLevel : levels[0]} disabled={levels.length <= 1} onChange={(event) => updateRoute(kind, { thinkingLevel: event.target.value as ThinkingLevel })}>
                        {levels.map((level) => <option key={level} value={level}>思考 · {THINKING_LABEL[level]}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </main>

        <aside className="settings-aside">
          <div className="aside-card">
            <ShieldCheck size={16} />
            <h4>写作时模型能做什么</h4>
            <p>AI 搭档只能读取本作品的资料：检索证据、场景、元素和世界状态。它不能读写你电脑上的文件，也不能执行命令。</p>
          </div>
          <div className="aside-card">
            <KeyRound size={16} />
            <h4>密钥保存在哪里</h4>
            <p>手动填写的密钥只保存在本机数据目录；选择环境变量时只保存变量名，不把变量值写入设置文件或页面响应。</p>
            <code>{settings.dataDir}</code>
          </div>
          <div className="aside-card">
            <CircleAlert size={16} />
            <h4>会发送什么</h4>
            <p>生成时，本场正文、场景卡和检索到的相关资料会发送给所选 provider。测试连接只发送一句不含作品内容的问候。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function groupModels(models: ModelOption[]): Array<[string, ModelOption[]]> {
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups.entries()];
}

function costLabel(model: ModelOption): string {
  if (model.costInput === undefined || model.costOutput === undefined || (model.costInput === 0 && model.costOutput === 0)) return "";
  return ` · $${model.costInput}/$${model.costOutput} 每百万 token`;
}

function withContext(model: ProviderModelInput, value: string): ProviderModelInput {
  const { contextWindow: _previous, ...rest } = model;
  return value ? { ...rest, contextWindow: Number(value) } : rest;
}

function ProviderEditor({ mode, initial, existingIds, oauthProviderId, onOAuth, onCancel, onSaved }: { mode: "create" | "edit"; initial: Draft; existingIds: string[]; oauthProviderId?: string; onOAuth: (providerId: string) => void; onCancel: () => void; onSaved: (settings: AgentSettingsView, name: string) => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<ProviderModelInput[] | null>(null);
  const [error, setError] = useState("");
  const apiOption = API_OPTIONS.find((option) => option.value === draft.api) ?? API_OPTIONS[0]!;
  const isVolc = draft.providerId.includes("volcengine") || draft.baseUrl.includes("volces.com");
  const set = (patch: Partial<Draft>) => setDraft((value) => ({ ...value, ...patch }));
  const models = draft.models.filter((model) => model.id.trim());
  const idValid = /^[a-z0-9][a-z0-9-]{1,40}$/.test(draft.providerId);
  const idTaken = mode === "create" && existingIds.includes(draft.providerId);
  const canSave = idValid && !idTaken && draft.name.trim() && /^https?:\/\//.test(draft.baseUrl.trim()) && models.length > 0 && (draft.keySource === "manual" || /^[A-Z][A-Z0-9_]{1,80}$/.test(draft.apiKeyEnv)) && !saving;

  const discover = async () => {
    setDiscovering(true);
    setError("");
    try {
      const result = await api.discoverModels(draft.providerId || "new", { baseUrl: draft.baseUrl.trim(), api: draft.api, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) });
      setDiscovered(result.models);
      if (!result.models.length) setError("服务没有返回模型列表，请手动填写模型 ID。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取模型列表失败");
    } finally {
      setDiscovering(false);
    }
  };

  const toggleDiscovered = (model: ProviderModelInput) => {
    const exists = models.some((item) => item.id === model.id);
    set({ models: exists ? models.filter((item) => item.id !== model.id) : [...models, model] });
  };

  const save = async () => {
    setSaving(true);
    setError("");
    const payload = {
      name: draft.name.trim(),
      api: draft.api,
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
      ...(draft.compat ? { compat: draft.compat } : {}),
      keySource: draft.keySource,
      ...(draft.keySource === "environment" ? { apiKeyEnv: draft.apiKeyEnv } : {}),
      ...(draft.quotaAccessKeyEnv ? { quotaAccessKeyEnv: draft.quotaAccessKeyEnv } : {}),
      ...(draft.quotaSecretKeyEnv ? { quotaSecretKeyEnv: draft.quotaSecretKeyEnv } : {}),
      models: models.map((model) => ({ ...model, id: model.id.trim(), ...(model.name?.trim() ? { name: model.name.trim() } : {}) })),
      ...(draft.keySource === "manual" && (draft.apiKey ? { apiKey: draft.apiKey } : mode === "edit" && !draft.keepKey ? { apiKey: "" } : {})),
    };
    try {
      const next = mode === "create" ? await api.createProvider(draft.providerId, payload) : await api.updateProvider(draft.providerId, payload);
      onSaved(next, payload.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存未完成");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="provider-editor">
      <header><h3>{mode === "create" ? "添加 provider" : `编辑 ${initial.name}`}</h3><div className="editor-header-actions">{oauthProviderId && <button className="button ghost small" onClick={() => onOAuth(oauthProviderId)}>使用 OAuth 登录</button>}<button className="icon-button" onClick={onCancel} aria-label="关闭"><X size={16} /></button></div></header>
      <div className="editor-grid">
        <label className="field-label">显示名称<input value={draft.name} onChange={(event) => set({ name: event.target.value, ...(mode === "create" && (!draft.providerId || draft.providerId === slug(draft.name)) ? { providerId: slug(event.target.value) } : {}) })} placeholder="例如：我的 DeepSeek" /></label>
        <label className="field-label">标识（ID）<input value={draft.providerId} disabled={mode === "edit"} onChange={(event) => set({ providerId: event.target.value.toLowerCase() })} placeholder="my-provider" />{draft.providerId && !idValid && <small className="field-error">只能用小写字母、数字和短横线，2–41 个字符</small>}{idTaken && <small className="field-error">这个标识已被使用</small>}</label>
        <label className="field-label span-2">接口类型<select value={draft.api} onChange={(event) => set({ api: event.target.value as ProviderApi })}>{API_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{apiOption.hint}</small></label>
        <label className="field-label span-2">服务地址（Base URL）<input value={draft.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} placeholder={apiOption.placeholder} spellCheck={false} /></label>
        <label className="field-label span-2">密钥来源<select value={draft.keySource} onChange={(event) => set({ keySource: event.target.value as Draft["keySource"] })}><option value="manual">手动填写 API Key</option><option value="environment">读取环境变量</option></select></label>
        {draft.keySource === "environment" ? (
          <label className="field-label span-2">环境变量名<input id="api-key-env" value={draft.apiKeyEnv} onChange={(event) => set({ apiKeyEnv: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} placeholder="例如 DEEPSEEK_API_KEY" spellCheck={false} /><small>应用只保存变量名；启动 Nova 前，请先在系统或终端中设置该变量。</small></label>
        ) : (
          <label className="field-label span-2">API Key
            <input type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => set({ apiKey: event.target.value })} placeholder={draft.keepKey ? "已保存密钥；留空则保持不变" : "本机模型可以留空"} spellCheck={false} />
            {mode === "edit" && initial.keepKey && <span className="checkbox-line"><input type="checkbox" checked={!draft.keepKey && !draft.apiKey} onChange={(event) => set({ keepKey: !event.target.checked, apiKey: "" })} />清除已保存的密钥</span>}
          </label>
        )}
        {isVolc && <>
          <label className="field-label">额度 IAM Access Key 环境变量<input value={draft.quotaAccessKeyEnv} onChange={(event) => set({ quotaAccessKeyEnv: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} placeholder="VOLC_ACCESSKEY" spellCheck={false} /></label>
          <label className="field-label">额度 IAM Secret Key 环境变量<input value={draft.quotaSecretKeyEnv} onChange={(event) => set({ quotaSecretKeyEnv: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} placeholder="VOLC_SECRETKEY" spellCheck={false} /></label>
          <p className="field-hint span-2">推理 API Key 与额度 IAM AK/SK 是两套凭据；OAuth 登录的套餐无需填写这两项。</p>
        </>}
      </div>

      <div className="models-editor">
        <div className="models-editor-head"><span>模型</span>{draft.api.startsWith("openai") && <button className="button ghost small" disabled={discovering || !/^https?:\/\//.test(draft.baseUrl.trim())} onClick={() => void discover()}>{discovering ? <LoaderCircle size={13} className="spin" /> : <CloudDownload size={13} />}从服务读取模型列表</button>}</div>
        {discovered && discovered.length > 0 && (
          <div className="discovered">{discovered.slice(0, 60).map((model) => <button key={model.id} className={models.some((item) => item.id === model.id) ? "picked" : ""} onClick={() => toggleDiscovered(model)}>{models.some((item) => item.id === model.id) && <Check size={11} />}{model.id}</button>)}</div>
        )}
        {draft.models.map((model, index) => (
          <div className="model-row" key={index}>
            <input value={model.id} onChange={(event) => set({ models: draft.models.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) })} placeholder="模型 ID，例如 deepseek-chat" spellCheck={false} aria-label="模型 ID" />
            <input value={model.name ?? ""} onChange={(event) => set({ models: draft.models.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} placeholder="显示名称（可选）" aria-label="显示名称" />
            <input type="number" min={1024} step={1024} value={model.contextWindow ?? ""} onChange={(event) => set({ models: draft.models.map((item, itemIndex) => itemIndex === index ? withContext(item, event.target.value) : item) })} placeholder="上下文 128000" aria-label="上下文长度" />
            <label className="checkbox-line" title="模型支持思考（推理）"><input type="checkbox" checked={Boolean(model.reasoning)} onChange={(event) => set({ models: draft.models.map((item, itemIndex) => itemIndex === index ? { ...item, reasoning: event.target.checked } : item) })} />思考</label>
            <button className="icon-button" aria-label="移除模型" disabled={draft.models.length <= 1} onClick={() => set({ models: draft.models.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button>
          </div>
        ))}
        <button className="text-button" onClick={() => set({ models: [...draft.models, { id: "" }] })}><Plus size={13} />再加一个模型</button>
      </div>

      {error && <p className="inline-note error"><CircleAlert size={13} />{error}</p>}
      <footer><button className="button ghost" onClick={onCancel}>取消</button><button className="button primary" disabled={!canSave} onClick={() => void save()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存</button></footer>
    </section>
  );
}
