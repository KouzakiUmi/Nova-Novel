import { createHash, createHmac } from "node:crypto";
import type { UsageWindowView } from "@nova-novel/shared";
import type { VolcPlan } from "./models.js";

const HOST = "open.volcengineapi.com";
const REGION = "cn-beijing";
const SERVICE = "ark";
const VERSION = "2024-01-01";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
function escape(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function amount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }
  return undefined;
}
function reset(value: unknown, unit: "seconds" | "milliseconds"): string | undefined {
  const numeric = amount(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  const date = new Date(unit === "seconds" ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function window(kind: string, percentUsed: number, resetAt?: string, detail?: Pick<UsageWindowView, "used" | "limit" | "unit">): UsageWindowView {
  return { kind, percentUsed: Math.max(0, Math.min(100, percentUsed)), ...(resetAt ? { resetAt } : {}), ...detail };
}

export function signVolcRequest(accessKeyId: string, secretAccessKey: string, action: string, date = Date.now()) {
  if (!accessKeyId.trim() || !secretAccessKey.trim()) throw new Error("额度查询需要 IAM AK/SK");
  const xDate = new Date(date).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256("{}");
  const query = `Action=${escape(action)}&Version=${VERSION}`;
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`;
  const scope = `${shortDate}/${REGION}/${SERVICE}/request`;
  const canonical = ["POST", "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const toSign = ["HMAC-SHA256", xDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, shortDate), REGION), SERVICE), "request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return { url: `https://${HOST}/?${query}`, headers: { "content-type": "application/json", "x-content-sha256": payloadHash, "x-date": xDate, authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}

export function parseVolcUsage(plan: VolcPlan, body: unknown): UsageWindowView[] {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = value.Result && typeof value.Result === "object" && !Array.isArray(value.Result) ? value.Result as Record<string, unknown> : value;
  if (plan === "coding-plan") {
    const rows = Array.isArray(result.QuotaUsage) ? result.QuotaUsage as Array<Record<string, unknown>> : [];
    return rows.flatMap(row => {
      const level = String(row.Level ?? "").trim().toLowerCase();
      const kind = ({ session: "5h", "5h": "5h", five_hour: "5h", fivehour: "5h", weekly: "week", week: "week", "7d": "week", monthly: "month", month: "month" } as Record<string, string>)[level];
      const percent = amount(row.Percent);
      return kind && percent !== undefined ? [window(kind, percent, reset(row.ResetTimestamp, "seconds"))] : [];
    });
  }
  const definitions = [["AFPFiveHour", "text:5h"], ["AFPWeekly", "text:week"], ["AFPMonthly", "all:month"], ["AFPDaily", "daily:day"]] as const;
  return definitions.flatMap(([field, kind]) => {
    const row = result[field];
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const value = row as Record<string, unknown>, quota = amount(value.Quota), used = amount(value.Used);
    if (quota === undefined || used === undefined || quota <= 0) return [];
    return [window(kind, used / quota * 100, reset(value.ResetTime, "milliseconds"), { used, limit: quota, unit: "AFP" })];
  });
}

export async function fetchVolcUsage(plan: VolcPlan, accessKeyId: string, secretAccessKey: string, fetcher: typeof fetch = fetch): Promise<UsageWindowView[]> {
  const action = plan === "agent-plan" ? "GetAFPUsage" : "GetCodingPlanUsage";
  const { url, headers } = signVolcRequest(accessKeyId, secretAccessKey, action);
  const response = await fetcher(url, { method: "POST", headers, body: "{}", redirect: "error", signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("火山方舟额度响应过大");
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error("火山方舟额度响应不是有效 JSON"); }
  const error = body && typeof body === "object" ? (body as { ResponseMetadata?: { Error?: { Code?: unknown; Message?: unknown } } }).ResponseMetadata?.Error : undefined;
  if (error) throw new Error(`火山方舟额度查询失败：${typeof error.Code === "string" ? error.Code : "未知错误"}`);
  if (!response.ok) throw new Error(`火山方舟额度接口返回 HTTP ${response.status}`);
  return parseVolcUsage(plan, body);
}
