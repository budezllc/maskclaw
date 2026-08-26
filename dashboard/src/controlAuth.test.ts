import { describe, expect, it } from "vitest";
import { authorizeControlRequest } from "./controlAuth";

describe("controlAuth", () => {
  it("allows all requests when no dev token is configured", () => {
    expect(authorizeControlRequest("/control/snapshot", {}, "")).toBe(true);
  });

  it("requires the dev token header for control routes", () => {
    const token = "dev-token-value";
    expect(authorizeControlRequest("/control/snapshot", {}, token)).toBe(false);
    expect(
      authorizeControlRequest("/control/snapshot", { "x-maskclaw-dev-token": token }, token),
    ).toBe(true);
    expect(authorizeControlRequest("/control/health", {}, token)).toBe(true);
  });
});
