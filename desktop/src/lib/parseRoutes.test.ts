import { describe, expect, it } from "vitest";
import { defaultModelFromPayload, parseRoutes } from "./parseRoutes";

describe("parseRoutes", () => {
  it("maps OpenAI-style models plus context_window", () => {
    const rows = parseRoutes({
      data: [
        { id: "lmstudio-local", capabilities: { context_window: 131072 } },
        { id: "maskclaw" },
      ],
    });
    expect(rows[0]).toMatchObject({ id: "lmstudio-local", track: "01", contextWindow: 131072 });
    expect(rows[1]).toMatchObject({ id: "maskclaw", track: "02", contextWindow: null });
  });
});

describe("defaultModelFromPayload", () => {
  it("prefers maskclaw then switchyard", () => {
    expect(defaultModelFromPayload({}, ["lmstudio-local", "maskclaw"])).toBe("maskclaw");
    expect(defaultModelFromPayload({ default_model: "lmstudio-local" }, ["lmstudio-local", "maskclaw"])).toBe(
      "lmstudio-local",
    );
  });
});
