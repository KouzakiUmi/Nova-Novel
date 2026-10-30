import { useMemo, useState } from "react";
import type { AgentSettingsView, TaskKind } from "@nova-novel/shared";

const TASK_LABELS = {
  scene: "续写场景",
  polish: "推敲 / 扩写",
  consistency: "检查 / 复盘",
} as const;

type WritingTaskKind = keyof typeof TASK_LABELS;

interface WritingModelPickerProps {
  settings: AgentSettingsView | null;
  onSelect: (kind: TaskKind, provider?: string, modelId?: string) => Promise<unknown>;
  onOpenSettings: () => void;
}

export function WritingModelPicker({ settings, onSelect, onOpenSettings }: WritingModelPickerProps) {
  const [kind, setKind] = useState<WritingTaskKind>("scene");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const models = useMemo(() => (settings?.models ?? []).filter(model => model.available), [settings]);
  const route = settings?.routes.find(item => item.kind === kind);
  const selected = route?.provider && route?.modelId && models.some(model => model.provider === route.provider && model.modelId === route.modelId)
    ? `${route.provider}\u0000${route.modelId}`
    : "";
  const defaultModel = models[0];
  const currentModel = selected ? models.find(model => `${model.provider}\u0000${model.modelId}` === selected) : defaultModel;
  const providers = [...new Set(models.map(model => model.provider))];

  const choose = async (value: string) => {
    const [provider, modelId] = value.split("\u0000");
    setSaving(true);
    setError("");
    try {
      await onSelect(kind, provider || undefined, modelId || undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型分配尚未保存");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="writing-model-picker" aria-label="执行模型">
      <div className="writing-model-picker-heading"><strong>执行模型</strong><small>按任务保存，生成前等待设置写入</small></div>
      {!settings ? <p className="quiet-empty">正在读取模型设置…</p> : models.length === 0 ? (
        <button className="text-button" onClick={onOpenSettings}>没有可用模型，前往模型与服务</button>
      ) : (
        <>
          <div className="writing-model-picker-fields">
            <select aria-label="写作任务类型" value={kind} disabled={saving} onChange={event => { setKind(event.target.value as WritingTaskKind); setError(""); }}>
              {Object.entries(TASK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select aria-label={`${TASK_LABELS[kind]}实际执行模型`} title={currentModel ? `${currentModel.provider} / ${currentModel.name}` : undefined} value={selected} disabled={saving} onChange={event => void choose(event.target.value)}>
              <option value="">默认 · {defaultModel?.name ?? "无"}</option>
              {providers.map(provider => <optgroup key={provider} label={provider}>{models.filter(model => model.provider === provider).map(model => <option key={`${model.provider}:${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>{model.name}</option>)}</optgroup>)}
            </select>
          </div>
          {saving && <p className="writing-model-picker-status" role="status">正在保存模型分配…</p>}
          {error && <p className="inline-note error" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
