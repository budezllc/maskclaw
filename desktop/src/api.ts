import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, previewInvoke } from "./lib/browserPreview";
import { secretsFromSetup, type SecretBinding } from "./lib/secretMapping";
import { writeSetupDraft } from "./lib/setupDraft";
import { buildDeployment } from "./lib/tomlBuilder";
import type { SetupForm } from "./lib/setupTypes";

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    return previewInvoke(cmd, args) as Promise<T>;
  }
  return invoke(cmd, args);
}

export type EngineState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "failed";

export interface AppSnapshot {
  needs_setup: boolean;
  listen_url: string;
  engine_state: EngineState;
  last_error: string | null;
  telemetry_opt_in: boolean;
  autostart: boolean;
  engine_flavor: "stock" | "maskclaw" | string;
  config_toml: string;
  maskclaw_toml: string;
  logs: string[];
  routing_tail: RoutingRecord[];
}

export interface RoutingRecord {
  ts?: string;
  session_id?: string;
  model?: string;
  tier?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  label: string;
  detail: string;
  models: string[];
}

export interface HealthResult {
  ok: boolean;
  body: string;
}

export function getSnapshot(): Promise<AppSnapshot> {
  return call("get_snapshot");
}

export function startEngine(): Promise<AppSnapshot> {
  return call("start_engine");
}

export function stopEngine(): Promise<AppSnapshot> {
  return call("stop_engine");
}

export function restartEngine(): Promise<AppSnapshot> {
  return call("restart_engine");
}

export function saveSetup(form: SetupForm): Promise<AppSnapshot> {
  writeSetupDraft(form);
  const { toml } = buildDeployment(form);
  const secrets = secretsFromSetup(form);
  return call("save_setup", { form, toml, secrets });
}

export function persistSecrets(secrets: SecretBinding[]): Promise<void> {
  if (secrets.length === 0) {
    return Promise.resolve();
  }
  return call("persist_secrets", { secrets });
}

export function loadSetupSecrets(): Promise<Record<string, string>> {
  return call("load_setup_secrets");
}

export function saveRawToml(toml: string): Promise<AppSnapshot> {
  return call("save_raw_toml", { toml });
}

export function saveRawMaskclawToml(toml: string): Promise<AppSnapshot> {
  return call("save_raw_maskclaw_toml", { toml });
}

export function setTelemetryOptIn(optIn: boolean): Promise<void> {
  return call("set_telemetry_opt_in", { optIn });
}

export function setAutostart(enabled: boolean): Promise<void> {
  return call("set_autostart", { enabled });
}

export function fetchHealth(): Promise<HealthResult> {
  return call("fetch_health");
}

export function fetchStats(): Promise<unknown> {
  return call("fetch_stats");
}

export function fetchMaskclawStats(): Promise<unknown> {
  return call("fetch_maskclaw_stats");
}

export function resetEngineStats(): Promise<void> {
  return call("reset_engine_stats");
}

export function fetchModels(): Promise<unknown> {
  return call("fetch_models");
}

export function probeInvokeArgs(url: string, apiKey?: string): { url: string; apiKey: string | null } {
  const trimmed = apiKey?.trim();
  return { url, apiKey: trimmed ? trimmed : null };
}

export function probeBackend(url: string, apiKey?: string): Promise<ProbeResult> {
  return call("probe_backend", probeInvokeArgs(url, apiKey));
}

export function openExternalUrl(url: string): Promise<void> {
  return call("open_external_url", { url });
}
