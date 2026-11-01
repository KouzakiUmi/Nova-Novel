import { useRef, useState } from "react";
import type { ImportedChapterDraft, ManuscriptPreview } from "@nova-novel/shared";
import { ArrowRight, FileUp, LoaderCircle, ShieldCheck, Sparkles, X } from "lucide-react";
import { useDialogKeyboard } from "./useDialogKeyboard";
import { api } from "../lib/api";

interface ImportDialogProps {
  aiReady: boolean;
  busy: boolean;
  onCancel: () => void;
  onImport: (input: { title: string; chapters: ImportedChapterDraft[] }) => Promise<boolean>;
}

/** 导入整本小说：AI 或本地规则给出分章预览，作者确认后才创建新作品；原作品不被覆盖。 */
export function ImportDialog({ aiReady, busy, onCancel, onImport }: ImportDialogProps) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [useAi, setUseAi] = useState(aiReady);
  const [preview, setPreview] = useState<ManuscriptPreview | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<"analyze" | "import" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const pending = busy || working !== null;
  useDialogKeyboard(dialogRef, () => { if (!pending) onCancel(); }, true);

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

  const analyze = async () => {
    if (!text.trim() || pending) return;
    setWorking("analyze");
    setError("");
    try {
      const result = await api.analyzeImport({ text, useAi: useAi && aiReady });
      setPreview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分析未完成，请重试");
    } finally { setWorking(null); }
  };

  const confirm = async () => {
    if (!preview || pending) return;
    setWorking("import");
    setError("");
    try {
      const created = await onImport({ title: title.trim() || "导入的作品", chapters: preview.chapters });
      if (created) onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败，请重试");
    } finally { setWorking(null); }
  };

  const renameChapter = (index: number, value: string) => {
    setPreview(current => current ? { ...current, chapters: current.chapters.map((chapter, i) => i === index ? { ...chapter, title: value } : chapter) } : current);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!pending) onCancel(); }}>
      <section ref={dialogRef} className="new-project-dialog import-dialog" role="dialog" aria-modal="true" aria-label="导入已有小说" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow">BRING YOUR MANUSCRIPT</p><h2>导入写到一半的小说</h2><p>按章节整理成新作品，正文逐字保留，原作品不受影响。</p></div>
          <button className="icon-button" disabled={pending} onClick={onCancel} aria-label="关闭"><X size={17} /></button>
        </header>

        {!preview ? (
          <div className="new-project-body">
            <label className="field-label">作品名（可先使用默认名）<input autoFocus data-autofocus value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} placeholder="导入的作品" maxLength={200} /></label>
            <div className="import-source-row">
              <button className="button secondary" disabled={pending} onClick={() => fileRef.current?.click()}><FileUp size={15} />选择 Markdown / TXT 文件</button>
              <input ref={fileRef} type="file" accept=".md,.markdown,.txt" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} />
              <span>{text ? `已读入 ${text.length.toLocaleString("zh-CN")} 字符` : "或在下方粘贴全文"}</span>
            </div>
            <label className="field-label">小说全文<textarea value={text} disabled={pending} onChange={(event) => { setText(event.target.value); }} rows={8} placeholder="把小说全文粘贴到这里。支持“第X章 / 第X卷 / Chapter N / 楔子 / 番外”等章节标题，也支持 Markdown 的 # 与 ## 标记。" /></label>
            <label className={`import-ai-option ${!aiReady ? "disabled" : ""}`}>
              <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady || pending} onChange={(event) => setUseAi(event.target.checked)} />
              <Sparkles size={15} />
              <span><strong>AI 协助分章</strong><small>{aiReady ? "模型只判断哪些是章节标题并规范命名，正文切片在本机完成，不改写你的文字。" : "接入模型后可用；当前将按本地章节标题规则切分。"}</small></span>
            </label>
            <p className="human-confirm-note"><ShieldCheck size={14} />下一步先预览分章结果，确认后才入库；全书正文不会发送给模型改写，只发送疑似标题行及前后摘录。</p>
            {error && <p className="inline-note error" role="alert">{error}</p>}
          </div>
        ) : (
          <div className="new-project-body import-preview">
            <div className="import-preview-summary">
              <strong>{preview.chapterCount} 章 · {preview.sceneCount} 场 · {preview.wordCount.toLocaleString("zh-CN")} 字</strong>
              <span className={`badge ${preview.aiUsed ? "violet" : "neutral"}`}>{preview.aiUsed ? "AI 协助分章" : "本地规则分章"}</span>
            </div>
            {preview.warnings.map(warning => <p key={warning} className="inline-note">{warning}</p>)}
            <ul className="import-chapter-list">
              {preview.chapters.map((chapter, index) => (
                <li key={index}>
                  <div className="import-chapter-head">
                    <input aria-label={`第 ${index + 1} 章标题`} value={chapter.title} disabled={pending} onChange={(event) => renameChapter(index, event.target.value)} maxLength={200} />
                    <span>{chapter.scenes.length} 场 · {chapter.scenes.reduce((sum, scene) => sum + scene.body.replace(/\s/g, "").length, 0).toLocaleString("zh-CN")} 字</span>
                  </div>
                  <ul>{chapter.scenes.map((scene, sceneIndex) => <li key={sceneIndex}><span>{scene.title}</span><small>{scene.body.replace(/\s/g, "").length.toLocaleString("zh-CN")} 字</small></li>)}</ul>
                </li>
              ))}
            </ul>
            {error && <p className="inline-note error" role="alert">{error}</p>}
          </div>
        )}

        <footer>
          {preview ? (
            <>
              <button className="button ghost" disabled={pending} onClick={() => setPreview(null)}>返回修改原文</button>
              <button className="button primary" disabled={pending || !preview.chapterCount} onClick={() => void confirm()}>{working === "import" ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}确认分章并导入新作品</button>
            </>
          ) : (
            <>
              <span>{useAi && aiReady ? "AI 判断章节边界，本机完成切片" : "按章节标题自动切分"}</span>
              <button className="button primary" disabled={!text.trim() || pending} onClick={() => void analyze()}>{working === "analyze" ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{working === "analyze" ? "正在分析章节…" : "分析并预览分章"}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
