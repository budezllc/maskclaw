export interface RouteRow {
  id: string;
  track: string;
  displayName: string;
  contextWindow: number | null;
  streaming: boolean;
  toolCalling: boolean;
}

function smartRank(id: string): number {
  if (id === "maskclaw") {
    return 0;
  }
  if (id === "switchyard") {
    return 1;
  }
  return 2;
}

/** Collapse hyphenated aliases of the same route (MiniMax-M3 vs minimax-m3). */
export function compactRouteId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function dropSlugAliases(ids: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const key = compactRouteId(id) || id;
    const list = groups.get(key) ?? [];
    list.push(id);
    groups.set(key, list);
  }
  const keep = new Set<string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      keep.add(group[0]);
      continue;
    }
    const preferred = group.find((candidate) => compactRouteId(candidate) !== candidate) ?? group[0];
    keep.add(preferred);
  }
  return ids.filter((id) => keep.has(id));
}

export function sortRoutesForClient(rows: RouteRow[]): RouteRow[] {
  return [...rows]
    .sort((left, right) => smartRank(left.id) - smartRank(right.id))
    .map((row, index) => ({
      ...row,
      track: String(index + 1).padStart(2, "0"),
    }));
}

export function parseRoutes(models: unknown): RouteRow[] {
  const root = models && typeof models === "object" ? (models as Record<string, unknown>) : {};
  const data = Array.isArray(root.data) ? root.data : [];
  const rows = data.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const caps =
      row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as Record<string, unknown>)
        : {};
    const id = typeof row.id === "string" ? row.id : `route-${index}`;
    const displayName = typeof row.display_name === "string" ? row.display_name : id;
    return {
      id,
      track: String(index + 1).padStart(2, "0"),
      displayName,
      contextWindow: typeof caps.context_window === "number" ? caps.context_window : null,
      streaming: caps.streaming === true,
      toolCalling: caps.tool_calling === true,
    };
  });
  const kept = new Set(dropSlugAliases(rows.map((row) => row.id)));
  return sortRoutesForClient(rows.filter((row) => kept.has(row.id)));
}

/** Fallback when /v1/models is slow or unavailable: read route ids from saved routes.toml. */
export function routeIdsFromToml(toml: string): string[] {
  const ids: string[] = [];
  let inRoutes = false;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\[routes\./.test(line)) {
      inRoutes = true;
      continue;
    }
    if (/^\[/.test(line) && !line.startsWith("[routes.")) {
      inRoutes = false;
    }
    if (!inRoutes) {
      continue;
    }
    const match = line.match(/^id\s*=\s*"([^"]+)"/);
    if (match) {
      ids.push(match[1]);
    }
  }
  return dropSlugAliases(ids);
}

export function routeRowsFromIds(ids: string[]): RouteRow[] {
  return sortRoutesForClient(
    dropSlugAliases(ids).map((id, index) => ({
      id,
      track: String(index + 1).padStart(2, "0"),
      displayName: id,
      contextWindow: null,
      streaming: true,
      toolCalling: false,
    })),
  );
}

export function defaultModelFromPayload(models: unknown, routeIds: string[]): string {
  const root = models && typeof models === "object" ? (models as Record<string, unknown>) : {};
  const listed = typeof root.default_model === "string" ? root.default_model : undefined;
  return defaultClientModel(routeIds, listed);
}

/** Route id a client should send as `model`. Prefer smart routing over a listed pin. */
export function defaultClientModel(routeIds: string[], listedDefault?: string): string {
  return (
    routeIds.find((id) => id === "maskclaw") ??
    routeIds.find((id) => id === "switchyard") ??
    (listedDefault && routeIds.includes(listedDefault) ? listedDefault : undefined) ??
    routeIds[0] ??
    "maskclaw"
  );
}

export function clientModelLabel(id: string): string {
  return id === "maskclaw" || id === "switchyard" ? `${id} (smart routing)` : id;
}
