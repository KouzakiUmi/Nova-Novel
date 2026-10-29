import { useEffect, useMemo, useRef, useState } from "react";
import type { Revision, WorkspaceSnapshot } from "@nova-novel/shared";
import {
  Archive,
  ArrowRight,
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Columns2,
  FileClock,
  GitBranch,
  History,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Download,
  Upload,
  FileJson2,
} from "lucide-react";
import { Badge } from "./UI";
import { InteractionReplay } from "./InteractionReplay";
import { useDialogKeyboard } from "./useDialogKeyboard";
import { api } from "../lib/api";

interface RevisionsViewProps {
  snapshot: WorkspaceSnapshot;
  onCreateVersion: (name: string) => Promise<void>;
  onRestore: (revisionId: string) => Promise<void>;
  onActivate: (projectId: string) => Promise<void>;
  onBeforeWrite: () => Promise<void>;
  onOpenScene: (sceneId: string) => void;
}

export function RevisionsView({ snapshot, onCreateVersion, onRestore, onActivate, onBeforeWrite, onOpenScene }: RevisionsViewProps) {
  const [selectedId, setSelectedId] = useState(snapshot.revisions[0]?.revisionId ?? "");
  const [versionName, setVersionName] = useState("第一章初稿");
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [versionError, setVersionError] = useState("");
  const creatingVersionRef = useRef(false);
  const [mode, setMode] = useState<"versions" | "replay">("versions");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [preview, setPreview] = useState<{ revisionId: string; scenes: WorkspaceSnapshot["scenes"]; facts: WorkspaceSnapshot["facts"] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const backupFileRef = useRef<HTMLInputElement>(null);
  const versionDialogRef = useRef<HTMLElement>(null);
  useDialogKeyboard(versionDialogRef, () => setShowNewVersion(false), showNewVersion);
  const selected = snapshot.revisions.find((revision) => revision.revisionId === selectedId) ?? snapshot.revisions[0];
  useEffect(() => {
    const revisionId = selected?.revisionId;
    if (!revisionId) { setPreview(null); return; }
    let active = true;
    setPreview(null);
    void api.revision(revisionId).then(result => {
      if (active) setPreview({ revisionId, scenes: result.scenes, facts: result.facts });
    }).catch(cause => { if (active) setImportError(cause instanceof Error ? cause.message : "无法读取所选修订"); });
    return () => { active = false; };
  }, [selected?.revisionId]);
  const previewScenes = preview && preview.revisionId === selected?.revisionId ? preview.scenes : [];
  const previewPendingFacts = preview && preview.revisionId === selected?.revisionId ? preview.facts.filter(fact => fact.reviewState === "candidate") : [];
  const pendingFacts = snapshot.facts.filter((fact) => fact.reviewState === "candidate");
  const candidateTasks = snapshot.tasks.filter((task) => task.state === "succeeded" || task.state === "interrupted");
  const currentWords = useMemo(
    () => snapshot.scenes.reduce((sum, scene) => sum + scene.body.length, 0),
    [snapshot.scenes],
  );
  const download = async (kind: "markdown" | "backup") => {
    setImportError("");
    try { await api.download(`/api/export/${kind}?projectId=${encodeURIComponent(snapshot.activeProject.projectId)}`, `${snapshot.activeProject.title}.${kind === "markdown" ? "md" : "json"}`); }
    catch (cause) { setImportError(cause instanceof Error ? cause.message : "导出失败"); }
  };
  const importFile = async (file: File) => {
    setImporting(true); setImportError(""); setImportNotice("");
    try {
      const text = await file.text();
      await onBeforeWrite();
      const result = await api.importProject({ title: file.name.replace(/\.(md|markdown|txt)$/i, "") || file.name, premise: "从本地 Markdown/TXT 导入", text });
      await onActivate(result.project.projectId);
      onOpenScene(result.snapshot.scenes[0]?.sceneId ?? "");
    } catch (cause) { setImportError(cause instanceof Error ? cause.message : "导入失败"); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const restoreFile = async (file: File) => {
    setImporting(true); setImportError(""); setImportNotice("");
    try {
      const backup = JSON.parse(await file.text()) as unknown;
      await onBeforeWrite();
      const result = await api.restoreBackup(backup);
      await onActivate(result.project.projectId);
      setImportNotice([`已恢复为新作品“${result.project.title}”，原作品未覆盖。`, ...result.warnings].join(" "));
    } catch (cause) { setImportError(cause instanceof Error ? cause.message : "备份恢复失败"); }
    finally { setImporting(false); if (backupFileRef.current) backupFileRef.current.value = ""; }
  };

  return (
    <div className="revisions-page">
      <header className="page-toolbar">
        <div>
          <p className="eyebrow">EVERY CHOICE, RECOVERABLE</p>
          <h1>修订与版本</h1>
          <p>正文、计划和重要元素变化一起审阅；恢复不会抹掉现在。</p>
        </div>
        <div className="revision-transfer-actions"><button className="button ghost" onClick={() => void download("markdown")}><Download size={15} />Markdown</button><button className="button ghost" onClick={() => void download("backup")}><FileJson2 size={15} />JSON 备份</button><button className="button secondary" disabled={importing} onClick={() => fileRef.current?.click()}><Upload size={15} />{importing ? "导入中…" : "导入 Markdown/TXT"}</button><input ref={fileRef} type="file" accept=".md,.markdown,.txt" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); }} /><button className="button secondary" disabled={importing} onClick={() => backupFileRef.current?.click()}><RotateCcw size={15} />恢复 JSON 备份</button><input ref={backupFileRef} type="file" accept=".json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void restoreFile(file); }} /><button className="button ghost" onClick={() => setMode(current => current === "replay" ? "versions" : "replay")}><History size={15} />{mode === "replay" ? "版本列表" : "过程回放"}</button><button className="button primary" onClick={() => setShowNewVersion(true)}><Plus size={15} />创建命名版本</button></div>
      </header>
      <p className="backup-scope-note">JSON 备份保存当前快照，不含历史修订、任务运行或工作流定义；恢复时会创建新作品，不覆盖原稿。</p>

      {importError && <p className="inline-note error" role="alert">{importError}</p>}
      {importNotice && <p className="inline-note" role="status">{importNotice}</p>}
      {mode === "replay" ? <InteractionReplay snapshot={snapshot} onOpenScene={onOpenScene} /> : <>
      <div className="revision-summary">
        <Summary icon={<BookOpenCheck size={20} />} label="当前主稿" value={`${currentWords.toLocaleString("zh-CN")} 字`} detail={`${snapshot.scenes.length} 个场景 · ${snapshot.branches[0]?.name ?? "主稿"}`} />
        <Summary icon={<Sparkles size={20} />} label="待审产物" value={candidateTasks.length + pendingFacts.length} detail="候选与元素变化分别决定" tone="violet" />
        <Summary icon={<CircleAlert size={20} />} label="待确认事实" value={pendingFacts.length} detail="未知不会自动判为错误" tone="amber" />
        <Summary icon={<History size={20} />} label="可恢复版本" value={snapshot.revisions.length} detail="含自动恢复点与命名版本" />
      </div>

      <div className="revisions-workspace">
        <aside className="version-list">
          <div className="pane-heading">
            <span>作品版本</span>
            <span className="button ghost small"><GitBranch size={13} />主稿</span>
          </div>
          {snapshot.revisions.map((revision) => (
            <button
              key={revision.revisionId}
              className={selected?.revisionId === revision.revisionId ? "active" : ""}
              onClick={() => setSelectedId(revision.revisionId)}
            >
              <span className={`revision-icon ${revision.kind}`}><RevisionIcon revision={revision} /></span>
              <div>
                <strong>{revision.name}</strong>
                <small>{new Date(revision.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {revision.wordCount} 字</small>
                <code>{revision.revisionId.slice(0, 14)}</code>
              </div>
              {revision.kind === "named" && <Badge tone="green">里程碑</Badge>}
            </button>
          ))}
        </aside>

        <main className="revision-detail">
          {selected && (
            <>
              <div className="revision-detail-heading">
                <div>
                  <p className="eyebrow">{selected.kind.toUpperCase()} · {selected.revisionId.slice(0, 14)}</p>
                  <h2>{selected.name}</h2>
                  <p>{new Date(selected.createdAt).toLocaleString("zh-CN")} · {selected.wordCount} 字</p>
                </div>
                <button className="button secondary" onClick={() => void onRestore(selected.revisionId)}>
                  <RotateCcw size={14} />恢复为新版本
                </button>
              </div>
              <div className="revision-notice">
                <ShieldCheck size={16} />
                <p>恢复会保留当前主稿，并从所选快照创建一个新的恢复版本。Pi 会话和作品版本互不回滚。</p>
              </div>

              <section className="changeset-card">
                <div className="changeset-heading">
                  <div>
                    <Columns2 size={18} />
                    <span><strong>所选版本的组成</strong><small>正文、场景计划与元素状态共享同一份不可变清单</small></span>
                  </div>
                  <Badge tone="violet">Revision</Badge>
                </div>
                <div className="change-group">
                  <div className="change-group-title">
                    <ChevronDown size={14} /><strong>正文与场景</strong><Badge>{preview ? previewScenes.length : "…"}</Badge>
                  </div>
                  {!preview ? <p className="quiet-empty">正在读取所选修订…</p> : previewScenes.filter((scene) => scene.body.trim()).slice(0, 3).map((scene) => (
                    <div className="text-change-row" key={scene.sceneId}>
                      <span className="change-type">场景</span>
                      <div><strong>{scene.title}</strong><p>{scene.body.slice(0, 88)}{scene.body.length > 88 ? "…" : ""}</p></div>
                      <span>{scene.body.length} 字</span>
                    </div>
                  ))}
                </div>
                <div className="change-group">
                  <div className="change-group-title">
                    <ChevronDown size={14} /><strong>元素与事实</strong>
                    <Badge tone={previewPendingFacts.length ? "amber" : "green"}>{previewPendingFacts.length ? `${previewPendingFacts.length} 待确认` : "已核对"}</Badge>
                  </div>
                  {previewPendingFacts.length ? previewPendingFacts.map((fact) => (
                    <div className="fact-review-row" key={fact.factId}>
                      <CircleAlert size={15} />
                      <div><strong>{fact.predicate}</strong><p>{fact.semanticType} · 来源 {fact.sourceKind}</p></div>
                    </div>
                  )) : <p className="quiet-empty">{preview ? "所选版本没有待确认的元素事实。" : "正在读取所选修订…"}</p>}
                </div>
                <div className="changeset-actions">
                  <span className="quiet-empty"><Check size={13} />版本引用已固定，布局变化不会改写此快照</span>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
      </>}

      {showNewVersion && (
        <div className="modal-backdrop" onMouseDown={() => setShowNewVersion(false)}>
          <section ref={versionDialogRef} className="small-modal" role="dialog" aria-modal="true" aria-label="创建命名版本" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">A MOMENT WORTH KEEPING</p>
            <h2>给这个阶段一个名字</h2>
            <p>命名版本引用当前正文、场景计划与元素状态。之后的修改不会改写它。</p>
            <label className="field-label">版本名称<input autoFocus data-autofocus value={versionName} onChange={(event) => setVersionName(event.target.value)} /></label>
            <div className="version-preview">
              <Archive size={17} />
              <div><strong>{snapshot.activeProject.title}</strong><p>{snapshot.scenes.length} 个场景 · {currentWords} 字 · {snapshot.facts.length} 条事实</p></div>
            </div>
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setShowNewVersion(false)}>取消</button>
              <button
                className="button primary"
                disabled={!versionName.trim() || creatingVersion}
                onClick={() => {
                  if (creatingVersionRef.current) return;
                  creatingVersionRef.current = true;
                  setCreatingVersion(true); setVersionError("");
                  void onCreateVersion(versionName).then(() => setShowNewVersion(false)).catch(cause => setVersionError(cause instanceof Error ? cause.message : "命名版本尚未保存，请重试")).finally(() => { creatingVersionRef.current = false; setCreatingVersion(false); });
                }}
              >
                <Check size={14} />保存命名版本
              </button>
            </div>
            {versionError && <p className="inline-note error" role="alert">{versionError}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

function Summary({ icon, label, value, detail, tone = "" }: { icon: React.ReactNode; label: string; value: string | number; detail: string; tone?: string }) {
  return (
    <div>
      <span className={`summary-icon ${tone}`}>{icon}</span>
      <p>{label}<strong>{value}</strong></p>
      <small>{detail}</small>
    </div>
  );
}

function RevisionIcon({ revision }: { revision: Revision }) {
  if (revision.kind === "named") return <Archive size={16} />;
  if (revision.kind === "restored") return <RotateCcw size={16} />;
  if (revision.kind === "changeset") return <Sparkles size={16} />;
  return <FileClock size={16} />;
}
