export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
}

export interface ModelStatsView {
  id: string;
  calls: number;
  errors: number;
  tokens: TokenUsage;
  avgLatencyMs: number | null;
  p50Ms: number | null;
}

export interface RoutingOverheadView {
  count: number;
  sumMs: number;
  avgMs: number | null;
}

export interface RoutingFallbacksView {
  count: number;
}

export interface StatsViewModel {
  totalRequests: number;
  totalErrors: number;
  totalTokens: TokenUsage;
  byModel: ModelStatsView[];
  byClassifier: ModelStatsView[];
  classifierRequests: number;
  classifierErrors: number;
  routingOverhead: RoutingOverheadView;
  routingFallbacks: RoutingFallbacksView;
}

const EMPTY_TOKENS: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  cached_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokensFrom(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== "object") return { ...EMPTY_TOKENS };
  const t = raw as Record<string, unknown>;
  const nested =
    t.tokens && typeof t.tokens === "object" ? (t.tokens as Record<string, unknown>) : t;
  return {
    prompt_tokens: num(nested.prompt_tokens ?? nested.prompt),
    completion_tokens: num(nested.completion_tokens ?? nested.completion),
    cached_tokens: num(nested.cached_tokens ?? nested.cached),
    cache_creation_tokens: num(nested.cache_creation_tokens ?? nested.cache_creation),
    reasoning_tokens: num(nested.reasoning_tokens ?? nested.reasoning),
  };
}

function latencyFrom(raw: unknown): { avgLatencyMs: number | null; p50Ms: number | null } {
  if (!raw || typeof raw !== "object") {
    return { avgLatencyMs: null, p50Ms: null };
  }
  const row = raw as Record<string, unknown>;
  const samples = row.latency_samples ?? row.latency_ms ?? row.latencies;
  const nested =
    row.model_call_latency && typeof row.model_call_latency === "object"
      ? (row.model_call_latency as Record<string, unknown>)
      : row.total_latency && typeof row.total_latency === "object"
        ? (row.total_latency as Record<string, unknown>)
        : null;
  if (nested) {
    return {
      avgLatencyMs: typeof nested.avg_ms === "number" ? nested.avg_ms : null,
      p50Ms: typeof nested.p50_ms === "number" ? nested.p50_ms : null,
    };
  }
  if (Array.isArray(samples)) {
    const list = samples.filter((n): n is number => typeof n === "number");
    if (list.length === 0) return { avgLatencyMs: null, p50Ms: null };
    const avg = list.reduce((sum, n) => sum + n, 0) / list.length;
    return { avgLatencyMs: avg, p50Ms: null };
  }
  return { avgLatencyMs: null, p50Ms: null };
}

function modelMap(raw: unknown): ModelStatsView[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([id, value]) => {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const latency = latencyFrom(row);
    return {
      id,
      calls: num(row.calls ?? row.requests ?? row.total_requests),
      errors: num(row.errors ?? row.total_errors),
      tokens: tokensFrom(row),
      avgLatencyMs: latency.avgLatencyMs,
      p50Ms: latency.p50Ms,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function compactStatId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findTrackStats(
  routeId: string,
  stats: StatsViewModel | null,
  backendIds: string[] = [],
): ModelStatsView | undefined {
  if (!stats) return undefined;
  const pool = [...stats.byModel, ...stats.byClassifier];
  for (const key of [routeId, ...backendIds]) {
    if (!key) continue;
    const exact = pool.find((row) => row.id === key);
    if (exact) return exact;
    const compact = compactStatId(key);
    if (!compact) continue;
    const fuzzy = pool.find((row) => compactStatId(row.id) === compact);
    if (fuzzy) return fuzzy;
  }
  return undefined;
}

const SMART_ROUTE_IDS = new Set(["switchyard", "maskclaw"]);

function mergeModelStats(rows: ModelStatsView[], id: string): ModelStatsView | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  if (rows.length === 1) {
    return rows[0];
  }
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const errors = rows.reduce((sum, row) => sum + row.errors, 0);
  const tokens = rows.reduce<TokenUsage>(
    (acc, row) => ({
      prompt_tokens: acc.prompt_tokens + row.tokens.prompt_tokens,
      completion_tokens: acc.completion_tokens + row.tokens.completion_tokens,
      cached_tokens: acc.cached_tokens + row.tokens.cached_tokens,
      cache_creation_tokens: acc.cache_creation_tokens + row.tokens.cache_creation_tokens,
      reasoning_tokens: acc.reasoning_tokens + row.tokens.reasoning_tokens,
    }),
    { ...EMPTY_TOKENS },
  );
  const latencyRows = rows.filter((row) => row.avgLatencyMs !== null);
  const avgLatencyMs =
    latencyRows.length === 0
      ? null
      : latencyRows.reduce((sum, row) => sum + (row.avgLatencyMs ?? 0), 0) / latencyRows.length;
  return {
    id,
    calls,
    errors,
    tokens,
    avgLatencyMs,
    p50Ms: null,
  };
}

/** Classifier routes never appear as model ids in /v1/stats; roll up engine totals. */
export function smartRouteStats(stats: StatsViewModel, routeId: string): ModelStatsView | undefined {
  if (!SMART_ROUTE_IDS.has(routeId)) {
    return undefined;
  }
  if (stats.totalRequests > 0) {
    return {
      id: routeId,
      calls: stats.totalRequests,
      errors: stats.totalErrors,
      tokens: stats.totalTokens,
      avgLatencyMs: stats.routingOverhead.avgMs,
      p50Ms: null,
    };
  }
  return mergeModelStats([...stats.byModel, ...stats.byClassifier], routeId);
}

/**
 * Fill each track from explicit backend ids, then give leftover /v1/stats model
 * rows to the one remaining local track. MiniMax matches minimax-m3 by compact
 * id; lmstudio-local does not match gemma-4-e4b-it without this.
 */
export function trackStatsByRoute(
  routeIds: string[],
  stats: StatsViewModel | null,
  backendIdsByRoute: Record<string, string[]> = {},
): Record<string, ModelStatsView | undefined> {
  const assigned: Record<string, ModelStatsView | undefined> = {};
  if (!stats) return assigned;

  const claimed = new Set<string>();
  for (const routeId of routeIds) {
    const hit = findTrackStats(routeId, stats, backendIdsByRoute[routeId] ?? []);
    if (hit) {
      assigned[routeId] = hit;
      claimed.add(compactStatId(hit.id));
    }
  }

  const leftoverRoutes = routeIds.filter((id) => !assigned[id] && !SMART_ROUTE_IDS.has(id));
  const leftoverModels = stats.byModel.filter((row) => !claimed.has(compactStatId(row.id)));
  if (leftoverRoutes.length === 1 && leftoverModels.length === 1) {
    assigned[leftoverRoutes[0]] = leftoverModels[0];
  } else if (leftoverRoutes.length === 1 && leftoverModels.length === 0) {
    const leftoverClassifier = stats.byClassifier.filter(
      (row) => !claimed.has(compactStatId(row.id)),
    );
    if (leftoverClassifier.length === 1) {
      assigned[leftoverRoutes[0]] = leftoverClassifier[0];
    }
  }

  for (const routeId of routeIds) {
    if (!assigned[routeId] && SMART_ROUTE_IDS.has(routeId)) {
      assigned[routeId] = smartRouteStats(stats, routeId);
    }
  }
  return assigned;
}

function overheadFrom(raw: unknown): RoutingOverheadView {
  if (!raw || typeof raw !== "object") return { count: 0, sumMs: 0, avgMs: null };
  const row = raw as Record<string, unknown>;
  const count = num(row.count ?? row.n);
  const sumMs = num(row.sum_ms ?? row.sum ?? row.total_ms);
  const avgMs = typeof row.avg_ms === "number" ? row.avg_ms : count > 0 ? sumMs / count : null;
  return { count, sumMs, avgMs };
}

function fallbacksFrom(raw: unknown): RoutingFallbacksView {
  if (!raw || typeof raw !== "object") {
    return { count: typeof raw === "number" ? raw : 0 };
  }
  const row = raw as Record<string, unknown>;
  const named = num(row.count ?? row.total ?? row.n);
  if (named > 0) return { count: named };
  return {
    count: Object.values(row).reduce<number>((sum, value) => sum + num(value), 0),
  };
}

export function adaptStats(snapshot: unknown): StatsViewModel {
  const root = asRecord(snapshot);
  const classifier = asRecord(root.classifier);
  return {
    totalRequests: num(root.total_requests),
    totalErrors: num(root.total_errors),
    totalTokens: tokensFrom(root.total_tokens ?? root),
    byModel: modelMap(root.by_model ?? root.models),
    byClassifier: modelMap(root.by_classifier ?? classifier.models),
    classifierRequests: num(root.classifier_requests ?? classifier.total_requests),
    classifierErrors: num(root.classifier_errors ?? classifier.total_errors),
    routingOverhead: overheadFrom(root.routing_overhead),
    routingFallbacks: fallbacksFrom(root.routing_fallbacks),
  };
}

export function lastRequestHop(logs: string[]): { requested: string; selected: string } | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const requested = /requested_model="([^"]*)"/.exec(logs[i])?.[1];
    const selected = /selected_model="([^"]*)"/.exec(logs[i])?.[1];
    if (requested !== undefined && selected !== undefined) {
      return { requested, selected };
    }
  }
  return null;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}
