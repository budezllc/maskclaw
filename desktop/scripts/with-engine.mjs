import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MASKCLAW, resolveEngineFlavor, writeEngineFlavorFile } from "./engine-flavor.mjs";

const argv = process.argv.slice(2);
let flavorRaw = MASKCLAW;
if (argv[0] === "maskclaw" || argv[0] === "stock") {
  flavorRaw = argv.shift();
}
if (argv.length === 0) {
  console.error("usage: node scripts/with-engine.mjs [maskclaw] <command>...");
  process.exit(1);
}

const flavor = resolveEngineFlavor(flavorRaw);
if (flavor !== MASKCLAW) {
  console.error("MASKCLAW desktop is MaskClaw-only");
  process.exit(1);
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
writeEngineFlavorFile(desktopRoot, flavor);
process.env.SWITCHYARD_ENGINE = flavor;

if (!argv.includes("--config")) {
  argv.push("--config", join(desktopRoot, "src-tauri", "tauri.maskclaw.conf.json"));
}

const child = spawn(argv[0], argv.slice(1), {
  stdio: "inherit",
  env: process.env,
  shell: true,
  cwd: desktopRoot,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
