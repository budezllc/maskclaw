import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyAppearance,
  nextAppearance,
  parseAppearance,
  persistAppearance,
  readAppearance,
  themeToggleLabel,
  themeActionWord,
} from "./theme";

describe("appearance", () => {
  it("defaults unknown values to dark", () => {
    expect(parseAppearance(null)).toBe("dark");
    expect(parseAppearance("sepia")).toBe("dark");
    expect(parseAppearance("light")).toBe("light");
  });

  it("toggles dark and light", () => {
    expect(nextAppearance("dark")).toBe("light");
    expect(nextAppearance("light")).toBe("dark");
  });

  it("labels the control as the theme it will switch to", () => {
    expect(themeToggleLabel("dark")).toBe("Light theme");
    expect(themeToggleLabel("light")).toBe("Dark theme");
    expect(themeActionWord("dark")).toBe("Light");
    expect(themeActionWord("light")).toBe("Dark");
  });

  it("reads and persists through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(readAppearance(storage)).toBe("dark");
    persistAppearance("light", storage);
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
    expect(readAppearance(storage)).toBe("light");
  });

  it("stamps the document for CSS and native color-scheme", () => {
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: "" } };
    applyAppearance("light", root);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    applyAppearance("dark", root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});
