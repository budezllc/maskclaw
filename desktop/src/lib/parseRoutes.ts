export interface RouteRow {
  id: string;
  track: string;
  contextWindow: number | null;
}

export function parseRoutes(models: unknown): RouteRow[] {
  const root = models && typeof models === "object" ? (models as Record<string, unknown>) : {};
  const data = Array.isArray(root.data) ? root.data : [];
  return data.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const caps =
      row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as Record<string, unknown>)
        : {};
    const id = typeof row.id === "string" ? row.id : `route-${index}`;
    return {
      id,
      track: String(index + 1).padStart(2, "0"),
      contextWindow: typeof caps.context_window === "number" ? caps.context_window : null,
    };
  });
}

export function defaultModelFromPayload(models: unknown, routeIds: string[]): string {
  const root = models && typeof models === "object" ? (models as Record<string, unknown>) : {};
  const listed = typeof root.default_model === "string" ? root.default_model : undefined;
  if (listed && routeIds.includes(listed)) return listed;
  return (
    routeIds.find((id) => id === "maskclaw") ??
    routeIds.find((id) => id === "switchyard") ??
    routeIds[0] ??
    "maskclaw"
  );
}
