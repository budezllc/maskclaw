import type { ControlSnapshot, ProbeOptions, ProbeResult } from "./control";

export type { ControlSnapshot, ProbeOptions, ProbeResult } from "./control";
export { ENGINE_LISTEN_URL } from "./control";

export type HostSession = {
  ok: boolean;
  passwordSet: boolean;
  loggedIn: boolean;
};

export type HostWifiNetwork = {
  ssid: string;
  signal: number;
  security: string;
};

export type HostInterface = {
  name: string;
  type: string;
  state: string;
  connected: boolean;
  connection?: string;
  ip: string | null;
};

export type HostNetwork = {
  hostname: string;
  addresses: string[];
  wifiAvailable: boolean;
  interfaces: HostInterface[];
  wifi: {
    available: boolean;
    radioOn: boolean;
    connectedSsid: string | null;
    networks: HostWifiNetwork[];
  };
  active: { device: string; type: string } | null;
};

async function jsonError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

const sameOrigin: RequestInit = { credentials: "same-origin" };

const devControlToken = import.meta.env.VITE_DEV_CONTROL_TOKEN as string | undefined;

function controlFetchInit(init: RequestInit = {}): RequestInit {
  if (!devControlToken) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.set("X-MaskClaw-Dev-Token", devControlToken);
  return { ...init, headers };
}

function controlFetcher(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, controlFetchInit(init));
}

export async function fetchHostSession(fetcher: typeof fetch = fetch): Promise<HostSession> {
  const response = await fetcher("/host/session", sameOrigin);
  const body = (await response.json().catch(() => ({}))) as Partial<HostSession>;
  return {
    ok: Boolean(body.ok) && response.ok,
    passwordSet: Boolean(body.passwordSet),
    loggedIn: Boolean(body.loggedIn),
  };
}

export async function hostLogin(password: string, fetcher: typeof fetch = fetch): Promise<HostSession> {
  const response = await fetcher("/host/login", {
    ...sameOrigin,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(await jsonError(response, `login ${response.status}`));
  }
  return (await response.json()) as HostSession;
}

export async function hostLogout(fetcher: typeof fetch = fetch): Promise<HostSession> {
  const response = await fetcher("/host/logout", { ...sameOrigin, method: "POST" });
  if (!response.ok) {
    throw new Error(await jsonError(response, `logout ${response.status}`));
  }
  return (await response.json()) as HostSession;
}

export async function setDashboardPassword(
  password: string,
  current: string | undefined,
  fetcher: typeof fetch = fetch,
  setupToken?: string,
): Promise<HostSession> {
  const payload: Record<string, string> = { password };
  if (current) {
    payload.current = current;
  }
  if (setupToken) {
    payload.setupToken = setupToken;
  }
  const response = await fetcher("/host/password", {
    ...sameOrigin,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await jsonError(response, `password ${response.status}`));
  }
  return (await response.json()) as HostSession;
}

export async function fetchHostNetwork(fetcher: typeof fetch = fetch): Promise<HostNetwork> {
  const response = await fetcher("/host/network", sameOrigin);
  if (!response.ok) {
    throw new Error(await jsonError(response, `network ${response.status}`));
  }
  return (await response.json()) as HostNetwork;
}

export async function setHostname(hostname: string, fetcher: typeof fetch = fetch): Promise<HostNetwork> {
  const response = await fetcher("/host/hostname", {
    ...sameOrigin,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname }),
  });
  if (!response.ok) {
    throw new Error(await jsonError(response, `hostname ${response.status}`));
  }
  return (await response.json()) as HostNetwork;
}

export async function connectEthernet(fetcher: typeof fetch = fetch): Promise<HostNetwork> {
  const response = await fetcher("/host/network/ethernet", { ...sameOrigin, method: "POST" });
  if (!response.ok) {
    throw new Error(await jsonError(response, `ethernet ${response.status}`));
  }
  return (await response.json()) as HostNetwork;
}

export async function connectWifi(ssid: string, password: string, fetcher: typeof fetch = fetch): Promise<HostNetwork> {
  const response = await fetcher("/host/network/wifi", {
    ...sameOrigin,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(password ? { ssid, password } : { ssid }),
  });
  if (!response.ok) {
    throw new Error(await jsonError(response, `wifi ${response.status}`));
  }
  return (await response.json()) as HostNetwork;
}

export interface HealthResult {
  ok: boolean;
  body: string;
}

async function readJson(path: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(path);
  if (!response.ok) {
    throw new Error(`${path} ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function fetchHealth(fetcher: typeof fetch = fetch): Promise<HealthResult> {
  const response = await fetcher("/health");
  const body = await response.text();
  return { ok: response.ok, body };
}

export function fetchEngineStats(fetcher: typeof fetch = fetch): Promise<unknown> {
  return readJson("/v1/stats", fetcher);
}

/** Poll-friendly: keep dashboard live when a single tick fails. */
export async function tryFetchEngineStats(fetcher: typeof fetch = fetch): Promise<unknown | null> {
  try {
    return await fetchEngineStats(fetcher);
  } catch {
    return null;
  }
}

export function fetchModels(fetcher: typeof fetch = fetch): Promise<unknown> {
  return readJson("/v1/models", fetcher);
}

export async function resetEngineStats(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("/v1/stats/reset", { method: "POST" });
  if (!response.ok) {
    throw new Error(`reset ${response.status}`);
  }
}

export async function fetchControlSnapshot(fetcher: typeof fetch = fetch): Promise<ControlSnapshot> {
  const response = await controlFetcher(fetcher)("/control/snapshot");
  if (!response.ok) {
    throw new Error(`control ${response.status}`);
  }
  return (await response.json()) as ControlSnapshot;
}

export async function postControl(path: string, fetcher: typeof fetch = fetch): Promise<ControlSnapshot> {
  const response = await controlFetcher(fetcher)(path, { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${path} ${response.status}`);
  }
  return (await response.json()) as ControlSnapshot;
}

export function startEngine(fetcher: typeof fetch = fetch): Promise<ControlSnapshot> {
  return postControl("/control/engine/start", fetcher);
}

export function stopEngine(fetcher: typeof fetch = fetch): Promise<ControlSnapshot> {
  return postControl("/control/engine/stop", fetcher);
}

export function restartEngine(fetcher: typeof fetch = fetch): Promise<ControlSnapshot> {
  return postControl("/control/engine/restart", fetcher);
}

export async function saveToml(
  kind: "routes" | "maskclaw",
  toml: string,
  fetcher: typeof fetch = fetch,
): Promise<ControlSnapshot> {
  const response = await controlFetcher(fetcher)(`/control/toml/${kind}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toml }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `save ${kind} ${response.status}`);
  }
  return (await response.json()) as ControlSnapshot;
}

export async function probeBackend(
  url: string,
  options: ProbeOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<ProbeResult> {
  const response = await controlFetcher(fetcher)("/control/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, apiKey: options.apiKey, model: options.model }),
  });
  if (!response.ok) {
    throw new Error(`probe ${response.status}`);
  }
  const body = (await response.json()) as { results: ProbeResult[] };
  const result = body.results[0];
  if (!result) {
    throw new Error("probe returned no result");
  }
  return { ...result, models: result.models ?? [] };
}

export async function probeBackends(fetcher: typeof fetch = fetch): Promise<ProbeResult[]> {
  const response = await controlFetcher(fetcher)("/control/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!response.ok) {
    throw new Error(`probe ${response.status}`);
  }
  const body = (await response.json()) as { results: ProbeResult[] };
  return body.results.map((result) => ({ ...result, models: result.models ?? [] }));
}

export async function fetchSecrets(fetcher: typeof fetch = fetch): Promise<{ name: string; set: boolean }[]> {
  const response = await controlFetcher(fetcher)("/control/secrets");
  if (!response.ok) {
    throw new Error(`secrets ${response.status}`);
  }
  const body = (await response.json()) as { secrets: { name: string; set: boolean }[] };
  return body.secrets;
}

export async function writeSecrets(
  values: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<{ name: string; set: boolean }[]> {
  const response = await controlFetcher(fetcher)("/control/secrets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `secrets ${response.status}`);
  }
  const body = (await response.json()) as { secrets: { name: string; set: boolean }[] };
  return body.secrets;
}
