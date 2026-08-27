import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MASKCLAW_NAV_ITEMS } from "./maskclawNav";
import { RAIL_ITEMS, X_PROFILE_HANDLE, X_PROFILE_URL, defaultClientModel, isAllowedExternalUrl } from "./railNav";

describe("rail nav", () => {
  it("names the board Home instead of Open", () => {
    expect(RAIL_ITEMS.map((item) => item.label)).toEqual(["Home", "Setup", "Settings"]);
  });

  it("uses the web Yard pages for MaskClaw and never lists BOX", () => {
    expect(MASKCLAW_NAV_ITEMS.map((item) => item.label)).toEqual(["HOME", "MASKED", "MODELS", "SETTINGS"]);
    expect(MASKCLAW_NAV_ITEMS.some((item) => item.label === "BOX" || item.pane === "box")).toBe(false);
  });

  it("does not show a Yard heading under MASKCLAW", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../components/maskclaw/MaskClawApp.tsx"),
      "utf8",
    );
    expect(src).toContain("MASKCLAW");
    expect(src).not.toMatch(/mc-group-label/);
    expect(src).not.toMatch(/>Yard</);
  });

  it("links the rail X icon to KeiSakaiX", () => {
    expect(X_PROFILE_HANDLE).toBe("@KeiSakaiX");
    expect(X_PROFILE_URL).toBe("https://x.com/KeiSakaiX");
    expect(isAllowedExternalUrl(X_PROFILE_URL)).toBe(true);
    expect(isAllowedExternalUrl("https://x.com/someone-else")).toBe(false);
  });
});

describe("defaultClientModel", () => {
  it("prefers the smart switchyard route when present", () => {
    expect(defaultClientModel(["minimax-m3", "switchyard", "unsloth-local"])).toBe("switchyard");
  });

  it("falls back to the first listed route", () => {
    expect(defaultClientModel(["minimax-m3"])).toBe("minimax-m3");
  });

  it("defaults to switchyard when nothing is listed", () => {
    expect(defaultClientModel([])).toBe("switchyard");
  });
});
