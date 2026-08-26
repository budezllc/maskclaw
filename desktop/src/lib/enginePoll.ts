import type { HealthResult } from "../api";

export const POLL_TIMEOUT_MS = 2000;
export const POLL_INTERVAL_MS = 2000;

export type PollTickResult = {
  health: string;
  stats: unknown | null;
  models: unknown | null;
  maskclawStats: unknown | null;
};

/** Reject if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
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

/**
 * One dashboard poll: health/stats/models settle independently so a single
 * hung invoke cannot block the others, and each call is hard-capped.
 * MaskClaw stats are optional and only fetched when a fetcher is provided.
 */
export async function runPollTick(deps: {
  fetchHealth: () => Promise<HealthResult>;
  fetchStats: () => Promise<unknown>;
  fetchModels: () => Promise<unknown>;
  fetchMaskclawStats?: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<PollTickResult> {
  const ms = deps.timeoutMs ?? POLL_TIMEOUT_MS;
  const fetchMaskclawStats = deps.fetchMaskclawStats;
  const [healthSettled, statsSettled, modelsSettled, maskclawSettled] = await Promise.allSettled([
    withTimeout(deps.fetchHealth(), ms, "health"),
    withTimeout(deps.fetchStats(), ms, "stats"),
    withTimeout(deps.fetchModels(), ms, "models"),
    fetchMaskclawStats
      ? withTimeout(fetchMaskclawStats(), ms, "maskclaw")
      : Promise.resolve(null),
  ]);

  let health = "down";
  if (healthSettled.status === "fulfilled") {
    health = healthSettled.value.ok ? healthSettled.value.body : "down";
  }

  return {
    health,
    stats: statsSettled.status === "fulfilled" ? statsSettled.value : null,
    models: modelsSettled.status === "fulfilled" ? modelsSettled.value : null,
    maskclawStats:
      fetchMaskclawStats && maskclawSettled.status === "fulfilled" ? maskclawSettled.value : null,
  };
}

/** Skip a tick while the previous one is still in flight (avoids pile-up). */
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
