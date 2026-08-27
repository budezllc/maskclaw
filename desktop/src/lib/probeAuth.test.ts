import { describe, expect, it } from "vitest";
import { probeInvokeArgs } from "../api";

describe("probeInvokeArgs", () => {
  it("sends the pasted Unsloth key with Check", () => {
    expect(probeInvokeArgs("http://127.0.0.1:8888/v1", "  sk-unsloth-live  ")).toEqual({
      url: "http://127.0.0.1:8888/v1",
      apiKey: "sk-unsloth-live",
      model: null,
    });
    expect(probeInvokeArgs("https://api.minimax.io/v1", "sk-live", "MiniMax-M3")).toEqual({
      url: "https://api.minimax.io/v1",
      apiKey: "sk-live",
      model: "MiniMax-M3",
    });
  });

  it("omits a blank key so a stored credential can be used", () => {
    expect(probeInvokeArgs("http://127.0.0.1:8888/v1", "   ")).toEqual({
      url: "http://127.0.0.1:8888/v1",
      apiKey: null,
      model: null,
    });
  });
});
