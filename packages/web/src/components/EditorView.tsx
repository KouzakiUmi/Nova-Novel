import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, getTextBetween, getTextSerializersFromSchema, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { AgentSettingsView, ConsistencyReport, ExtractedLedgerBundle, GenerationProgress, GenerationReceipt, GenerationRequest, Scene, SceneFieldOption, SceneProposalCard, WorkspaceSnapshot } from "@nova-novel/shared";
import { countWords, recommendNextAction, type NextActionKind } from "@nova-novel/shared";
import {
  AlignLeft,
  ArrowRight,
  Bold,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  Columns2,
  FilePlus2,
  Highlighter,
  History,
  Italic,
  LibraryBig,
  List,
  LoaderCircle,
  PanelRightClose,
  Quote,
  Redo2,
  Save,
  Search,
  Send,
  Sparkles,
  Square,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { Badge } from "./UI";
import { IconCore } from "./icons";
import { AnnotationPanel, type AnnotationDraftRange } from "./AnnotationPanel";
import { RevisionPanel } from "./RevisionPanel";
import { api } from "../lib/api";
import { WritingModelPicker } from "./WritingModelPicker";
import { readAppearance } from "../lib/appearance";

interface GenerationHandle {
  receipt: Promise<GenerationReceipt>;
  idempotencyKey: string;
}

interface EditorViewProps {
  snapshot: WorkspaceSnapshot;
  scene: Scene;
  localDraft?: string;
  focusMode: boolean;
  onSelectScene: (sceneId: string) => void;
  onDirty: (scene: Scene) => void;
  onSave: (scene: Scene) => Promise<void>;
  onGenerate: (request: GenerationRequest) => GenerationHandle;
  onProgress: (idempotencyKey: string) => Promise<GenerationProgress>;
  onCancel: (idempotencyKey: string) => Promise<void>;
  onOpenElement: (entityId: string) => void;
  onOpenReview: () => void;
  onOpenSettings: () => void;
  onChanged: () => Promise<unknown>;
  onRegisterFlush: (flush: (() => Promise<void>) | null) => void;
  agentSettings: AgentSettingsView | null;
  onSelectTaskModel: (kind: TaskKind, provider?: string, modelId?: string) => Promise<unknown>;
}

type TaskKind = GenerationRequest["kind"];
type Range = NonNullable<GenerationRequest["range"]>;

export interface LastRequest { kind: TaskKind; input: string; range?: Range; label: string }

type Outcome =
  | { type: "continuation"; sceneId: string; text: string; proposals: string[]; baseBody: string; incomplete: boolean; stale: boolean }
  | { type: "replacement"; sceneId: string; text: string; proposals: string[]; range: Range; baseBody: string; incomplete: boolean; stale: boolean }
  | { type: "report"; sceneId: string; title: string; report: ConsistencyReport; incomplete: boolean };

const BLOCK_SEPARATOR = "\n\n";

/** 与正文保存口径一致的纯文本：块之间两个换行，硬换行为一个换行。 */
function plainText(editor: Editor): string {
  return editor.getText({ blockSeparator: BLOCK_SEPARATOR });
}

/** 文档位置 → 纯文本偏移（与 plainText 同一序列化规则）。 */
function textOffset(editor: Editor, pos: number): number {
  const doc = editor.state.doc;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  return getTextBetween(doc, { from: 0, to: clamped }, { blockSeparator: BLOCK_SEPARATOR, textSerializers: getTextSerializersFromSchema(editor.schema) }).length;
}

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function bodyToContent(body: string): string {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return body.split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${escape(paragraph).replaceAll("\n", "<br>")}</p>`).join("") || "<p></p>";
}

function payloadOf(receipt: GenerationReceipt): Record<string, unknown> {
  const result = receipt.task.result;
  if (typeof result === "string") return { text: result };
  return result && typeof result === "object" ? result as Record<string, unknown> : {};
}

function proposalsOf(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.proposals) ? payload.proposals.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function reportOf(payload: Record<string, unknown>): ConsistencyReport {
  const raw = payload.report;
  if (raw && typeof raw === "object" && Array.isArray((raw as ConsistencyReport).issues)) return raw as ConsistencyReport;
  const text = typeof payload.text === "string" ? payload.text : "";
  return { summary: text || "检查已完成，没有返回结构化问题。", issues: [] };
}

const severityMeta = {
  conflict: { label: "约束冲突", tone: "red" as const, hint: "与已确认设定或正文矛盾，合入前需要处理" },
  unknown: { label: "未知 / 缺口", tone: "amber" as const, hint: "资料不足以判断，不等于错误" },
  aesthetic: { label: "审美建议", tone: "violet" as const, hint: "可选，跳过也完全可以" },
};

const SCENE_INTENTS = {
  action: { label: "推进事件", hint: "目标 → 阻碍 → 变化", instruction: "以行动推进当前场景：让人物围绕目标尝试，遇到具体阻碍，并形成结果或状态变化。结果不必是失败、灾难或反转。" },
  reaction: { label: "反应与决定", hint: "反应 → 两难 → 决定", instruction: "以反应、两难与决定推进当前场景：让人物处理已经发生的事，看见可选方向并作出符合其动机的决定；可以用行动、对话或压缩叙述，不要求大段内心独白。" },
  dialogue: { label: "对话与行动", hint: "正在做的事 + 谈话目的", instruction: "写一段对话与行动并行的场景：人物既有正在做的事，也有想从谈话中得到的东西。允许回避、停顿、行动和未说出口的目的，不写成纯逻辑辩论，不用口头禅代替人物差异。" },
} as const;
type SceneWritingIntent = keyof typeof SCENE_INTENTS;

const SCENE_REVIEW_INTENT = "复盘当前场景，不改正文：开头人物追求什么或面对什么问题；结尾正文实际发生了什么结果或状态变化；若继续写下一场，人物可以作出什么决定。只依据正文明确支持的内容，不为迎合结构公式强造灾难、反转或变化。把正文未交代的因果与变化标为 unknown，把可选的表达建议标为 aesthetic，并在 summary 里用普通语言概括“结果与可能的下一步”。";

export function EditorView({ snapshot, scene, localDraft, focusMode, onSelectScene, onDirty, onSave, onGenerate, onProgress, onCancel, onOpenElement, onOpenReview, onOpenSettings, onChanged, onRegisterFlush, agentSettings, onSelectTaskModel }: EditorViewProps) {
  const [body, setBody] = useState(localDraft ?? scene.body);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">(localDraft === undefined ? "saved" : "error");
  const [assistantTab, setAssistantTab] = useState<"assistant" | "context" | "scene" | "annotations" | "revision">("assistant");
  const [rightOpen, setRightOpen] = useState(true);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraftRange | null>(null);
  const [running, setRunning] = useState<{ key: string; sceneId: string; label: string; text: string; tools: string[] } | null>(null);
  const [lastRequest, setLastRequest] = useState<LastRequest | null>(null);
  const [compare, setCompare] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sceneIntent, setSceneIntent] = useState<SceneWritingIntent>("action");
  const [taskNote, setTaskNote] = useState("");
  const [lastAction, setLastAction] = useState<"accepted" | "reviewed" | null>(null);
  const [sceneFilter, setSceneFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractBundle, setExtractBundle] = useState<ExtractedLedgerBundle | null>(null);
  const [nextSceneBusy, setNextSceneBusy] = useState(false);
  const [nextSceneCards, setNextSceneCards] = useState<SceneProposalCard[]>([]);
  const [nextSceneArtifactId, setNextSceneArtifactId] = useState("");
  const sceneIdRef = useRef(scene.sceneId);
  const bodyRef = useRef(localDraft ?? scene.body);
  const sceneRef = useRef(scene);
  if (sceneRef.current.sceneId === scene.sceneId) sceneRef.current = scene;
  // 只表示尚未被任何一次保存请求捕获的修改，避免重复提交已在途的内容。
  const unsavedChangesRef = useRef(false);
  const aiReady = snapshot.connection.state === "connected";
  const manuscriptSize = 18 * readAppearance().manuscriptScale / 100;
  const activeSceneIntent = SCENE_INTENTS[sceneIntent];
  const nextAction = recommendNextAction({ hasBody: Boolean(body.trim()), hasPlan: Boolean((scene.goal ?? "").trim() || scene.summary.trim()), outcome: outcome ? outcome.type === "report" ? "report" : "candidate" : null, stale: outcome && outcome.type !== "report" ? outcome.stale : false, lastAction });

  const editor = useEditor({
    extensions: [StarterKit.configure({ bold: false, italic: false, blockquote: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, heading: false, horizontalRule: false, codeBlock: false, code: false, strike: false, underline: false, link: false })],
    content: bodyToContent(localDraft ?? scene.body),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "manuscript-editor",
        "aria-label": "场景正文",
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const text = plainText(currentEditor);
      bodyRef.current = text;
      unsavedChangesRef.current = true;
      setBody(text);
      setSaveState("dirty");
      onDirty({ ...sceneRef.current, body: text });
    },
  });

  const editorState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => currentEditor ? {
      bold: currentEditor.isActive("bold"),
      italic: currentEditor.isActive("italic"),
      hasSelection: !currentEditor.state.selection.empty,
      selectedText: currentEditor.state.doc.textBetween(currentEditor.state.selection.from, currentEditor.state.selection.to, BLOCK_SEPARATOR),
      from: currentEditor.state.selection.from,
      to: currentEditor.state.selection.to,
    } : { bold: false, italic: false, hasSelection: false, selectedText: "", from: 0, to: 0 },
  });

  useEffect(() => {
    if (!outcome || outcome.type === "report") return;
    void api.recordInteraction({ projectId: scene.projectId, sceneId: scene.sceneId, kind: "candidate-presented", actor: "system" }).catch(() => undefined);
  }, [outcome?.sceneId]);

  const flushPendingChanges = useCallback(async () => {
    if (!unsavedChangesRef.current) return;
    const currentScene = sceneRef.current;
    const bodyToSave = bodyRef.current;
    unsavedChangesRef.current = false;
    setSaveState("saving");
    try {
      await onSave({ ...currentScene, body: bodyToSave });
      if (sceneIdRef.current === currentScene.sceneId) setSaveState(unsavedChangesRef.current ? "dirty" : "saved");
    } catch (error) {
      unsavedChangesRef.current = true;
      if (sceneIdRef.current === currentScene.sceneId) setSaveState("error");
      throw error;
    }
  }, [onSave]);

  useEffect(() => {
    if (localDraft === undefined && scene.body === bodyRef.current) {
      unsavedChangesRef.current = false;
      setSaveState("saved");
    }
  }, [localDraft, scene.body]);

  useEffect(() => {
    onRegisterFlush(flushPendingChanges);
    return () => onRegisterFlush(null);
  }, [flushPendingChanges, onRegisterFlush]);

  useEffect(() => {
    // 切换场景或离开写作页时，先让在途修改进入应用的串行保存队列。
    // effect 中捕获的 scene 仍是离开前的场景，不会被下一场景的 bodyRef 污染。
    return () => {
      if (!unsavedChangesRef.current) return;
      const bodyToSave = bodyRef.current;
      unsavedChangesRef.current = false;
      const draft = { ...sceneRef.current, body: bodyToSave };
      onDirty(draft);
      void onSave(draft).catch(cause => setTaskNote(cause instanceof Error ? `本地草稿已保留：${cause.message}` : "本地草稿已保留，请重试保存。"));
    };
  }, [scene.sceneId]);

  useEffect(() => {
    if (sceneIdRef.current === scene.sceneId) return;
    sceneRef.current = scene;
    sceneIdRef.current = scene.sceneId;
    bodyRef.current = scene.body;
    unsavedChangesRef.current = false;
    setBody(scene.body);
    setOutcome(null);
    setAnnotationDraft(null);
    setRunning(null);
    setLastRequest(null);
    setCompare(false);
    setTaskNote("");
    setLastAction(null);
    setSaveState("saved");
    editor?.commands.setContent(bodyToContent(scene.body), { emitUpdate: false });
  }, [scene.sceneId, scene.body, editor]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      const bodyToSave = bodyRef.current;
      unsavedChangesRef.current = false;
      void onSave({ ...scene, body: bodyToSave })
        .then(() => {
          if (sceneIdRef.current === scene.sceneId) setSaveState((state) => state === "saving" && !unsavedChangesRef.current ? "saved" : state);
        })
        .catch(() => {
          if (sceneIdRef.current !== scene.sceneId) return;
          unsavedChangesRef.current = true;
          setSaveState("error");
        });
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [body, saveState, scene, onSave]);

  // 生成期间轮询进度，展示已流式到达的文字与调用的资料工具。
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void onProgress(running.key).then((progress) => {
        if (stopped) return;
        setRunning((current) => current && current.key === running.key ? { ...current, text: progress.text, tools: progress.tools } : current);
      }).catch(() => undefined);
    }, 700);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [running?.key, onProgress]);

  const entities = useMemo(() => snapshot.elements.filter((entity) => scene.entityIds.includes(entity.entityId)).slice(0, 4), [snapshot.elements, scene.entityIds]);
  const relatedEvidence = useMemo(() => snapshot.evidence.filter((item) => item.sceneId === scene.sceneId).slice(0, 4), [snapshot.evidence, scene.sceneId]);
  const wordCount = countWords(body);

  const generate = useCallback(async (request: LastRequest) => {
    if (running) return;
    if (!aiReady) {
      setTaskNote("还没有接入模型。到“模型与服务”添加一个 provider 后即可生成。");
      return;
    }
    void api.recordInteraction({ projectId: scene.projectId, sceneId: scene.sceneId, kind: "suggestion-open" }).catch(() => undefined);
    setLastRequest(request);
    setOutcome(null);
    setCompare(false);
    const baseBody = bodyRef.current;
    const requestSceneId = scene.sceneId;
    const idempotencyKey = crypto.randomUUID();
    const handle = onGenerate({
      projectId: snapshot.activeProject.projectId,
      sceneId: scene.sceneId,
      draftId: snapshot.authoringDraft.draftId,
      kind: request.kind,
      input: request.input,
      idempotencyKey,
      ...(request.range ? { range: request.range } : {}),
    });
    setRunning({ key: handle.idempotencyKey, sceneId: requestSceneId, label: request.label, text: "", tools: [] });
    setTaskNote("正在读取当前场景与可见资料；你可以继续写作。");
    try {
      const receipt = await handle.receipt;
      // 任务仍会在服务端归档，但迟到结果只属于发起它的场景。
      if (sceneIdRef.current !== requestSceneId) return;
      const state = receipt.task.state;
      const payload = payloadOf(receipt);
      const text = typeof payload.text === "string" ? payload.text : "";
      const incomplete = receipt.task.completeness === "partial";
      if (state === "failed" || ((state === "cancelled" || state === "interrupted") && !text.trim() && request.kind !== "consistency")) {
        setTaskNote(receipt.task.error ?? (state === "failed" ? "生成未完成，已保留现有正文。" : "已停止，没有可用的部分结果。"));
        return;
      }
      const stale = receipt.freshness === "stale" || bodyRef.current !== baseBody;
      if (request.kind === "consistency") {
        setOutcome({ type: "report", sceneId: requestSceneId, title: request.label, report: reportOf(payload), incomplete });
        setLastAction("reviewed");
        setTaskNote("检查结果只供参考，不会改动正文。");
      } else if (request.kind === "polish" && request.range) {
        setOutcome({ type: "replacement", sceneId: requestSceneId, text, proposals: proposalsOf(payload), range: request.range, baseBody, incomplete, stale });
        setTaskNote(stale ? "原文已变化，采用前请先比较。" : "改写已就绪，只会替换你选中的那一段。");
      } else {
        setOutcome({ type: "continuation", sceneId: requestSceneId, text, proposals: proposalsOf(payload), baseBody, incomplete, stale });
        setTaskNote(stale ? "原文已变化，候选仍保留，请比较后决定。" : "候选已保存，尚未进入正文。");
      }
    } catch (cause) {
      if (sceneIdRef.current === requestSceneId) setTaskNote(cause instanceof Error ? cause.message : "生成未完成");
    } finally {
      setRunning((current) => current?.key === idempotencyKey ? null : current);
    }
  }, [aiReady, onGenerate, running, scene.sceneId, snapshot.activeProject.projectId, snapshot.authoringDraft.draftId]);

  const performNextAction = (kind: NextActionKind) => {
    if (kind === "plan") { setRightOpen(true); setAssistantTab("scene"); return; }
    if (kind === "write") { editor?.commands.focus(); return; }
    if (kind === "compare") { setCompare(true); return; }
    if (kind === "review-candidate") { document.querySelector(".candidate-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (kind === "review-scene") { void generate({ kind: "consistency", label: "场景复盘", input: SCENE_REVIEW_INTENT }); return; }
    void generate({ kind: "scene", label: activeSceneIntent.label, input: `${activeSceneIntent.instruction}${prompt.trim() ? `\n作者补充要求：${prompt.trim()}` : ""}` });
  };

  const stop = async () => {
    if (!running) return;
    setTaskNote("正在停止，已收到的文字会保留为不完整候选。");
    try { await onCancel(running.key); } catch (cause) { setTaskNote(cause instanceof Error ? cause.message : "停止请求未完成"); }
  };

  const selectionRange = (): Range | undefined => {
    if (!editor || !editorState?.hasSelection) return undefined;
    const text = plainText(editor);
    // 选区起点落在块首时，前导块分隔符不属于选中文字。
    let from = textOffset(editor, editorState.from);
    const to = textOffset(editor, editorState.to);
    while (from < to && text[from] === "\n") from += 1;
    return { from, to, baseText: text.slice(from, to) };
  };

  const createAnnotationDraft = async () => {
    const range = selectionRange();
    if (!range || !range.baseText.trim()) { setTaskNote("先选中要批注的一段文字，也可以使用整场想法。"); setAssistantTab("annotations"); return; }
    const textHash = await sha256Text(range.baseText);
    setAnnotationDraft({ ...range, textHash });
    setRightOpen(true);
    setAssistantTab("annotations");
  };

  const polishSelection = (mode: "tighten" | "expand", intentOverride?: string) => {
    const range = selectionRange();
    if (!range || !range.baseText.trim()) return;
    const intent = intentOverride?.trim() ? `作者意图：${intentOverride.trim()}\n` : prompt.trim() ? `作者意图：${prompt.trim()}\n` : "";
    void generate(mode === "tighten"
      ? { kind: "polish", label: "推敲表达", range, input: `${intent}只改表达，不新增人物、身份、死亡或物品状态变化。` }
      : { kind: "polish", label: "扩写选段", range, input: `${intent}允许扩写这一段，关键新事实必须单列为提案。` });
  };

  const checkSelection = () => {
    const range = selectionRange();
    if (!range) return;
    void generate({ kind: "consistency", label: "检查选段", range, input: `检查这段文字与已知设定、人物知识和物品状态是否一致：\n${range.baseText}` });
  };

  const applyText = (next: string) => {
    if (!editor) return;
    editor.commands.setContent(bodyToContent(next));
    bodyRef.current = next;
    unsavedChangesRef.current = true;
    setBody(next);
    setSaveState("dirty");
    onDirty({ ...sceneRef.current, body: next });
  };

  const acceptOutcome = () => {
    if (!outcome || outcome.sceneId !== scene.sceneId || outcome.type === "report") return;
    const current = bodyRef.current;
    if (outcome.type === "continuation") {
      const addition = outcome.text.trim();
      applyText(current.trim() ? `${current.replace(/\s+$/, "")}${BLOCK_SEPARATOR}${addition}` : addition);
    } else {
      const { from, to, baseText } = outcome.range;
      if (outcome.stale || outcome.baseBody !== current || !baseText || current.slice(from, to) !== baseText) {
        setTaskNote("原文已变化，改写没有应用。请重新选择要推敲的文字后再试。");
        return;
      }
      applyText(`${current.slice(0, from)}${outcome.text}${current.slice(to)}`);
    }
    setOutcome(null);
    setCompare(false);
    setLastAction("accepted");
    void api.recordInteraction({ projectId: scene.projectId, sceneId: scene.sceneId, kind: "candidate-accept" }).catch(() => undefined);
    setTaskNote("已采用到正文，可以随时撤销。");
  };

  const chapters = snapshot.chapters.map((chapter) => ({ chapter, scenes: snapshot.scenes.filter((item) => item.chapterId === chapter.chapterId && (!sceneFilter || item.title.includes(sceneFilter))) }));

  return (
    <div className={`editor-workspace ${!rightOpen ? "right-closed" : ""}`}>
      {!focusMode && (
        <aside className="scene-sidebar">
          <div className="pane-heading"><span>卷章与场景</span><Badge>{snapshot.scenes.length}</Badge></div>
          <label className="scene-search"><Search size={14} /><input value={sceneFilter} onChange={(event) => setSceneFilter(event.target.value)} placeholder="查找场景" aria-label="查找场景" /></label>
          <div className="scene-tree">
            {chapters.map(({ chapter, scenes }) => (
              <section key={chapter.chapterId}>
                <button className="chapter-row" onClick={() => setCollapsed((value) => ({ ...value, [chapter.chapterId]: !value[chapter.chapterId] }))} aria-expanded={!collapsed[chapter.chapterId]}>{collapsed[chapter.chapterId] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<strong>{chapter.title}</strong><span>{scenes.length}</span></button>
                {!collapsed[chapter.chapterId] && scenes.map((item) => (
                  <button key={item.sceneId} className={`scene-row ${item.sceneId === scene.sceneId ? "active" : ""}`} onClick={() => onSelectScene(item.sceneId)}>
                    <span className={`scene-status-mark ${item.status}`} />
                    <span><strong>{item.title}</strong><small>{item.status === "final" ? "已定稿" : item.status === "review" ? "待审阅" : item.status === "writing" ? "写作中" : item.status === "planned" ? "已有计划" : "草稿"} · {countWords(item.sceneId === scene.sceneId ? body : item.body)} 字</small></span>
                    {item.sceneId === scene.sceneId && <ChevronRight size={13} />}
                  </button>
                ))}
              </section>
            ))}
          </div>
          <div className="scene-sidebar-bottom">
            <div className="mini-plan"><span>当前场景卡</span><p>{scene.goal || "尚未写下场景目标"}</p>{scene.conflict && <small>阻碍 · {scene.conflict}</small>}</div>
            <button className="button ghost full" onClick={() => { setRightOpen(true); setAssistantTab("scene"); }}><AlignLeft size={14} />展开场景卡</button>
          </div>
        </aside>
      )}

      <main className="editor-stage">
        <div className="editor-toolbar">
          <div className="format-tools">
            <button className="icon-button" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()} aria-label="撤销"><Undo2 size={16} /></button>
            <button className="icon-button" onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()} aria-label="重做"><Redo2 size={16} /></button>
            <i />
            <button className="icon-button" disabled title="正文按纯文本保存，暂不支持格式" aria-label="粗体"><Bold size={16} /></button>
            <button className="icon-button" disabled title="正文按纯文本保存，暂不支持格式" aria-label="斜体"><Italic size={16} /></button>
            <button className="icon-button" disabled title="正文按纯文本保存，暂不支持格式" aria-label="引用"><Quote size={16} /></button>
            <button className="icon-button" disabled title="正文按纯文本保存，暂不支持格式" aria-label="列表"><List size={16} /></button>
            <small>纯文本 · 保留段落与换行</small>
          </div>
          <div className="editor-meta"><span className={`save-indicator ${saveState}`}>{saveState === "saved" ? <Check size={13} /> : saveState === "saving" ? <LoaderCircle size={13} className="spin" /> : <Clock3 size={13} />}{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中" : saveState === "error" ? "本地草稿 · 待处理" : "待保存"}</span><button className="icon-button" aria-label="版本历史" title="版本历史" onClick={onOpenReview}><History size={16} /></button><button className="icon-button" onClick={() => setRightOpen((open) => !open)} aria-label={rightOpen ? "收起助手" : "展开助手"} title={rightOpen ? "收起助手" : "展开助手"}><PanelRightClose size={16} /></button></div>
        </div>

        <div className="paper-scroll">
          <article className="paper">
            <header className="scene-title-block">
              <p>{snapshot.chapters.find((chapter) => chapter.chapterId === scene.chapterId)?.title ?? "未分章"}<span>·</span>场景 {scene.narrationOrder}</p>
              <h1>{scene.title}</h1>
              <div className="scene-byline"><span>{scene.pov ? `${scene.pov} 视角` : "视角待定"}</span><i /><span>{scene.storyTime ?? "故事时间待定"}</span><i /><Badge tone="green">{scene.status === "review" ? "待审阅" : scene.status === "final" ? "已定稿" : scene.status === "planned" ? "已有计划" : "写作中"}</Badge></div>
            </header>
            {!body.trim() && !running && !outcome && (
              <section className="blank-scene-guide" aria-label="空白第一场写作提示">
                <div><p className="eyebrow">A PLACE TO BEGIN</p><h2>第一场，不必从一个完美的句子开始。</h2><p>下面三个问题都可以留空。先写一个动作、一句对白或一个画面，也是在开始。</p></div>
                <ol><li><span>01</span><p><strong>谁想做什么？</strong>只写此刻最想完成的一件小事。</p></li><li><span>02</span><p><strong>什么让这件事不容易？</strong>一个人、一个限制，或一个意外都可以。</p></li><li><span>03</span><p><strong>结束时有什么变化？</strong>决定、关系或掌握的信息有了一点不同。</p></li></ol>
              </section>
            )}
            <EditorContent editor={editor} />
            <div className="manuscript-end"><span>§</span><i /></div>

            {running?.sceneId === scene.sceneId && (
              <div className="candidate-loading">
                <span className="weave-loader"><i /><i /><i /></span>
                <div className="candidate-loading-body">
                  <strong>{running.label} · 正在形成一份候选</strong>
                  <p>{running.tools.length ? `已查阅：${[...new Set(running.tools)].map(toolLabel).join("、")}` : taskNote}</p>
                  {running.text && <p className="stream-preview">{running.text.slice(-420)}</p>}
                </div>
                <button className="button ghost small" onClick={() => void stop()}><Square size={12} />停止</button>
              </div>
            )}

            {outcome?.sceneId === scene.sceneId && outcome.type === "report" && (
              <section className="report-panel">
                <div className="candidate-heading"><div><CheckCircle2 size={16} /><strong>{outcome.title}{outcome.incomplete ? "（不完整）" : ""}</strong><Badge tone="amber">只读报告 · 不改正文</Badge></div><button className="icon-button" onClick={() => setOutcome(null)} aria-label="关闭报告"><X size={15} /></button></div>
                <p className="report-summary">{outcome.report.summary}</p>
                {outcome.report.issues.length === 0 ? <p className="quiet-empty report-empty">没有发现可确认的冲突。未知不代表错误。</p> : (
                  <ul className="issue-list">
                    {(["conflict", "unknown", "aesthetic"] as const).flatMap((severity) => outcome.report.issues.filter((issue) => issue.severity === severity).map((issue, index) => (
                      <li key={`${severity}-${index}`} className={`issue ${severity}`}>
                        <div className="issue-head"><Badge tone={severityMeta[severity].tone}>{severityMeta[severity].label}</Badge><strong>{issue.title}</strong></div>
                        <p>{issue.detail}</p>
                        {issue.evidence.length > 0 && <div className="issue-evidence">{issue.evidence.slice(0, 3).map((quote, quoteIndex) => <blockquote key={quoteIndex}>{quote}</blockquote>)}</div>}
                        <small>{severityMeta[severity].hint}</small>
                      </li>
                    )))}
                  </ul>
                )}
                <div className="candidate-actions">
                  <button className="button ghost small" onClick={() => lastRequest && void generate(lastRequest)}><WandSparkles size={14} />重新检查</button>
                  <button
                    className="button primary small"
                    disabled={nextSceneBusy}
                    onClick={() => {
                      setNextSceneBusy(true);
                      void api
                        .plotIdeate({
                          projectId: snapshot.activeProject.projectId,
                          mode: "next_scene",
                          sceneId: scene.sceneId,
                          reviewSummary: outcome.report.summary,
                        })
                        .then((res) => {
                          setNextSceneCards(res.scenes ?? []);
                          setNextSceneArtifactId(res.artifactId);
                        })
                        .catch((err) => setTaskNote(err instanceof Error ? err.message : "构思下一场失败"))
                        .finally(() => setNextSceneBusy(false));
                    }}
                  >
                    {nextSceneBusy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
                    据此构思下一场
                  </button>
                </div>
                {nextSceneCards.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: "1px solid rgba(0,0,0,0.08)", paddingTop: 10 }}>
                    <strong>下一场提案（点击即可在当前场景之后新建并跳转）：</strong>
                    <div className="fact-grid" style={{ marginTop: 8 }}>
                      {nextSceneCards.map((sc) => (
                        <div key={sc.proposalId} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <strong>{sc.title}</strong>
                          <small>目标：{sc.goal}</small>
                          <small>阻碍：{sc.conflict}</small>
                          <small>结果：{sc.summary}</small>
                          <button
                            className="button primary small"
                            disabled={nextSceneBusy}
                            onClick={() => {
                              setNextSceneBusy(true);
                              void flushPendingChanges()
                                .then(() => {
                                  const head = snapshot.branches.find((b) => b.branchId === snapshot.activeProject.activeBranchId)?.headRevisionId ?? scene.baseRevisionId;
                                  return api.applyPlotIdeation({
                                    projectId: snapshot.activeProject.projectId,
                                    baseRevisionId: head,
                                    // 掺入本批生成产物 ID：proposalId（scene-1 等）跨批次重复不会撞幂等键。
                                    acceptanceId: `plot_next_${nextSceneArtifactId || `legacy_${sc.proposalId}`}_${sc.proposalId}`,
                                    mode: "next_scene",
                                    sceneId: scene.sceneId,
                                    scenes: [sc],
                                  });
                                })
                                .then(async (res) => {
                                  setNextSceneCards([]);
                                  await onChanged();
                                  if (res.scenes[0]) onSelectScene(res.scenes[0].sceneId);
                                })
                                .catch((err) => setTaskNote(err instanceof Error ? err.message : "采用下一场失败"))
                                .finally(() => setNextSceneBusy(false));
                            }}
                          >
                            <Check size={12} />
                            采用并跳至下一场
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {outcome && outcome.sceneId === scene.sceneId && outcome.type !== "report" && (
              <section className={`candidate-panel ${outcome.stale || outcome.baseBody !== body ? "is-stale" : ""}`}>
                <div className="candidate-heading"><div><Sparkles size={16} /><strong>{outcome.incomplete ? "不完整候选" : outcome.type === "replacement" ? "选段改写" : "接着写的候选"}</strong><Badge tone="violet">未进入正文</Badge></div><button className="icon-button" onClick={() => { void api.recordInteraction({ projectId: scene.projectId, sceneId: scene.sceneId, kind: "candidate-dismiss" }).catch(() => undefined); setOutcome(null); }} aria-label="关闭候选"><X size={15} /></button></div>
                {(outcome.stale || outcome.baseBody !== body) && <p className="stale-warning"><CircleAlert size={14} />{outcome.type === "replacement" ? "原文已变化，不能直接替换。请重新选择要推敲的文字。" : "你在生成期间修改了原文。候选仍保留，请比较后决定是否采用。"}</p>}
                <div className={`candidate-text ${compare ? "compare" : ""}`}>
                  {compare && <div><span>{outcome.type === "replacement" ? "原选段" : "当前结尾"}</span><p>{outcome.type === "replacement" ? outcome.range.baseText : body.slice(-600)}</p></div>}
                  <div><span>{outcome.type === "replacement" ? "改写后" : compare ? "候选段落" : "将接在正文末尾"}</span><p>{outcome.text}</p></div>
                </div>
                {outcome.proposals.length > 0 && (
                  <div className="proposal-list"><span>需要你决定的新事实（不会自动写入设定）</span>{outcome.proposals.map((item, index) => <p key={index}><CircleHelp size={12} />{item}</p>)}</div>
                )}
                <div className="candidate-actions">
                  <button className="button primary small" disabled={outcome.type === "replacement" && (outcome.stale || outcome.baseBody !== body || !outcome.range.baseText || body.slice(outcome.range.from, outcome.range.to) !== outcome.range.baseText)} onClick={acceptOutcome}><Check size={14} />{outcome.type === "replacement" ? "替换选段" : "接到正文末尾"}</button>
                  <button className="button ghost small" onClick={() => setCompare((value) => !value)}><Columns2 size={14} />{compare ? "收起比较" : "比较原文"}</button>
                  <button className="button ghost small" disabled={!lastRequest || Boolean(running)} onClick={() => lastRequest && void generate(lastRequest)}><WandSparkles size={14} />再试一稿</button>
                </div>
                <p className="candidate-provenance"><LibraryBig size={12} />{lastRequest?.label ?? "候选"} · 使用 {relatedEvidence.length} 条原文证据 · {entities.length} 个场景元素 · 主稿 {scene.baseRevisionId.slice(0, 12)}</p>
              </section>
            )}
          </article>
        </div>

        {editorState?.hasSelection && !running && (
          <div className="selection-toolbar"><Highlighter size={14} /><span>已选 {countWords(editorState.selectedText)} 字</span><button onClick={() => polishSelection("tighten")}>推敲表达</button><button onClick={() => polishSelection("expand")}>扩写</button><button onClick={checkSelection}>检查</button><button onClick={() => void createAnnotationDraft()}>批注</button></div>
        )}

        <div className="editor-bottom-bar"><span>{wordCount.toLocaleString("zh-CN")} 字</span><span>正文 {Number(manuscriptSize.toFixed(1))}px · 行距 2</span><span className="editor-bottom-spacer" /><button onClick={onOpenReview}><CircleAlert size={13} />{snapshot.facts.some((fact) => fact.reviewState === "candidate") ? "有待确认变化" : "暂无待确认变化"}</button></div>
      </main>

      {rightOpen && !focusMode && (
        <aside className="assistant-sidebar">
          <div className="assistant-tabs" role="tablist"><button className={assistantTab === "assistant" ? "active" : ""} onClick={() => setAssistantTab("assistant")}>助手</button><button className={assistantTab === "context" ? "active" : ""} onClick={() => setAssistantTab("context")}>上下文 <span>{relatedEvidence.length}</span></button><button className={assistantTab === "scene" ? "active" : ""} onClick={() => setAssistantTab("scene")}>场景卡</button><button className={assistantTab === "annotations" ? "active" : ""} onClick={() => setAssistantTab("annotations")}>批注</button><button className={assistantTab === "revision" ? "active" : ""} onClick={() => setAssistantTab("revision")}>修订</button></div>
          {assistantTab === "assistant" && (
            <div className="assistant-content">
              <div className="assistant-intro"><span className="assistant-mark"><Sparkles size={18} /></span><div><strong>写作搭档</strong><p>基于这一场，帮你往下走。</p></div></div>
              {!aiReady && (
                <button className="setup-callout" onClick={onOpenSettings}><IconCore size={18} /><span><strong>接入一个模型</strong><small>添加 provider 后即可续写、推敲和检查</small></span><ArrowRight size={14} /></button>
              )}
              {aiReady && <WritingModelPicker settings={agentSettings} onSelect={onSelectTaskModel} onOpenSettings={onOpenSettings} />}
              <section className="next-action-bar" aria-label="建议的下一步"><div><span>下一步</span><strong>{nextAction.title}</strong><p>{nextAction.reason}</p></div><button className="button secondary small" disabled={Boolean(running) && nextAction.kind !== "review-candidate" && nextAction.kind !== "compare"} onClick={() => performNextAction(nextAction.kind)}>{nextAction.buttonLabel}<ArrowRight size={13} /></button></section>
              <div className="writing-intent-picker" role="group" aria-label="选择本场写作意图">{(Object.keys(SCENE_INTENTS) as SceneWritingIntent[]).map((intent) => <button key={intent} className={sceneIntent === intent ? "active" : ""} onClick={() => setSceneIntent(intent)}>{SCENE_INTENTS[intent].label}</button>)}</div>
              <p className="writing-intent-hint">{activeSceneIntent.hint} · 只影响本次生成，不给场景贴永久标签</p>
              <div className="quick-actions">
                <button disabled={Boolean(running)} onClick={() => void generate({ kind: "scene", label: activeSceneIntent.label, input: `${activeSceneIntent.instruction}${prompt.trim() ? `\n作者补充要求：${prompt.trim()}` : ""}` })}><span><WandSparkles size={16} /></span><div><strong>接着这场写</strong><small>只写新段落，接在正文末尾</small></div><ArrowRight size={14} /></button>
                <button disabled={Boolean(running)} onClick={() => editorState?.hasSelection ? polishSelection("tighten") : setTaskNote("先在正文里选中想推敲的一段，再点这里。")}><span><Highlighter size={16} /></span><div><strong>推敲这一段</strong><small>选中一段，只替换那一段</small></div><ArrowRight size={14} /></button>
                <button disabled={Boolean(running)} onClick={() => void generate({ kind: "consistency", label: "前后照应检查", input: "检查当前场景正文与已确认设定、人物知识和物品状态是否一致。" })}><span><CheckCircle2 size={16} /></span><div><strong>检查前后照应</strong><small>用证据说话，未知不当作错误</small></div><ArrowRight size={14} /></button>
                <button disabled={Boolean(running)} onClick={() => void generate({ kind: "consistency", label: "场景复盘", input: SCENE_REVIEW_INTENT })}><span><BookOpen size={16} /></span><div><strong>复盘这场</strong><small>看结果与可能的下一步，不给正文打分</small></div><ArrowRight size={14} /></button>
                <button
                  disabled={Boolean(running) || extractBusy || !body.trim()}
                  onClick={() => {
                    setExtractBusy(true);
                    setTaskNote("正在扫描本场正文并核验原句证据…");
                    void flushPendingChanges()
                      .then(() => api.extractLedger({ projectId: snapshot.activeProject.projectId, sceneId: scene.sceneId }))
                      .then((bundle) => {
                        setExtractBundle(bundle);
                        setTaskNote("已提取本场新元素、事实与事件提案，请审阅后入库。");
                      })
                      .catch((err) => setTaskNote(err instanceof Error ? err.message : "提取设定失败"))
                      .finally(() => setExtractBusy(false));
                  }}
                >
                  <span>{extractBusy ? <LoaderCircle size={16} className="spin" /> : <LibraryBig size={16} />}</span>
                  <div>
                    <strong>从本场提取设定与状态</strong>
                    <small>自动核验正文原句证据，经你确认后入库</small>
                  </div>
                  <ArrowRight size={14} />
                </button>
              </div>
              {extractBundle && extractBundle.sceneId === scene.sceneId && (
                <section className="note-composer" style={{ marginBottom: 12 }} aria-label="本场设定提取审阅">
                  <div className="note-composer-heading">
                    <LibraryBig size={16} />
                    <div>
                      <strong>正文反向提取审阅</strong>
                      <p>
                        新元素 {extractBundle.newElements.length} · 事实 {extractBundle.factProposals.length} · 事件{" "}
                        {extractBundle.eventProposals.length}
                      </p>
                    </div>
                    <button className="button ghost small" onClick={() => setExtractBundle(null)}>
                      关闭
                    </button>
                  </div>
                  {extractBundle.newElements.map((el) => (
                    <div key={el.proposalId} className="fact-card">
                      <strong>
                        新元素：{el.name}（{el.type}）
                      </strong>
                      <small>{el.summary}</small>
                      <small style={{ opacity: 0.75 }}>证据原句：「{el.quote.slice(0, 60)}」</small>
                    </div>
                  ))}
                  {extractBundle.factProposals.map((fp) => (
                    <div key={fp.proposalId} className="fact-card">
                      <strong>
                        事实：{fp.subjectName} · {fp.predicate} = {fp.value}
                      </strong>
                      <small style={{ opacity: 0.75 }}>证据原句：「{fp.quote.slice(0, 60)}」</small>
                    </div>
                  ))}
                  {extractBundle.eventProposals.map((ep) => (
                    <div key={ep.proposalId} className="fact-card">
                      <strong>
                        事件：{ep.subjectName} · {ep.kind} → {ep.toValue}
                      </strong>
                      <small style={{ opacity: 0.75 }}>证据原句：「{ep.quote.slice(0, 60)}」</small>
                    </div>
                  ))}
                  <div className="note-composer-actions">
                    <span>全部绑定确定性段落证据 ID</span>
                    <button
                      className="button primary small"
                      disabled={extractBusy}
                      onClick={() => {
                        setExtractBusy(true);
                        void api
                          .applyExtractedLedger({
                            projectId: snapshot.activeProject.projectId,
                            sceneId: scene.sceneId,
                            acceptanceId: `extract_${scene.sceneId}_${extractBundle.revisionId}`,
                            newElements: extractBundle.newElements,
                            factProposals: extractBundle.factProposals,
                            eventProposals: extractBundle.eventProposals,
                          })
                          .then(async () => {
                            setExtractBundle(null);
                            await onChanged();
                            setTaskNote("已将提取的元素、事实与状态事件写入元素账本。");
                          })
                          .catch((err) => setTaskNote(err instanceof Error ? err.message : "入库失败"))
                          .finally(() => setExtractBusy(false));
                      }}
                    >
                      <Check size={13} />
                      全部确认入库
                    </button>
                  </div>
                </section>
              )}
              <div className="assistant-divider"><span>本场写作依据</span></div>
              <section className="context-group"><div className="context-group-title"><ChevronDown size={13} /><strong>必须遵守</strong><span>{entities.length + 1}</span></div><div className="constraint-card"><BookOpen size={15} /><div><strong>选定计划 · 拟发生</strong><p>{scene.goal || scene.summary || "由当前正文继续发展"}</p></div></div>{entities.slice(0, 2).map((entity) => <button className="entity-context-row" key={entity.entityId} onClick={() => onOpenElement(entity.entityId)}><span className={`entity-glyph ${entity.type}`}>{entity.name.slice(0, 1)}</span><span><strong>{entity.name}</strong><small>{entity.summary}</small></span><ChevronRight size={13} /></button>)}</section>
              <section className="context-group"><div className="context-group-title"><ChevronDown size={13} /><strong>原文证据</strong><span>{relatedEvidence.length}</span></div>{relatedEvidence.length ? relatedEvidence.slice(0, 2).map((item) => <blockquote key={item.evidenceId}>{item.quote}<cite>{item.sourceKind === "manuscript" ? "已采用正文" : "作者设定"} · {item.sourceRevisionId.slice(0, 8)}</cite></blockquote>) : <p className="quiet-empty">新场景还没有额外检索证据，将优先使用你的输入与计划。</p>}</section>
              {taskNote && <p className="task-note"><Sparkles size={13} />{taskNote}</p>}
              <div className="assistant-spacer" />
              <div className="agent-note"><span className={`status-dot ${aiReady ? "online" : ""}`} /><p>{aiReady ? "内置 AI 搭档 · 模型按任务分配，可在“模型与服务”调整" : "尚未接入模型；写作、保存与版本功能可正常使用"}</p></div>
              {promptOpen && <div className="prompt-composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} aria-label="本次写作要求" placeholder="例如：让对白更克制，保留父女都没有说出口的关心。" /><div><button className="text-button" onClick={() => setPromptOpen(false)}>收起</button><button className="button primary small" disabled={Boolean(running) || !prompt.trim()} onClick={() => { setPromptOpen(false); void generate({ kind: "scene", label: "按要求接着写", input: prompt.trim() }); }}><Send size={13} />生成候选</button></div></div>}
              {!promptOpen && <button className="assistant-input" onClick={() => setPromptOpen(true)}><span>{prompt.trim() || "说说这场戏还需要什么…"}</span><Send size={15} /></button>}
            </div>
          )}
          {assistantTab === "context" && <ContextPanel snapshot={snapshot} scene={scene} />}
          {assistantTab === "scene" && <ScenePanel key={scene.sceneId} scene={scene} onSave={(changes) => onSave({ ...changes, body: bodyRef.current })} />}
          {assistantTab === "annotations" && <AnnotationPanel key={scene.sceneId} snapshot={snapshot} scene={scene} body={body} {...(annotationDraft ? { draftRange: annotationDraft } : {})} onClearDraft={() => setAnnotationDraft(null)} onChanged={onChanged} />}
          {assistantTab === "revision" && <RevisionPanel key={scene.sceneId} snapshot={snapshot} scene={scene} body={body} hasSelection={Boolean(editorState?.hasSelection)} onSceneSave={(changes) => onSave({ ...changes, body: bodyRef.current })} onGenerate={generate} onPolish={polishSelection} onOpenAnnotations={() => setAssistantTab("annotations")} onTaskNote={setTaskNote} />}
        </aside>
      )}
    </div>
  );
}

function toolLabel(name: string): string {
  return ({ novel_search: "资料检索", novel_get_scene: "场景", novel_list_elements: "元素列表", novel_get_element: "元素详情", novel_world_state: "世界状态" } as Record<string, string>)[name] ?? name;
}

function ContextPanel({ snapshot, scene }: { snapshot: WorkspaceSnapshot; scene: Scene }) {
  const evidence = snapshot.evidence.filter((item) => !item.sceneId || item.sceneId === scene.sceneId);
  return <div className="side-panel-content"><p className="eyebrow">VISIBLE TO THIS TASK</p><h3>这次生成能看到什么</h3><p className="panel-description">先按主稿、故事路线与人物知识边界过滤，再选择原文。候选不会混进事实清单。</p><div className="context-summary"><span><strong>{snapshot.facts.length}</strong>已确认事实</span><span><strong>{evidence.length}</strong>原文证据</span></div>{evidence.map((item) => <blockquote key={item.evidenceId}>{item.quote}<cite>{item.sourceKind} · {item.sourceRevisionId.slice(0, 10)}</cite></blockquote>)}{!evidence.length && <p className="quiet-empty">暂无历史证据。这是正常的新故事状态。</p>}</div>;
}

export function ScenePanel({ scene, onSave }: { scene: Scene; onSave: (scene: Scene) => Promise<void> }) {
  const [goal, setGoal] = useState(scene.goal ?? "");
  const [conflict, setConflict] = useState(scene.conflict ?? "");
  const [change, setChange] = useState(scene.summary);
  const [pov, setPov] = useState(scene.pov ?? "");
  const [storyTime, setStoryTime] = useState(scene.storyTime ?? "");
  const [saved, setSaved] = useState(false);
  const [brainstormBusy, setBrainstormBusy] = useState<"goal" | "conflict" | "summary" | null>(null);
  const [brainstormTarget, setBrainstormTarget] = useState<"goal" | "conflict" | "summary">("conflict");
  const [brainstormOptions, setBrainstormOptions] = useState<SceneFieldOption[]>([]);
  const [brainstormError, setBrainstormError] = useState("");
  const update = (setter: (value: string) => void, value: string) => { setter(value); setSaved(false); };
  const runBrainstorm = (target: "goal" | "conflict" | "summary") => {
    if (brainstormBusy) return;
    setBrainstormBusy(target);
    setBrainstormTarget(target);
    setBrainstormError("");
    void api
      .plotIdeate({
        projectId: scene.projectId,
        mode: "scene_brainstorm",
        sceneId: scene.sceneId,
        fieldTarget: target,
      })
      .then((res) => setBrainstormOptions(res.fieldOptions ?? []))
      .catch((cause) => { setBrainstormOptions([]); setBrainstormError(cause instanceof Error ? cause.message : "AI 场景建议未完成，请重试"); })
      .finally(() => setBrainstormBusy(null));
  };
  const applyBrainstorm = (val: string) => {
    if (brainstormTarget === "goal") update(setGoal, val);
    else if (brainstormTarget === "conflict") update(setConflict, val);
    else update(setChange, val);
    setBrainstormOptions([]);
  };
  return (
    <div className="side-panel-content">
      <p className="eyebrow">SCENE INTENTION</p><h3>{scene.title}</h3><p className="panel-description">只填此刻有用的一项，其余可以留空。结果不必是失败或反转，也可以是决定、关系或信息变化。</p>
      <div className="scene-causality" aria-label="本场行动线预览">
        <span>本场行动线 · 拟发生</span>
        <div><p><b>目标</b>{goal.trim() || "尚未决定"}</p><i>→</i><p><b>阻碍</b>{conflict.trim() || "尚未决定"}</p><i>→</i><p><b>结果 / 变化</b>{change.trim() || "尚未决定"}</p></div>
        <small>用来检查计划的因果连接，不给正文评分。</small>
      </div>
      {brainstormError && <p className="inline-note error" role="alert">{brainstormError}</p>}
      {brainstormOptions.length > 0 && (
        <div className="note-composer" style={{ marginBottom: 10 }} aria-label="场景字段AI急救候选">
          <div className="note-composer-heading">
            <Sparkles size={15} />
            <div>
              <strong>AI 帮我想「{brainstormTarget === "goal" ? "目标" : brainstormTarget === "conflict" ? "阻碍" : "结果"}」</strong>
            </div>
            <button className="button ghost small" onClick={() => setBrainstormOptions([])}>收起</button>
          </div>
          {brainstormOptions.map((opt) => (
            <div key={opt.optionId} className="fact-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <strong>{opt.label}</strong>
              <small>{opt.value}</small>
              <button className="button primary small" onClick={() => applyBrainstorm(opt.value)}><Check size={12} />填入此项</button>
            </div>
          ))}
        </div>
      )}
      <label className="field-label">
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          这场戏要发生什么
          <button type="button" className="text-button" disabled={brainstormBusy !== null} onClick={() => runBrainstorm("goal")}>
            {brainstormBusy === "goal" ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}AI 帮我想目标
          </button>
        </span>
        <textarea value={goal} placeholder="例如：阿禾想在关门前结清最后一笔旧账" onChange={(event) => update(setGoal, event.target.value)} rows={3} />
      </label>
      <label className="field-label">
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          真正的阻碍
          <button type="button" className="text-button" disabled={brainstormBusy !== null} onClick={() => runBrainstorm("conflict")}>
            {brainstormBusy === "conflict" ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}AI 帮我想阻碍
          </button>
        </span>
        <textarea value={conflict} placeholder="例如：取鞋的人说出的年份对不上" onChange={(event) => update(setConflict, event.target.value)} rows={3} />
      </label>
      <label className="field-label">
        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          预期结果 / 场景摘要
          <button type="button" className="text-button" disabled={brainstormBusy !== null} onClick={() => runBrainstorm("summary")}>
            {brainstormBusy === "summary" ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}AI 帮我想结果
          </button>
        </span>
        <textarea value={change} placeholder="例如：阿禾决定先修鞋，再询问收据来历；关店计划没有改变" onChange={(event) => update(setChange, event.target.value)} rows={3} />
      </label>
      <label className="field-label">视角人物（POV）<input aria-label="场景卡视角人物" value={pov} placeholder="例如：阿禾" onChange={(event) => update(setPov, event.target.value)} /></label>
      <label className="field-label">故事时间（storyTime）<input aria-label="场景卡故事时间" value={storyTime} placeholder="例如：1 或 第一夜" onChange={(event) => update(setStoryTime, event.target.value)} /></label>
      <div className="scene-fact"><span>叙述顺序</span><strong>{scene.narrationOrder}</strong></div>
      <button className="button primary full" onClick={() => void onSave({ ...scene, goal, conflict, summary: change, ...(pov.trim() ? { pov: pov.trim() } : { pov: "" }), ...(storyTime.trim() ? { storyTime: storyTime.trim() } : { storyTime: "" }) }).then(() => setSaved(true)).catch(() => undefined)}>{saved ? <Check size={14} /> : <Save size={14} />}{saved ? "场景卡已保存" : "保存场景卡"}</button>
      <p className="panel-footnote"><FilePlus2 size={13} />计划只表示“拟发生”，采用正文后才会成为稿件证据。</p>
    </div>
  );
}
