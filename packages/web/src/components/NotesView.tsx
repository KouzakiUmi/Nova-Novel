import { useMemo, useRef, useState } from "react";
import type { AuthorNote, ElementDesignCard, NoteIncubateResult, NoteIncubateTarget, SceneProposalCard, WorkspaceSnapshot } from "@nova-novel/shared";
import { Archive, ArrowRight, Check, FilePlus2, Link2, LoaderCircle, Plus, RotateCcw, Search, Sparkles, StickyNote } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";

export function NotesView({
  snapshot,
  onChanged,
  onOpenScene,
}: {
  snapshot: WorkspaceSnapshot;
  onChanged: () => Promise<unknown>;
  onOpenScene: (sceneId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "inbox" | "linked" | "archived" | "all">("active");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  // 多便签 AI 孵化器状态
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [incubateTarget, setIncubateTarget] = useState<NoteIncubateTarget>("character");
  const [incubatePrompt, setIncubatePrompt] = useState("");
  const [incubateBusy, setIncubateBusy] = useState(false);
  const [incubateResult, setIncubateResult] = useState<NoteIncubateResult | null>(null);
  const [editableElementCard, setEditableElementCard] = useState<ElementDesignCard | null>(null);
  const [editableSceneCards, setEditableSceneCards] = useState<SceneProposalCard[]>([]);

  const notes = useMemo(
    () =>
      snapshot.notes.filter(
        (note) =>
          (filter === "all" || (filter === "active" ? note.status !== "archived" : note.status === filter)) &&
          `${note.title}${note.body}${note.tags.join(" ")}`.includes(query),
      ),
    [snapshot.notes, filter, query],
  );

  const create = async () => {
    if (!title.trim()) {
      setError("先写一个便签标题，内容可以稍后补。");
      return;
    }
    setCreating(true);
    setError("");
    setStatusMsg("");
    try {
      await api.createNote({ projectId: snapshot.activeProject.projectId, title: title.trim(), body });
      setTitle("");
      setBody("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "便签保存失败");
    } finally {
      setCreating(false);
    }
  };

  const toggleSelectNote = (noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : prev.length < 5 ? [...prev, noteId] : prev,
    );
  };

  const runIncubate = async () => {
    if (incubateBusy || selectedNoteIds.length === 0) return;
    setIncubateBusy(true);
    setError("");
    setStatusMsg("");
    try {
      const result = await api.incubateNotes({
        projectId: snapshot.activeProject.projectId,
        noteIds: selectedNoteIds,
        targetKind: incubateTarget,
        ...(incubatePrompt.trim() ? { prompt: incubatePrompt.trim() } : {}),
      });
      setIncubateResult(result);
      setEditableElementCard(result.elementCards?.[0] ?? null);
      setEditableSceneCards(result.sceneCards ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "多便签 AI 孵化失败");
    } finally {
      setIncubateBusy(false);
    }
  };

  const applyIncubation = async () => {
    if (!incubateResult || incubateBusy) return;
    setIncubateBusy(true);
    setError("");
    setStatusMsg("");
    try {
      const head = snapshot.branches.find((b) => b.branchId === snapshot.activeProject.activeBranchId)?.headRevisionId ?? "";
      const applied = await api.applyNoteIncubation({
        projectId: snapshot.activeProject.projectId,
        noteIds: incubateResult.noteIds,
        targetKind: incubateResult.targetKind,
        baseRevisionId: head,
        acceptanceId: `incubate_${incubateResult.artifactId}`,
        ...(editableElementCard ? { elementCard: editableElementCard } : {}),
        ...(editableSceneCards.length ? { sceneCards: editableSceneCards } : {}),
      });
      await onChanged();
      setIncubateResult(null);
      setSelectedNoteIds([]);
      setStatusMsg(
        applied.entity
          ? `已将便签孵化为元素「${applied.entity.name}」并自动建立关联`
          : `已将便签孵化为 ${applied.scenes?.length ?? 1} 张场景卡并自动关联`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "采用孵化提案失败");
    } finally {
      setIncubateBusy(false);
    }
  };

  return (
    <div className="notes-page page-scroll">
      <header className="page-toolbar">
        <div>
          <p className="eyebrow">IDEAS BEFORE STRUCTURE</p>
          <h1>创作便签</h1>
          <p>先收下人物、画面、疑问和一句话。便签不会自动成为正文或设定，只有明确转为场景或孵化采用时才进入作品。</p>
        </div>
        <Badge tone="green">{snapshot.notes.filter((note) => note.status !== "archived").length} 条未归档</Badge>
      </header>
      <section className="note-composer">
        <div className="note-composer-heading">
          <StickyNote size={18} />
          <div>
            <strong>记下一个想法</strong>
            <p>不必完整，也不必现在决定它属于哪一场。</p>
          </div>
        </div>
        <input
          aria-label="新便签标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：父亲其实早已知道收据的来历"
        />
        <textarea
          aria-label="新便签内容"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          placeholder="补充一个画面、疑问、对白或暂时不想忘记的细节……"
        />
        <div className="note-composer-actions">
          <span>只保存为想法，不进入 RAG 或正文</span>
          <button className="button primary" disabled={creating} onClick={() => void create()}>
            {creating ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
            收下便签
          </button>
        </div>
      </section>

      {selectedNoteIds.length > 0 && (
        <section className="note-composer" style={{ marginBottom: 14 }} aria-label="多便签AI孵化器">
          <div className="note-composer-heading">
            <Sparkles size={18} />
            <div>
              <strong>多便签 AI 孵化器（已选 {selectedNoteIds.length} / 5 条便签）</strong>
              <p>将零散便签整合孵化为角色设定卡、世界观规则卡或串联场景卡。</p>
            </div>
            <button className="button ghost small" onClick={() => setSelectedNoteIds([])}>
              清空选择
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr auto", gap: 8, alignItems: "center" }}>
            <select
              aria-label="便签孵化目标类型"
              value={incubateTarget}
              disabled={incubateBusy}
              onChange={(e) => setIncubateTarget(e.target.value as NoteIncubateTarget)}
            >
              <option value="character">孵化为角色设定卡</option>
              <option value="world">孵化为世界观/规则设定</option>
              <option value="scenes">孵化为串联场景卡</option>
            </select>
            <input
              aria-label="便签孵化补充要求"
              value={incubatePrompt}
              disabled={incubateBusy}
              onChange={(e) => setIncubatePrompt(e.target.value)}
              placeholder="可选：补充整合方向（如：让这几条线索指向同一个神秘顾客）"
            />
            <button className="button primary" disabled={incubateBusy} onClick={() => void runIncubate()}>
              {incubateBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
              开始 AI 孵化
            </button>
          </div>

          {incubateResult && editableElementCard && (
            <div className="fact-card" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <strong>孵化元素提案：{editableElementCard.name}</strong>
              <input
                aria-label="孵化元素名称"
                value={editableElementCard.name}
                onChange={(e) => setEditableElementCard({ ...editableElementCard, name: e.target.value })}
              />
              <textarea
                aria-label="孵化元素简介"
                rows={3}
                value={editableElementCard.summary}
                onChange={(e) => setEditableElementCard({ ...editableElementCard, summary: e.target.value })}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="button ghost small" onClick={() => setIncubateResult(null)}>
                  取消
                </button>
                <button className="button primary small" disabled={incubateBusy} onClick={() => void applyIncubation()}>
                  <Check size={13} />
                  确认入库并关联所选便签
                </button>
              </div>
            </div>
          )}

          {incubateResult && editableSceneCards.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {editableSceneCards.map((sc, idx) => (
                <div key={sc.proposalId} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <strong>孵化场景提案 {idx + 1}</strong>
                  <input
                    aria-label={`孵化场景标题 ${idx + 1}`}
                    value={sc.title}
                    onChange={(e) =>
                      setEditableSceneCards((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, title: e.target.value } : item)),
                      )
                    }
                  />
                  <textarea
                    aria-label={`孵化场景摘要 ${idx + 1}`}
                    rows={2}
                    value={sc.summary}
                    onChange={(e) =>
                      setEditableSceneCards((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, summary: e.target.value } : item)),
                      )
                    }
                  />
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="button ghost small" onClick={() => setIncubateResult(null)}>
                  取消
                </button>
                <button className="button primary small" disabled={incubateBusy} onClick={() => void applyIncubation()}>
                  <Check size={13} />
                  确认转为场景并关联便签
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="notes-toolbar">
        <label className="element-search">
          <Search size={14} />
          <input
            aria-label="搜索便签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索想法、对白或标签"
          />
        </label>
        <select
          aria-label="筛选便签"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="active">未归档</option>
          <option value="inbox">仅想法</option>
          <option value="linked">已关联</option>
          <option value="archived">已归档</option>
          <option value="all">全部</option>
        </select>
      </div>
      {error && <p className="inline-note error">{error}</p>}
      {statusMsg && (
        <p className="inline-note" role="status">
          <Check size={13} />
          {statusMsg}
        </p>
      )}
      {notes.length === 0 ? (
        <div className="empty-state">
          <StickyNote size={28} />
          <h3>这里还没有便签</h3>
          <p>把尚未成形的想法先放在这里，之后再整理成场景或关联元素。</p>
        </div>
      ) : (
        <div className="notes-grid">
          {notes.map((note) => (
            <NoteCard
              key={`${note.noteId}:${note.updatedAt}`}
              note={note}
              snapshot={snapshot}
              selectedForIncubate={selectedNoteIds.includes(note.noteId)}
              onToggleIncubate={() => toggleSelectNote(note.noteId)}
              onChanged={onChanged}
              onOpenScene={onOpenScene}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteCard({
  note,
  snapshot,
  selectedForIncubate,
  onToggleIncubate,
  onChanged,
  onOpenScene,
}: {
  note: AuthorNote;
  snapshot: WorkspaceSnapshot;
  selectedForIncubate: boolean;
  onToggleIncubate: () => void;
  onChanged: () => Promise<unknown>;
  onOpenScene: (sceneId: string) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(", "));
  const [sceneId, setSceneId] = useState(note.sceneId ?? "");
  const [elementId, setElementId] = useState(note.elementId ?? "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const save = () =>
    api.updateNote(note.noteId, {
      title: title.trim(),
      body,
      sceneId: sceneId || null,
      elementId: elementId || null,
      tags: tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  return (
    <article className={`note-card ${note.status === "archived" ? "archived" : ""}`}>
      <div className="note-card-heading">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {note.status !== "archived" && (
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                aria-label={`选择便签 ${note.title} 进行AI孵化`}
                checked={selectedForIncubate}
                onChange={onToggleIncubate}
              />
              AI孵化
            </label>
          )}
          <Badge tone={note.status === "linked" ? "green" : note.status === "archived" ? "neutral" : "amber"}>
            {note.status === "linked" ? "已关联" : note.status === "archived" ? "已归档" : "想法"}
          </Badge>
        </div>
        <span>
          {new Date(note.updatedAt).toLocaleString("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <input
        className="note-title-input"
        aria-label="便签标题"
        value={title}
        disabled={busy || note.status === "archived"}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        aria-label="便签内容"
        value={body}
        disabled={busy || note.status === "archived"}
        onChange={(event) => setBody(event.target.value)}
        rows={4}
      />
      <label>
        标签
        <input
          aria-label="便签标签"
          value={tags}
          disabled={busy || note.status === "archived"}
          onChange={(event) => setTags(event.target.value)}
          placeholder="人物, 收据, 待定"
        />
      </label>
      <div className="note-link-grid">
        <label>
          关联场景
          <select
            aria-label="便签关联场景"
            value={sceneId}
            disabled={busy || note.status === "archived"}
            onChange={(event) => setSceneId(event.target.value)}
          >
            <option value="">不关联</option>
            {snapshot.scenes.map((scene) => (
              <option key={scene.sceneId} value={scene.sceneId}>
                {scene.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          关联元素
          <select
            aria-label="便签关联元素"
            value={elementId}
            disabled={busy || note.status === "archived"}
            onChange={(event) => setElementId(event.target.value)}
          >
            <option value="">不关联</option>
            {snapshot.elements.map((element) => (
              <option key={element.entityId} value={element.entityId}>
                {element.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="inline-note error">{error}</p>}
      <div className="note-card-actions">
        {note.status !== "archived" && (
          <button className="button ghost small" disabled={busy || !title.trim()} onClick={() => void run(save)}>
            <Check size={13} />
            保存
          </button>
        )}
        {note.sceneId ? (
          <button className="button secondary small" onClick={() => onOpenScene(note.sceneId!)}>
            <Link2 size={13} />
            打开场景
            <ArrowRight size={12} />
          </button>
        ) : (
          note.status !== "archived" && (
            <button
              className="button secondary small"
              disabled={busy || !title.trim()}
              onClick={() =>
                void run(async () => {
                  await save();
                  const result = await api.promoteNote(note.noteId);
                  onOpenScene(result.scene.sceneId);
                })
              }
            >
              <FilePlus2 size={13} />
              转为场景
            </button>
          )
        )}
        {note.status !== "archived" ? (
          <button
            className="icon-button"
            aria-label="归档便签"
            title="归档"
            disabled={busy}
            onClick={() => void run(() => api.archiveNote(note.noteId))}
          >
            <Archive size={14} />
          </button>
        ) : (
          <button
            className="button ghost small"
            disabled={busy}
            onClick={() => void run(() => api.updateNote(note.noteId, { status: "inbox" }))}
          >
            <RotateCcw size={13} />
            恢复
          </button>
        )}
      </div>
    </article>
  );
}
