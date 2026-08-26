export type Surface = "local" | "appliance";

/** Vite forbids `--mode local` (.env.local postfix). CLI uses `sidecar`. */
export function surfaceFromViteMode(mode: string): Surface {
  return mode === "appliance" ? "appliance" : "local";
}

export function surfaceFromEnv(
  value: string | undefined = import.meta.env.VITE_SURFACE,
): Surface {
  return value === "appliance" ? "appliance" : "local";
}

export function showBoxAdmin(surface: Surface): boolean {
  return surface === "appliance";
}
