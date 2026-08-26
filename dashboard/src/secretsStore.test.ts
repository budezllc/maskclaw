import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecretsStore, migrateEnvFileToKeyring, secretsBackend } from "./secretsStore";
import { secretStatus } from "./secretsEnv";

describe("secretsStore", () => {
  let dir = "";
  let envPath = "";

  beforeEach(() => {
    process.env.MASKCLAW_SECRETS_BACKEND = "file";
    dir = mkdtempSync(path.join(tmpdir(), "maskclaw-secrets-"));
    envPath = path.join(dir, "engine.env");
  });

  afterEach(() => {
    delete process.env.MASKCLAW_SECRETS_BACKEND;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the file backend when forced", () => {
    expect(secretsBackend()).toBe("file");
    const store = createSecretsStore(envPath);
    const stored = store.saveUpdates({ MINIMAX_API_KEY: "test-key-value" }, ["MINIMAX_API_KEY"]);
    expect(readFileSync(envPath, "utf8")).toContain("MINIMAX_API_KEY=test-key-value");
    expect(store.loadNamed(["MINIMAX_API_KEY"]).MINIMAX_API_KEY).toBe("test-key-value");
    expect(secretStatus(["MINIMAX_API_KEY", "UNSLOTH_API_KEY"], stored)).toEqual([
      { name: "MINIMAX_API_KEY", set: true },
      { name: "UNSLOTH_API_KEY", set: false },
    ]);
  });

  it("does not migrate plaintext env files when file backend is active", () => {
    writeFileSync(envPath, "MINIMAX_API_KEY=legacy-key\n", "utf8");
    migrateEnvFileToKeyring(envPath);
    expect(existsSync(envPath)).toBe(true);
    expect(existsSync(`${envPath}.bak`)).toBe(false);
  });
});
