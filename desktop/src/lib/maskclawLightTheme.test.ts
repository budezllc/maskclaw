import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../maskclaw.css"),
  "utf8",
);

function parseRules(source: string): { selectors: string[]; body: string }[] {
  const rules: { selectors: string[]; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    rules.push({
      selectors: match[1]
        .split(",")
        .map((sel) => sel.trim())
        .filter(Boolean),
      body: match[2],
    });
  }
  return rules;
}

function light(sel: string): string {
  return `html.mc-root[data-theme="light"] ${sel}`;
}

function ruleFor(sel: string) {
  const rule = parseRules(css).find((r) => r.selectors.includes(sel));
  expect(rule, `missing light-theme rule for ${sel}`).toBeTruthy();
  return rule!;
}

describe("MaskClaw light-theme buttons", () => {
  it("keeps outline and copy labels readable on a light fill", () => {
    const outline = ruleFor(light(".mc-btn"));
    expect(outline.body).toMatch(/background:\s*#fff/);
    expect(outline.body).toMatch(/color:\s*#111/);

    const copy = ruleFor(light(".mc-copy"));
    expect(copy.body).toMatch(/background:\s*#fff/);
    expect(copy.body).toMatch(/color:\s*#111/);
  });

  it("keeps primary fill dark with white text", () => {
    const primary = ruleFor(light(".mc-btn.primary"));
    expect(primary.body).toMatch(/background:\s*#111/);
    expect(primary.body).toMatch(/color:\s*#fff/);
  });
});
