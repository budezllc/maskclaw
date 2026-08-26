import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { applySecretUpdates, formatEngineEnv, parseEngineEnv } from "./secretsEnv";

export const KEYRING_SERVICE = "com.switchyard.app";

export type SecretsBackend = "file" | "keyring";

export function secretsBackend(): SecretsBackend {
  const forced = process.env.MASKCLAW_SECRETS_BACKEND;
  if (forced === "file" || forced === "keyring") {
    return forced;
  }
  if (process.platform === "win32") {
    return "keyring";
  }
  return "file";
}

export interface SecretsStore {
  loadNamed(names: string[]): Record<string, string>;
  saveUpdates(values: Record<string, string>, namesFromToml: string[]): Record<string, string>;
}

class FileSecretsStore implements SecretsStore {
  constructor(private readonly envPath: string) {}

  private readAll(): Record<string, string> {
    return parseEngineEnv(existsSync(this.envPath) ? readFileSync(this.envPath, "utf8") : "");
  }

  loadNamed(names: string[]): Record<string, string> {
    const stored = this.readAll();
    const picked: Record<string, string> = {};
    for (const name of names) {
      if (stored[name]) {
        picked[name] = stored[name];
      }
    }
    return picked;
  }

  saveUpdates(values: Record<string, string>, _namesFromToml: string[]): Record<string, string> {
    const next = applySecretUpdates(this.readAll(), values);
    writeFileSync(this.envPath, formatEngineEnv(next), "utf8");
    return next;
  }
}

class KeyringSecretsStore implements SecretsStore {
  private entryFor(name: string) {
    const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    return new Entry(KEYRING_SERVICE, name);
  }

  loadNamed(names: string[]): Record<string, string> {
    const picked: Record<string, string> = {};
    for (const name of names) {
      try {
        const value = this.entryFor(name).getPassword();
        if (value) {
          picked[name] = value;
        }
      } catch {
        // Missing entries are normal.
      }
    }
    return picked;
  }

  saveUpdates(values: Record<string, string>, namesFromToml: string[]): Record<string, string> {
    const stored = this.loadNamed(namesFromToml);
    const next = applySecretUpdates(stored, values);
    for (const [name, value] of Object.entries(next)) {
      this.entryFor(name).setPassword(value);
    }
    return next;
  }
}

export function createSecretsStore(envPath: string): SecretsStore {
  if (secretsBackend() === "keyring") {
    migrateEnvFileToKeyring(envPath);
    return new KeyringSecretsStore();
  }
  return new FileSecretsStore(envPath);
}

export function migrateEnvFileToKeyring(envPath: string): void {
  if (secretsBackend() !== "keyring" || !existsSync(envPath)) {
    return;
  }
  const backupPath = `${envPath}.bak`;
  if (existsSync(backupPath)) {
    return;
  }
  const parsed = parseEngineEnv(readFileSync(envPath, "utf8"));
  if (Object.keys(parsed).length === 0) {
    renameSync(envPath, backupPath);
    return;
  }
  const store = new KeyringSecretsStore();
  store.saveUpdates(parsed, Object.keys(parsed));
  renameSync(envPath, backupPath);
}
