import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Check, RotateCcw, Type } from "lucide-react";
import { applyAppearance, DEFAULT_APPEARANCE, readAppearance, type AppearanceSettings } from "../lib/appearance";
import { Badge } from "./UI";

let appearanceQueue: Promise<unknown> = Promise.resolve();

export function AppearanceView() {
  const [settings, setSettings] = useState<AppearanceSettings>(() => readAppearance());
  const settingsRef = useRef(settings);
  const sequence = useRef(0);
  const [saveState, setSaveState] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void appearanceQueue.then(() => api.appearance(), () => api.appearance()).then(saved => { if (active && sequence.current === 0) { settingsRef.current = saved; setSettings(saved); applyAppearance(saved); setSaveState("saved"); } }).catch(cause => { if (active && sequence.current === 0) { setSaveState("error"); setError(cause instanceof Error ? cause.message : "未能读取已保存的外观设置"); } });
    return () => { active = false; };
  }, []);
  const persist = (next: AppearanceSettings) => {
    const seq = ++sequence.current;
    setSaveState("saving"); setError("");
    const task = appearanceQueue.then(() => api.saveAppearance(next), () => api.saveAppearance(next));
    appearanceQueue = task;
    void task.then(() => { if (seq === sequence.current) setSaveState("saved"); }).catch(cause => { if (seq === sequence.current) { setSaveState("error"); setError(cause instanceof Error ? cause.message : "外观尚未保存"); } });
  };
  const update = (patch: Partial<AppearanceSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next); applyAppearance(next); persist(next);
  };
  return (
    <div className="settings-page page-scroll appearance-page">
      <header className="page-toolbar"><div><p className="eyebrow">TYPE & READING</p><h1>界面与字体</h1><p>选择适合长时间写作和阅读的字体。默认使用应用内置字体，离线也能保持一致。</p></div><Badge tone={saveState === "saved" ? "green" : "amber"}><Check size={12} />{saveState === "saved" ? "已保存在本机" : saveState === "error" ? "当前预览 · 尚未保存" : saveState === "loading" ? "正在读取设置" : "当前预览 · 保存中"}</Badge></header>
      {error && <p className="inline-note error" role="alert">{error} · 当前预览已保留。<button className="button ghost small" onClick={() => persist(settingsRef.current)}>重试保存</button></p>}
      <div className="appearance-layout">
        <main>
          <section className="settings-section appearance-section">
            <div className="settings-section-head"><div><h2>字体选择</h2><p>界面与正文分开设置。修改即时预览，保存成功后会在这台设备上保留，不影响作品内容。</p></div><button className="button ghost small" onClick={() => update({ ...DEFAULT_APPEARANCE })}><RotateCcw size={13} />恢复默认</button></div>
            <div className="appearance-fields">
              <label className="field-label"><span>界面字体</span><select aria-label="界面字体" value={settings.uiFont} onChange={event => update({ uiFont: event.target.value as AppearanceSettings["uiFont"] })}><option value="builtin">内置无衬线（默认）</option><option value="system">跟随系统</option></select><small>Inter + Noto Sans CJK，适合导航、按钮和设置项。</small></label>
              <label className="field-label"><span>正文字体</span><select aria-label="正文字体" value={settings.manuscriptFont} onChange={event => update({ manuscriptFont: event.target.value as AppearanceSettings["manuscriptFont"] })}><option value="builtin">霞鹜文楷 Medium（默认）</option><option value="wenkai">霞鹜文楷 Regular</option><option value="neo">霞鹜新晰黑 · 屏幕阅读（本机）</option><option value="sarasa">更纱黑体 UI SC（本机）</option><option value="system">等线 / 系统黑体</option></select><small>默认用 Medium 字重减轻长时间阅读的纤细感；本机字体未安装时回退到内置文楷或黑体，不使用宋体。</small></label>
            </div>
            <div className="appearance-scale"><span>界面字号</span><div className="segmented-control" role="group" aria-label="界面字号">{[90, 100, 110, 120, 130].map(scale => <button key={scale} className={settings.uiScale === scale ? "active" : ""} onClick={() => update({ uiScale: scale })}>{scale === 90 ? "紧凑" : scale === 100 ? "标准" : scale === 110 ? "较大" : scale === 120 ? "特大" : "最大"}<small>{scale}%</small></button>)}</div></div>
            <div className="appearance-scale"><span>正文字号</span><div className="segmented-control" role="group" aria-label="正文字号">{[90, 100, 110, 120].map(scale => <button key={scale} className={settings.manuscriptScale === scale ? "active" : ""} onClick={() => update({ manuscriptScale: scale })}>{scale === 90 ? "紧凑" : scale === 100 ? "标准" : scale === 110 ? "较大" : "特大"}<small>{scale}%</small></button>)}</div></div>
          </section>
          <section className="settings-section appearance-preview-section">
            <div className="settings-section-head"><div><h2>实时预览</h2><p>检查界面层级与正文阅读感。</p></div></div>
            <div className="appearance-ui-preview"><div><strong>故事画布</strong><Badge tone="green">写作中</Badge></div><p>章节、场景和设置项使用界面字体。</p><div className="appearance-preview-actions"><button className="button primary small">主要操作</button><button className="button ghost small">次要操作</button></div></div>
            <article className="appearance-manuscript-preview"><p className="eyebrow">SCENE 01</p><h2>关门前的收据</h2><p>阿禾把最后一只鞋楦收进纸箱，卷帘门外的雨还没停。柜台底下卡着一张收据，纸黄了，红色印章倒很清楚：已付，待取。</p><p>她认得父亲的字。可那双鞋她今天才第一次见。</p></article>
          </section>
        </main>
        <aside className="appearance-notes"><Type size={22} /><h3>字体来源</h3><p>默认文楷和界面字体随应用内置，不需要访问字体 CDN。标记“本机”的阅读字体只在本机已安装时使用，不随应用复制；缺失时自动使用内置文楷或黑体。</p><ul><li>霞鹜文楷 · SIL Open Font License 1.1（默认）</li><li>Inter / Noto Sans CJK · SIL Open Font License 1.1</li><li>霞鹜新晰黑 · IPA Font License（本机）</li><li>更纱黑体 UI SC · 本机阅读字体</li></ul><div className="appearance-license-links"><a href="fonts/INTER-LICENSE.txt" target="_blank" rel="noreferrer">Inter 许可</a><a href="fonts/NOTO-SANS-LICENSE.txt" target="_blank" rel="noreferrer">Noto Sans 许可</a><a href="fonts/LXGW-LICENSE.txt" target="_blank" rel="noreferrer">文楷许可</a></div></aside>
      </div>
    </div>
  );
}
