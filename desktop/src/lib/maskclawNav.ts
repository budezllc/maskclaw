export type MaskclawPane = "board" | "mask" | "models" | "settings";

export interface MaskclawNavItem {
  pane: MaskclawPane;
  label: string;
  icon: "home" | "mask" | "models" | "settings";
}

/** Desktop MaskClaw nav matches the web dashboard Yard group, minus BOX (appliance-only). */
export const MASKCLAW_NAV_ITEMS: MaskclawNavItem[] = [
  { pane: "board", label: "HOME", icon: "home" },
  { pane: "mask", label: "MASKED", icon: "mask" },
  { pane: "models", label: "MODELS", icon: "models" },
  { pane: "settings", label: "SETTINGS", icon: "settings" },
];
