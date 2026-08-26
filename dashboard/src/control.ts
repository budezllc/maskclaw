import { extractBaseUrls, tailJsonl, tomlContainsLiteralSecret } from "./tomlEdit";

export const ENGINE_LISTEN_URL = "http://127.0.0.1:4000";

export type ProbeOptions = {
  apiKey?: string;
  model?: string;
};

export type ProbeResult = {
  url: string;
  ok: boolean;
  label: string;
  detail: string;
  models: string[];
};

export type ControlSnapshot = {
  listenUrl: string;
  engineUp: boolean;
  lastError: string | null;
  routesToml: string;
  maskclawToml: string;
  logs: string[];
};

export type ControlIO = {
  listenUrl: string;
  readRoutes(): Promise<string>;
  writeRoutes(toml: string): Promise<void>;
  readMaskclaw(): Promise<string>;
  writeMaskclaw(toml: string): Promise<void>;
  readRoutingLog(): Promise<string>;
  startEngine(): Promise<void>;
  stopEngine(): Promise<void>;
  restartEngine(): Promise<void>;
  engineUp(): Promise<boolean>;
  lastError(): string | null;
  probe(url: string, options?: ProbeOptions): Promise<ProbeResult>;
  listSecrets(): Promise<{ name: string; set: boolean }[]>;
  writeSecrets(values: Record<string, string>): Promise<void>;
};

export type ControlResponse = { status: number; json: unknown };

function jsonError(status: number, error: string): ControlResponse {
  return { status, json: { error } };
}

async function snapshot(io: ControlIO): Promise<ControlSnapshot> {
  const [routesToml, maskclawToml, logRaw, engineUp] = await Promise.all([
    io.readRoutes(),
    io.readMaskclaw(),
    io.readRoutingLog(),
    io.engineUp(),
  ]);
  return {
    listenUrl: io.listenUrl,
    engineUp,
    lastError: io.lastError(),
    routesToml,
    maskclawToml,
    logs: tailJsonl(logRaw, 40),
  };
}

export async function handleControl(
  req: { method: string; pathname: string; body?: string },
  io: ControlIO,
): Promise<ControlResponse> {
  const method = req.method.toUpperCase();
  const path = req.pathname.replace(/\/$/, "") || "/";

  try {
    if (method === "GET" && path === "/control/snapshot") {
      return { status: 200, json: await snapshot(io) };
    }
    if (method === "POST" && path === "/control/engine/start") {
      await io.startEngine();
      return { status: 200, json: await snapshot(io) };
    }
    if (method === "POST" && path === "/control/engine/stop") {
      await io.stopEngine();
      return { status: 200, json: await snapshot(io) };
    }
    if (method === "POST" && path === "/control/engine/restart") {
      await io.restartEngine();
      return { status: 200, json: await snapshot(io) };
    }
    if (method === "GET" && path === "/control/toml/routes") {
      return { status: 200, json: { toml: await io.readRoutes() } };
    }
    if (method === "PUT" && path === "/control/toml/routes") {
      const toml = parseTomlBody(req.body);
      if (tomlContainsLiteralSecret(toml)) {
        return jsonError(400, "Do not put secrets in routes.toml. Use api_key_env.");
      }
      await io.writeRoutes(toml);
      await io.restartEngine();
      return { status: 200, json: await snapshot(io) };
    }
    if (method === "GET" && path === "/control/toml/maskclaw") {
      return { status: 200, json: { toml: await io.readMaskclaw() } };
    }
    if (method === "PUT" && path === "/control/toml/maskclaw") {
      const toml = parseTomlBody(req.body);
      await io.writeMaskclaw(toml);
      await io.restartEngine();
      return { status: 200, json: await snapshot(io) };
    }
    if (method === "GET" && path === "/control/secrets") {
      return { status: 200, json: { secrets: await io.listSecrets() } };
    }
    if (method === "PUT" && path === "/control/secrets") {
      await io.writeSecrets(parseSecretsBody(req.body));
      return { status: 200, json: { secrets: await io.listSecrets() } };
    }
    if (method === "POST" && path === "/control/probe") {
      const parsed = req.body ? (JSON.parse(req.body) as ProbeOptions & { url?: string }) : {};
      const options: ProbeOptions = {
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
      };
      if (!parsed.url) {
        const toml = await io.readRoutes();
        const urls = extractBaseUrls(toml);
        const results = [];
        for (const url of urls) {
          results.push(await io.probe(url));
        }
        return { status: 200, json: { results } };
      }
      return { status: 200, json: { results: [await io.probe(parsed.url, options)] } };
    }
    return jsonError(404, "unknown control route");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return jsonError(500, message);
  }
}

function parseTomlBody(body: string | undefined): string {
  if (!body) {
    throw new Error("missing body");
  }
  const parsed = JSON.parse(body) as { toml?: unknown };
  if (typeof parsed.toml !== "string") {
    throw new Error("toml must be a string");
  }
  return parsed.toml;
}

function parseSecretsBody(body: string | undefined): Record<string, string> {
  if (!body) {
    throw new Error("missing body");
  }
  const parsed = JSON.parse(body) as { values?: unknown };
  if (!parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) {
    throw new Error("values must be an object");
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.values as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`${name} must be a string`);
    }
    values[name] = value;
  }
  return values;
}
