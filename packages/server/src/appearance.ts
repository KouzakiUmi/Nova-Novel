import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DomainError } from "./domain.js";

export interface AppearanceSettings {
  uiFont: "builtin" | "system";
  manuscriptFont: "builtin" | "wenkai" | "system";
  manuscriptScale: number;
}

const DEFAULT_APPEARANCE: AppearanceSettings = { uiFont: "builtin", manuscriptFont: "builtin", manuscriptScale: 100 };

export function readAppearanceSettings(dataDir: string): AppearanceSettings {
  const path = resolve(dataDir, "appearance.json");
  if (!existsSync(path)) return { ...DEFAULT_APPEARANCE };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AppearanceSettings>;
    return {
      uiFont: value.uiFont === "system" ? "system" : "builtin",
      manuscriptFont: value.manuscriptFont === "system" ? "system" : value.manuscriptFont === "wenkai" ? "wenkai" : "builtin",
      manuscriptScale: typeof value.manuscriptScale === "number" && [90, 100, 110, 120].includes(value.manuscriptScale) ? value.manuscriptScale : 100,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}

export function writeAppearanceSettings(dataDir: string, input: Partial<AppearanceSettings>): AppearanceSettings {
  if (input.uiFont !== undefined && !["builtin", "system"].includes(input.uiFont)) throw new DomainError(400, "INVALID_INPUT", "界面字体无效");
  if (input.manuscriptFont !== undefined && !["builtin", "wenkai", "system"].includes(input.manuscriptFont)) throw new DomainError(400, "INVALID_INPUT", "正文字体无效");
  if (input.manuscriptScale !== undefined && (typeof input.manuscriptScale !== "number" || ![90, 100, 110, 120].includes(input.manuscriptScale))) throw new DomainError(400, "INVALID_INPUT", "正文字号无效");
  const next = { ...readAppearanceSettings(dataDir), ...input };
  mkdirSync(dataDir, { recursive: true });
  const path = resolve(dataDir, "appearance.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return next;
}
