export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
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
