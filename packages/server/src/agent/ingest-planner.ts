import type { IngestPlan, IngestPlanOption } from "@nova-novel/shared";

export interface IngestPlannerDeps { complete(prompt: string): Promise<string> }
/** 客户端本地分章后的结构摘要；正文不进入本请求，只给模型可判定结构的抽样。 */
export interface IngestDigest { chapterCount: number; sceneCount: number; wordCount: number; titles: string[]; head: string; middle: string; tail: string; opening: string }

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try { const value: unknown = JSON.parse(text.slice(start, end + 1)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function defaultOptions(sceneCount: number): IngestPlanOption[] {
  return [
    { id: "fast", title: "仅分章入库", detail: "只整理章节与正文，不额外调用模型，之后可在写作页逐场提取。", steps: ["本地按标题分章", "预览确认后创建作品"], estimatedCalls: 0, extract: false },
    { id: "standard", title: "分章 + 知识提取", detail: "逐场提取人物/设定、人物关系与状态事件，统一审阅后入库，作品打开即有元素账本。", steps: ["本地分章创建作品", "逐场 AI 提取（可暂停续跑）", "统一审阅确认入库"], estimatedCalls: sceneCount, recommended: true, extract: true },
  ];
}

function promptFor(digest: IngestDigest): string {
  const titles = digest.titles.slice(0, 24).join("、");
  return [
    "你是小说创作应用的导入总控。作者在本地完成了章节切分，现在你只根据结构摘要与抽样文字判断文本特点并给出处理方案。",
    "程序提供的能力：1) 本地按标题行切片分章（可用你给出的标题正则再切一次，正文不改写）；2) 逐场调用模型提取人物/设定、人物关系与状态事件并附原文证据，可暂停续跑；3) 全部提取后由作者统一审阅入库；4) 只分章入库、不做知识提取也可以。",
    "请输出 JSON（不要输出其他文字）：{",
    '  "analysis": "你对文本类型、章节结构、目录/番外/元信息特点的判定（中文 2-4 句）",',
    '  "chapterPattern": "可选。若本地标题规则可能漏判，给出匹配章节标题行的正则（不带斜杠与全局标志，例如 ^第\\\\d+章）；能确定则给，否则留空字符串",',
    '  "options": [ {"id":"fast 或 standard 或自定义","title":"方案名","detail":"适合谁、产物是什么","steps":["步骤1","步骤2"],"estimatedCalls":预计模型调用次数（整数）,"recommended":是否推荐（布尔）,"extract":是否进入逐场知识提取（布尔）} ]',
    "方案最多 3 个，必须包含一个不做知识提取的快速方案和一个知识提取方案；不要发明程序没有的能力（例如人物弧线、自动改写）。",
    `结构摘要：共 ${digest.chapterCount} 章、${digest.sceneCount} 场、约 ${digest.wordCount} 字。部分章标题：${titles}。`,
    `开头抽样：${digest.head}`,
    `中部抽样：${digest.middle}`,
    `结尾抽样：${digest.tail}`,
    `原始文本前 600 字：${digest.opening.slice(0, 600)}`,
  ].join("\n");
}

/** Agent 预处理：依据结构摘要判定处理方案；返回 null 时由本地默认流程接管。 */
export async function planManuscriptIngest(digest: IngestDigest, deps: IngestPlannerDeps): Promise<IngestPlan | null> {
  try {
    const text = await deps.complete(promptFor(digest));
    const parsed = parseJsonObject(text) as { analysis?: unknown; chapterPattern?: unknown; options?: unknown };
    const analysis = typeof parsed.analysis === "string" ? parsed.analysis.trim() : "";
    const options = Array.isArray(parsed.options) ? parsed.options.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      if (typeof raw.title !== "string" || !raw.title.trim()) return [];
      return [{
        id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `option-${index + 1}`,
        title: raw.title.trim().slice(0, 60),
        detail: typeof raw.detail === "string" ? raw.detail.trim().slice(0, 400) : "",
        steps: Array.isArray(raw.steps) ? raw.steps.filter((step): step is string => typeof step === "string").slice(0, 6) : [],
        estimatedCalls: typeof raw.estimatedCalls === "number" && Number.isFinite(raw.estimatedCalls) ? Math.max(0, Math.round(raw.estimatedCalls)) : 0,
        ...(raw.recommended === true ? { recommended: true } : {}),
        extract: raw.extract !== false,
      }];
    }) : [];
    if (!analysis && !options.length) return null;
    const chapterPattern = typeof parsed.chapterPattern === "string" && parsed.chapterPattern.trim() ? parsed.chapterPattern.trim().slice(0, 300) : undefined;
    return { analysis, options: options.length ? options : defaultOptions(digest.sceneCount), ...(chapterPattern ? { chapterPattern } : {}) };
  } catch { return null; }
}
