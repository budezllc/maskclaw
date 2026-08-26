import { useEffect, useRef, useState } from "react";
import type { AppSnapshot, ProbeResult } from "../api";
import {
  fetchHealth,
  fetchModels,
  fetchStats,
  probeBackend,
  restartEngine,
  startEngine,
  stopEngine,
} from "../api";
import { CopyButton } from "./CopyButton";
import { engineBusyLabel, engineToggle, snapshotFromInvokeError } from "../lib/engineControls";
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  createPollGate,
  runPollTick,
  withTimeout,
} from "../lib/enginePoll";
import { defaultClientModel } from "../lib/railNav";
import { adaptStats, findTrackStats, routeTargetAliases, type StatsViewModel } from "../lib/statsAdapter";
import { useTapeStick } from "../lib/useTapeStick";

interface Props {
  snap: AppSnapshot;
  onChange: (snap: AppSnapshot) => void;
  refresh: () => Promise<AppSnapshot>;
}

interface RouteRow {
  id: string;
  track: string;
}

function lampClass(state: AppSnapshot["engine_state"]): string {
  if (state === "running") return "clear";
  if (state === "failed") return "stop";
  return "hold";
}

function parseRoutes(models: unknown): RouteRow[] {
  const root = models && typeof models === "object" ? (models as Record<string, unknown>) : {};
  const data = Array.isArray(root.data) ? root.data : [];
  return data.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const id = typeof row.id === "string" ? row.id : `route-${index}`;
    return { id, track: String(index + 1).padStart(2, "0") };
  });
}

export function Dashboard({ snap, onChange, refresh }: Props) {
  const [stats, setStats] = useState<StatsViewModel | null>(null);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [busy, setBusy] = useState(false);
  const tapeRef = useRef<HTMLPreElement>(null);
  const tapeText =
    [...snap.routing_tail.map((r) => JSON.stringify(r)), ...snap.logs].join("\n") || "No movements yet.";
  useTapeStick(tapeRef, tapeText);

  useEffect(() => {
    let cancelled = false;
    const gate = createPollGate();
    const tick = async () => {
      await gate.run(async () => {
        const polled = await runPollTick({
          fetchHealth,
          fetchStats,
          fetchModels,
        });
        if (cancelled) return;
        if (polled.stats !== null) setStats(adaptStats(polled.stats));
        if (polled.models !== null) setRoutes(parseRoutes(polled.models));
        try {
          const next = await withTimeout(refresh(), POLL_TIMEOUT_MS, "snapshot");
          if (!cancelled) onChange(next);
        } catch {
          /* keep last snapshot */
        }
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [onChange, refresh]);

  const modelId = defaultClientModel(routes.map((route) => route.id));

  async function run(action: () => Promise<AppSnapshot>) {
    setBusy(true);
    try {
      onChange(await action());
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

  const toggle = engineToggle(snap.engine_state);

  return (
    <section>
      <header className="destination-head">
        <div className="actions header-actions">
          <button
            className={`btn ${toggle.action === "stop" ? "stop" : ""}`}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void run(toggle.action === "stop" ? stopEngine : startEngine)}
          >
            {engineBusyLabel(toggle, busy)}
          </button>
          <button className="btn ghost" disabled={busy} aria-busy={busy} onClick={() => void run(restartEngine)}>
            Restart
          </button>
          <button
            className="btn ghost"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void probeFromConfig()}
          >
            Probe backends
          </button>
        </div>
        <div className="flap">
          <div className="flap-row">
            <span className={`lamp ${lampClass(snap.engine_state)}`} />
            <span className="value">{snap.listen_url}</span>
            <CopyButton label="base URL" value={snap.listen_url} />
          </div>
          <div className="flap-row">
            <span className="lamp spacer" />
            <span className="value">{modelId}</span>
            <CopyButton label="model" value={modelId} />
          </div>
        </div>
      </header>
      {snap.last_error && <p className="err">{snap.last_error}</p>}

      <div className="tracks-wrap">
      <table className="tracks">
        <thead>
          <tr>
            <th>Track</th>
            <th>Destination</th>
            <th>Calls</th>
            <th>Errors</th>
            <th>Backend</th>
          </tr>
        </thead>
        <tbody>
          {routes.length === 0 ? (
            <tr>
              <td colSpan={5}>No routes yet. Finish Setup or start the engine.</td>
            </tr>
          ) : (
            routes.map((route) => {
              const aliases = routeTargetAliases(snap.config_toml)[route.id] ?? [];
              const model = findTrackStats(route.id, stats, aliases);
              const probe = probes.find((p) => p.detail.includes(route.id) || p.ok);
              return (
                <tr key={route.id}>
                  <td className="track-no">{route.track}</td>
                  <td>
                    {route.id}
                    {model && model.id !== route.id ? (
                      <div className="track-used">{model.id}</div>
                    ) : null}
                  </td>
                  <td>{model?.calls ?? "—"}</td>
                  <td>{model?.errors ?? "—"}</td>
                  <td>{probe ? probe.label : "not probed"}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      </div>

      <div className="tonnage">
        <article>
          <div className="k">Requests</div>
          <div className="n">{stats?.totalRequests ?? 0}</div>
        </article>
        <article>
          <div className="k">Errors</div>
          <div className="n">{stats?.totalErrors ?? 0}</div>
        </article>
        <article>
          <div className="k">Classifier</div>
          <div className="n">{stats?.classifierRequests ?? 0}</div>
        </article>
        <article>
          <div className="k">Fallbacks</div>
          <div className="n">{stats?.routingFallbacks.count ?? 0}</div>
        </article>
      </div>

      {probes.length > 0 && (
        <ul className="probe-list">
          {probes.map((probe) => (
            <li key={probe.url} className={`probe ${probe.ok ? "ok" : "bad"}`}>
              {probe.label} — {probe.url} — {probe.detail}
            </li>
          ))}
        </ul>
      )}

      <div className="activity">
        <p className="step-kicker">Activity</p>
        <pre className="tape" ref={tapeRef}>
          {tapeText}
        </pre>
      </div>
    </section>
  );
}
