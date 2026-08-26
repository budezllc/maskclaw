import { describe, expect, it } from "vitest";
import { adaptMaskclawStats, forceLocalRouteLabel, kindPlates } from "./maskclawStatsAdapter";

describe("kindPlates", () => {
  it("sorts by count then name", () => {
    expect(kindPlates({ email: 2, phone: 4, jwt: 4 })).toEqual([
      ["jwt", 4],
      ["phone", 4],
      ["email", 2],
    ]);
  });

  it("returns empty when missing", () => {
    expect(kindPlates(undefined)).toEqual([]);
  });
});

describe("adaptMaskclawStats", () => {
  it("treats enabled false as off", () => {
    expect(adaptMaskclawStats({ enabled: false, matches: 9 })).toMatchObject({
      enabled: false,
      matches: 0,
      byKind: [],
    });
  });

  it("maps an enabled snapshot", () => {
    const view = adaptMaskclawStats({
      enabled: true,
      requests: 10,
      requests_with_matches: 4,
      matches: 7,
      critical: 1,
      residual: 2,
      force_local_overrides: 3,
      restore_misses: 1,
      sessions: { active: 2, unique_values: 5 },
      force_local: "on_unmaskable",
      local_route_id: "lmstudio-local",
      session_ttl_secs: 900,
      dictionary_count: 12,
      regex_count: 3,
      allowlist_count: 1,
      by_kind: { email: 3, phone: 1 },
    });
    expect(view.enabled).toBe(true);
    expect(view.requests).toBe(10);
    expect(view.requestsWithMatches).toBe(4);
    expect(view.matches).toBe(7);
    expect(view.forceLocalOverrides).toBe(3);
    expect(view.forceLocal).toBe("on_unmaskable");
    expect(view.localRouteId).toBe("lmstudio-local");
    expect(view.sessionTtlSecs).toBe(900);
    expect(view.dictionaryCount).toBe(12);
    expect(view.regexCount).toBe(3);
    expect(view.allowlistCount).toBe(1);
    expect(view.sessionsActive).toBe(2);
    expect(view.uniqueValues).toBe(5);
    expect(view.byKind).toEqual([
      ["email", 3],
      ["phone", 1],
    ]);
  });

  it("hides unused or uninstalled local-route pins", () => {
    expect(forceLocalRouteLabel("never", "unsloth-local")).toBe("");
    expect(forceLocalRouteLabel("always", "unsloth-local", ["lmstudio-local"])).toBe("");
    expect(forceLocalRouteLabel("always", "lmstudio-local", ["lmstudio-local"])).toBe("lmstudio-local");
  });

  it("tolerates null", () => {
    expect(adaptMaskclawStats(null).enabled).toBe(false);
  });
});
