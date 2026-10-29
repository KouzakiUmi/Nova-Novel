export interface WritingRecommendation {
  label: "写作推荐" | "暂不优先";
  tone: "green" | "amber";
  reason: string;
}

export function writingRecommendation(modelId: string): WritingRecommendation {
  const id = modelId.toLowerCase();
  if (/claude-(?:opus|sonnet)-5\.5/.test(id)) return { label: "暂不优先", tone: "amber", reason: "先与 4.6 做同场景比较；不因为版本号更大就默认叙事更合适" };
  if (/claude-(?:opus|sonnet)-4\.6/.test(id)) return { label: "写作推荐", tone: "green", reason: "可优先比较人物语气、对白和叙事连贯性" };
  if (/gemini/.test(id)) return { label: "写作推荐", tone: "green", reason: "可优先评估叙事、意象和长篇连贯性" };
  if (/claude-(?:opus|sonnet)/.test(id)) return { label: "写作推荐", tone: "green", reason: "适合比较人物动机、语气与修订质量" };
  if (/deepseek/.test(id)) return { label: "写作推荐", tone: "green", reason: "可优先试写中文场景、动作和对白" };
  if (/kimi|moonshot/.test(id)) return { label: "写作推荐", tone: "green", reason: "可优先评估中文长文本与资料延续能力" };
  if (/claude-haiku/.test(id)) return { label: "暂不优先", tone: "amber", reason: "更偏速度与效率，细腻叙事先做同场景比较" };
  return { label: "暂不优先", tone: "amber", reason: "没有明确的写作优先建议，先用一个短场景验证文风与事实保持" };
}
