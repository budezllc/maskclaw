export interface MaskclawStatsView {
  enabled: boolean;
  forceLocal: string;
  localRouteId: string;
  sessionTtlSecs: number;
  dictionaryCount: number;
  regexCount: number;
  allowlistCount: number;
  requests: number;
  requestsWithMatches: number;
  matches: number;
  critical: number;
  residual: number;
  forceLocalOverrides: number;
  restoreMisses: number;
  sessionsActive: number;
  uniqueValues: number;
  byKind: [string, number][];
}

const DISABLED: MaskclawStatsView = {
  enabled: false,
  forceLocal: "never",
  localRouteId: "",
  sessionTtlSecs: 0,
  dictionaryCount: 0,
  regexCount: 0,
  allowlistCount: 0,
  requests: 0,
  requestsWithMatches: 0,
  matches: 0,
  critical: 0,
  residual: 0,
  forceLocalOverrides: 0,
  restoreMisses: 0,
  sessionsActive: 0,
  uniqueValues: 0,
  byKind: [],
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function kindPlates(byKind: Record<string, number> | undefined): [string, number][] {
  if (!byKind) {
    return [];
  }
  return Object.entries(byKind).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

export function adaptMaskclawStats(raw: unknown): MaskclawStatsView {
  if (!raw || typeof raw !== "object") {
    return { ...DISABLED };
  }
  const row = raw as Record<string, unknown>;
  if (row.enabled !== true) {
    return { ...DISABLED };
  }
  const sessions =
    row.sessions && typeof row.sessions === "object"
      ? (row.sessions as Record<string, unknown>)
      : {};
  const byKind =
    row.by_kind && typeof row.by_kind === "object" && !Array.isArray(row.by_kind)
      ? (row.by_kind as Record<string, number>)
      : undefined;
  return {
    enabled: true,
    forceLocal: typeof row.force_local === "string" ? row.force_local : "never",
    localRouteId: typeof row.local_route_id === "string" ? row.local_route_id : "",
    sessionTtlSecs: num(row.session_ttl_secs),
    dictionaryCount: num(row.dictionary_count),
    regexCount: num(row.regex_count),
    allowlistCount: num(row.allowlist_count),
    requests: num(row.requests),
    requestsWithMatches: num(row.requests_with_matches),
    matches: num(row.matches),
    critical: num(row.critical),
    residual: num(row.residual),
    forceLocalOverrides: num(row.force_local_overrides),
    restoreMisses: num(row.restore_misses),
    sessionsActive: num(sessions.active),
    uniqueValues: num(sessions.unique_values),
    byKind: kindPlates(byKind),
  };
}
