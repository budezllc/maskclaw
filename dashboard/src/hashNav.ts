import { showBoxAdmin, type Surface } from "./surface";

export type Page = "board" | "mask" | "models" | "settings" | "box";

export function pageFromHash(hash: string, surface: Surface): Page {
  const raw = hash.replace(/^#/, "");
  if (raw === "mask") return "mask";
  if (raw === "models") return "models";
  if (raw === "settings") return "settings";
  if (raw === "box" && showBoxAdmin(surface)) return "box";
  return "board";
}
