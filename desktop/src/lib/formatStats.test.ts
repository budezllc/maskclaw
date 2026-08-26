import { describe, expect, it } from "vitest";
import { formatCount, formatMs, lastRequestHop } from "./formatStats";

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1216)).toBe("1,216");
  });
});

describe("formatMs", () => {
  it("uses seconds at 1000ms and above", () => {
    expect(formatMs(1700)).toBe("1.7s");
    expect(formatMs(942)).toBe("942ms");
    expect(formatMs(null)).toBe("—");
  });
});

describe("lastRequestHop", () => {
  it("reads the latest requested → selected hop from engine logs", () => {
    expect(
      lastRequestHop([
        'requested_model="lmstudio-local" selected_model="gemma-4-e4b-it"',
      ]),
    ).toEqual({ requested: "lmstudio-local", selected: "gemma-4-e4b-it" });
    expect(lastRequestHop(["no hop"])).toBeNull();
  });
});
