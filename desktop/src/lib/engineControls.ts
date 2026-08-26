import type { AppSnapshot, EngineState } from "../api";

export type EngineToggle = {
  action: "start" | "stop";
  label: string;
};

/** Primary board control: Start when idle, Stop once the engine is up. */
export function engineToggle(state: EngineState): EngineToggle {
  if (state === "starting") {
    return { action: "stop", label: "Starting…" };
  }
  if (state === "running" || state === "restarting") {
    return { action: "stop", label: "Stop" };
  }
  return { action: "start", label: "Start" };
}

export function engineBusyLabel(toggle: EngineToggle, busy: boolean): string {
  if (!busy) return toggle.label;
  return toggle.action === "start" ? "Starting…" : "Stopping…";
}

export function snapshotFromInvokeError(snap: AppSnapshot, err: unknown): AppSnapshot {
  return {
    ...snap,
    engine_state: "failed",
    last_error: err instanceof Error ? err.message : String(err),
  };
}
