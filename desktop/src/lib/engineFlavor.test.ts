import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { appDisplayName, appVersion, isMaskclawFlavor, parseEngineFlavor, windowTitle } from "./engineFlavor";
// JS helper used by fetch-sidecar / with-engine.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no types for sidecar scripts
import {
  MASKCLAW,
  STOCK,
  defaultMaskclawEngineRoot,
  resolveEngineFlavor,
} from "../../scripts/engine-flavor.mjs";

describe("parseEngineFlavor", () => {
  it("defaults unknown values to stock", () => {
    expect(parseEngineFlavor(undefined)).toBe("stock");
    expect(parseEngineFlavor("")).toBe("stock");
    expect(parseEngineFlavor("stock")).toBe("stock");
    expect(parseEngineFlavor("other")).toBe("stock");
  });

  it("recognizes maskclaw", () => {
    expect(parseEngineFlavor("maskclaw")).toBe("maskclaw");
    expect(isMaskclawFlavor("maskclaw")).toBe(true);
    expect(isMaskclawFlavor("stock")).toBe(false);
  });

  it("names the MaskClaw flavor MASKCLAW DESKTOP", () => {
    expect(appDisplayName("maskclaw")).toBe("MASKCLAW DESKTOP");
    expect(appDisplayName("stock")).toBe("Switchyard");
  });

  it("puts the package version next to MASKCLAW DESKTOP", () => {
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(windowTitle("maskclaw")).toBe(`MASKCLAW DESKTOP ${appVersion()}`);
    expect(windowTitle("stock")).toBe(`Switchyard ${appVersion()}`);
  });
});

describe("resolveEngineFlavor", () => {
  it("defaults empty to maskclaw", () => {
    expect(resolveEngineFlavor("")).toBe(MASKCLAW);
    expect(resolveEngineFlavor(undefined)).toBe(MASKCLAW);
    expect(resolveEngineFlavor("MASKCLAW")).toBe(MASKCLAW);
  });

  it("accepts maskclaw", () => {
    expect(resolveEngineFlavor("maskclaw")).toBe(MASKCLAW);
    expect(resolveEngineFlavor("MaskClaw")).toBe(MASKCLAW);
  });

  it("still parses an explicit stock value for tests", () => {
    expect(resolveEngineFlavor("stock")).toBe(STOCK);
  });

  it("rejects unknown flavors", () => {
    expect(() => resolveEngineFlavor("custom")).toThrow(/unknown SWITCHYARD_ENGINE/);
  });
});

describe("defaultMaskclawEngineRoot", () => {
  it("resolves engine/ next to desktop/", () => {
    const previous = process.env.MASKCLAW_ENGINE_ROOT;
    delete process.env.MASKCLAW_ENGINE_ROOT;
    try {
      expect(defaultMaskclawEngineRoot(join("repo", "desktop"))).toBe(join("repo", "engine"));
    } finally {
      if (previous === undefined) {
        delete process.env.MASKCLAW_ENGINE_ROOT;
      } else {
        process.env.MASKCLAW_ENGINE_ROOT = previous;
      }
    }
  });

  it("honors MASKCLAW_ENGINE_ROOT", () => {
    const previous = process.env.MASKCLAW_ENGINE_ROOT;
    process.env.MASKCLAW_ENGINE_ROOT = join("other", "engine");
    try {
      expect(defaultMaskclawEngineRoot(join("repo", "desktop"))).toBe(join("other", "engine"));
    } finally {
      if (previous === undefined) {
        delete process.env.MASKCLAW_ENGINE_ROOT;
      } else {
        process.env.MASKCLAW_ENGINE_ROOT = previous;
      }
    }
  });
});
