import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultMaskclawEngineRoot,
  maskclawServerCrate,
} from "../desktop/scripts/engine-flavor.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

test("monorepo has engine, desktop, dashboard, and appliance", () => {
  assert.ok(existsSync(join(repoRoot, "engine", "Cargo.toml")));
  assert.ok(existsSync(join(repoRoot, "engine", "crates", "switchyard-server", "Cargo.toml")));
  assert.ok(existsSync(join(repoRoot, "desktop", "package.json")));
  assert.ok(existsSync(join(repoRoot, "dashboard", "package.json")));
  assert.ok(existsSync(join(repoRoot, "appliance", "README.md")));
});

test("desktop sidecar resolves the in-tree engine", () => {
  const previous = process.env.MASKCLAW_ENGINE_ROOT;
  delete process.env.MASKCLAW_ENGINE_ROOT;
  try {
    const engineRoot = defaultMaskclawEngineRoot(join(repoRoot, "desktop"));
    assert.equal(engineRoot, join(repoRoot, "engine"));
    assert.ok(existsSync(maskclawServerCrate(engineRoot)));
  } finally {
    if (previous === undefined) {
      delete process.env.MASKCLAW_ENGINE_ROOT;
    } else {
      process.env.MASKCLAW_ENGINE_ROOT = previous;
    }
  }
});

test("root README documents the product tree and current surfaces", () => {
  const readme = read("README.md");
  for (const needle of [
    "engine/",
    "desktop/",
    "dashboard/",
    "appliance/",
    "model id `maskclaw`",
    "HOME",
    "MASKED",
    "MODELS",
    "SETTINGS",
    "npm run tauri:build",
    "pnpm dev",
    "pwsh scripts/build-engine-aarch64.ps1",
    "GET /v1/maskclaw/stats",
    "force_local",
  ]) {
    assert.ok(readme.includes(needle), `README.md missing ${needle}`);
  }
  assert.ok(!readme.includes("switchyard launch"));
  assert.ok(!readme.includes('id = "switchyard"'));
});

test("appliance pin and scripts stay repo-relative", () => {
  const pin = read("appliance/ENGINE_PIN");
  const pathLine = pin.split(/\r?\n/).find((line) => line.startsWith("ENGINE_PATH="));
  assert.ok(pathLine);
  const enginePath = pathLine.slice("ENGINE_PATH=".length).trim();
  assert.ok(!enginePath.includes("Users"));
  assert.ok(!enginePath.includes("/home/"));
  assert.equal(enginePath, "../engine");
  assert.ok(existsSync(join(repoRoot, "appliance", enginePath, "Cargo.toml")));

  const dashboardScript = read("appliance/scripts/build-dashboard.ps1");
  assert.ok(dashboardScript.includes("dashboard"));
  assert.ok(!dashboardScript.includes("Users\\"));
  assert.ok(!dashboardScript.includes("Users/"));
});
