import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MASKCLAW,
  defaultMaskclawEngineRoot,
  maskclawServerCrate,
  readSidecarFlavor,
  resolveEngineFlavor,
  writeEngineFlavorFile,
  writeSidecarFlavor,
} from "./engine-flavor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".sidecar-stage");
const destDir = join(root, "src-tauri", "binaries");
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || "x86_64-pc-windows-msvc";
const destName =
  process.platform === "win32"
    ? `switchyard-server-${triple}.exe`
    : `switchyard-server-${triple}`;
const dest = join(destDir, destName);
const flavor = resolveEngineFlavor();

if (flavor !== MASKCLAW) {
  throw new Error("MASKCLAW desktop builds the in-tree MaskClaw engine only");
}

writeEngineFlavorFile(root, flavor);

const stagedFlavor = readSidecarFlavor(root);
const refresh = Boolean(process.env.SWITCHYARD_REFRESH_SIDECAR);
if (existsSync(dest) && stagedFlavor === flavor && !refresh) {
  console.log(`sidecar already staged (${flavor}): ${dest}`);
  process.exit(0);
}

mkdirSync(stage, { recursive: true });
mkdirSync(destDir, { recursive: true });

const engineRoot = defaultMaskclawEngineRoot(root);
const crate = maskclawServerCrate(engineRoot);
if (!existsSync(crate)) {
  throw new Error(
    `MaskClaw engine crate not found at ${crate}. Set MASKCLAW_ENGINE_ROOT or keep engine/ next to desktop/.`,
  );
}
const install = `cargo install --locked --path "${crate}" --root "${stage}"`;
console.log(`[${flavor}] ${install}`);
execSync(install, { stdio: "inherit", cwd: root });

const staged =
  process.platform === "win32"
    ? join(stage, "bin", "switchyard-server.exe")
    : join(stage, "bin", "switchyard-server");
if (!existsSync(staged)) {
  throw new Error(`cargo install did not produce ${staged}`);
}
copyFileSync(staged, dest);
writeSidecarFlavor(root, flavor);
console.log(`staged sidecar from engine/ (${MASKCLAW}) -> ${dest}`);
