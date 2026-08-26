import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POLL_TIMEOUT_MS,
  createPollGate,
  runPollTick,
  withTimeout,
} from "./enginePoll";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves when the promise settles before the deadline", async () => {
    await expect(withTimeout(Promise.resolve(42), 50, "fast")).resolves.toBe(42);
  });

  it("rejects when the promise hangs past the deadline", async () => {
    vi.useFakeTimers();
    const hanging = new Promise<number>(() => {
      /* never settles */
    });
    const pending = withTimeout(hanging, 25, "slow");
    const assertion = expect(pending).rejects.toThrow(/slow timed out after 25ms/);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});

describe("runPollTick", () => {
  it("maps successful health/stats/models", async () => {
    const result = await runPollTick({
      fetchHealth: async () => ({ ok: true, body: '{"status":"ok"}' }),
      fetchStats: async () => ({ total_requests: 3 }),
      fetchModels: async () => ({ data: [{ id: "a" }] }),
      timeoutMs: 100,
    });
    expect(result.health).toBe('{"status":"ok"}');
    expect(result.stats).toEqual({ total_requests: 3 });
    expect(result.models).toEqual({ data: [{ id: "a" }] });
    expect(result.maskclawStats).toBeNull();
  });

  it("does not call MaskClaw stats on a stock poll", async () => {
    const fetchMaskclawStats = vi.fn(async () => ({ enabled: true }));
    const result = await runPollTick({
      fetchHealth: async () => ({ ok: true, body: "ok" }),
      fetchStats: async () => ({ total_requests: 1 }),
      fetchModels: async () => ({ data: [] }),
      timeoutMs: 100,
    });
    expect(fetchMaskclawStats).not.toHaveBeenCalled();
    expect(result.maskclawStats).toBeNull();
  });

  it("includes MaskClaw stats when a fetcher is provided", async () => {
    const result = await runPollTick({
      fetchHealth: async () => ({ ok: true, body: "ok" }),
      fetchStats: async () => ({ total_requests: 1 }),
      fetchModels: async () => ({ data: [] }),
      fetchMaskclawStats: async () => ({ enabled: true, matches: 4 }),
      timeoutMs: 100,
    });
    expect(result.maskclawStats).toEqual({ enabled: true, matches: 4 });
  });

  it("nulls a failed MaskClaw leg without dropping other stats", async () => {
    const result = await runPollTick({
      fetchHealth: async () => ({ ok: true, body: "ok" }),
      fetchStats: async () => ({ total_requests: 2 }),
      fetchModels: async () => ({ data: [] }),
      fetchMaskclawStats: async () => {
        throw new Error("maskclaw offline");
      },
      timeoutMs: 100,
    });
    expect(result.stats).toEqual({ total_requests: 2 });
    expect(result.maskclawStats).toBeNull();
  });

  it("marks health down and nulls failed legs without waiting on hangers", async () => {
    vi.useFakeTimers();
    const tick = runPollTick({
      fetchHealth: () => new Promise(() => undefined),
      fetchStats: async () => {
        throw new Error("stats offline");
      },
      fetchModels: async () => ({ data: [] }),
      timeoutMs: 40,
    });
    const assertion = tick.then((result) => {
      expect(result.health).toBe("down");
      expect(result.stats).toBeNull();
      expect(result.models).toEqual({ data: [] });
      expect(result.maskclawStats).toBeNull();
    });
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
  });

  it("uses POLL_TIMEOUT_MS by default", async () => {
    expect(POLL_TIMEOUT_MS).toBe(2000);
  });
});

describe("createPollGate", () => {
  it("skips overlapping runs until the first finishes", async () => {
    const gate = createPollGate();
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("first");
        }),
    );
    expect(gate.busy).toBe(true);
    const skipped = await gate.run(async () => "second");
    expect(skipped).toBeUndefined();
    release();
    await expect(first).resolves.toBe("first");
    expect(gate.busy).toBe(false);
    await expect(gate.run(async () => "third")).resolves.toBe("third");
  });
});
