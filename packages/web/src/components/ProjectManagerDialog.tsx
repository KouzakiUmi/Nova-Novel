import { useEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "@nova-novel/shared";
import { Archive, Copy, FolderOpen, RotateCcw, Save, X } from "lucide-react";
import { api } from "../lib/api";
import { Badge } from "./UI";
import { useDialogKeyboard } from "./useDialogKeyboard";

export function ProjectManagerDialog({ snapshot, onClose, onActivate, onBeforeWrite }: { snapshot: WorkspaceSnapshot; onClose: () => void; onActivate: (projectId: string) => Promise<void>; onBeforeWrite: () => Promise<void> }) {
  const [title, setTitle] = useState(snapshot.activeProject.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogKeyboard(dialogRef, onClose);
  useEffect(() => { setTitle(snapshot.activeProject.title); }, [snapshot.activeProject.projectId, snapshot.activeProject.title]);
  const run = async (action: () => Promise<{ snapshot: WorkspaceSnapshot }>) => {
    setBusy(true); setError("");
    try { await onBeforeWrite(); const result = await action(); await onActivate(result.snapshot.activeProject.projectId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "作品操作失败"); }
    finally { setBusy(false); }
  };
  const activate = async (projectId: string) => {
    setBusy(true); setError("");
    try { await onBeforeWrite(); await onActivate(projectId); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "作品打开失败"); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section ref={dialogRef} className="small-modal project-manager-dialog" role="dialog" aria-modal="true" aria-label="管理作品" onMouseDown={event => event.stopPropagation()}>
        <header className="project-manager-heading"><div><p className="eyebrow">YOUR LOCAL LIBRARY</p><h2>管理作品</h2><p>重命名、复制或归档。归档不会删除正文和历史。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭作品管理"><X size={16} /></button></header>
        <section className="project-current-card"><div className="project-current-label"><Badge tone="green">当前作品</Badge><span>{snapshot.scenes.length} 个场景</span></div><label className="field-label">作品名称<input aria-label="作品名称" data-autofocus value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label><div className="project-manager-actions"><button className="button primary small" disabled={busy || !title.trim() || title.trim() === snapshot.activeProject.title} onClick={() => void run(() => api.updateProject(snapshot.activeProject.projectId, { title: title.trim() }))}><Save size={13} />保存名称</button><button className="button secondary small" disabled={busy} onClick={() => void run(() => api.duplicateProject(snapshot.activeProject.projectId))}><Copy size={13} />复制当前作品</button><button className="button ghost small" disabled={busy} onClick={() => void run(() => api.updateProject(snapshot.activeProject.projectId, { archived: true }))}><Archive size={13} />归档当前作品</button></div><p className="panel-description">复制包含当前章节、场景计划、正文和剧情节点，并创建独立初始修订；元素事实、批注、便签和历史版本不复制。</p></section>
        <section className="active-projects"><h3>未归档作品 <span>{snapshot.projects.length}</span></h3>{snapshot.projects.map(project => { const current = project.projectId === snapshot.activeProject.projectId; return <article key={project.projectId}><div><strong>{project.title}</strong><p>{current ? "当前作品" : "未归档"}</p></div><button className="button ghost small" disabled={busy || current} onClick={() => void activate(project.projectId)}><FolderOpen size={13} />{current ? "正在使用" : "打开作品"}</button></article>; })}</section>
        <section className="archived-projects"><h3>已归档作品 <span>{snapshot.archivedProjects.length}</span></h3>{snapshot.archivedProjects.length ? snapshot.archivedProjects.map(project => <article key={project.projectId}><div><strong>{project.title}</strong><p>归档于 {project.archivedAt ? new Date(project.archivedAt).toLocaleString("zh-CN") : "未知时间"}</p></div><button className="button ghost small" disabled={busy} onClick={() => void run(() => api.updateProject(project.projectId, { archived: false }))}><RotateCcw size={13} />恢复作品</button></article>) : <p className="quiet-empty">没有已归档作品。</p>}</section>
        {error && <p className="inline-note error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
