import type { ProviderModelInput } from "@nova-novel/shared";
import { VOLC_CATALOG } from "./catalog.js";

export type VolcPlan = "agent-plan" | "coding-plan";
export const VOLC_ROUTES: Record<VolcPlan, string> = { "agent-plan": "volcengine-agent-plan", "coding-plan": "volcengine-coding-plan" };
export const VOLC_LABELS: Record<VolcPlan, string> = { "agent-plan": "火山方舟 · Agent 套餐", "coding-plan": "火山方舟 · 编程套餐" };

function knownModel(plan: VolcPlan, id: string) {
  return VOLC_CATALOG[plan].models.find(model => model.id === id || (model.aliases as readonly string[] | undefined)?.includes(id));
}
type VolcModelInput = Omit<Partial<ProviderModelInput>, "input"> & { id: string; name?: string; input?: readonly ("text" | "image")[] };
function convert(model: VolcModelInput): ProviderModelInput {
  const efforts = "reasoningEfforts" in model ? model.reasoningEfforts : false;
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    contextWindow: model.contextWindow ?? 32768,
    maxTokens: model.maxTokens ?? 8192,
    input: model.input ? [...model.input] : ["text"],
    reasoning: Boolean(efforts),
    ...(efforts && typeof efforts === "object" ? { thinkingLevelMap: { ...efforts } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  };
}
export function volcSnapshotModels(plan: VolcPlan): ProviderModelInput[] {
  return VOLC_CATALOG[plan].models.map(model => convert(model));
}
export function volcBaseUrl(plan: VolcPlan): string { return VOLC_CATALOG[plan].baseURL; }
export function volcCompat(plan: VolcPlan) { return { ...VOLC_CATALOG[plan].compat }; }
export function volcProviderModel(plan: VolcPlan, row: { model_id?: unknown; model_name?: unknown; output_name?: unknown }): ProviderModelInput {
  const id = typeof row.output_name === "string" && row.output_name ? row.output_name : row.model_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(id)) throw new Error("火山方舟模型目录包含非法 ID");
  const known = knownModel(plan, id) ?? (typeof row.model_id === "string" ? knownModel(plan, row.model_id) : undefined);
  return convert({ ...(known ?? { contextWindow: 32768, maxTokens: 8192, input: ["text"], reasoningEfforts: false }), id, name: typeof row.model_name === "string" && row.model_name.trim() ? row.model_name.trim() : known?.name ?? id });
}
export function planFromProvider(providerId: string): VolcPlan | undefined {
  if (providerId.includes("agent-plan")) return "agent-plan";
  if (providerId.includes("coding-plan")) return "coding-plan";
  return undefined;
}
