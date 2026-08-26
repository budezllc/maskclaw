import type { HealthResult } from "./api";

export const POLL_TIMEOUT_MS = 2000;
export const POLL_INTERVAL_MS = 2000;

export type PollTickResult = {
  health: HealthResult;
  stats: unknown | null;
  models: unknown | null;
  maskclawStats: unknown | null;
};

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function runPollTick(deps: {
  fetchHealth: () => Promise<HealthResult>;
  fetchStats: () => Promise<unknown>;
  fetchModels: () => Promise<unknown>;
  fetchMaskclawStats: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<PollTickResult> {
  const ms = deps.timeoutMs ?? POLL_TIMEOUT_MS;
  const [healthSettled, statsSettled, modelsSettled, maskSettled] = await Promise.allSettled([
    withTimeout(deps.fetchHealth(), ms, "health"),
    withTimeout(deps.fetchStats(), ms, "stats"),
    withTimeout(deps.fetchModels(), ms, "models"),
    withTimeout(deps.fetchMaskclawStats(), ms, "maskclaw"),
  ]);

  const health: HealthResult =
    healthSettled.status === "fulfilled" ? healthSettled.value : { ok: false, body: "down" };

  return {
    health,
    stats: statsSettled.status === "fulfilled" ? statsSettled.value : null,
    models: modelsSettled.status === "fulfilled" ? modelsSettled.value : null,
    maskclawStats: maskSettled.status === "fulfilled" ? maskSettled.value : null,
  };
}

export function createPollGate() {
  let inFlight = false;

  return {
    get busy() {
      return inFlight;
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (inFlight) return undefined;
      inFlight = true;
      try {
        return await fn();
      } finally {
        inFlight = false;
      }
    },
  };
}
