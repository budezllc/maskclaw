import { describe, expect, it } from "vitest";
import {
  clientModelLabel,
  defaultModelFromPayload,
  parseRoutes,
  routeIdsFromToml,
  routeRowsFromIds,
} from "./parseRoutes";

describe("parseRoutes", () => {
  it("maps OpenAI-style models plus context_window and prefers smart routes first", () => {
    const rows = parseRoutes({
      data: [
        { id: "lmstudio-local", capabilities: { context_window: 131072 } },
        { id: "maskclaw" },
      ],
    });
    expect(rows[0]).toMatchObject({ id: "maskclaw", track: "01", contextWindow: null });
    expect(rows[1]).toMatchObject({ id: "lmstudio-local", track: "02", contextWindow: 131072 });
  });

  it("drops hyphenated aliases of the same provider model id", () => {
    const rows = parseRoutes({
      data: [{ id: "MiniMax-M3" }, { id: "minimax-m3" }, { id: "maskclaw" }],
    });
    expect(rows.map((row) => row.id)).toEqual(["maskclaw", "MiniMax-M3"]);
  });
});

describe("defaultModelFromPayload", () => {
  it("prefers maskclaw then switchyard over a listed pin", () => {
    expect(defaultModelFromPayload({}, ["lmstudio-local", "maskclaw"])).toBe("maskclaw");
    expect(
      defaultModelFromPayload({ default_model: "lmstudio-local" }, ["lmstudio-local", "maskclaw"]),
    ).toBe("maskclaw");
    expect(clientModelLabel("maskclaw")).toBe("maskclaw (smart routing)");
  });
});

describe("routeIdsFromToml", () => {
  it("reads route ids from routes.toml when /v1/models is unavailable", () => {
    const toml = `
[routes.smart]
id = "maskclaw"

[routes.local]
id = "lmstudio-local"

[routes.cloud]
id = "minimax-m3"
`;
    expect(routeIdsFromToml(toml)).toEqual(["maskclaw", "lmstudio-local", "minimax-m3"]);
    expect(routeRowsFromIds(routeIdsFromToml(toml)).map((row) => row.id)).toEqual([
      "maskclaw",
      "lmstudio-local",
      "minimax-m3",
    ]);
  });
});
