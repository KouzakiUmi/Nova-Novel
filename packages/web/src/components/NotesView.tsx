import { useMemo, useState } from "react";
import type { AuthorNote, WorkspaceSnapshot } from "@nova-novel/shared";
import { Archive, ArrowRight, Check, FilePlus2, Link2, LoaderCircle, Plus, RotateCcw, Search, StickyNote } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

export function NotesView({ snapshot, onChanged, onOpenScene }: { snapshot: WorkspaceSnapshot; onChanged: () => Promise<unknown>; onOpenScene: (sceneId: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "inbox" | "linked" | "archived" | "all">("active");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const notes = useMemo(() => snapshot.notes.filter(note => (filter === "all" || (filter === "active" ? note.status !== "archived" : note.status === filter)) && `${note.title}${note.body}${note.tags.join(" ")}`.includes(query)), [snapshot.notes, filter, query]);

  const create = async () => {
    if (!title.trim()) { setError("先写一个便签标题，内容可以稍后补。"); return; }
    setCreating(true); setError("");
    try {
      await api.createNote({ projectId: snapshot.activeProject.projectId, title: title.trim(), body });
      setTitle(""); setBody("");
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "便签保存失败"); }
    finally { setCreating(false); }
  };

  return (
    <div className="notes-page page-scroll">
      <header className="page-toolbar"><div><p className="eyebrow">IDEAS BEFORE STRUCTURE</p><h1>创作便签</h1><p>先收下人物、画面、疑问和一句话。便签不会自动成为正文或设定，只有明确转为场景时才进入作品。</p></div><Badge tone="green">{snapshot.notes.filter(note => note.status !== "archived").length} 条未归档</Badge></header>
      <section className="note-composer">
        <div className="note-composer-heading"><StickyNote size={18} /><div><strong>记下一个想法</strong><p>不必完整，也不必现在决定它属于哪一场。</p></div></div>
        <input aria-label="新便签标题" value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：父亲其实早已知道收据的来历" />
        <textarea aria-label="新便签内容" value={body} onChange={event => setBody(event.target.value)} rows={3} placeholder="补充一个画面、疑问、对白或暂时不想忘记的细节……" />
        <div className="note-composer-actions"><span>只保存为想法，不进入 RAG 或正文</span><button className="button primary" disabled={creating} onClick={() => void create()}>{creating ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}收下便签</button></div>
      </section>
      <div className="notes-toolbar"><label className="element-search"><Search size={14} /><input aria-label="搜索便签" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索想法、对白或标签" /></label><select aria-label="筛选便签" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="active">未归档</option><option value="inbox">仅想法</option><option value="linked">已关联</option><option value="archived">已归档</option><option value="all">全部</option></select></div>
      {error && <p className="inline-note error">{error}</p>}
      {notes.length === 0 ? <div className="empty-state"><StickyNote size={28} /><h3>这里还没有便签</h3><p>把尚未成形的想法先放在这里，之后再整理成场景或关联元素。</p></div> : <div className="notes-grid">{notes.map(note => <NoteCard key={`${note.noteId}:${note.updatedAt}`} note={note} snapshot={snapshot} onChanged={onChanged} onOpenScene={onOpenScene} />)}</div>}
    </div>
  );
}

function NoteCard({ note, snapshot, onChanged, onOpenScene }: { note: AuthorNote; snapshot: WorkspaceSnapshot; onChanged: () => Promise<unknown>; onOpenScene: (sceneId: string) => void }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(", "));
  const [sceneId, setSceneId] = useState(note.sceneId ?? "");
  const [elementId, setElementId] = useState(note.elementId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成"); }
    finally { setBusy(false); }
  };
  const save = () => run(() => api.updateNote(note.noteId, { title: title.trim(), body, sceneId: sceneId || null, elementId: elementId || null, tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }));
  return (
    <article className={`note-card ${note.status === "archived" ? "archived" : ""}`}>
      <div className="note-card-heading"><Badge tone={note.status === "linked" ? "green" : note.status === "archived" ? "neutral" : "amber"}>{note.status === "linked" ? "已关联" : note.status === "archived" ? "已归档" : "想法"}</Badge><span>{new Date(note.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
      <input className="note-title-input" aria-label="便签标题" value={title} disabled={busy || note.status === "archived"} onChange={event => setTitle(event.target.value)} />
      <textarea aria-label="便签内容" value={body} disabled={busy || note.status === "archived"} onChange={event => setBody(event.target.value)} rows={4} />
      <label>标签<input aria-label="便签标签" value={tags} disabled={busy || note.status === "archived"} onChange={event => setTags(event.target.value)} placeholder="人物, 收据, 待定" /></label>
      <div className="note-link-grid">
        <label>关联场景<select aria-label="便签关联场景" value={sceneId} disabled={busy || note.status === "archived"} onChange={event => setSceneId(event.target.value)}><option value="">不关联</option>{snapshot.scenes.map(scene => <option key={scene.sceneId} value={scene.sceneId}>{scene.title}</option>)}</select></label>
        <label>关联元素<select aria-label="便签关联元素" value={elementId} disabled={busy || note.status === "archived"} onChange={event => setElementId(event.target.value)}><option value="">不关联</option>{snapshot.elements.map(element => <option key={element.entityId} value={element.entityId}>{element.name}</option>)}</select></label>
      </div>
      {error && <p className="inline-note error">{error}</p>}
      <div className="note-card-actions">
        {note.status !== "archived" && <button className="button ghost small" disabled={busy || !title.trim()} onClick={() => void save()}><Check size={13} />保存</button>}
        {note.sceneId ? <button className="button secondary small" onClick={() => onOpenScene(note.sceneId!)}><Link2 size={13} />打开场景<ArrowRight size={12} /></button> : note.status !== "archived" && <button className="button secondary small" disabled={busy || !title.trim()} onClick={() => void run(async () => { await save(); const result = await api.promoteNote(note.noteId); onOpenScene(result.scene.sceneId); })}><FilePlus2 size={13} />转为场景</button>}
        {note.status !== "archived" ? <button className="icon-button" aria-label="归档便签" title="归档" disabled={busy} onClick={() => void run(() => api.archiveNote(note.noteId))}><Archive size={14} /></button> : <button className="button ghost small" disabled={busy} onClick={() => void run(() => api.updateNote(note.noteId, { status: "inbox" }))}><RotateCcw size={13} />恢复</button>}
      </div>
    </article>
  );
}
