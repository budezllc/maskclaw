import { describe, expect, it } from "vitest";
import { formatDryRunForWizard, parseDryRunStderr } from "./dryRunParser";

describe("parseDryRunStderr", () => {
  it("returns null on success", () => {
    expect(parseDryRunStderr("", 0)).toBeNull();
  });

  it("rewrites TOML parse failures", () => {
    const err = parseDryRunStderr(
      'invalid server config C:\\Users\\a\\routes.toml: failed to parse TOML: missing field `targets`',
      1,
    );
    expect(err?.kind).toBe("parse");
    expect(err?.path).toContain("routes.toml");
    expect(err?.userMessage).toMatch(/targets/i);
    expect(formatDryRunForWizard(err!)).not.toMatch(/deny_unknown_fields/i);
  });

  it("never surfaces deny_unknown_fields as a panic", () => {
    const err = parseDryRunStderr(
      "invalid server config routes.toml: failed to parse TOML: deny_unknown_fields: unknown field `hot_reload`",
      2,
    );
    expect(err?.userMessage).toMatch(/does not use/i);
    expect(err?.userMessage).not.toMatch(/panic/i);
    expect(err?.userMessage).not.toMatch(/deny_unknown_fields/i);
  });

  it("rewrites missing API key env validation", () => {
    const err = parseDryRunStderr(
      "invalid server config routes.toml: MINIMAX_API_KEY is missing or empty",
      1,
    );
    expect(err?.kind).toBe("validate");
    expect(err?.userMessage).toMatch(/key is missing/i);
  });

  it("handles empty stderr with a failed exit", () => {
    const err = parseDryRunStderr("", 1);
    expect(err?.kind).toBe("unknown");
    expect(err?.userMessage).toMatch(/did not start/i);
  });
});
