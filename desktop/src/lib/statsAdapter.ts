export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_creation_tokens: number;
  cacheable_prompt_tokens: number;
  reasoning_tokens: number;
}

export interface ModelStatsView {
  id: string;
  calls: number;
  errors: number;
  tokens: TokenUsage;
  latencySamples: number[];
  avgLatencyMs: number | null;
}

export interface RoutingOverheadView {
  count: number;
  sumMs: number;
  avgMs: number | null;
}

export interface RoutingFallbacksView {
  count: number;
}

export interface StageRouterView {
  present: boolean;
  raw: unknown;
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
  stageRouter: StageRouterView;
}

const EMPTY_TOKENS: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  cached_tokens: 0,
  cache_creation_tokens: 0,
  cacheable_prompt_tokens: 0,
  reasoning_tokens: 0,
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokensFrom(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== "object") return { ...EMPTY_TOKENS };
  const t = raw as Record<string, unknown>;
  const nested =
    t.tokens && typeof t.tokens === "object"
      ? (t.tokens as Record<string, unknown>)
      : t;
  return {
    prompt_tokens: num(nested.prompt_tokens),
    completion_tokens: num(nested.completion_tokens),
    cached_tokens: num(nested.cached_tokens),
    cache_creation_tokens: num(nested.cache_creation_tokens),
    cacheable_prompt_tokens: num(nested.cacheable_prompt_tokens),
    reasoning_tokens: num(nested.reasoning_tokens),
  };
}

function latencyFrom(raw: unknown): number[] {
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  const samples = row.latency_samples ?? row.latency_ms ?? row.latencies;
  if (Array.isArray(samples)) {
    return samples.filter((n): n is number => typeof n === "number");
  }
  return [];
}

function average(samples: number[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((sum, n) => sum + n, 0) / samples.length;
}

function modelMap(raw: unknown): ModelStatsView[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).map(([id, value]) => {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const samples = latencyFrom(row);
    return {
      id,
      calls: num(row.calls ?? row.requests ?? row.total_requests),
      errors: num(row.errors ?? row.total_errors),
      tokens: tokensFrom(row),
      latencySamples: samples,
      avgLatencyMs: average(samples),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function compactStatId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Map route ids in routes.toml to upstream model ids used by /v1/stats. */
export function routeTargetAliases(toml: string): Record<string, string[]> {
  const targets = new Map<string, string>();
  const routes: { id: string; refs: string[] }[] = [];
  let section: "target" | "route" | null = null;
  let name = "";
  let fields: Record<string, string> = {};

  const flush = () => {
    if (section === "target" && fields.id) targets.set(name, fields.id);
    if (section === "route" && fields.id) {
      routes.push({
        id: fields.id,
        refs: [fields.target, fields.strong_target, fields.weak_target, fields.classifier_target].filter(
          (value): value is string => Boolean(value),
        ),
      });
    }
  };

  for (const line of toml.split("\n")) {
    const head = line.trim().match(/^\[(targets|routes)\.([^\]]+)\]/);
    if (head) {
      flush();
      section = head[1] === "targets" ? "target" : "route";
      name = head[2];
      fields = {};
      continue;
    }
    const kv = line.trim().match(/^(\w+)\s*=\s*"([^"]+)"/);
    if (kv) fields[kv[1]] = kv[2];
  }
  flush();

  const out: Record<string, string[]> = {};
  for (const route of routes) {
    const aliases = [route.id];
    for (const ref of route.refs) {
      const modelId = targets.get(ref);
      if (modelId) aliases.push(modelId);
    }
    out[route.id] = aliases;
  }
  return out;
}

export function findTrackStats(
  routeId: string,
  stats: StatsViewModel | null,
  aliases: string[] = [],
): ModelStatsView | undefined {
  if (!stats) return undefined;
  const pool = [...stats.byModel, ...stats.byClassifier];
  const names = [routeId, ...aliases];
  for (const id of names) {
    const hit = pool.find((row) => row.id === id);
    if (hit) return hit;
  }
  const compact = names.map(compactStatId);
  return pool.find((row) => compact.includes(compactStatId(row.id)));
}

const SMART_ROUTE_IDS = new Set(["switchyard", "maskclaw"]);

/**
 * Fill each track from explicit backend ids, then give leftover /v1/stats model
 * rows to the one remaining local track.
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
    return assigned;
  }
  if (leftoverRoutes.length === 1 && leftoverModels.length === 0) {
    const leftoverClassifier = stats.byClassifier.filter(
      (row) => !claimed.has(compactStatId(row.id)),
    );
    if (leftoverClassifier.length === 1) {
      assigned[leftoverRoutes[0]] = leftoverClassifier[0];
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
  const algorithm = asRecord(root.algorithm_stats);
  const classifier = asRecord(root.classifier);
  const stage = algorithm.stage_router;
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
    stageRouter: { present: stage !== undefined, raw: stage ?? null },
  };
}
