import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { adaptStats, findTrackStats, lastRequestHop, smartRouteStats, trackStatsByRoute } from "./engineStats";
import { pageFromHash } from "./hashNav";
import { defaultClientModel, parseRoutes, routeIdsFromToml, routeRowsFromIds } from "./models";
import { BoardPage } from "./components/BoardPage";
import { BoxPage } from "./components/BoxPage";
import { EngineSettingsPage } from "./components/EngineSettingsPage";
import { MaskPage } from "./components/MaskPage";
import { ModelsPage } from "./components/ModelsPage";
import type { SetupForm } from "./setupTypes";
import { adaptMaskclawStats, assertStatsSafe, fetchStats, forceLocalRouteLabel, kindPlates } from "./stats";
import { showBoxAdmin, surfaceFromEnv, surfaceFromViteMode } from "./surface";
import pkg from "../package.json";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("surface", () => {
  it("hides box admin in local mode", () => {
    expect(surfaceFromEnv("local")).toBe("local");
    expect(showBoxAdmin("local")).toBe(false);
    expect(showBoxAdmin("appliance")).toBe(true);
  });

  it("maps Vite sidecar mode to the local surface (Vite reserves --mode local)", () => {
    expect(surfaceFromViteMode("sidecar")).toBe("local");
    expect(surfaceFromViteMode("development")).toBe("local");
    expect(surfaceFromViteMode("appliance")).toBe("appliance");
    const scripts = pkg.scripts;
    expect(scripts.dev).not.toMatch(/--mode local(?:\s|$)/);
    expect(scripts.build).not.toMatch(/--mode local(?:\s|$)/);
    expect(scripts.dev).toMatch(/--mode sidecar/);
  });
});

describe("hash", () => {
  it("keeps Box off the local surface", () => {
    expect(pageFromHash("#box", "local")).toBe("board");
    expect(pageFromHash("#box", "appliance")).toBe("box");
    expect(pageFromHash("#mask", "local")).toBe("mask");
    expect(pageFromHash("#settings", "local")).toBe("settings");
    expect(pageFromHash("#models", "local")).toBe("models");
    expect(pageFromHash("#models", "appliance")).toBe("models");
  });
});

describe("stats", () => {
  it("rejects payloads that look like secrets", () => {
    expect(() => assertStatsSafe('{"email":"ada@example.com"}')).toThrow(/secret/);
    expect(() => assertStatsSafe('{"p":"__MC_email_ab"}')).toThrow(/secret/);
  });

  it("parses a clean snapshot and sorts kinds by count", () => {
    expect(kindPlates({ phone: 1, email: 4, person: 4 })).toEqual([
      ["email", 4],
      ["person", 4],
      ["phone", 1],
    ]);
  });

  it("fetches /v1/maskclaw/stats without leaking secrets into parse", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            enabled: true,
            matches: 2,
            by_kind: { email: 2 },
            sessions: { active: 1, unique_values: 1 },
          }),
          { status: 200 },
        ),
    );
    const snapshot = await fetchStats(fetcher as unknown as typeof fetch);
    expect(snapshot.matches).toBe(2);
    expect(snapshot.by_kind?.email).toBe(2);
  });

  it("adapts MaskClaw counters including detectors and residual", () => {
    const view = adaptMaskclawStats({
      enabled: true,
      force_local: "on_unmaskable",
      local_route_id: "unsloth-local",
      session_ttl_secs: 900,
      detectors: { email: true, phone: false },
      dictionary_count: 1,
      regex_count: 4,
      allowlist_count: 0,
      requests: 10,
      requests_with_matches: 3,
      matches: 7,
      critical: 0,
      residual: 2,
      force_local_overrides: 1,
      restore_misses: 0,
      by_kind: { person: 5, email: 2 },
      sessions: { active: 4, unique_values: 8 },
    });
    expect(view.matches).toBe(7);
    expect(view.residual).toBe(2);
    expect(view.detectors.phone).toBe(false);
    expect(view.byKind[0]).toEqual(["person", 5]);
    expect(view.localRouteId).toBe("unsloth-local");
    expect(forceLocalRouteLabel("never", "unsloth-local")).toBe("");
    expect(forceLocalRouteLabel("always", "unsloth-local", ["lmstudio-local"])).toBe("");
    expect(forceLocalRouteLabel("on_unmaskable", "lmstudio-local", ["lmstudio-local"])).toBe(
      "lmstudio-local",
    );
  });
});

describe("engine stats", () => {
  it("adapts live /v1/stats shape and matches tracks by compact id", () => {
    const stats = adaptStats({
      total_requests: 360,
      total_errors: 0,
      total_tokens: { prompt: 100, completion: 20, cached: 5, cache_creation: 0, reasoning: 1 },
      models: {
        "MiniMax-M3": {
          calls: 245,
          errors: 0,
          prompt_tokens: 10,
          completion_tokens: 4,
          model_call_latency: { avg_ms: 2807.63, p50_ms: 1922.64 },
        },
      },
      classifier: { total_requests: 347, total_errors: 0, models: {} },
      routing_overhead: { count: 360, total_ms: 1000, avg_ms: 2.7 },
      routing_fallbacks: { context_window: 0, unavailable: 1 },
    });
    expect(stats.totalRequests).toBe(360);
    expect(stats.totalTokens.prompt_tokens).toBe(100);
    expect(stats.classifierRequests).toBe(347);
    expect(stats.routingFallbacks.count).toBe(1);
    expect(findTrackStats("minimax-m3", stats)?.calls).toBe(245);
    expect(findTrackStats("minimax-m3", stats)?.avgLatencyMs).toBeCloseTo(2807.63);
  });

  it("joins local tracks to stats keyed by the backend model id", () => {
    const stats = adaptStats({
      total_requests: 40,
      total_errors: 0,
      models: {
        "MiniMax-M3": { calls: 30, errors: 0, model_call_latency: { avg_ms: 2000 } },
        "qwen2.5-coder-7b": { calls: 10, errors: 1, model_call_latency: { avg_ms: 450 } },
      },
    });
    expect(findTrackStats("lmstudio-local", stats)).toBeUndefined();
    expect(findTrackStats("lmstudio-local", stats, ["qwen2.5-coder-7b"])?.calls).toBe(10);
    expect(findTrackStats("lmstudio-local", stats, ["qwen2.5-coder-7b"])?.errors).toBe(1);
    expect(findTrackStats("minimax-m3", stats, ["MiniMax-M3"])?.calls).toBe(30);
  });

  it("fills the leftover local track from overnight stats without a toml join", () => {
    const stats = adaptStats({
      total_requests: 2228,
      total_errors: 0,
      models: {
        "MiniMax-M3": { calls: 1126, errors: 0, model_call_latency: { avg_ms: 3900 } },
        "gemma-4-e4b-it": { calls: 1102, errors: 0, model_call_latency: { avg_ms: 800 } },
      },
      classifier: {
        total_requests: 1166,
        models: { "gemma-4-e4b-it": { calls: 1162, errors: 0 } },
      },
    });
    const byRoute = trackStatsByRoute(
      ["lmstudio-local", "minimax-m3", "switchyard"],
      stats,
    );
    expect(byRoute["minimax-m3"]?.calls).toBe(1126);
    expect(byRoute["lmstudio-local"]?.id).toBe("gemma-4-e4b-it");
    expect(byRoute["lmstudio-local"]?.calls).toBe(1102);
    expect(byRoute.switchyard?.calls).toBe(2228);
  });

  it("rolls smart routing totals onto the maskclaw track", () => {
    const stats = adaptStats({
      total_requests: 4,
      total_errors: 0,
      models: {
        "MiniMax-M3": { calls: 2, errors: 0 },
        "gemma-4-e4b-it": { calls: 2, errors: 0 },
      },
    });
    const byRoute = trackStatsByRoute(["maskclaw", "minimax-m3", "lmstudio-local"], stats, {
      "minimax-m3": ["MiniMax-M3"],
      "lmstudio-local": ["gemma-4-e4b-it"],
    });
    expect(byRoute.maskclaw?.calls).toBe(4);
    expect(smartRouteStats(stats, "maskclaw")?.calls).toBe(4);
  });

  it("reads the last requested route and selected backend from engine logs", () => {
    expect(
      lastRequestHop([
        'requested_model="switchyard" selected_model="gemma-4-e4b-it"',
        'requested_model="switchyard" selected_model="MiniMax-M3" streaming=false',
      ]),
    ).toEqual({ requested: "switchyard", selected: "MiniMax-M3" });
  });
});

describe("models", () => {
  it("prefers maskclaw over a listed local pin as the client model", () => {
    expect(defaultClientModel(["lmstudio-local", "minimax-m3", "maskclaw"], "lmstudio-local")).toBe(
      "maskclaw",
    );
    expect(defaultClientModel(["switchyard", "lmstudio-local"])).toBe("switchyard");
    expect(defaultClientModel(["lmstudio-local"], "lmstudio-local")).toBe("lmstudio-local");
  });

  it("lists maskclaw as track 01 even when the engine listed a local pin first", () => {
    const routes = parseRoutes({
      data: [{ id: "lmstudio-local" }, { id: "minimax-m3" }, { id: "maskclaw" }],
    });
    expect(routes.map((row) => row.id)).toEqual(["maskclaw", "lmstudio-local", "minimax-m3"]);
    expect(routes.map((row) => row.track)).toEqual(["01", "02", "03"]);
  });

  it("hides hyphenated aliases of the same provider model", () => {
    const routes = parseRoutes({
      data: [
        { id: "maskclaw" },
        { id: "nvidia-nemotron-3-5-lightning-free" },
        { id: "nvidia/nemotron-3.5-lightning:free" },
        { id: "MiniMax-M3" },
        { id: "minimax-m3" },
      ],
    });
    expect(routes.map((row) => row.id)).toEqual([
      "maskclaw",
      "nvidia/nemotron-3.5-lightning:free",
      "MiniMax-M3",
    ]);
  });

  it("prefers the listed default model id", () => {
    const routes = parseRoutes({
      default_model: "maskclaw",
      data: [{ id: "maskclaw" }, { id: "unsloth-local" }],
    });
    expect(routes.map((row) => row.id)).toEqual(["maskclaw", "unsloth-local"]);
    expect(defaultClientModel(routes.map((row) => row.id), "maskclaw")).toBe("maskclaw");
  });

  it("reads route ids from routes.toml when /v1/models is unavailable", () => {
    const toml = `
[routes.smart]
id = "maskclaw"

[routes.local]
id = "lmstudio-local"

[routes.cloud]
id = "minimax-m3"
`;
    expect(routeIdsFromToml(toml)).toEqual(["maskclaw", "lmstudio-local", "minimax-m3"]);
    expect(routeRowsFromIds(routeIdsFromToml(toml)).map((row) => row.id)).toEqual([
      "maskclaw",
      "lmstudio-local",
      "minimax-m3",
    ]);
  });
});

describe("pages", () => {
  it("renders yard tracks and masking ledger without secrets", () => {
    render(
      <BoardPage
        engineUp={true}
        listenUrl="http://127.0.0.1:4000"
        surface="local"
        hostNetwork={null}
        routes={[{ id: "lmstudio-local", track: "01", displayName: "lmstudio-local", contextWindow: null, streaming: true, toolCalling: false }]}
        backendIdsByRoute={{ "lmstudio-local": ["qwen2.5-coder-7b"] }}
        modelId="switchyard"
        stats={adaptStats({
          total_requests: 10,
          total_errors: 0,
          models: { "qwen2.5-coder-7b": { calls: 10, errors: 0, model_call_latency: { avg_ms: 450 } } },
        })}
        logs={['{"model":"maskclaw"}']}
        probes={[]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={() => {}}
      />,
    );
    expect(screen.getAllByText("lmstudio-local").length).toBeGreaterThan(0);
    expect(screen.getByText("qwen2.5-coder-7b")).toBeTruthy();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    expect(screen.getByText("HOME")).toBeTruthy();
    expect(screen.getByText("Engine live")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test connections" })).toBeTruthy();
    expect(screen.queryByText("Probe backends")).toBeNull();
    const clientToggle = screen.getByRole("button", { name: "Client target" });
    expect(clientToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Base URL v1")).toBeNull();
    fireEvent.click(clientToggle);
    expect(clientToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/OpenAI-compatible client/)).toBeTruthy();
    expect(screen.getByText("Base URL v1")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:4000/v1")).toBeTruthy();
    expect(screen.queryByText(/Point tools at the sidecar/)).toBeNull();
    expect(screen.getByRole("button", { name: "Copy V1" })).toBeTruthy();
    expect(document.querySelector(".text-3xl")).toBeTruthy();
    expect(screen.queryByText("ada@")).toBeNull();
    expect(screen.getByText('{"model":"maskclaw"}')).toBeTruthy();

    render(
      <MaskPage
        maskclaw={adaptMaskclawStats({
          enabled: true,
          matches: 3,
          requests: 1,
          requests_with_matches: 1,
          by_kind: { email: 3 },
          sessions: { active: 1, unique_values: 1 },
        })}
      />,
    );
    expect(screen.getByText("MASKED")).toBeTruthy();
    expect(screen.getAllByText("email").length).toBeGreaterThan(0);

    cleanup();
    render(
      <MaskPage
        routeIds={["maskclaw", "minimax-m3"]}
        maskclaw={adaptMaskclawStats({
          enabled: true,
          force_local: "never",
          local_route_id: "unsloth-local",
          matches: 0,
          requests: 8,
        })}
      />,
    );
    expect(screen.queryByText(/unsloth/i)).toBeNull();
    expect(screen.getByText("force_local never")).toBeTruthy();
  });

  it("lists every track as the client model and selects maskclaw by default", async () => {
    cleanup();
    render(
      <BoardPage
        engineUp={true}
        listenUrl="http://127.0.0.1:4000"
        surface="local"
        hostNetwork={null}
        routes={[
          { id: "lmstudio-local", track: "01", displayName: "lmstudio-local", contextWindow: null, streaming: true, toolCalling: false },
          { id: "minimax-m3", track: "02", displayName: "minimax-m3", contextWindow: 1_000_000, streaming: true, toolCalling: true },
          { id: "maskclaw", track: "03", displayName: "maskclaw", contextWindow: 1_000_000, streaming: true, toolCalling: true },
        ]}
        modelId="maskclaw"
        stats={null}
        logs={[]}
        probes={[]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Client target" }));
    const picker = screen.getByRole("combobox", { name: "Model" });
    expect(picker.textContent).toContain("maskclaw (smart routing)");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fireEvent.click(picker);
    expect(screen.getByRole("option", { name: "lmstudio-local" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "minimax-m3" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "maskclaw (smart routing)" })).toBeTruthy();
    const local = screen.getByRole("option", { name: "lmstudio-local" });
    fireEvent.pointerDown(local, { pointerType: "mouse" });
    fireEvent.click(local);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("lmstudio-local"));
    writeText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy model" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("lmstudio-local"));
  });

  it("shows leftover local track totals when stats use the backend model id", () => {
    cleanup();
    render(
      <BoardPage
        engineUp={true}
        listenUrl="http://127.0.0.1:4000"
        surface="local"
        hostNetwork={null}
        routes={[
          { id: "lmstudio-local", track: "01", displayName: "lmstudio-local", contextWindow: null, streaming: true, toolCalling: false },
          { id: "minimax-m3", track: "02", displayName: "minimax-m3", contextWindow: 1_000_000, streaming: true, toolCalling: true },
          { id: "switchyard", track: "03", displayName: "switchyard", contextWindow: 1_000_000, streaming: true, toolCalling: true },
        ]}
        modelId="lmstudio-local"
        stats={adaptStats({
          total_requests: 2228,
          models: {
            "MiniMax-M3": { calls: 1126, errors: 0, model_call_latency: { avg_ms: 3900 } },
            "gemma-4-e4b-it": { calls: 1102, errors: 0, model_call_latency: { avg_ms: 800 } },
          },
        })}
        logs={[
          'LLM request handled requested_model="switchyard" selected_model="MiniMax-M3" streaming=false',
        ]}
        probes={[]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={() => {}}
      />,
    );
    expect(screen.getByText("1,102")).toBeTruthy();
    expect(screen.getByText("gemma-4-e4b-it")).toBeTruthy();
    expect(screen.getByText("1,126")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Client target" }));
    expect(screen.getByText("Last request")).toBeTruthy();
    expect(screen.getByText("switchyard → MiniMax-M3")).toBeTruthy();
  });

  it("toggles Start/Stop from engine status and colors the live chip", () => {
    cleanup();
    const { rerender } = render(
      <BoardPage
        engineUp={false}
        listenUrl="http://127.0.0.1:4000"
        surface="local"
        hostNetwork={null}
        routes={[]}
        modelId="maskclaw"
        stats={null}
        logs={[]}
        probes={[]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={() => {}}
      />,
    );
    const down = screen.getByRole("status");
    expect(down.textContent).toContain("Engine down");
    expect(down.className).toContain("text-red-300");
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    rerender(
      <BoardPage
        engineUp={true}
        listenUrl="http://127.0.0.1:4000"
        surface="local"
        hostNetwork={null}
        routes={[]}
        modelId="maskclaw"
        stats={null}
        logs={[]}
        probes={[]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={() => {}}
      />,
    );
    const live = screen.getByRole("status");
    expect(live.textContent).toContain("Engine live");
    expect(live.className).toContain("text-emerald-300");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("hides connection results until Test connections, and keeps them gone after X or leaving HOME", () => {
    cleanup();
    const sample = [
      {
        url: "https://api.minimax.io/v1/models",
        ok: true,
        label: "Found",
        detail: "200",
        models: ["MiniMax-M3"],
      },
    ];
    const board = {
      engineUp: true,
      listenUrl: "http://127.0.0.1:4000",
      surface: "local" as const,
      hostNetwork: null,
      routes: [],
      modelId: "maskclaw",
      stats: null,
      logs: [] as string[],
      busy: false,
      resetting: false,
      onStart: () => {},
      onStop: () => {},
      onRestart: () => {},
      onReset: () => {},
    };
    function Shell() {
      const [page, setPage] = useState<"board" | "mask">("board");
      const [probes, setProbes] = useState<typeof sample>([]);
      function go(next: "board" | "mask") {
        if (next !== "board") {
          setProbes([]);
        }
        setPage(next);
      }
      return (
        <div>
          <button type="button" onClick={() => go("board")}>
            Go HOME
          </button>
          <button type="button" onClick={() => go("mask")}>
            Go MASKED
          </button>
          {page === "board" ? (
            <BoardPage
              {...board}
              probes={probes}
              onProbe={() => setProbes(sample)}
              onDismissProbes={() => setProbes([])}
            />
          ) : (
            <h1>MASKED</h1>
          )}
        </div>
      );
    }
    render(<Shell />);
    expect(screen.queryByRole("region", { name: "Connection results" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test connections" }));
    expect(screen.getByRole("region", { name: "Connection results" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss connection results" }));
    expect(screen.queryByRole("region", { name: "Connection results" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go MASKED" }));
    fireEvent.click(screen.getByRole("button", { name: "Go HOME" }));
    expect(screen.queryByRole("region", { name: "Connection results" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test connections" }));
    expect(screen.getByRole("region", { name: "Connection results" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go MASKED" }));
    fireEvent.click(screen.getByRole("button", { name: "Go HOME" }));
    expect(screen.queryByRole("region", { name: "Connection results" })).toBeNull();
  });

  it("shows Box copy on the appliance page", () => {
    cleanup();
    render(
      <BoxPage
        session={{ ok: true, passwordSet: false, loggedIn: false }}
        network={null}
        busy={false}
        onSetPassword={() => {}}
        onLogout={() => {}}
        onSetHostname={() => {}}
        onEthernet={() => {}}
        onWifi={() => {}}
      />,
    );
    expect(screen.getByText("BOX")).toBeTruthy();
    expect(screen.getByText("Dashboard password")).toBeTruthy();
    expect(screen.getByText("Network and hostname")).toBeTruthy();
  });

  it("toggles detectors from maskclaw.toml and exposes save buttons", () => {
    cleanup();
    const onDetector = vi.fn();
    const onSaveRoutes = vi.fn();
    const onSaveMaskclaw = vi.fn();
    render(
      <EngineSettingsPage
        maskclaw={null}
        routesToml="schema_version = 1\n"
        maskclawToml={"[detectors]\nemail = true\nphone = true\n"}
        onRoutesToml={() => {}}
        onMaskclawToml={() => {}}
        onSaveRoutes={onSaveRoutes}
        onSaveMaskclaw={onSaveMaskclaw}
        onDetector={onDetector}
        busy={false}
      />,
    );
    expect(screen.getByRole("switch", { name: "Email" })).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Email" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save routes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save MaskClaw" }));
    expect(onSaveRoutes).toHaveBeenCalledOnce();
    expect(onSaveMaskclaw).toHaveBeenCalledOnce();
    expect(onDetector).not.toHaveBeenCalled();
  });

  it("shows cloud and local on tabs, and saves each half separately", async () => {
    cleanup();
    const onApply = vi.fn<(form: SetupForm) => Promise<void>>(async () => {});
    render(
      <ModelsPage
        routesToml={`schema_version = 1

[llm_clients.minimax]
format = "openai_chat"
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[targets.strong]
id = "MiniMax-M3"
llm_client = "minimax"
`}
        secretFlags={[]}
        busy={false}
        onApply={onApply}
        onProbe={async () => ({ url: "", ok: false, label: "Not running", detail: "down", models: [] })}
      />,
    );
    expect(screen.getByText("MODELS")).toBeTruthy();
    expect(screen.queryByText(/step 1 of 2/i)).toBeNull();
    expect(screen.getByRole("tab", { name: "Cloud" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Local" })).toBeTruthy();
    expect(screen.getByLabelText("Provider")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Provider"));
    expect(screen.getByRole("option", { name: "MiniMax" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "OpenRouter" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Custom" })).toBeTruthy();
    expect(screen.getByLabelText("Strong model")).toBeTruthy();
    expect(screen.getByLabelText("Weak model")).toBeTruthy();
    expect(screen.getByDisplayValue("MiniMax-M3")).toBeTruthy();
    expect(screen.queryByText(/China endpoint/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Strong model"), { target: { value: "MiniMax-M4" } });
    fireEvent.click(screen.getByRole("tab", { name: "Local" }));
    expect(screen.getByText("Unsloth")).toBeTruthy();
    expect(screen.getByText("LM Studio")).toBeTruthy();
    expect(screen.getByText("Gemma / Ollama")).toBeTruthy();
    expect(screen.getByDisplayValue("http://127.0.0.1:8888/v1")).toBeTruthy();
    expect(screen.getByDisplayValue("unsloth/gemma-4-E4B-it-GGUF")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Unsloth"));
    fireEvent.click(screen.getByRole("button", { name: "Save local" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const savedLocal = onApply.mock.calls[0][0];
    expect(savedLocal.cloud.modelId).toBe("MiniMax-M3");
    expect(savedLocal.locals.unsloth.enabled).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Save cloud" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    const savedCloud = onApply.mock.calls[1][0];
    expect(savedCloud.cloud.modelId).toBe("MiniMax-M4");
    expect(savedCloud.locals.unsloth.enabled).toBe(true);
  });

  it("keeps MiniMax when a second cloud provider is saved from the MODELS page", async () => {
    cleanup();
    const onApply = vi.fn<(form: SetupForm) => Promise<void>>(async () => {});
    render(
      <ModelsPage
        routesToml={`schema_version = 1

[llm_clients.minimax]
format = "openai_chat"
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[targets.strong]
id = "MiniMax-M3"
llm_client = "minimax"
`}
        secretFlags={[{ name: "MINIMAX_API_KEY", set: true }]}
        busy={false}
        onApply={onApply}
        onProbe={async () => ({ url: "", ok: false, label: "Not running", detail: "down", models: [] })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Provider"));
    fireEvent.click(screen.getByRole("option", { name: "OpenAI" }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-openai-not-real" } });
    fireEvent.change(screen.getByLabelText("Strong model"), { target: { value: "gpt-4o" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cloud" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const saved = onApply.mock.calls[0][0];
    expect(saved.clouds.minimax.enabled).toBe(true);
    expect(saved.clouds.minimax.modelId).toBe("MiniMax-M3");
    expect(saved.clouds.openai.enabled).toBe(true);
    expect(saved.clouds.openai.modelId).toBe("gpt-4o");
    expect(saved.cloud.provider).toBe("openai");
    expect(screen.getByLabelText("Smart routing / fallback uses")).toBeTruthy();
  });

  it("lists models from the provider and tests a pasted model id", async () => {
    cleanup();
    const onProbe = vi.fn(async (_url: string, options?: { model?: string }) => {
      if (options?.model) {
        const ok = options.model === "MiniMax-M3";
        return {
          url: "",
          ok,
          label: ok ? "Model works" : "Unknown model",
          detail: "",
          models: ok ? [options.model] : [],
        };
      }
      return {
        url: "",
        ok: true,
        label: "Found",
        detail: "",
        models: ["MiniMax-M3", "MiniMax-M2.5"],
      };
    });
    render(
      <ModelsPage
        routesToml={`schema_version = 1

[llm_clients.minimax]
format = "openai_chat"
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[targets.strong]
id = "MiniMax-M3"
llm_client = "minimax"
`}
        secretFlags={[{ name: "MINIMAX_API_KEY", set: true }]}
        busy={false}
        onApply={async () => {}}
        onProbe={onProbe}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    await waitFor(() => expect(screen.getByLabelText("Provider models")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Provider models"));
    const list = screen.getByRole("listbox", { name: "Provider models" });
    expect(list.className).toContain("bg-popover");
    expect(list.className).toContain("text-popover-foreground");
    fireEvent.click(screen.getByRole("option", { name: "MiniMax-M2.5" }));
    expect((screen.getByLabelText("Strong model") as HTMLInputElement).value).toBe("MiniMax-M2.5");
    fireEvent.change(screen.getByLabelText("Strong model"), { target: { value: "MiniMax-M3" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByText("MiniMax-M3 works")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Strong model"), { target: { value: "nope-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByText("nope-model: Unknown model")).toBeTruthy());
  });
});
