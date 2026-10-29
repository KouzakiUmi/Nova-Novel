import { useMemo, useState } from "react";
import type { Scene, WorkspaceSnapshot } from "@nova-novel/shared";
import type { LastRequest } from "./EditorView";
import { analyzeRevisionText } from "@nova-novel/shared";
import { ArrowRight, CheckCircle2, Highlighter, MessageSquareText, ScanText, WandSparkles } from "lucide-react";
import { ScenePanel } from "./EditorView";

interface RevisionPanelProps {
  snapshot: WorkspaceSnapshot;
  scene: Scene;
  body: string;
  hasSelection: boolean;
  onSceneSave: (scene: Scene) => Promise<void>;
  onGenerate: (request: LastRequest) => void;
  onPolish: (mode: "tighten" | "expand", intent?: string) => void;
  onOpenAnnotations: () => void;
  onTaskNote: (message: string) => void;
}

export function RevisionPanel({ snapshot, scene, body, hasSelection, onSceneSave, onGenerate, onPolish, onOpenAnnotations, onTaskNote }: RevisionPanelProps) {
  const [mode, setMode] = useState<"structure" | "language">("structure");
  const [styleIntent, setStyleIntent] = useState("");
  const insights = useMemo(() => analyzeRevisionText(body), [body]);
  return (
    <div className="side-panel-content revision-panel">
      <div className="revision-mode-switch" role="tablist" aria-label="修订层级"><button className={mode === "structure" ? "active" : ""} onClick={() => setMode("structure")}><ScanText size={14} />结构修订</button><button className={mode === "language" ? "active" : ""} onClick={() => setMode("language")}><Highlighter size={14} />语言修订</button></div>
      {mode === "structure" ? <>
        <p className="eyebrow">STORY BEFORE SENTENCES</p><h3>先处理故事结构</h3><p className="panel-description">先确认人物目标、阻碍、实际结果和下一步决定，再处理句子。计划与事实保持分开。</p>
        <ScenePanel scene={scene} onSave={onSceneSave} />
        <button className="button secondary full" onClick={() => onGenerate({ kind: "consistency", label: "结构复盘", input: "只检查当前场景的结构与人物动机：目标是否清楚、阻碍是否具体、实际结果是否由行动造成、下一步决定是否自然。区分正文明确事实与未知缺口，不修改正文，不评价文笔，不强迫灾难或反转。" })}><CheckCircle2 size={14} />检查结构与动机<ArrowRight size={13} /></button>
      </> : <>
        <p className="eyebrow">LANGUAGE WITH EVIDENCE</p><h3>再处理具体表达</h3><p className="panel-description">以下是可解释的文本观察，不是评分。重复和短段可以有意使用，是否需要修改由你决定。</p>
        <div className="revision-metrics"><div><strong>{insights.paragraphCount}</strong><span>段落</span></div><div><strong>{insights.sentenceCount}</strong><span>句子</span></div><div><strong>{insights.averageSentenceLength}</strong><span>平均句长</span></div><div><strong>{insights.shortParagraphRatio}%</strong><span>短段比例</span></div></div>
        <section className="revision-repeat"><h4>重复开头</h4>{insights.repeatedStarts.length ? <div className="repeat-chips">{insights.repeatedStarts.map(item => <span key={item.text}>{item.text}… × {item.count}</span>)}</div> : <p className="quiet-empty">没有发现连续重复的四字开头。</p>}</section>
        <label className="field-label">本次表达意图<textarea rows={2} value={styleIntent} onChange={event => setStyleIntent(event.target.value)} placeholder="例如：保留克制对白，减少解释性情绪，不统一改成短句。" /></label>
        <div className="revision-actions"><button className="button secondary" disabled={!hasSelection} onClick={() => hasSelection ? onPolish("tighten", styleIntent) : onTaskNote("先在正文里选中要推敲的一段，再处理表达。")}><Highlighter size={14} />推敲选区</button><button className="button ghost" disabled={!hasSelection} onClick={() => hasSelection ? onPolish("expand", styleIntent) : onTaskNote("先在正文里选中想扩写的一段。")}><WandSparkles size={14} />扩写选区</button><button className="button ghost" onClick={() => onGenerate({ kind: "consistency", label: "重复与节奏检查", input: `只检查重复表达与节奏，不改正文：${JSON.stringify(insights)}。结合作者意图判断是否值得调整，不把所有重复或短段判为问题。作者意图：${styleIntent || "未指定"}` })}><ScanText size={14} />检查重复与节奏</button></div>
        <button className="text-button" onClick={onOpenAnnotations}><MessageSquareText size={13} />查看这场批注<ArrowRight size={12} /></button>
      </>}
    </div>
  );
}
