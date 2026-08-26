import { describe, expect, it } from "vitest";
import { probeInvokeArgs } from "../api";

describe("probeInvokeArgs", () => {
  it("sends the pasted Unsloth key with Check", () => {
    expect(probeInvokeArgs("http://127.0.0.1:8888/v1", "  sk-unsloth-live  ")).toEqual({
      url: "http://127.0.0.1:8888/v1",
      apiKey: "sk-unsloth-live",
    });
  });

  it("omits a blank key so a stored credential can be used", () => {
    expect(probeInvokeArgs("http://127.0.0.1:8888/v1", "   ")).toEqual({
      url: "http://127.0.0.1:8888/v1",
      apiKey: null,
    });
  });
});
