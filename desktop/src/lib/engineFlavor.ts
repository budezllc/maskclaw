export type EngineFlavor = "stock" | "maskclaw";

export const STOCK_APP_NAME = "Switchyard";
export const MASKCLAW_APP_NAME = "MASKCLAW DESKTOP";

export function parseEngineFlavor(raw: unknown): EngineFlavor {
  return raw === "maskclaw" ? "maskclaw" : "stock";
}

export function isMaskclawFlavor(flavor: unknown): boolean {
  return parseEngineFlavor(flavor) === "maskclaw";
}

export function appDisplayName(flavor: unknown): string {
  return isMaskclawFlavor(flavor) ? MASKCLAW_APP_NAME : STOCK_APP_NAME;
}

export function appVersion(): string {
  const version = import.meta.env.VITE_APP_VERSION;
  return typeof version === "string" && version.length > 0 ? version : "0.0.0";
}

/** Native window / document title: product name, then the package version. */
export function windowTitle(flavor: unknown): string {
  return `${appDisplayName(flavor)} ${appVersion()}`;
}
