import { useEffect, useRef, useState } from "react";
import type { ImportedChapterDraft, IngestPlan, IngestPlanOption, ManuscriptPreview } from "@nova-novel/shared";
import { ArrowRight, CircleAlert, FileUp, LoaderCircle, ShieldCheck, Sparkles, X } from "lucide-react";
import { useDialogKeyboard } from "./useDialogKeyboard";
import { api, type IngestRunView } from "../lib/api";

export interface ImportTarget { projectId: string; title: string; headRevisionId: string }
interface ImportDialogProps {
  aiReady: boolean;
  busy: boolean;
  onCancel: () => void;
  onImport: (input: { title: string; chapters: ImportedChapterDraft[] }) => Promise<ImportTarget | null>;
  onAppend: (input: { projectId: string; baseRevisionId: string; chapters: ImportedChapterDraft[] }) => Promise<{ headRevisionId: string } | null>;
  onProjectCreated: (projectId: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
}

const ABNORMAL_CHAPTER_WORDS = 20_000;
const wordsOf = (chapter: ImportedChapterDraft) => chapter.scenes.reduce((sum, scene) => sum + scene.body.replace(/\s/g, "").length, 0);
const asText = (chapters: ImportedChapterDraft[]) => chapters.map(chapter => `${chapter.title}\n\n${chapter.scenes.map(scene => scene.body).join("\n\n")}`).join("\n\n");

/** 导入整本小说：AI 或本地规则给出分章预览；异常堆积章可以先落盘正常章节，剩余文本继续分并追加到同一作品。 */
export function ImportDialog({ aiReady, busy, onCancel, onImport, onAppend, onProjectCreated, onRefresh }: ImportDialogProps) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [useAi, setUseAi] = useState(aiReady);
  const [preview, setPreview] = useState<ManuscriptPreview | null>(null);
  const [plan, setPlan] = useState<IngestPlan | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<IngestRunView | null>(null);
  const [committing, setCommitting] = useState(false);
  const [target, setTarget] = useState<ImportTarget | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [remainingText, setRemainingText] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<"analyze" | "import" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const pending = busy || working !== null;
  useDialogKeyboard(dialogRef, () => { if (!pending) requestClose(); }, true);

  const firstAbnormal = preview ? preview.chapters.findIndex(chapter => wordsOf(chapter) > ABNORMAL_CHAPTER_WORDS) : -1;
  const abnormal = firstAbnormal >= 0 && preview ? preview.chapters.slice(firstAbnormal) : [];
  const normal = firstAbnormal >= 0 && preview ? preview.chapters.slice(0, firstAbnormal) : [];
  const remainingWords = remainingText.replace(/\s/g, "").length;

  function requestClose() {
    if (remainingText && !confirmDiscard) { setConfirmDiscard(true); return; }
    onCancel();
  }

  const readFile = async (file: File) => {
    setError("");
    try {
      const content = await file.text();
      if (!content.trim()) { setError("文件里没有文字内容"); return; }
      setText(content);
      setPreview(null);
      if (!title) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, "") || file.name);
    } catch { setError("读取文件失败，请重试或直接粘贴正文"); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  };

  const analyze = async (input: string) => {
    if (!input.trim() || pending) return;
    setWorking("analyze");
    setError("");
    try {
      const result = await api.ingestPlan({ text: input, useAi: useAi && aiReady });
      setPlan(result.plan);
      setPreview(result.preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分析未完成，请重试");
    } finally { setWorking(null); }
  };

  /** Agent 方案：进入逐场知识提取运行器。 */
  const startIngest = async () => {
    if (!preview || pending) return;
    setWorking("import");
    setError("");
    try {
      const result = await api.ingestStart({ title: title.trim() || "导入的作品", chapters: preview.chapters });
      await onProjectCreated(result.project.projectId);
      setRunId(result.runId);
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动提取运行");
    } finally { setWorking(null); }
  };

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api.ingestRun(runId);
        if (!stopped) setRun(next);
      } catch { /* 轮询失败时保留上次状态 */ }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [runId]);

  const ingestAction = async (action: "cancel" | "resume" | "discard") => {
    if (!runId) return;
    try {
      const next = await api.ingestAction(runId, action);
      setRun(next);
      if (action === "discard") onCancel();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成"); }
  };

  const commitIngest = async () => {
    if (!runId || committing) return;
    setCommitting(true);
    setError("");
    try {
      await api.ingestCommit(runId, crypto.randomUUID());
      await onRefresh();
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "入库失败，请重试");
    } finally { setCommitting(false); }
  };

  const options: IngestPlanOption[] = plan?.options ?? [
    { id: "fast", title: "仅分章入库", detail: "只整理章节与正文，不额外调用模型，之后可在写作页逐场提取。", steps: [], estimatedCalls: 0, extract: false },
    { id: "standard", title: "分章 + 知识提取", detail: "逐场提取人物/设定、人物关系与状态事件，统一审阅后入库。", steps: [], estimatedCalls: preview?.sceneCount ?? 0, recommended: true, extract: true },
  ];

  /** 落盘一批章节；返回是否成功。 */
  const persist = async (chapters: ImportedChapterDraft[]): Promise<boolean> => {
    setWorking("import");
    setError("");
    try {
      if (!target) {
        const created = await onImport({ title: title.trim() || "导入的作品", chapters });
        if (!created) return false;
        setTarget(created);
      } else {
        const result = await onAppend({ projectId: target.projectId, baseRevisionId: target.headRevisionId, chapters });
        if (!result) return false;
        setTarget({ ...target, headRevisionId: result.headRevisionId });
      }
      setImportedCount(count => count + chapters.length);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "入库失败，请重试");
      return false;
    } finally { setWorking(null); }
  };

  /** 全部章节一次入库，顺序保持原样。 */
  const confirmAll = async () => {
    if (!preview || pending) return;
    if (await persist(preview.chapters)) onCancel();
  };

  /** 先落盘正常章节，剩余异常章文本留待继续分。 */
  const confirmNormal = async () => {
    if (!preview || pending || !normal.length) return;
    if (await persist(normal)) {
      setRemainingText(asText(abnormal));
      setPreview(null);
    }
  };

  const importRemaining = async () => {
    if (!remainingText.trim() || pending) return;
    const chapter: ImportedChapterDraft = { title: "未分章正文", scenes: [{ title: "第一场", body: remainingText.trim() }] };
    if (await persist([chapter])) { setRemainingText(""); onCancel(); }
  };

  const renameChapter = (index: number, value: string) => {
    setPreview(current => current ? { ...current, chapters: current.chapters.map((chapter, i) => i === index ? { ...chapter, title: value } : chapter) } : current);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!pending) requestClose(); }}>
      <section ref={dialogRef} className="new-project-dialog import-dialog" role="dialog" aria-modal="true" aria-label="导入已有小说" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow">BRING YOUR MANUSCRIPT</p><h2>{target ? `继续分章 · ${target.title}` : "导入写到一半的小说"}</h2><p>{target ? `已落盘 ${importedCount} 章，剩余文本继续分析；每次确认都会追加到同一作品。` : "按章节整理成新作品，正文逐字保留，原作品不受影响。"}</p></div>
          <button className="icon-button" disabled={pending} onClick={requestClose} aria-label="关闭"><X size={17} /></button>
        </header>

        {runId && run && run.status !== "review" && (
          <div className="new-project-body">
            <div className="import-continue-panel">
              <strong>正在逐场提取知识 · {run.done.length} / {run.queue.length} 场</strong>
              <p>提取人物/设定、人物关系与状态事件，每场完成即落盘，可暂停后继续。{run.failed.length > 0 ? ` ${run.failed.length} 场失败（续跑会重试）。` : ""}</p>
              <div className="continue-actions">
                {run.status === "running" && <button className="button secondary" onClick={() => void ingestAction("cancel")}>暂停提取</button>}
                {run.status === "paused" && <button className="button primary" onClick={() => void ingestAction("resume")}><ArrowRight size={15} />继续提取</button>}
                <button className="button ghost" onClick={() => void ingestAction("discard")}>放弃并关闭</button>
              </div>
              {run.failed.length > 0 && <p className="inline-note">{run.failed[0]?.error}</p>}
            </div>
          </div>
        )}

        {runId && run && run.status === "review" && (
          <div className="new-project-body">
            <div className="import-preview-summary">
              <strong>提取完成 · {run.done.length} 场</strong>
              <span className="badge violet">待统一审阅</span>
            </div>
            <p className="ingest-review-stats">元素提案 {run.bundles.reduce((sum, bundle) => sum + bundle.newElements.length, 0)} · 事实/关系提案 {run.bundles.reduce((sum, bundle) => sum + bundle.factProposals.length, 0)} · 状态事件提案 {run.bundles.reduce((sum, bundle) => sum + bundle.eventProposals.length, 0)}</p>
            <ul className="import-chapter-list">
              {run.bundles.map(bundle => (
                <li key={bundle.sceneId}>
                  <div className="import-chapter-head"><strong>{bundle.sceneTitle}</strong><span>{bundle.newElements.length} 元素 · {bundle.factProposals.length} 事实 · {bundle.eventProposals.length} 事件</span></div>
                  <ul>
                    {bundle.newElements.slice(0, 3).map(element => <li key={element.proposalId}><span>{element.name}（{element.type}）</span><small>{element.summary.slice(0, 40)}</small></li>)}
                    {bundle.factProposals.slice(0, 3).map(fact => <li key={fact.proposalId}><span>{fact.subjectName} · {fact.predicate}</span><small>{fact.value.slice(0, 40)}</small></li>)}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="continue-actions">
              <button className="button primary" disabled={committing} onClick={() => void commitIngest()}>{committing ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}确认提案并入库</button>
              <button className="button ghost" disabled={committing} onClick={() => void ingestAction("discard")}>放弃提案</button>
            </div>
          </div>
        )}

        {!runId && !preview && !target && (
          <div className="new-project-body">
            <label className="field-label">作品名（可先使用默认名）<input autoFocus data-autofocus value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} placeholder="导入的作品" maxLength={200} /></label>
            <div className="import-source-row">
              <button className="button secondary" disabled={pending} onClick={() => fileRef.current?.click()}><FileUp size={15} />选择 Markdown / TXT 文件</button>
              <input ref={fileRef} type="file" accept=".md,.markdown,.txt" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} />
              <span>{text ? `已读入 ${text.length.toLocaleString("zh-CN")} 字符` : "或在下方粘贴全文"}</span>
            </div>
            <label className="field-label">小说全文<textarea value={text} disabled={pending} onChange={(event) => { setText(event.target.value); }} rows={8} placeholder="把小说全文粘贴到这里。支持“第X章 / 第X卷 / ch-18 / Chapter N / 楔子 / 番外”等章节标题，也支持 Markdown 的 # 与 ## 标记。" /></label>
            <label className={`import-ai-option ${!aiReady ? "disabled" : ""}`}>
              <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady || pending} onChange={(event) => setUseAi(event.target.checked)} />
              <Sparkles size={15} />
              <span><strong>AI 协助分章</strong><small>{aiReady ? "模型只判断哪些是章节标题并规范命名，正文切片在本机完成，不改写你的文字。" : "接入模型后可用；当前将按本地章节标题规则切分。"}</small></span>
            </label>
            <p className="human-confirm-note"><ShieldCheck size={14} />下一步先预览分章结果，确认后才入库；全书正文不会发送给模型改写，只发送疑似标题行及前后摘录。</p>
          </div>
        )}

        {!runId && !preview && target && (
          <div className="new-project-body">
            <div className="import-continue-panel">
              <strong>已落盘 {importedCount} 章到《{target.title}》</strong>
              <p>还剩 {remainingWords.toLocaleString("zh-CN")} 字未分章。继续分析后会先预览，确认才追加；也可以直接把剩余文字作为一章入库。</p>
              <div className="continue-actions">
                <button className="button primary" disabled={pending || !remainingText.trim()} onClick={() => void analyze(remainingText)}>{working === "analyze" ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}继续分析剩余文本</button>
                <button className="button ghost" disabled={pending || !remainingText.trim()} onClick={() => void importRemaining()}>剩余作为一章入库</button>
              </div>
            </div>
          </div>
        )}

        {!runId && preview && (
          <div className="new-project-body import-preview">
            {plan?.analysis && <p className="ingest-analysis"><Sparkles size={15} />{plan.analysis}</p>}
            <div className="ingest-options" role="group" aria-label="选择处理方案">
              {options.map(option => (
                <button key={option.id} className={`ingest-option ${option.recommended ? "recommended" : ""}`} disabled={pending} onClick={() => void (option.extract ? startIngest() : confirmAll())}>
                  <strong>{option.title}{option.recommended ? " · 推荐" : ""}</strong>
                  <small>{option.detail}</small>
                  <span>{option.extract ? `约 ${option.estimatedCalls} 次模型调用` : "不额外调用模型"}</span>
                </button>
              ))}
            </div>
            <div className="import-preview-summary">
              <strong>{preview.chapterCount} 章 · {preview.sceneCount} 场 · {preview.wordCount.toLocaleString("zh-CN")} 字</strong>
              <span className={`badge ${preview.aiUsed ? "violet" : "neutral"}`}>{preview.aiUsed ? "AI 协助分章" : "本地规则分章"}</span>
            </div>
            {preview.warnings.map(warning => <p key={warning} className="inline-note">{warning}</p>)}
            {abnormal.length > 0 && <p className="inline-note"><CircleAlert size={14} />{abnormal.length} 章字数异常堆积（超过 {(ABNORMAL_CHAPTER_WORDS / 10000).toFixed(0)} 万字），通常意味着后面的标题没识别出来。可以先落盘正常章节，剩余文本继续分。</p>}
            <ul className="import-chapter-list">
              {preview.chapters.map((chapter, index) => (
                <li key={index} className={wordsOf(chapter) > ABNORMAL_CHAPTER_WORDS ? "abnormal" : ""}>
                  <div className="import-chapter-head">
                    <input aria-label={`第 ${index + 1} 章标题`} value={chapter.title} disabled={pending} onChange={(event) => renameChapter(index, event.target.value)} maxLength={200} />
                    <span>{chapter.scenes.length} 场 · {wordsOf(chapter).toLocaleString("zh-CN")} 字</span>
                  </div>
                  <ul>{chapter.scenes.map((scene, sceneIndex) => <li key={sceneIndex}><span>{scene.title}</span><small>{scene.body.replace(/\s/g, "").length.toLocaleString("zh-CN")} 字</small></li>)}</ul>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="inline-note error" role="alert">{error}</p>}
        {confirmDiscard && remainingText && (
          <p className="inline-note error" role="alert">还有 {remainingWords.toLocaleString("zh-CN")} 字未入库。
            <button className="text-button" disabled={pending} onClick={() => void importRemaining()}>剩余作为一章入库</button>
            <button className="text-button" disabled={pending} onClick={onCancel}>丢弃剩余并关闭</button>
          </p>
        )}

        <footer>
          {!preview && !target && (
            <>
              <span>{useAi && aiReady ? "AI 判断章节边界，本机完成切片" : "按章节标题自动切分"}</span>
              <button className="button primary" disabled={!text.trim() || pending} onClick={() => void analyze(text)}>{working === "analyze" ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{working === "analyze" ? "正在分析章节…" : "分析并预览分章"}</button>
            </>
          )}
          {!runId && !preview && target && <span>确认无误的章节已落盘，可分批继续，不必一次分完。</span>}
          {!runId && preview && (
            <>
              <button className="button ghost" disabled={pending} onClick={() => setPreview(null)}>返回修改原文</button>
              <div className="continue-actions">
                {abnormal.length > 0 && normal.length > 0 && <button className="button secondary" disabled={pending} onClick={() => void confirmNormal()}>{working === "import" ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}先落盘 {normal.length} 章，剩余继续分</button>}
                <button className="button primary" disabled={pending || !preview.chapterCount} onClick={() => void confirmAll()}>{working === "import" ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{target ? "确认并追加到作品" : "确认分章并导入新作品"}</button>
              </div>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
