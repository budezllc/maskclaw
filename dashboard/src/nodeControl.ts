import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINE_LISTEN_URL, type ControlIO, type ProbeOptions, type ProbeResult } from "./control";
import { completionsProbeUrl, extractModelIds, modelsProbeUrl } from "./probeModels";
import { secretStatus } from "./secretsEnv";
import { createSecretsStore } from "./secretsStore";
import { extractApiKeyEnvs } from "./tomlEdit";

const LISTEN_PORT = 4000;
const LISTEN_HOST = "127.0.0.1";

export function defaultDataDir(): string {
  if (process.env.MASKCLAW_DATA_DIR) {
    return process.env.MASKCLAW_DATA_DIR;
  }
  return path.join(homedir(), "AppData", "Roaming", "com.switchyard.app");
}

export function defaultServerBin(): string {
  if (process.env.MASKCLAW_SERVER_BIN) {
    return process.env.MASKCLAW_SERVER_BIN;
  }
  const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
  return path.join(local, "MASKCLAW DESKTOP", "switchyard-server.exe");
}

export function serverArgs(dataDir: string): string[] {
  return [
    "--config",
    path.join(dataDir, "routes.toml"),
    "--host",
    LISTEN_HOST,
    "--port",
    String(LISTEN_PORT),
    "--routing-log-file",
    path.join(dataDir, "routing.jsonl"),
    "--shutdown-timeout",
    "30s",
    "--maskclaw-config",
    path.join(dataDir, "maskclaw.toml"),
  ];
}

function readOrEmpty(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function parseListeningPid(netstatOutput: string, port: number): number | null {
  const suffix = `:${port}`;
  for (const line of netstatOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP") || !trimmed.includes("LISTENING")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[1]?.endsWith(suffix)) {
      const pid = Number(parts[parts.length - 1]);
      return Number.isFinite(pid) ? pid : null;
    }
  }
  return null;
}

async function run(command: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(command, args, { windowsHide: true });
    return stdout;
  } catch (caught) {
    const err = caught as { stdout?: string };
    return err.stdout ?? "";
  }
}

export function createNodeControlIO(
  dataDir = defaultDataDir(),
  serverBin = defaultServerBin(),
): ControlIO {
  let lastError: string | null = null;
  const routesPath = path.join(dataDir, "routes.toml");
  const maskclawPath = path.join(dataDir, "maskclaw.toml");
  const logPath = path.join(dataDir, "routing.jsonl");
  const envPath = path.join(dataDir, "engine.env");
  const secrets = createSecretsStore(envPath);

  function storedSecrets(): Record<string, string> {
    return secrets.loadNamed(extractApiKeyEnvs(readOrEmpty(routesPath)));
  }

  async function engineUp(): Promise<boolean> {
    try {
      const response = await fetch(`${ENGINE_LISTEN_URL}/health`, { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function stopEngine(): Promise<void> {
    const output = await run("netstat", ["-ano"]);
    const pid = parseListeningPid(output, LISTEN_PORT);
    if (pid) {
      await run("taskkill", ["/PID", String(pid), "/F"]);
    }
    lastError = null;
  }

  async function startEngine(): Promise<void> {
    if (await engineUp()) {
      lastError = null;
      return;
    }
    if (!existsSync(serverBin)) {
      lastError = `Engine binary missing: ${serverBin}`;
      throw new Error(lastError);
    }
    if (!existsSync(routesPath)) {
      lastError = "No routes.toml yet. Save one in Settings first.";
      throw new Error(lastError);
    }
    const child = spawn(serverBin, serverArgs(dataDir), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...storedSecrets() },
    });
    child.unref();
    lastError = null;
  }

  return {
    listenUrl: ENGINE_LISTEN_URL,
    async readRoutes() {
      return readOrEmpty(routesPath);
    },
    async writeRoutes(toml) {
      writeFileSync(routesPath, toml, "utf8");
    },
    async readMaskclaw() {
      return readOrEmpty(maskclawPath);
    },
    async writeMaskclaw(toml) {
      writeFileSync(maskclawPath, toml, "utf8");
    },
    async readRoutingLog() {
      return readOrEmpty(logPath);
    },
    startEngine,
    stopEngine,
    async restartEngine() {
      await stopEngine();
      await startEngine();
    },
    engineUp,
    lastError() {
      return lastError;
    },
    async probe(url, options) {
      return probeBackend(url, options);
    },
    async listSecrets() {
      return secretStatus(extractApiKeyEnvs(readOrEmpty(routesPath)), storedSecrets());
    },
    async writeSecrets(values) {
      const names = extractApiKeyEnvs(readOrEmpty(routesPath));
      secrets.saveUpdates(values, names);
    },
  };
}

export async function probeBackend(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const headers: Record<string, string> = {};
  const token = options.apiKey?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const model = options.model?.trim();
  if (model) {
    const target = completionsProbeUrl(url);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (response.ok) {
        return { url: target, ok: true, label: "Model works", detail: String(response.status), models: [model] };
      }
      const unknown = response.status === 400 || response.status === 404;
      return {
        url: target,
        ok: false,
        label: unknown ? "Unknown model" : "Unreachable",
        detail: `HTTP ${response.status}`,
        models: [],
      };
    } catch (caught) {
      return {
        url: target,
        ok: false,
        label: "Unreachable",
        detail: caught instanceof Error ? caught.message : String(caught),
        models: [],
      };
    }
  }
  const modelsUrl = modelsProbeUrl(url);
  try {
    const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
    const body = await response.text();
    if (response.ok) {
      return {
        url: modelsUrl,
        ok: true,
        label: "Found",
        detail: String(response.status),
        models: extractModelIds(body),
      };
    }
    const needsKey = (response.status === 401 || response.status === 403) && !token;
    return {
      url: modelsUrl,
      ok: false,
      label: needsKey ? "Needs API key" : response.status === 401 || response.status === 403 ? "Auth failed" : "Unreachable",
      detail: `HTTP ${response.status}`,
      models: [],
    };
  } catch (caught) {
    return {
      url: modelsUrl,
      ok: false,
      label: "Not running",
      detail: caught instanceof Error ? caught.message : String(caught),
      models: [],
    };
  }
}
