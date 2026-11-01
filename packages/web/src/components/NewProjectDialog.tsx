import { useRef, useState } from "react";
import { useDialogKeyboard } from "./useDialogKeyboard";
import { ArrowRight, ClipboardPaste, FileUp, Lightbulb, LoaderCircle, PenLine, ShieldCheck, X } from "lucide-react";

export interface NewProjectInput {
  title: string;
  premise: string;
  body: string;
  destination: "start" | "write";
}

interface NewProjectDialogProps {
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: NewProjectInput) => Promise<boolean>;
  onOpenImport: () => void;
}

type EntryMode = "idea" | "paste" | "blank";

const entries: Array<{ id: EntryMode; title: string; detail: string; icon: typeof Lightbulb }> = [
  { id: "idea", title: "我有一个模糊点子", detail: "先保存这句话，再从几个方向里选择", icon: Lightbulb },
  { id: "paste", title: "我已有片段", detail: "粘贴后直接保存为第一场，不要求先整理设定", icon: ClipboardPaste },
  { id: "blank", title: "我想从空白直接写", detail: "建立空白第一场，写作提示可选、可跳过", icon: PenLine },
];

export function NewProjectDialog({ busy, onCancel, onCreate, onOpenImport }: NewProjectDialogProps) {
  const [mode, setMode] = useState<EntryMode>("idea");
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = busy || saving;
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeyboard(dialogRef, () => { if (!pending) onCancel(); });
  const valid = mode === "idea" ? premise.trim().length > 0 : mode === "paste" ? body.trim().length > 0 : true;

  const submit = async () => {
    if (!valid || pending) return;
    setSaving(true);
    setError("");
    try {
      const created = await onCreate({
        title: title.trim() || "未命名作品",
        premise: mode === "idea" ? premise.trim() : "",
        body: mode === "paste" ? body.trim() : "",
        destination: mode === "idea" ? "start" : "write",
      });
      if (created) onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "作品尚未创建，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!pending) onCancel(); }}>
      <section ref={dialogRef} className="new-project-dialog" role="dialog" aria-modal="true" aria-label="新建自己的作品" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">A STORY OF YOUR OWN</p><h2>新建自己的作品</h2><p>不用先想好书名、题材或整个世界。选择最像你现在状态的一种起点。</p></div><button className="icon-button" disabled={pending} onClick={onCancel} aria-label="关闭"><X size={17} /></button></header>
        <div className="new-project-body">
          <div className="entry-mode-grid" role="group" aria-label="选择创作起点">
            {entries.map((entry) => <button key={entry.id} className={mode === entry.id ? "active" : ""} disabled={pending} onClick={() => { setMode(entry.id); setError(""); }}><entry.icon size={18} /><span><strong>{entry.title}</strong><small>{entry.detail}</small></span></button>)}
            <button disabled={pending} onClick={onOpenImport}><FileUp size={18} /><span><strong>导入已有小说</strong><small>整本 Markdown/TXT 按章节入库，可用 AI 协助分章</small></span></button>
          </div>
          <label className="field-label">作品名（可先使用默认名）<input autoFocus data-autofocus value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} placeholder="未命名作品" maxLength={200} /></label>
          {mode === "idea" && <label className="field-label">你的点子<textarea value={premise} disabled={pending} onChange={(event) => setPremise(event.target.value)} rows={4} placeholder="一句话、一个人物，或者一个画面……" /></label>}
          {mode === "paste" && <label className="field-label">已有片段<textarea value={body} disabled={pending} onChange={(event) => setBody(event.target.value)} rows={8} placeholder="把已经写下的正文粘贴到这里。它只会保存到你的本机作品中。" /></label>}
          {mode === "blank" && <div className="blank-entry-note"><PenLine size={17} /><p>下一步会出现一张空白纸和三个可选问题。你可以直接写，也可以先让 AI 给几个方向。</p></div>}
          <p className="human-confirm-note"><ShieldCheck size={14} />这里由你决定。AI 不会自动创建作品、粘贴内容或覆盖已有正文。</p>
          {error && <p className="inline-note error" role="alert">{error}</p>}
        </div>
        <footer><span>{mode === "idea" ? "创建后进入四步创作流程" : mode === "paste" ? "片段会保存为第一场正文" : "创建后即可直接写作"}</span><button className="button primary" disabled={!valid || pending} onClick={() => void submit()}>{pending ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{mode === "idea" ? "创建并继续找方向" : mode === "paste" ? "保存为第一场" : "创建空白第一场"}</button></footer>
      </section>
    </div>
  );
}
