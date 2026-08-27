import { describe, expect, it, vi } from "vitest";
import { handleControl, type ControlIO, type ProbeResult } from "./control";
import { parseListeningPid, serverArgs } from "./nodeControl";
import {
  extractApiKeyEnvs,
  extractBaseUrls,
  parseDetectors,
  setDetectorLine,
  setTopLevelTomlString,
  syncMaskclawLocalRoute,
  tailJsonl,
  tomlContainsLiteralSecret,
} from "./tomlEdit";
import { applySecretUpdates, parseEngineEnv, secretStatus } from "./secretsEnv";

function io(overrides: Partial<ControlIO> = {}): ControlIO {
  let routes = 'schema_version = 1\n[llm_clients.x]\nbase_url = "http://127.0.0.1:8888/v1"\n';
  let maskclaw = "enabled = true\n[detectors]\nemail = true\n";
  return {
    listenUrl: "http://127.0.0.1:4000",
    async readRoutes() {
      return routes;
    },
    async writeRoutes(toml) {
      routes = toml;
    },
    async readMaskclaw() {
      return maskclaw;
    },
    async writeMaskclaw(toml) {
      maskclaw = toml;
    },
    async readRoutingLog() {
      return '{"model":"maskclaw"}\n{"model":"minimax-m3"}\n';
    },
    startEngine: vi.fn(async () => {}),
    stopEngine: vi.fn(async () => {}),
    restartEngine: vi.fn(async () => {}),
    async engineUp() {
      return true;
    },
    lastError() {
      return null;
    },
    async probe(url): Promise<ProbeResult> {
      return { url, ok: true, label: "Found", detail: "ok", models: [] };
    },
    async listSecrets() {
      return [{ name: "MINIMAX_API_KEY", set: false }];
    },
    writeSecrets: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("toml edit", () => {
  it("extracts unique base urls and toggles detectors", () => {
    const toml = `
[llm_clients.a]
base_url = "http://127.0.0.1:8888/v1"
[llm_clients.b]
base_url = "http://127.0.0.1:8888/v1"
`;
    expect(extractBaseUrls(toml)).toEqual(["http://127.0.0.1:8888/v1"]);
    expect(setDetectorLine("[detectors]\nemail = true\n", "email", false)).toContain("email = false");
    const toggled = setDetectorLine("[detectors]\nemail = true\nphone = true\n", "email", false);
    expect(parseDetectors(toggled)).toMatchObject({ email: false, phone: true, ssn: true });
    expect(parseDetectors("enabled = true\n")).toMatchObject({ email: true, api_key: true });
    const commented = `enabled = true\n\n# [detectors]\n# email = true\n\n[detectors]\nphone = true\nemail = false\n`;
    expect(parseDetectors(commented)).toMatchObject({ email: false, phone: true, api_key: true });
    expect(parseDetectors(setDetectorLine(commented, "email", true)).email).toBe(true);
    expect(tomlContainsLiteralSecret('api_key = "sk-live"')).toBe(true);
    expect(tomlContainsLiteralSecret('api_key_env = "MINIMAX_API_KEY"')).toBe(false);
    expect(extractApiKeyEnvs('api_key_env = "MINIMAX_API_KEY"\napi_key_env = "UNSLOTH_API_KEY"\napi_key_env = "MINIMAX_API_KEY"')).toEqual([
      "MINIMAX_API_KEY",
      "UNSLOTH_API_KEY",
    ]);
    expect(tailJsonl("a\nb\nc\n", 2)).toEqual(["b", "c"]);
  });

  it("drops a stale unsloth-local pin when routes.toml no longer has that route", () => {
    const sidecar = `enabled = true
force_local = "never"
local_route_id = "unsloth-local"

[detectors]
email = true
`;
    const routes = `
schema_version = 1
[routes.minimax]
id = "minimax-m3"
`;
    const synced = syncMaskclawLocalRoute(sidecar, routes);
    expect(synced).not.toMatch(/unsloth-local/);
    expect(synced).toContain("[detectors]");
    expect(setTopLevelTomlString(sidecar, "local_route_id", "lmstudio-local")).toContain(
      'local_route_id = "lmstudio-local"',
    );
  });
});

describe("control", () => {
  it("saves routes.toml and restarts, rejecting literal secrets", async () => {
    const control = io();
    await control.writeMaskclaw(`enabled = true
force_local = "never"
local_route_id = "unsloth-local"
`);
    const probed = await handleControl({ method: "POST", pathname: "/control/probe", body: "{}" }, control);
    expect(probed.status).toBe(200);
    expect(probed.json).toMatchObject({ results: [{ ok: true }] });
    const saved = await handleControl(
      { method: "PUT", pathname: "/control/toml/routes", body: JSON.stringify({ toml: "schema_version = 1\n" }) },
      control,
    );
    expect(saved.status).toBe(200);
    expect(control.restartEngine).toHaveBeenCalledOnce();
    expect(await control.readMaskclaw()).not.toMatch(/unsloth/);

    const rejected = await handleControl(
      {
        method: "PUT",
        pathname: "/control/toml/routes",
        body: JSON.stringify({ toml: 'api_key = "sk-secret"\n' }),
      },
      control,
    );
    expect(rejected.status).toBe(400);
  });

  it("starts and stops the engine through control routes", async () => {
    const control = io();
    expect((await handleControl({ method: "POST", pathname: "/control/engine/start" }, control)).status).toBe(200);
    expect(control.startEngine).toHaveBeenCalledOnce();
    expect((await handleControl({ method: "POST", pathname: "/control/engine/stop" }, control)).status).toBe(200);
    expect(control.stopEngine).toHaveBeenCalledOnce();
  });

  it("lists secret names without values and writes engine.env", async () => {
    const listed = await handleControl({ method: "GET", pathname: "/control/secrets" }, io());
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({ secrets: [{ name: "MINIMAX_API_KEY", set: false }] });
    expect(JSON.stringify(listed.json)).not.toMatch(/sk-/);

    const control = io();
    const saved = await handleControl(
      {
        method: "PUT",
        pathname: "/control/secrets",
        body: JSON.stringify({ values: { MINIMAX_API_KEY: "test-key-value" } }),
      },
      control,
    );
    expect(saved.status).toBe(200);
    expect(control.writeSecrets).toHaveBeenCalledWith({ MINIMAX_API_KEY: "test-key-value" });
    expect(control.restartEngine).not.toHaveBeenCalled();
  });

  it("forwards a pasted API key and model id to probe", async () => {
    const probe = vi.fn(async () => ({
      url: "https://api.minimax.io/v1/models",
      ok: true,
      label: "Found",
      detail: "ok",
      models: ["MiniMax-M3"],
    }));
    const control = io({ probe });
    const listed = await handleControl(
      {
        method: "POST",
        pathname: "/control/probe",
        body: JSON.stringify({ url: "https://api.minimax.io/v1", apiKey: "sk-test-not-real" }),
      },
      control,
    );
    expect(listed.status).toBe(200);
    expect(probe).toHaveBeenCalledWith("https://api.minimax.io/v1", {
      apiKey: "sk-test-not-real",
      model: undefined,
    });
    await handleControl(
      {
        method: "POST",
        pathname: "/control/probe",
        body: JSON.stringify({
          url: "https://api.minimax.io/v1",
          apiKey: "sk-test-not-real",
          model: "MiniMax-M3",
        }),
      },
      control,
    );
    expect(probe).toHaveBeenCalledWith("https://api.minimax.io/v1", {
      apiKey: "sk-test-not-real",
      model: "MiniMax-M3",
    });
    expect(JSON.stringify(listed.json)).not.toMatch(/sk-test-not-real/);
  });
});

describe("engine helpers", () => {
  it("parses netstat pid and builds maskclaw server args", () => {
    const output = "  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       30332";
    expect(parseListeningPid(output, 4000)).toBe(30332);
    const args = serverArgs("C:/data");
    expect(args).toContain("--maskclaw-config");
    expect(args.some((arg) => arg.endsWith("maskclaw.toml"))).toBe(true);
  });
});

describe("engine env", () => {
  it("parses names and never treats empty updates as a write", () => {
    const stored = parseEngineEnv("MINIMAX_API_KEY=test-key-value\n# comment\n");
    expect(secretStatus(["MINIMAX_API_KEY", "UNSLOTH_API_KEY"], stored)).toEqual([
      { name: "MINIMAX_API_KEY", set: true },
      { name: "UNSLOTH_API_KEY", set: false },
    ]);
    expect(() => applySecretUpdates(stored, { MINIMAX_API_KEY: "  " })).toThrow(/at least one/);
    expect(applySecretUpdates(stored, { UNSLOTH_API_KEY: "other-test-key" }).UNSLOTH_API_KEY).toBe("other-test-key");
  });
});
