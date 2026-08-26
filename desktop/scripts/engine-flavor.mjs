import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STOCK = "stock";
export const MASKCLAW = "maskclaw";

export function resolveEngineFlavor(raw = process.env.SWITCHYARD_ENGINE) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === MASKCLAW) {
    return MASKCLAW;
  }
  if (value === STOCK) {
    return STOCK;
  }
  throw new Error(`unknown SWITCHYARD_ENGINE=${raw} (use maskclaw)`);
}

export function flavorFilePath(desktopRoot) {
  return join(desktopRoot, "src-tauri", "engine-flavor.txt");
}

export function sidecarFlavorPath(desktopRoot) {
  return join(desktopRoot, "src-tauri", "binaries", "sidecar-flavor.txt");
}

export function writeEngineFlavorFile(desktopRoot, flavor) {
  const path = flavorFilePath(desktopRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${flavor}\n`);
}

export function readSidecarFlavor(desktopRoot) {
  const path = sidecarFlavorPath(desktopRoot);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").trim().toLowerCase();
}

export function writeSidecarFlavor(desktopRoot, flavor) {
  const path = sidecarFlavorPath(desktopRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${flavor}\n`);
}

export function defaultMaskclawEngineRoot(desktopRoot) {
  if (process.env.MASKCLAW_ENGINE_ROOT) {
    return process.env.MASKCLAW_ENGINE_ROOT;
  }
  return join(desktopRoot, "..", "engine");
}

export function maskclawServerCrate(engineRoot) {
  return join(engineRoot, "crates", "switchyard-server");
}
