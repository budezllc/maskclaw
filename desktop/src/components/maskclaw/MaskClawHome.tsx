import { useEffect, useMemo, useRef, useState } from "react";
import type { ProbeResult } from "../../api";
import { CopyButton } from "../CopyButton";
import { formatCount, formatMs, lastRequestHop } from "../../lib/formatStats";
import {
  clientModelLabel,
  defaultModelFromPayload,
  type RouteRow,
} from "../../lib/parseRoutes";
import { trackStatsByRoute, type StatsViewModel } from "../../lib/statsAdapter";

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="mc-metric">
      <p className="mc-k">{label}</p>
      <p className="mc-n">{value}</p>
      {hint ? <p className="mc-hint">{hint}</p> : null}
    </article>
  );
}

export function MaskClawHome({
  listenUrl,
  logs,
  lastError,
  stats,
  routes,
  modelsPayload,
  backendIdsByRoute,
  engineUp,
  probes,
  busy,
  resetting,
  onStart,
  onStop,
  onRestart,
  onProbe,
  onReset,
  onDismissProbes,
}: {
  listenUrl: string;
  logs: string[];
  lastError: string | null;
  stats: StatsViewModel | null;
  routes: RouteRow[];
  modelsPayload: unknown;
  backendIdsByRoute: Record<string, string[]>;
  engineUp: boolean;
  probes: ProbeResult[];
  busy: boolean;
  resetting: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onProbe: () => void;
  onReset: () => void;
  onDismissProbes: () => void;
}) {
  const byRoute = trackStatsByRoute(
    routes.map((route) => route.id),
    stats,
    backendIdsByRoute,
  );
  const base = listenUrl.replace(/\/$/, "");
  const listenUrlV1 = `${base}/v1`;
  const modelId = defaultModelFromPayload(
    modelsPayload,
    routes.map((route) => route.id),
  );
  const hop = lastRequestHop(logs);
  const modelChoices = useMemo(() => {
    const ids = routes.map((route) => route.id);
    if (modelId && !ids.includes(modelId)) {
      return [modelId, ...ids];
    }
    return ids.length > 0 ? ids : modelId ? [modelId] : [];
  }, [modelId, routes]);
  const [clientOpen, setClientOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() =>
    modelChoices.includes(modelId) ? modelId : (modelChoices[0] ?? modelId),
  );
  const modelInputRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (modelChoices.includes(selectedModel)) {
      return;
    }
    setSelectedModel(modelChoices.includes(modelId) ? modelId : (modelChoices[0] ?? modelId));
  }, [modelChoices, modelId, selectedModel]);

  async function copyModelId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      /* clipboard may be blocked */
    }
  }

  return (
    <div className="mc-page">
      <header>
        <h1 className="mc-h1">HOME</h1>
        <div className="mc-toolbar">
          <span
            role="status"
            aria-live="polite"
            className={`mc-engine${engineUp ? " live" : " down"}`}
          >
            {engineUp ? "Engine live" : "Engine down"}
          </span>
          {engineUp ? (
            <button type="button" className="mc-btn stop" disabled={busy} onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="button" className="mc-btn primary" disabled={busy} onClick={onStart}>
              Start
            </button>
          )}
          <button type="button" className="mc-btn" disabled={busy} onClick={onRestart}>
            Restart
          </button>
          <button type="button" className="mc-btn" disabled={busy} onClick={onProbe}>
            Test connections
          </button>
          <button type="button" className="mc-btn" disabled={resetting} onClick={onReset}>
            Reset stats
          </button>
        </div>
      </header>

      {lastError && !engineUp ? <p className="err">{lastError}</p> : null}

      {probes.length > 0 ? (
        <section className="mc-probe-banner" aria-label="Connection results">
          <div className="mc-probe-head">
            <div>
              <p className="mc-probe-title">Connection results</p>
              <p className="mc-lede">Cloud and local endpoints this box talks to.</p>
            </div>
            <button
              type="button"
              className="mc-btn"
              aria-label="Dismiss connection results"
              onClick={onDismissProbes}
            >
              Close
            </button>
          </div>
          <ul className="mc-probes">
            {probes.map((probe) => (
              <li key={probe.url}>
                <span className={probe.ok ? "mc-chip" : "mc-chip bad"}>{probe.label}</span> {probe.url} —{" "}
                {probe.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mc-card">
        <button
          type="button"
          className="mc-client-toggle"
          aria-expanded={clientOpen}
          aria-controls="client-target-panel"
          onClick={() => setClientOpen((open) => !open)}
        >
          <h2>Client target</h2>
          <span aria-hidden="true">{clientOpen ? "▴" : "▾"}</span>
        </button>
        {clientOpen ? (
          <div id="client-target-panel">
            <p className="mc-lede">
              Point any OpenAI-compatible client at this box: set its base URL to one of the addresses
              below.
            </p>
            <div className="mc-row">
              <div>
                <p className="mc-k">Base URL</p>
                <p className="mc-mono">{base}</p>
              </div>
              <CopyButton label="base URL" value={base} caption="Copy" />
            </div>
            <div className="mc-row">
              <div>
                <p className="mc-k">Base URL v1</p>
                <p className="mc-mono">{listenUrlV1}</p>
              </div>
              <CopyButton label="base URL v1" value={listenUrlV1} caption="Copy V1" />
            </div>
            <div className="mc-row">
              <div className="mc-model-field">
                <p id="client-model-label" className="mc-k">
                  Model
                </p>
                <select
                  ref={modelInputRef}
                  aria-labelledby="client-model-label"
                  className="mc-select"
                  value={selectedModel}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSelectedModel(value);
                    void copyModelId(value);
                  }}
                >
                  {modelChoices.map((id) => (
                    <option key={id} value={id}>
                      {clientModelLabel(id)}
                    </option>
                  ))}
                </select>
              </div>
              <CopyButton
                label="model"
                value={modelInputRef.current?.value?.trim() || selectedModel}
                caption="Copy"
              />
            </div>
            {hop ? (
              <div>
                <p className="mc-k">Last request</p>
                <p className="mc-mono">
                  {hop.requested} → {hop.selected}
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <div id="client-target-panel" hidden />
        )}
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

      <section className="mc-card">
        <h2>Activity</h2>
        <p className="mc-lede">Routing log and engine console on this box.</p>
        <pre className="mc-tape">{logs.length > 0 ? logs.join("\n") : "No movements yet."}</pre>
      </section>
    </div>
  );
}
