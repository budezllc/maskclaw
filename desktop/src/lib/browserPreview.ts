import type { AppSnapshot, HealthResult, ProbeResult } from "../api";

type MaybeTauriWindow = { __TAURI_INTERNALS__?: unknown };

export function isTauriRuntime(win?: MaybeTauriWindow): boolean {
  const target =
    win ?? (typeof window === "undefined" ? undefined : (window as MaybeTauriWindow));
  return Boolean(target && "__TAURI_INTERNALS__" in target);
}

const PREVIEW_TOML = `
schema_version = 1

[targets.lmstudio]
id = "gemma-4-e4b-it"
base_url = "http://127.0.0.1:1234/v1"

[targets.minimax]
id = "MiniMax-M3"
base_url = "https://api.minimax.io/v1"

[routes.local]
id = "lmstudio-local"
target = "lmstudio"

[routes.smart]
id = "maskclaw"
strong_target = "minimax"
weak_target = "lmstudio"

[routes.minimax]
id = "minimax-m3"
target = "minimax"
`;

export function previewSnapshot(): AppSnapshot {
  return {
    needs_setup: false,
    listen_url: "http://127.0.0.1:4000",
    engine_state: "running",
    last_error: null,
    telemetry_opt_in: false,
    autostart: false,
    engine_flavor: "maskclaw",
    config_toml: PREVIEW_TOML.trim(),
    maskclaw_toml: "enabled = true\n",
    logs: ['requested_model="lmstudio-local" selected_model="gemma-4-e4b-it"'],
    routing_tail: [],
  };
}

export function previewHealth(): HealthResult {
  return { ok: true, body: '{"status":"ok"}' };
}

export function previewStats(): unknown {
  return {
    total_requests: 1216,
    total_errors: 0,
    classifier_requests: 165,
    classifier_errors: 0,
    total_tokens: {
      prompt_tokens: 550894,
      completion_tokens: 100889,
      cached_tokens: 23567,
    },
    routing_overhead: { count: 1216, sum_ms: 942, avg_ms: 942 },
    routing_fallbacks: { count: 0 },
    by_model: {
      "gemma-4-e4b-it": { calls: 1044, errors: 0, latency_ms: [1700] },
      "MiniMax-M3": { calls: 172, errors: 0, latency_ms: [3200] },
    },
  };
}

export function previewModels(): unknown {
  return {
    default_model: "lmstudio-local",
    data: [
      { id: "lmstudio-local", capabilities: { context_window: 131072 } },
      { id: "maskclaw", capabilities: { context_window: 1000000 } },
      { id: "minimax-m3", capabilities: { context_window: 1000000 } },
    ],
  };
}

export function previewMaskclawStats(): unknown {
  return {
    enabled: true,
    requests: 10,
    requests_with_matches: 4,
    matches: 7,
    critical: 1,
    residual: 2,
    force_local: "on_unmaskable",
    local_route_id: "lmstudio-local",
    session_ttl_secs: 900,
    dictionary_count: 12,
    regex_count: 3,
    allowlist_count: 1,
    force_local_overrides: 3,
    restore_misses: 1,
    sessions: { active: 2, unique_values: 5 },
    by_kind: { email: 3, phone: 1 },
  };
}

export function previewProbe(url: string): ProbeResult {
  return { url, ok: true, label: "Reachable", detail: "preview", models: [] };
}

export async function previewInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const snap = previewSnapshot();
  switch (cmd) {
    case "get_snapshot":
    case "start_engine":
    case "stop_engine":
    case "restart_engine":
    case "save_setup":
    case "save_raw_toml":
    case "save_raw_maskclaw_toml":
      return snap;
    case "fetch_health":
      return previewHealth();
    case "fetch_stats":
      return previewStats();
    case "fetch_models":
      return previewModels();
    case "fetch_maskclaw_stats":
      return previewMaskclawStats();
    case "reset_engine_stats":
    case "set_telemetry_opt_in":
    case "set_autostart":
    case "open_external_url":
    case "persist_secrets":
      return undefined;
    case "load_setup_secrets":
      return {};
    case "probe_backend":
      return previewProbe(typeof args?.url === "string" ? args.url : "");
    default:
      throw new Error(`preview invoke: unknown command ${cmd}`);
  }
}
