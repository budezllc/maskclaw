import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../maskclaw.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const re = /([^{}]+)\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const selectors = match[1].split(",").map((sel) => sel.trim());
    if (selectors.includes(selector)) {
      return match[2];
    }
  }
  throw new Error(`missing CSS rule for ${selector}`);
}

describe("MaskClaw full-width layout", () => {
  it("lets every page use the full main column on a widescreen", () => {
    const page = ruleBody(".mc-page");
    expect(page).toMatch(/width:\s*100%/);
    expect(page).toMatch(/max-width:\s*none/);
    expect(page).not.toMatch(/max-width:\s*72rem/);

    const app = ruleBody(".mc-app");
    expect(app).toMatch(/width:\s*100%/);

    const pane = ruleBody(".mc-app .settings-pane");
    expect(pane).toMatch(/width:\s*100%/);
    expect(pane).toMatch(/max-width:\s*none/);
  });
});
