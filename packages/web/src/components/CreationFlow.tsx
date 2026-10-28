import { Check, ShieldCheck, Sparkles, UserRound } from "lucide-react";

interface CreationFlowProps {
  hasCards: boolean;
  hasSelection: boolean;
  hasRehearsal: boolean;
}

const steps = [
  { title: "留下起点", human: "选入口、写点子或粘贴片段", ai: "按需补几个方向" },
  { title: "确定方向", human: "选择、改写或保留决定", ai: "生成可比较的短卡" },
  { title: "试写（可选）", human: "判断是否合乎意图", ai: "生成一小段候选" },
  { title: "写入第一场", human: "写作、采用并保存", ai: "按需续写或推敲" },
];

/** 与真实起步状态同步的流程图；不是需要另学的一套工作流编辑器。 */
export function CreationFlow({ hasCards, hasSelection, hasRehearsal }: CreationFlowProps) {
  const current = hasSelection ? 2 : hasCards ? 1 : 0;
  const completed = [hasCards, hasSelection, hasRehearsal, false];
  return (
    <section className="creation-flow" aria-label="从起点到第一场的创作流程">
      <header>
        <div><p className="eyebrow">YOUR FIRST SCENE</p><h2>从起点到第一场，四步就够了。</h2></div>
        <span><ShieldCheck size={14} />不自动跑完整本书</span>
      </header>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title} className={`${index === current ? "current" : ""} ${completed[index] ? "done" : ""}`} aria-current={index === current ? "step" : undefined}>
            <div className="flow-step-title"><span>{completed[index] ? <Check size={13} /> : `0${index + 1}`}</span><strong>{step.title}</strong></div>
            <p><UserRound size={12} /><span><b>你决定</b>{step.human}</span></p>
            <p><Sparkles size={12} /><span><b>AI 协助</b>{step.ai}</span></p>
          </li>
        ))}
      </ol>
      <p className="creation-flow-boundary"><ShieldCheck size={13} />AI 可在当前任务内检索本作品资料并生成候选；跨步骤推进、采用计划、写入正文和确认设定始终由你操作。试写可以跳过，不必完成所有 AI 步骤。</p>
    </section>
  );
}
