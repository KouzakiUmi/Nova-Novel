export interface AppearanceSettings {
  uiFont: "builtin" | "system";
  manuscriptFont: "builtin" | "wenkai" | "neo" | "sarasa" | "system";
  uiScale: number;
  manuscriptScale: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { uiFont: "builtin", manuscriptFont: "builtin", uiScale: 100, manuscriptScale: 100 };
const STORAGE_KEY = "nova-novel-appearance-v1";
const UI_SCALES = [90, 100, 110, 120, 130];
const MANUSCRIPT_SCALES = [90, 100, 110, 120];
const DISPLAY_FONT = '"LXGW WenKai", "霞鹜文楷", "NovaSans", "DengXian", "Microsoft YaHei", sans-serif';
const MANUSCRIPT_FONTS: Record<AppearanceSettings["manuscriptFont"], string> = {
  builtin: '"LXGW WenKai", "霞鹜文楷", "LXGW Neo XiHei Screen", "NovaSans", "DengXian", "Microsoft YaHei", sans-serif',
  wenkai: '"LXGW WenKai", "霞鹜文楷", "LXGW Neo XiHei Screen", "NovaSans", "DengXian", "Microsoft YaHei", sans-serif',
  neo: '"LXGW Neo XiHei Screen", "霞鹜新晰黑 屏幕阅读版", "LXGW WenKai", "NovaSans", "DengXian", "Microsoft YaHei", sans-serif',
  sarasa: '"Sarasa UI SC", "更纱黑体 UI SC", "NovaSans", "DengXian", "Microsoft YaHei", sans-serif',
  system: '"DengXian", "Microsoft YaHei", "NovaSans", sans-serif',
};

export function readAppearance(): AppearanceSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AppearanceSettings> | null;
    const manuscriptFont = value?.manuscriptFont;
    return {
      uiFont: value?.uiFont === "system" ? "system" : "builtin",
      manuscriptFont: manuscriptFont === "system" || manuscriptFont === "wenkai" || manuscriptFont === "neo" || manuscriptFont === "sarasa" ? manuscriptFont : "builtin",
      uiScale: typeof value?.uiScale === "number" && UI_SCALES.includes(value.uiScale) ? value.uiScale : 100,
      manuscriptScale: typeof value?.manuscriptScale === "number" && MANUSCRIPT_SCALES.includes(value.manuscriptScale) ? value.manuscriptScale : 100,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}

export function applyAppearance(settings: AppearanceSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--ui-font", settings.uiFont === "builtin" ? '"NovaInterface", "NovaSans", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' : '"Sarasa UI SC", "Segoe UI", "DengXian", "Microsoft YaHei", sans-serif');
  root.style.setProperty("--manuscript-font", MANUSCRIPT_FONTS[settings.manuscriptFont]);
  root.style.setProperty("--manuscript-weight", settings.manuscriptFont === "builtin" ? "500" : "400");
  root.style.setProperty("--display-font", DISPLAY_FONT);
  root.style.setProperty("--ui-scale", String(settings.uiScale / 100));
  root.style.setProperty("--manuscript-scale", String(settings.manuscriptScale / 100));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
