export type NextActionKind = "plan" | "review-candidate" | "compare" | "review-scene" | "continue" | "write";
export interface NextActionInput {
  hasBody: boolean;
  hasPlan: boolean;
  outcome?: "candidate" | "report" | null;
  stale?: boolean;
  lastAction?: "accepted" | "reviewed" | null;
}
export interface NextAction {
  kind: NextActionKind;
  title: string;
  reason: string;
  buttonLabel: string;
}

/** 只根据作者当前状态给出下一步，不调用模型，也不替作者执行。 */
export function recommendNextAction(input: NextActionInput): NextAction {
  if (input.outcome === "candidate" && input.stale) return { kind: "compare", title: "先比较原文与候选", reason: "你在生成期间修改了原文，候选仍保留，但不应直接覆盖。", buttonLabel: "比较原文" };
  if (input.outcome === "candidate") return { kind: "review-candidate", title: "审阅这份候选", reason: "候选尚未进入正文，可以采用、再试一稿或保留原文。", buttonLabel: "查看候选" };
  if (input.outcome === "report") return { kind: "continue", title: "把复盘转成下一步", reason: "报告不会改动正文；可以确定下一场计划，或继续当前场景。", buttonLabel: "继续写作" };
  if (!input.hasBody && !input.hasPlan) return { kind: "plan", title: "先确定这一场要发生什么", reason: "只写当前确定的一点，目标和结果都可以稍后再补。", buttonLabel: "填写场景目标" };
  if (!input.hasBody) return { kind: "write", title: "写下第一句", reason: "已有方向，可以从一个动作、一句对白或一个画面开始。", buttonLabel: "开始写作" };
  if (input.lastAction === "accepted") return { kind: "review-scene", title: "看看实际写出了什么", reason: "候选已经采用，可以复盘实际结果与状态变化，再决定下一步。", buttonLabel: "复盘这场" };
  if (input.lastAction === "reviewed") return { kind: "plan", title: "把决定写进下一步计划", reason: "复盘不会自动成为新事实；由你决定下一场目标，或继续当前场景。", buttonLabel: "编辑场景卡" };
  return { kind: "review-scene", title: "先复盘，再继续", reason: "看清当前正文的结果与可能的下一步，避免让模型盲目向前续写。", buttonLabel: "复盘这场" };
}
