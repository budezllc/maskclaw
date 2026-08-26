export type Pane = "board" | "setup" | "settings";

export interface RailItem {
  pane: Pane;
  label: string;
  icon: "home" | "setup" | "settings";
}

export const RAIL_ITEMS: RailItem[] = [
  { pane: "board", label: "Home", icon: "home" },
  { pane: "setup", label: "Setup", icon: "setup" },
  { pane: "settings", label: "Settings", icon: "settings" },
];

export const X_PROFILE_HANDLE = "@KeiSakaiX";
export const X_PROFILE_URL = "https://x.com/KeiSakaiX";

export function isAllowedExternalUrl(url: string): boolean {
  return url === X_PROFILE_URL;
}

/** Route id a client should send as `model`. Prefer the smart route when listed. */
export function defaultClientModel(routeIds: string[]): string {
  return routeIds.find((id) => id === "switchyard") ?? routeIds[0] ?? "switchyard";
}
