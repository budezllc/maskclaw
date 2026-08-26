import { describe, expect, it } from "vitest";
import { engineBusyLabel, engineToggle, snapshotFromInvokeError } from "./engineControls";
import type { AppSnapshot } from "../api";

describe("engineToggle", () => {
  it("shows Start when the engine is not running", () => {
    expect(engineToggle("stopped")).toEqual({ action: "start", label: "Start" });
    expect(engineToggle("failed")).toEqual({ action: "start", label: "Start" });
    expect(engineToggle("stopping")).toEqual({ action: "start", label: "Start" });
  });

  it("shows Stop instead of a highlighted Start while the engine is up", () => {
    expect(engineToggle("running")).toEqual({ action: "stop", label: "Stop" });
    expect(engineToggle("restarting")).toEqual({ action: "stop", label: "Stop" });
  });

  it("shows Starting while the engine is coming up", () => {
    expect(engineToggle("starting")).toEqual({ action: "stop", label: "Starting…" });
  });
});

describe("engineBusyLabel", () => {
  it("says Starting while a start click is in flight", () => {
    expect(engineBusyLabel({ action: "start", label: "Start" }, true)).toBe("Starting…");
    expect(engineBusyLabel({ action: "start", label: "Start" }, false)).toBe("Start");
  });
});

describe("snapshotFromInvokeError", () => {
  it("puts the invoke error on the board instead of swallowing it", () => {
    const snap = {
      engine_state: "stopped",
      last_error: null,
    } as AppSnapshot;
    const next = snapshotFromInvokeError(snap, new Error("Dry-run timed out"));
    expect(next.engine_state).toBe("failed");
    expect(next.last_error).toBe("Dry-run timed out");
  });
});
