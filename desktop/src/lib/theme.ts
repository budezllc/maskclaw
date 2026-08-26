export type Appearance = "dark" | "light";

export const THEME_STORAGE_KEY = "switchyard.appearance";

export function parseAppearance(raw: string | null | undefined): Appearance {
  return raw === "light" ? "light" : "dark";
}

export function nextAppearance(current: Appearance): Appearance {
  return current === "dark" ? "light" : "dark";
}

export function themeToggleLabel(current: Appearance): string {
  return current === "dark" ? "Light theme" : "Dark theme";
}

/** Short caption for the MaskClaw sidebar toggle (matches the web dashboard). */
export function themeActionWord(current: Appearance): string {
  return current === "dark" ? "Light" : "Dark";
}

export function readAppearance(storage: Pick<Storage, "getItem"> | null = defaultStorage()): Appearance {
  try {
    return parseAppearance(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function persistAppearance(
  theme: Appearance,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode / missing storage */
  }
}

export function applyAppearance(
  theme: Appearance,
  root: { dataset: DOMStringMap; style: { colorScheme: string } } = document.documentElement,
): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
