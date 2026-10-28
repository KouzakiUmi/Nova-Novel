import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  BookOpenText,
  Check,
  ChevronDown,
  Clock3,
  Command,
  Focus,
  GitBranch,
  LoaderCircle,
  PenLine,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type { WorkspaceSnapshot } from "@nova-novel/shared";
import { countWords } from "@nova-novel/shared";
import { IconConstellation, IconCore, IconFacet, IconFolio, IconLens, IconOrbit, IconQuill, IconSpark, NovaMark, type IconProps } from "./icons";

export type ViewId = "start" | "write" | "story" | "elements" | "context" | "workflow" | "revisions" | "settings";
export type SaveStatus = "saved" | "dirty" | "saving" | "error";

const navigation: Array<{ id: ViewId; label: string; hint: string; icon: (props: IconProps) => React.ReactElement }> = [
  { id: "start", label: "创作起步", hint: "从一句话开始", icon: IconSpark },
  { id: "write", label: "写作", hint: "正文与场景", icon: IconQuill },
  { id: "story", label: "故事", hint: "剧情与时间线", icon: IconConstellation },
  { id: "elements", label: "元素", hint: "人物、物品与规则", icon: IconFacet },
  { id: "context", label: "资料", hint: "证据与检索", icon: IconLens },
  { id: "workflow", label: "工作流", hint: "编排与运行", icon: IconOrbit },
  { id: "revisions", label: "修订", hint: "版本与恢复", icon: IconFolio },
  { id: "settings", label: "模型与服务", hint: "Provider、模型与任务分配", icon: IconCore },
];

interface AppShellProps {
  snapshot: WorkspaceSnapshot;
  view: ViewId;
  onViewChange: (view: ViewId) => void;
  focusMode: boolean;
  onFocusMode: () => void;
  onOpenStart: () => void;
  onOpenScene: (sceneId: string) => void;
  onProjectChange: (projectId: string) => Promise<void>;
  saveStatus: SaveStatus;
  children: ReactNode;
}

export function AppShell({ snapshot, view, onViewChange, focusMode, onFocusMode, onOpenStart, onOpenScene, onProjectChange, saveStatus, children }: AppShellProps) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const project = snapshot.activeProject;
  const words = snapshot.scenes.reduce((sum, scene) => sum + countWords(scene.body), 0);
  const activeBranch = snapshot.branches.find((branch) => branch.branchId === project.activeBranchId);
  const activeRevision = snapshot.revisions.find((revision) => revision.revisionId === activeBranch?.headRevisionId)
    ?? snapshot.revisions.at(-1);

  return (
    <div className={`app-shell ${focusMode ? "is-focus" : ""}`}>
      <aside className="app-rail">
        <button className="brand" onClick={onOpenStart} aria-label="Nova Novel 首页">
          <NovaMark size={34} />
          <span><strong>Nova Novel</strong><small>STORIES THAT IGNITE</small></span>
        </button>

        <label className="project-switcher">
          <span className="project-cover" aria-hidden="true">{project.title.trim().slice(0, 1) || "N"}</span>
          <span><small>当前作品</small><select aria-label="切换作品" value={project.projectId} onChange={(event) => void onProjectChange(event.target.value)}>{snapshot.projects.map((item) => <option key={item.projectId} value={item.projectId}>{item.title}</option>)}</select></span>
          <ChevronDown size={13} aria-hidden="true" />
        </label>

        <nav className="primary-nav" aria-label="作品功能">
          <p className="nav-section-label">创作空间</p>
          {navigation.slice(0, 5).map((item) => (
            <NavButton key={item.id} item={item} active={view === item.id} onClick={() => onViewChange(item.id)} />
          ))}
          <p className="nav-section-label nav-section-secondary">创作方法</p>
          {navigation.slice(5, 7).map((item) => (
            <NavButton key={item.id} item={item} active={view === item.id} onClick={() => onViewChange(item.id)} />
          ))}
        </nav>

        <div className="rail-bottom">
          <button className={`local-status ${view === "settings" ? "active" : ""}`} onClick={() => onViewChange("settings")} title="管理模型与服务">
            <span className={`status-dot ${snapshot.connection.state === "connected" ? "online" : ""}`} />
            <span><strong>{snapshot.connection.state === "connected" ? "AI 搭档已就绪" : "尚未接入模型"}</strong><small>{snapshot.connection.state === "connected" ? "模型与服务 · 已配置" : "写作与保存不受影响"}</small></span>
            <Settings2 size={15} aria-hidden="true" />
          </button>
          <p className="rail-footnote">故事留在你的设备上</p>
        </div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <div className="breadcrumbs">
            <BookOpenText size={16} aria-hidden="true" />
            <span>{project.title}</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{navigation.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <button className="search-trigger" onClick={() => setCommandOpen(true)}><Search size={15} /><span>搜索作品</span><kbd><Command size={11} /> K</kbd></button>
            <span className={`save-state ${saveStatus}`}>{saveStatus === "saving" ? <LoaderCircle size={14} className="spin" /> : saveStatus === "saved" ? <Check size={14} /> : <Clock3 size={14} />}{saveStatus === "saved" ? "已保存到本机" : saveStatus === "saving" ? "正在保存" : saveStatus === "error" ? "保存未完成" : "有未保存的修改"}</span>
            <span className="branch-button" title="当前写作分支"><GitBranch size={14} />{activeBranch?.name ?? "主稿"}</span>
            <button className={`icon-button ${focusMode ? "active" : ""}`} onClick={onFocusMode} aria-label="切换专注模式" title="专注模式"><Focus size={17} /></button>
          </div>
        </header>
        <div className="view-container">{children}</div>
        <footer className="statusbar">
          <span>{snapshot.scenes.length} 个场景</span>
          <span>{words.toLocaleString("zh-CN")} 字</span>
          <span className="statusbar-spacer" />
          <span><Archive size={12} />{activeRevision?.name ?? "自动恢复点"}</span>
          <span className="statusbar-revision">{activeRevision?.revisionId.slice(0, 12) ?? "本地草稿"}</span>
        </footer>
      </div>

      {commandOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCommandOpen(false)}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="搜索与跳转" onMouseDown={(event) => event.stopPropagation()}>
            <div className="command-input"><Search size={18} /><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="搜索场景、元素，或输入要去的功能…" /><button className="icon-button" onClick={() => setCommandOpen(false)} aria-label="关闭"><X size={17} /></button></div>
            <p className="command-label">快速前往</p>
            {navigation.filter((item) => `${item.label}${item.hint}`.includes(commandQuery)).map((item) => (
              <button key={item.id} className="command-result" onClick={() => { onViewChange(item.id); setCommandOpen(false); setCommandQuery(""); }}>
                <item.icon size={18} /><span><strong>{item.label}</strong><small>{item.hint}</small></span><kbd>↵</kbd>
              </button>
            ))}
            <p className="command-label">场景</p>
            {snapshot.scenes.filter((scene) => scene.title.includes(commandQuery)).slice(0, 4).map((scene) => (
              <button key={scene.sceneId} className="command-result" onClick={() => { onOpenScene(scene.sceneId); setCommandOpen(false); setCommandQuery(""); }}>
                <PenLine size={17} /><span><strong>{scene.title}</strong><small>{scene.summary || "未写摘要"}</small></span><span>场景</span>
              </button>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}

function NavButton({ item, active, onClick }: { item: (typeof navigation)[number]; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined} title={item.hint}>
      <item.icon size={19} /><span>{item.label}</span>{active && <i aria-hidden="true" />}
    </button>
  );
}
