import type { ProviderApi, ProviderModelInput, ThinkingLevel } from "@nova-novel/shared";

export interface ProviderMetadataExtension {
  providerId: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  oauth: boolean;
  source: "plugin";
  envRefs: string[];
  apiKeyEnv?: string;
  models: ProviderModelInput[];
}

const OPENAI_EFFORTS: NonNullable<ProviderModelInput["thinkingLevelMap"]> = { off: null, minimal: null, xhigh: "xhigh", max: "max" };
const TEXT_AND_IMAGE: Array<"text" | "image"> = ["text", "image"];
const TEXT_ONLY: Array<"text" | "image"> = ["text"];
function model(id: string, name: string, contextWindow: number, input: Array<"text" | "image">, efforts: readonly string[] = [], maxTokens = 128_000): ProviderModelInput {
  const reasoning = efforts.length > 0;
  return { id, name, contextWindow, maxTokens, input, reasoning, thinkingLevelMap: reasoning ? OPENAI_EFFORTS : { off: null, minimal: null, xhigh: null, max: null } };
}

// OpenAI Codex / Command Code 的上游补充元数据，参照 dsh-codex-connect 的模型注册方式。
const CODEX_MODELS: ProviderModelInput[] = [
  model("gpt-6.1-sol", "GPT-6.1-Sol", 1_050_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-6.1-terra", "GPT-6.1-Terra", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("gpt-6-astra", "GPT-6-Astra", 272_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-6-sol", "GPT-6-Sol", 1_050_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-6-luna", "GPT-6-Luna", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
];

// OpenDesign CoRouter 的本地目录分组。plan/paid 仅表示插件的额度池视图，不是上游计费承诺。
const OPENDESIGN_MODELS: ProviderModelInput[] = [
  model("gpt-6.1-sol", "GPT-6.1 Sol", 1_050_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-6.1-terra", "GPT-6.1 Terra", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("gpt-6-astra", "GPT-6 Astra", 1_050_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-6-luna", "GPT-6 Luna", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("gpt-6-sol", "GPT-6 Sol", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000, TEXT_AND_IMAGE, ["none", "low", "medium", "high", "xhigh", "max"]),
  model("claude-fable-5.1", "Claude Fable 5.1", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-fable-5", "Claude Fable 5", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-opus-5.5", "Claude Opus 5.5", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-opus-5", "Claude Opus 5", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-opus-4.8", "Claude Opus 4.8", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-sonnet-5.5", "Claude Sonnet 5.5", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-sonnet-5", "Claude Sonnet 5", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("claude-haiku-5.5", "Claude Haiku 5.5", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1_000_000, TEXT_AND_IMAGE, ["low", "high", "max"], 384_000),
  model("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, TEXT_AND_IMAGE, ["low", "high", "max"], 384_000),
  model("deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, TEXT_AND_IMAGE, ["low", "high", "max"], 384_000),
  model("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp", 1_000_000, TEXT_AND_IMAGE, ["low", "high", "max"], 384_000),
  model("glm-5.3-flashx", "GLM-5.3 Flash-X", 1_000_000, TEXT_AND_IMAGE, ["low", "high", "max"]),
  model("glm-5.3-flash", "GLM-5.3 Flash", 1_000_000, TEXT_AND_IMAGE, ["low", "high", "max"]),
  model("glm-5.2", "GLM-5.2", 1_000_000, TEXT_ONLY, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  model("kimi-k2.7-code", "Kimi K2.7 Code", 262_144, TEXT_AND_IMAGE, [], 262_144),
  model("kimi-k3", "Kimi K3", 1_048_576, TEXT_AND_IMAGE, ["low", "high", "max"]),
  model("kimi-k3.1-pro", "Kimi K3.1 Pro", 1_048_576, TEXT_AND_IMAGE, ["low", "high", "max"]),
  model("gemini-4-argon", "Gemini 4 Argon", 1_048_576, TEXT_AND_IMAGE, ["low", "medium", "high"]),
  model("gemini-3.8-flash", "Gemini 3.8 Flash", 1_048_576, TEXT_AND_IMAGE, ["low", "medium", "high"]),
  model("gemini-3.7-flash", "Gemini 3.7 Flash", 1_048_576, TEXT_AND_IMAGE, ["low", "medium", "high"]),
  model("grok-4.7", "Grok 4.7", 500_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh"]),
  model("grok-4.6", "Grok 4.6", 500_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh"]),
  model("grok-4.5", "Grok 4.5", 500_000, TEXT_AND_IMAGE, ["low", "medium", "high"]),
  model("mimo-v2.6-pro", "MiMo V2.6 Pro", 1_000_000, TEXT_AND_IMAGE, []),
  model("mimo-v2.6-flash", "MiMo V2.6 Flash", 1_000_000, TEXT_AND_IMAGE, []),
  model("hy4-preview", "Hunyuan H4 Preview", 1_000_000, TEXT_ONLY, ["none", "high"], 64_000),
  model("qwen3.7-max", "Qwen3.7 Max", 1_000_000, TEXT_ONLY, []),
  model("minimax-m3.1-flash", "MiniMax M3.1 Flash", 1_000_000, TEXT_AND_IMAGE, ["low", "medium", "high", "xhigh", "max"]),
  model("muse-spark-1.3", "Muse Spark 1.3", 1_048_576, TEXT_AND_IMAGE, ["minimal", "low", "medium", "high", "xhigh", "max"]),
  model("muse-wonder", "Muse Wonder", 1_048_576, TEXT_AND_IMAGE),
];

const OPENDESIGN_PLAN_IDS = ["gpt-6-luna", "claude-haiku-5.5", "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "glm-5.3-flashx", "glm-5.3-flash", "kimi-k2.7-code", "mimo-v2.6-pro", "mimo-v2.6-flash", "hy4-preview", "minimax-m3.1-flash"];

export const PROVIDER_METADATA_EXTENSIONS: ProviderMetadataExtension[] = [
  { providerId: "openai-codex", name: "OpenAI Codex / Command Code", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", oauth: true, source: "plugin", envRefs: [], models: CODEX_MODELS },
  { providerId: "opendesign-plan", name: "OpenDesign CoRouter · 套餐赠送", api: "openai-completions", baseUrl: "https://amr-api.open-design.ai/api/v1", oauth: false, source: "plugin", envRefs: ["OPEN_DESIGN_COOKIE", "OPEN_DESIGN_SESSION"], models: OPENDESIGN_MODELS.filter(model => OPENDESIGN_PLAN_IDS.includes(model.id)) },
  { providerId: "opendesign-paid", name: "OpenDesign CoRouter · 付费", api: "openai-completions", baseUrl: "https://amr-api.open-design.ai/api/v1", oauth: false, source: "plugin", envRefs: ["OPEN_DESIGN_COOKIE", "OPEN_DESIGN_SESSION"], models: OPENDESIGN_MODELS.filter(model => !OPENDESIGN_PLAN_IDS.includes(model.id)) },
];

export function extraProviderPresets(): ProviderMetadataExtension[] {
  return PROVIDER_METADATA_EXTENSIONS.map(provider => ({ ...provider, ...providerEnvironmentMetadata(provider.providerId), models: provider.models.map(model => ({ ...model, ...(model.input ? { input: [...model.input] } : {}) })) }));
}

export const PROVIDER_ENV_HINTS: Record<string, string[]> = {
  ...Object.fromEntries(PROVIDER_METADATA_EXTENSIONS.map(provider => [provider.providerId, provider.envRefs])),
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY", "KIMI_CODING_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  huggingface: ["HF_TOKEN"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_GO_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  "zai-coding": ["ZAI_CODING_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  "amazon-bedrock": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION"],
  azure: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  "volcengine-agent-plan": ["VOLC_ACCESSKEY", "VOLC_SECRETKEY"],
  "volcengine-coding-plan": ["VOLC_ACCESSKEY", "VOLC_SECRETKEY"],
};

const NON_SINGLE_KEY_PROVIDERS = new Set(["openai-codex", "opendesign-plan", "opendesign-paid", "amazon-bedrock", "azure", "google-vertex", "cloudflare-ai-gateway", "cloudflare-workers-ai", "volcengine-agent-plan", "volcengine-coding-plan"]);

export function providerEnvironmentMetadata(providerId: string, supportsApiKey = true): { envRefs: string[]; apiKeyEnv?: string } {
  const envRefs = [...(PROVIDER_ENV_HINTS[providerId] ?? (supportsApiKey ? [`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`] : []))];
  return { envRefs, ...(supportsApiKey && !NON_SINGLE_KEY_PROVIDERS.has(providerId) && envRefs[0] ? { apiKeyEnv: envRefs[0] } : {}) };
}
