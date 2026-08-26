export interface DetectorToggles {
  email: boolean;
  phone: boolean;
  ssn: boolean;
  credit_card: boolean;
  jwt: boolean;
  aws_key: boolean;
  api_key: boolean;
}

export const DETECTOR_KEYS: (keyof DetectorToggles)[] = [
  "email",
  "phone",
  "ssn",
  "credit_card",
  "jwt",
  "aws_key",
  "api_key",
];

export const DETECTOR_LABELS: Record<keyof DetectorToggles, string> = {
  email: "Email",
  phone: "Phone",
  ssn: "SSN",
  credit_card: "Credit card",
  jwt: "JWT",
  aws_key: "AWS key",
  api_key: "API key",
};

export interface SessionGauges {
  active: number;
  unique_values: number;
}

export interface StatsSnapshot {
  enabled: boolean;
  force_local?: string;
  local_route_id?: string | null;
  session_ttl_secs?: number;
  detectors?: DetectorToggles;
  dictionary_count?: number;
  regex_count?: number;
  allowlist_count?: number;
  requests?: number;
  requests_with_matches?: number;
  matches?: number;
  critical?: number;
  residual?: number;
  force_local_overrides?: number;
  restore_misses?: number;
  by_kind?: Record<string, number>;
  sessions?: SessionGauges;
}

export interface MaskclawStatsView {
  enabled: boolean;
  forceLocal: string;
  localRouteId: string;
  sessionTtlSecs: number;
  detectors: DetectorToggles;
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

const DEFAULT_DETECTORS: DetectorToggles = {
  email: true,
  phone: true,
  ssn: true,
  credit_card: true,
  jwt: true,
  aws_key: true,
  api_key: true,
};

const DISABLED: MaskclawStatsView = {
  enabled: false,
  forceLocal: "never",
  localRouteId: "",
  sessionTtlSecs: 0,
  detectors: { ...DEFAULT_DETECTORS },
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

const SECRETISH = /@|__MC_|sk-|AKIA/;

export function assertStatsSafe(json: string): void {
  if (SECRETISH.test(json)) {
    throw new Error("stats payload looks like it contains a secret");
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function kindPlates(byKind: Record<string, number> | undefined): [string, number][] {
  if (!byKind) {
    return [];
  }
  return Object.entries(byKind).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export function adaptMaskclawStats(raw: unknown): MaskclawStatsView {
  if (!raw || typeof raw !== "object") {
    return { ...DISABLED, detectors: { ...DEFAULT_DETECTORS } };
  }
  const row = raw as Record<string, unknown>;
  if (row.enabled !== true) {
    return { ...DISABLED, detectors: { ...DEFAULT_DETECTORS } };
  }
  const sessions =
    row.sessions && typeof row.sessions === "object" ? (row.sessions as Record<string, unknown>) : {};
  const detectorsRaw =
    row.detectors && typeof row.detectors === "object" ? (row.detectors as Record<string, unknown>) : {};
  const byKind =
    row.by_kind && typeof row.by_kind === "object" && !Array.isArray(row.by_kind)
      ? (row.by_kind as Record<string, number>)
      : undefined;
  const detectors = { ...DEFAULT_DETECTORS };
  for (const key of DETECTOR_KEYS) {
    if (typeof detectorsRaw[key] === "boolean") {
      detectors[key] = detectorsRaw[key];
    }
  }
  return {
    enabled: true,
    forceLocal: typeof row.force_local === "string" ? row.force_local : "never",
    localRouteId: typeof row.local_route_id === "string" ? row.local_route_id : "",
    sessionTtlSecs: num(row.session_ttl_secs),
    detectors,
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

/**
 * MASKED footer chip. `local_route_id` lives in maskclaw.toml and is independent of
 * the Models checkboxes, so a leftover `unsloth-local` would otherwise keep showing
 * while force_local is `never` (unused) or after Unsloth was turned off.
 */
export function forceLocalRouteLabel(
  forceLocal: string,
  localRouteId: string,
  liveRouteIds?: string[],
): string {
  const id = localRouteId.trim();
  if (!id || forceLocal === "never") {
    return "";
  }
  if (liveRouteIds && !liveRouteIds.includes(id)) {
    return "";
  }
  return id;
}

export async function fetchStats(fetcher: typeof fetch = fetch): Promise<StatsSnapshot> {
  const response = await fetcher("/v1/maskclaw/stats");
  if (!response.ok) {
    throw new Error(`stats ${response.status}`);
  }
  const text = await response.text();
  assertStatsSafe(text);
  return JSON.parse(text) as StatsSnapshot;
}

/** Poll-friendly: keep dashboard live when a single tick fails. */
export async function tryFetchStats(fetcher: typeof fetch = fetch): Promise<StatsSnapshot | null> {
  try {
    return await fetchStats(fetcher);
  } catch {
    return null;
  }
}
