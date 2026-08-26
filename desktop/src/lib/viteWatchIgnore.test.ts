import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const viteConfig = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../vite.config.ts"),
  "utf8",
);

describe("Vite watch ignores", () => {
  it("skips cargo sidecar staging so HMR is not killed by a locked exe", () => {
    expect(viteConfig).toContain("**/.sidecar-stage/**");
  });
});
