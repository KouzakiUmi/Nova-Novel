import { useCallback, useEffect, useRef, useState } from "react";
import type { NotionConversation, NotionConversationStatus, NotionCopilotAgent, NotionCopilotSettingsView } from "@nova-novel/shared";
import { Copy, LoaderCircle, MessageSquare, Plus, RefreshCw, Send, Settings2, Square } from "lucide-react";
import { notionCopilot } from "../lib/notion-copilot";
import "../notion-copilot.css";

const statusLabels: Record<NotionConversationStatus, string> = { idle: "尚未开始", running: "正在回复", stopping: "正在停止", completed: "回复完成", requires_action: "等待 Notion 操作确认", canceled: "已停止", failed: "本轮失败", interrupted: "运行状态待确认" };
const busyConversation = (item: NotionConversation | undefined) => !!item && ["running", "stopping"].includes(item.status);

/** This view receives no workspace snapshot, scene or authoring callbacks. */
export default function NotionCopilotView() {
  const [settings, setSettings] = useState<NotionCopilotSettingsView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKeyEnv, setApiKeyEnv] = useState("NOTION_API_KEY");
  const [agentId, setAgentId] = useState("");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [agents, setAgents] = useState<NotionCopilotAgent[]>([]);
  const [conversations, setConversations] = useState<NotionConversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);
  const listSequence = useRef(0);
  const operation = useRef(false);
  const draftRef = useRef({ message: "", requestId: "" });
  const transcript = useRef<HTMLDivElement>(null);
  const selected = conversations.find(item => item.id === selectedId);
  const running = busyConversation(selected);
  const anyRunning = conversations.some(busyConversation);
  const ready = !!settings?.enabled && settings.hasToken && !!settings.agentId && !settings.error;

  const applySettings = useCallback((next: NotionCopilotSettingsView) => {
    setSettings(next); setEnabled(next.enabled); setApiKeyEnv(next.apiKeyEnv); setAgentId(next.agentId);
    setToken(""); setClearToken(false);
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++listSequence.current;
    const next = await notionCopilot.list();
    if (!mounted.current || sequence !== listSequence.current) return;
    setConversations(next.conversations);
    setSelectedId(current => current || next.conversations[0]?.id || "");
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([notionCopilot.settings(), notionCopilot.list()]).then(([nextSettings, history]) => {
      if (!mounted.current) return;
      applySettings(nextSettings); setConversations(history.conversations); setSelectedId(history.conversations[0]?.id ?? "");
      setShowSettings(!nextSettings.enabled || !nextSettings.hasToken || !nextSettings.agentId);
    }).catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : "笔记助手加载失败"); })
      .finally(() => { if (mounted.current) setLoaded(true); });
    return () => { mounted.current = false; ++listSequence.current; };
  }, [applySettings]);
  useEffect(() => {
    if (!anyRunning) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (cause) { if (!canceled && mounted.current) setError(cause instanceof Error ? cause.message : "回复状态读取失败"); }
      if (!canceled) timer = setTimeout(() => void poll(), 900);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { canceled = true; clearTimeout(timer); };
  }, [anyRunning, refresh]);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "smooth" }); }, [selectedId, selected?.messages.length, selected?.partialText]);

  const perform = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试"); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const saveSettings = () => perform(async () => {
    const next = await notionCopilot.configure({ enabled, apiKeyEnv: apiKeyEnv.trim(), agentId: agentId.trim(), ...(clearToken ? { token: "" } : token ? { token } : {}) });
    if (!mounted.current) return;
    applySettings(next); setAgents([]); setNotice(next.enabled ? "连接设置已保存，可以读取 Agent 列表验证权限。" : "Notion 笔记助手已关闭。");
  });
  const discover = () => perform(async () => {
    const next = await notionCopilot.agents();
    if (!mounted.current) return;
    setAgents(next.agents);
    setNotice(next.agents.length ? `连接成功，可访问 ${next.agents.length} 个 Agent。选择后保存设置。` : "连接成功，尚无可访问的 Custom Agent。请在 Notion 中创建并授权笔记助手。");
  });
  const create = () => perform(async () => {
    const next = await notionCopilot.create();
    if (!mounted.current) return;
    setSelectedId(next.conversation.id); setMessage(""); draftRef.current = { message: "", requestId: "" }; await refresh();
  });
  const send = () => perform(async () => {
    if (!message.trim() || !selected || running) return;
    const outgoing = message.trim();
    // Reuse the key after an ambiguous network failure; do not charge for a retry twice.
    if (draftRef.current.message !== outgoing) draftRef.current = { message: outgoing, requestId: crypto.randomUUID() };
    await notionCopilot.send(selected.id, outgoing, draftRef.current.requestId);
    if (!mounted.current) return;
    setMessage(""); draftRef.current = { message: "", requestId: "" }; await refresh();
  });
  const cancel = () => perform(async () => { if (selected) { await notionCopilot.cancel(selected.id); await refresh(); } });
  const copy = (body: string, feedback = "回复已复制。") => perform(async () => { await navigator.clipboard.writeText(body); if (mounted.current) setNotice(feedback); });

  return <section className="notion-copilot" aria-label="Notion 笔记助手">
    <header className="notion-heading"><div><span className="notion-eyebrow">外部笔记 · 可选插件</span><h1><MessageSquare size={24} />Notion 笔记助手</h1><p>和 Notion 中的笔记助手对话，查找资料、总结笔记、梳理灵感。</p></div><button className="button secondary" onClick={() => setShowSettings(value => !value)} aria-expanded={showSettings}><Settings2 size={16} />连接设置</button></header>
    {!loaded && <p className="notion-feedback"><LoaderCircle className="spin" size={16} />正在读取笔记助手…</p>}
    {error && <p className="notion-feedback error" role="alert">{error}<button className="button ghost" onClick={() => void perform(refresh)}><RefreshCw size={14} />刷新</button></p>}
    {notice && <p className="notion-feedback" role="status">{notice}</p>}
    {settings?.error && <p className="notion-feedback error" role="alert">{settings.error}</p>}
    {showSettings && <form className="notion-settings" onSubmit={event => { event.preventDefault(); void saveSettings(); }}>
      <div className="notion-settings-title"><h2>连接 Notion</h2><label className="notion-toggle"><input type="checkbox" checked={enabled} disabled={busy || anyRunning} onChange={event => setEnabled(event.target.checked)} />启用笔记助手</label></div>
      <p>使用 Notion 中已有的 Custom Agent。桌面端登录与 API 授权分开；请为笔记助手配置所需的笔记访问权限。调用 Agent 可能消耗 Notion 额度。</p>
      <div className="notion-settings-fields">
        <label>令牌环境变量<input value={apiKeyEnv} maxLength={100} spellCheck={false} disabled={busy || anyRunning} onChange={event => setApiKeyEnv(event.target.value)} placeholder="NOTION_API_KEY" /></label>
        <label>本次运行令牌<input type="password" value={token} autoComplete="off" maxLength={4096} disabled={busy || anyRunning || clearToken} onChange={event => setToken(event.target.value)} placeholder={settings?.hasToken ? "已配置；留空保留" : "可选，仅在应用本次运行中使用"} /></label>
        <label>Notion Agent ID<input value={agentId} maxLength={100} spellCheck={false} disabled={busy || anyRunning} onChange={event => setAgentId(event.target.value)} placeholder="读取列表后选择，或填写 Agent ID" /></label>
        <label>可访问的 Agent<select value={agents.some(agent => agent.id === agentId) ? agentId : ""} disabled={busy || anyRunning || !agents.length} onChange={event => setAgentId(event.target.value)}><option value="">读取 Agent 列表后选择</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}</select></label>
      </div>
      <div className="notion-settings-actions"><button type="submit" className="button primary" disabled={busy || anyRunning || !!settings?.error}>保存设置</button><button type="button" className="button secondary" disabled={busy || anyRunning || !settings?.enabled || !settings.hasToken} onClick={() => void discover()}><RefreshCw size={14} />验证连接并读取 Agent</button><label className="notion-toggle"><input type="checkbox" checked={clearToken} disabled={busy || anyRunning} onChange={event => setClearToken(event.target.checked)} />清除本次运行令牌</label><span>{settings?.tokenSource === "session" ? "凭据来源：本次运行" : settings?.tokenSource === "environment" ? "凭据来源：环境变量" : "尚未配置凭据"}</span></div>
      <p className="notion-help">令牌只在服务端使用。环境变量引用与会话记录单独保存；手动令牌在关闭插件或退出应用后清除。<button type="button" className="button ghost" disabled={busy} onClick={() => void copy("https://developers.notion.com/guides/notion-agent-apis/quickstart", "官方接入说明链接已复制，可在浏览器中打开。")}>复制官方接入说明链接 <Copy size={12} /></button></p>
    </form>}
    {loaded && !settings?.enabled && <div className="notion-disabled"><MessageSquare size={30} /><h2>开启你的外部笔记助手</h2><p>连接 Notion 中的笔记助手后，可以在这里提问并保留对话。</p><button className="button primary" onClick={() => setShowSettings(true)}>配置 Notion 连接</button></div>}
    {settings?.enabled && <div className="notion-workspace">
      <aside className="notion-history" aria-label="笔记对话列表"><button className="button secondary" disabled={!ready || busy} onClick={() => void create()}><Plus size={16} />新对话</button>{conversations.map(item => <button key={item.id} className={`notion-history-item ${item.id === selectedId ? "active" : ""}`} aria-pressed={item.id === selectedId} onClick={() => { setSelectedId(item.id); setMessage(""); draftRef.current = { message: "", requestId: "" }; }}><strong>{item.title}</strong><small>{statusLabels[item.status]}</small></button>)}{!conversations.length && <p>你的笔记对话会保存在这里。</p>}</aside>
      <div className="notion-chat"><div className="notion-chat-title"><strong>{selected?.title ?? "开始一段笔记对话"}</strong>{selected && <span role="status">{statusLabels[selected.status]}</span>}</div>
        <div className="notion-transcript" ref={transcript} aria-label="对话内容" aria-busy={running}>
          {!selected && <div className="notion-chat-empty"><MessageSquare size={32} /><h2>从笔记里找到下一条线索</h2><p>新建对话，试试“总结我最近记录的灵感”或“找出关于某个主题的笔记”。</p></div>}
          {selected?.messages.map(item => <article key={item.id} className={`notion-message ${item.role}`}><header><strong>{item.role === "user" ? "你" : "Notion 笔记助手"}</strong>{item.role === "assistant" && <button className="button ghost" disabled={busy} onClick={() => void copy(item.text)} aria-label="复制回复"><Copy size={13} />复制</button>}</header><div className="notion-message-body">{item.text}</div></article>)}
          {selected?.partialText && <article className="notion-message assistant provisional"><header><strong>Notion 正在回复…</strong></header><div className="notion-message-body">{selected.partialText}</div></article>}
          {running && !selected?.partialText && <p className="notion-waiting"><LoaderCircle className="spin" size={16} />{selected?.status === "stopping" ? "正在停止远端会话…" : "Notion 正在查阅笔记并生成回复…"}</p>}
          {selected?.error && <p className="notion-feedback error" role="alert">{selected.error}</p>}
        </div>
        <form className="notion-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="notion-message">向笔记助手提问</label><textarea id="notion-message" value={message} maxLength={10_000} rows={3} disabled={!selected || !ready || busy || running} onChange={event => setMessage(event.target.value)} placeholder="向 Notion 笔记助手提问…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div><small>消息发送给 Notion · Ctrl / ⌘ + Enter 发送</small>{selected && ["running", "stopping", "interrupted", "requires_action"].includes(selected.status) ? <button type="button" className="button secondary" disabled={busy || selected.status === "stopping"} onClick={() => void cancel()}><Square size={14} />停止远端会话</button> : <button type="submit" className="button primary" disabled={busy || !ready || !selected || !message.trim()}><Send size={14} />发送</button>}</div></form>
      </div>
    </div>}
  </section>;
}
