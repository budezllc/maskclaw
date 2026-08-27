import { describe, expect, it } from "vitest";
import { extractBaseUrls, parseDetectors, setDetectorLine } from "./tomlEdit";

describe("tomlEdit detectors", () => {
  it("toggles detector lines without rewriting the rest of maskclaw.toml", () => {
    expect(extractBaseUrls(`[llm_clients.a]\nbase_url = "http://127.0.0.1:8888/v1"\n[llm_clients.b]\nbase_url = "http://127.0.0.1:8888/v1"\n`)).toEqual([
      "http://127.0.0.1:8888/v1",
    ]);
    expect(setDetectorLine("[detectors]\nemail = true\n", "email", false)).toContain("email = false");
    const toggled = setDetectorLine("[detectors]\nemail = true\nphone = true\n", "email", false);
    expect(parseDetectors(toggled)).toMatchObject({ email: false, phone: true, ssn: true });
    expect(parseDetectors("enabled = true\n")).toMatchObject({ email: true, api_key: true });
    const commented = `enabled = true\n\n# [detectors]\n# email = true\n\n[detectors]\nphone = true\nemail = false\n`;
    expect(parseDetectors(commented)).toMatchObject({ email: false, phone: true, api_key: true });
    expect(parseDetectors(setDetectorLine(commented, "email", true)).email).toBe(true);
  });
});
