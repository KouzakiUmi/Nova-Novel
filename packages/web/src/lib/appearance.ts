export interface AppearanceSettings {
  uiFont: "builtin" | "system";
  manuscriptFont: "builtin" | "wenkai" | "system";
  manuscriptScale: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { uiFont: "builtin", manuscriptFont: "builtin", manuscriptScale: 100 };
const STORAGE_KEY = "nova-novel-appearance-v1";

export function readAppearance(): AppearanceSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AppearanceSettings> | null;
    return {
      uiFont: value?.uiFont === "system" ? "system" : "builtin",
      manuscriptFont: value?.manuscriptFont === "system" ? "system" : value?.manuscriptFont === "wenkai" ? "wenkai" : "builtin",
      manuscriptScale: typeof value?.manuscriptScale === "number" && [90, 100, 110, 120].includes(value.manuscriptScale) ? value.manuscriptScale : 100,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}

export function applyAppearance(settings: AppearanceSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--ui-font", settings.uiFont === "builtin" ? '"NovaInterface", "NovaSans", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' : '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif');
  root.style.setProperty("--manuscript-font", settings.manuscriptFont === "wenkai" ? '"LXGW WenKai", "Songti SC", "Noto Serif CJK SC", serif' : settings.manuscriptFont === "builtin" ? '"NovaSerif", "Songti SC", "Noto Serif CJK SC", "STSong", Georgia, serif' : 'Georgia, "Songti SC", "Noto Serif CJK SC", "STSong", serif');
  root.style.setProperty("--manuscript-scale", String(settings.manuscriptScale / 100));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
