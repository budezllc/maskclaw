import { useEffect, useState } from "react";
import type { AppSnapshot, ProbeResult } from "../../api";
import {
  fetchHealth,
  fetchMaskclawStats,
  fetchModels,
  fetchStats,
  probeBackend,
  resetEngineStats,
  restartEngine,
  startEngine,
  stopEngine,
} from "../../api";
import { CopyButton } from "../CopyButton";
import { Settings } from "../Settings";
import { MaskClawModels } from "./MaskClawModels";
import { snapshotFromInvokeError } from "../../lib/engineControls";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, createPollGate, runPollTick, withTimeout } from "../../lib/enginePoll";
import { formatCount, formatMs, lastRequestHop } from "../../lib/formatStats";
import { MASKCLAW_NAV_ITEMS, type MaskclawPane } from "../../lib/maskclawNav";
import { adaptMaskclawStats, forceLocalRouteLabel, localRouteIdsInToml, type MaskclawStatsView } from "../../lib/maskclawStatsAdapter";
import { defaultModelFromPayload, parseRoutes, type RouteRow } from "../../lib/parseRoutes";
import { adaptStats, routeTargetAliases, trackStatsByRoute, type StatsViewModel } from "../../lib/statsAdapter";
import { applyAppearance, nextAppearance, persistAppearance, themeActionWord, type Appearance } from "../../lib/theme";

interface Props {
  snap: AppSnapshot;
  pane: MaskclawPane;
  onPane: (pane: MaskclawPane) => void;
  onChange: (snap: AppSnapshot) => void;
  refresh: () => Promise<AppSnapshot>;
  theme: Appearance;
  onTheme: (theme: Appearance) => void;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="mc-metric">
      <p className="mc-k">{label}</p>
      <p className="mc-n">{value}</p>
      {hint ? <p className="mc-hint">{hint}</p> : null}
    </article>
  );
}

function NavIcon({ name }: { name: (typeof MASKCLAW_NAV_ITEMS)[number]["icon"] }) {
  if (name === "home") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M4 11.4 12 4.5l8 6.9V20h-5.5v-5.2h-5V20H4z" />
      </svg>
    );
  }
  if (name === "mask") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 3 4.8 6.2v5.5c0 4.6 3 8.8 7.2 10 4.2-1.2 7.2-5.4 7.2-10V6.2L12 3z"
        />
      </svg>
    );
  }
  if (name === "models") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M9 3h6v2h2.5L19 8.5V11h2v2h-2v2.5L17.5 19H15v2H9v-2H6.5L5 15.5V13H3v-2h2V8.5L6.5 5H9V3zm3 6a3 3 0 1 0 .01 6A3 3 0 0 0 12 9z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 7h3.1a2.7 2.7 0 0 0 5.3 0H20V5H12.4a2.7 2.7 0 0 0-5.3 0H4zm8.5 12H4v-2h8.5a2.7 2.7 0 0 0 5.3 0H20v2h-2.2a2.7 2.7 0 0 0-5.3 0z"
      />
    </svg>
  );
}

function HomePage({
  snap,
  stats,
  routes,
  modelsPayload,
  engineUp,
  probes,
  busy,
  resetting,
  onStart,
  onStop,
  onRestart,
  onProbe,
  onReset,
}: {
  snap: AppSnapshot;
  stats: StatsViewModel | null;
  routes: RouteRow[];
  modelsPayload: unknown;
  engineUp: boolean;
  probes: ProbeResult[];
  busy: boolean;
  resetting: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onProbe: () => void;
  onReset: () => void;
}) {
  const aliases = routeTargetAliases(snap.config_toml);
  const byRoute = trackStatsByRoute(
    routes.map((route) => route.id),
    stats,
    aliases,
  );
  const listenUrl = snap.listen_url.replace(/\/$/, "");
  const listenUrlV1 = `${listenUrl}/v1`;
  const modelId = defaultModelFromPayload(
    modelsPayload,
    routes.map((route) => route.id),
  );
  const hop = lastRequestHop(snap.logs);
  return (
    <div className="mc-page">
      <header>
        <h1 className="mc-h1">HOME</h1>
        <div className="mc-toolbar">
          <span className={`mc-engine${engineUp ? "" : " down"}`}>{engineUp ? "Engine up" : "Engine down"}</span>
          <button type="button" className="mc-btn primary" disabled={busy || engineUp} onClick={onStart}>
            Start
          </button>
          <button type="button" className="mc-btn stop" disabled={busy || !engineUp} onClick={onStop}>
            Stop
          </button>
          <button type="button" className="mc-btn" disabled={busy} onClick={onRestart}>
            Restart
          </button>
          <button type="button" className="mc-btn" disabled={busy} onClick={onProbe}>
            Probe backends
          </button>
          <button type="button" className="mc-btn" disabled={resetting} onClick={onReset}>
            Reset stats
          </button>
        </div>
      </header>

      {snap.last_error ? <p className="err">{snap.last_error}</p> : null}

      <section className="mc-card">
        <h2>Client target</h2>
        <p className="mc-lede">
          Point tools at the sidecar. Send a track id such as lmstudio-local to pin that backend.
          switchyard auto-routes and is not a pin.
        </p>
        <div className="mc-row">
          <div>
            <p className="mc-k">Base URL</p>
            <p className="mc-mono">{listenUrl}</p>
          </div>
          <CopyButton label="base URL" value={listenUrl} caption="Copy" />
        </div>
        <div className="mc-row">
          <div>
            <p className="mc-k">Base URL v1</p>
            <p className="mc-mono">{listenUrlV1}</p>
          </div>
          <CopyButton label="base URL v1" value={listenUrlV1} caption="Copy V1" />
        </div>
        <div className="mc-row">
          <div>
            <p className="mc-k">Model</p>
            <p className="mc-mono">{modelId}</p>
          </div>
          <CopyButton label="model" value={modelId} caption="Copy" />
        </div>
        {hop ? (
          <div>
            <p className="mc-k">Last request</p>
            <p className="mc-mono">
              {hop.requested} → {hop.selected}
            </p>
          </div>
        ) : null}
      </section>

      <div className="mc-metrics">
        <Metric label="Requests" value={formatCount(stats?.totalRequests ?? 0)} />
        <Metric label="Errors" value={formatCount(stats?.totalErrors ?? 0)} />
        <Metric label="Classifier" value={formatCount(stats?.classifierRequests ?? 0)} />
        <Metric label="Fallbacks" value={formatCount(stats?.routingFallbacks.count ?? 0)} />
      </div>
      <div className="mc-metrics">
        <Metric label="Prompt tokens" value={formatCount(stats?.totalTokens.prompt_tokens ?? 0)} />
        <Metric label="Completion" value={formatCount(stats?.totalTokens.completion_tokens ?? 0)} />
        <Metric label="Cached" value={formatCount(stats?.totalTokens.cached_tokens ?? 0)} />
        <Metric
          label="Routing overhead"
          value={formatMs(stats?.routingOverhead.avgMs ?? null)}
          hint={stats ? `${formatCount(stats.routingOverhead.count)} decisions` : undefined}
        />
      </div>

      <section className="mc-card">
        <h2>Tracks</h2>
        <p className="mc-lede">Each row is a route id clients can send as model.</p>
        {routes.length === 0 ? (
          <p className="mc-empty">Start the engine, then this table fills from /v1/models.</p>
        ) : (
          <div className="mc-table-wrap">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Destination</th>
                  <th>Calls</th>
                  <th>Errors</th>
                  <th>Avg latency</th>
                  <th>Context</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => {
                  const model = byRoute[route.id];
                  return (
                    <tr key={route.id}>
                      <td>{route.track}</td>
                      <td>
                        <div>{route.id}</div>
                        {model && model.id !== route.id ? <div className="mc-sub">{model.id}</div> : null}
                      </td>
                      <td>{model ? formatCount(model.calls) : "—"}</td>
                      <td>{model ? formatCount(model.errors) : "—"}</td>
                      <td>{formatMs(model?.avgLatencyMs ?? null)}</td>
                      <td>{route.contextWindow ? formatCount(route.contextWindow) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {probes.length > 0 ? (
        <ul className="mc-probes">
          {probes.map((probe) => (
            <li key={probe.url}>
              {probe.label} — {probe.url} — {probe.detail}
            </li>
          ))}
        </ul>
      ) : null}

      <section className="mc-card">
        <h2>Activity</h2>
        <p className="mc-lede">Routing log and engine console on this box.</p>
        <pre className="mc-tape">{snap.logs.length > 0 ? snap.logs.join("\n") : "No movements yet."}</pre>
      </section>
    </div>
  );
}

function MaskedPage({
  maskclaw,
  routesToml,
  routeIds,
}: {
  maskclaw: MaskclawStatsView | null;
  routesToml: string;
  routeIds: string[];
}) {
  if (!maskclaw) {
    return (
      <div className="mc-page">
        <h1 className="mc-h1">MASKED</h1>
        <p className="mc-empty">The sidecar has not answered /v1/maskclaw/stats yet.</p>
      </div>
    );
  }
  if (!maskclaw.enabled) {
    return (
      <div className="mc-page">
        <h1 className="mc-h1">MASKED</h1>
        <p className="mc-lede">Masking is off.</p>
      </div>
    );
  }
  const liveIds = [...new Set([...routeIds, ...localRouteIdsInToml(routesToml)])];
  const localRoute = forceLocalRouteLabel(maskclaw.forceLocal, maskclaw.localRouteId, liveIds);
  return (
    <div className="mc-page">
      <h1 className="mc-h1">MASKED</h1>
      <div className="mc-metrics">
        <Metric label="Masked" value={formatCount(maskclaw.matches)} />
        <Metric label="Requests" value={formatCount(maskclaw.requests)} />
        <Metric label="With hits" value={formatCount(maskclaw.requestsWithMatches)} />
        <Metric label="Force local" value={formatCount(maskclaw.forceLocalOverrides)} />
      </div>
      <div className="mc-metrics">
        <Metric label="Sessions" value={formatCount(maskclaw.sessionsActive)} />
        <Metric label="In RAM" value={formatCount(maskclaw.uniqueValues)} />
        <Metric label="Restore miss" value={formatCount(maskclaw.restoreMisses)} />
        <Metric label="Critical" value={formatCount(maskclaw.critical)} />
      </div>
      <div className="mc-metrics">
        <Metric label="Residual" value={formatCount(maskclaw.residual)} />
        <Metric label="Dictionary" value={formatCount(maskclaw.dictionaryCount)} />
        <Metric label="Regex rules" value={formatCount(maskclaw.regexCount)} />
        <Metric label="Allowlist" value={formatCount(maskclaw.allowlistCount)} />
      </div>
      <section className="mc-card">
        <h2>By kind</h2>
        <p className="mc-lede">Placeholder types written this process lifetime.</p>
        {maskclaw.byKind.length === 0 ? (
          <p className="mc-empty">Nothing masked yet.</p>
        ) : (
          <ul className="mc-kinds">
            {maskclaw.byKind.map(([kind, count]) => (
              <li key={kind} className="mc-metric">
                <p className="mc-k">{kind}</p>
                <p className="mc-n">{formatCount(count)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="mc-chips">
        <span className="mc-chip">force_local {maskclaw.forceLocal}</span>
        {localRoute ? <span className="mc-chip">local route {localRoute}</span> : null}
        <span className="mc-chip">ttl {maskclaw.sessionTtlSecs}s</span>
      </div>
    </div>
  );
}

export function MaskClawApp({ snap, pane, onPane, onChange, refresh, theme, onTheme }: Props) {
  const [stats, setStats] = useState<StatsViewModel | null>(null);
  const [maskclaw, setMaskclaw] = useState<MaskclawStatsView | null>(null);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [modelsPayload, setModelsPayload] = useState<unknown>(null);
  const [engineUp, setEngineUp] = useState(snap.engine_state === "running");
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const gate = createPollGate();
    const tick = async () => {
      await gate.run(async () => {
        const polled = await runPollTick({
          fetchHealth,
          fetchStats,
          fetchModels,
          fetchMaskclawStats,
        });
        if (cancelled) return;
        setEngineUp(polled.health !== "down" || snap.engine_state === "running");
        if (polled.stats !== null) setStats(adaptStats(polled.stats));
        if (polled.models !== null) {
          setModelsPayload(polled.models);
          setRoutes(parseRoutes(polled.models));
        }
        setMaskclaw(adaptMaskclawStats(polled.maskclawStats));
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [snap.engine_state]);

  async function run(action: () => Promise<AppSnapshot>) {
    setBusy(true);
    try {
      onChange(await action());
      await refresh();
    } catch (err) {
      onChange(snapshotFromInvokeError(snap, err));
    } finally {
      setBusy(false);
    }
  }

  async function probeFromConfig() {
    setBusy(true);
    try {
      const urls = [...snap.config_toml.matchAll(/base_url\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      const unique = [...new Set(urls)];
      const results: ProbeResult[] = [];
      for (const url of unique) {
        try {
          results.push(await withTimeout(probeBackend(url), POLL_TIMEOUT_MS, "probe"));
        } catch (err) {
          results.push({
            url,
            ok: false,
            label: "Not running",
            detail: err instanceof Error ? err.message : String(err),
            models: [],
          });
        }
      }
      setProbes(results);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mc-app">
      <aside className="mc-sidebar">
        <div className="mc-brand">
          <p className="mc-eyebrow">MaskClaw</p>
          <p className="mc-brand-title">MASKCLAW</p>
        </div>
        <div className="mc-nav-wrap">
          <p className="mc-group-label">MaskClaw</p>
          <nav className="mc-nav">
            {MASKCLAW_NAV_ITEMS.map((item) => (
              <button
                key={item.pane}
                type="button"
                className={pane === item.pane ? "active" : ""}
                onClick={() => onPane(item.pane)}
              >
                <NavIcon name={item.icon} />
                {item.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="mc-foot">
          <button
            type="button"
            className="mc-theme"
            onClick={() => {
              const next = nextAppearance(theme);
              persistAppearance(next);
              applyAppearance(next);
              onTheme(next);
            }}
          >
            {themeActionWord(theme)}
          </button>
          <span className="mc-badge">maskclaw.local</span>
        </div>
      </aside>
      <main className="mc-main">
        {pane === "board" && (
          <HomePage
            snap={snap}
            stats={stats}
            routes={routes}
            modelsPayload={modelsPayload}
            engineUp={engineUp}
            probes={probes}
            busy={busy}
            resetting={resetting}
            onStart={() => void run(startEngine)}
            onStop={() => void run(stopEngine)}
            onRestart={() => void run(restartEngine)}
            onProbe={() => void probeFromConfig()}
            onReset={() => {
              void (async () => {
                setResetting(true);
                try {
                  await resetEngineStats();
                  setStats(adaptStats({}));
                } finally {
                  setResetting(false);
                }
              })();
            }}
          />
        )}
        {pane === "mask" && (
          <MaskedPage
            maskclaw={maskclaw}
            routesToml={snap.config_toml}
            routeIds={routes.map((route) => route.id)}
          />
        )}
        {pane === "models" && (
          <MaskClawModels configToml={snap.config_toml} onChange={onChange} />
        )}
        {pane === "settings" && <Settings snap={snap} onChange={onChange} surface="maskclaw" />}
      </main>
    </div>
  );
}
