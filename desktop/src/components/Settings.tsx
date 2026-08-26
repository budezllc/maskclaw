import { useState } from "react";
import type { AppSnapshot } from "../api";
import { saveRawMaskclawToml, saveRawToml, setAutostart, setTelemetryOptIn } from "../api";
import { appDisplayName, isMaskclawFlavor } from "../lib/engineFlavor";

interface Props {
  snap: AppSnapshot;
  onChange: (snap: AppSnapshot) => void;
  surface?: "yard" | "maskclaw";
}

export function Settings({ snap, onChange, surface = "yard" }: Props) {
  const [toml, setToml] = useState(snap.config_toml);
  const [maskclawToml, setMaskclawToml] = useState(snap.maskclaw_toml);
  const [error, setError] = useState<string | null>(null);
  const [maskclawError, setMaskclawError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState(snap.telemetry_opt_in);
  const [autostart, setAutostartOn] = useState(snap.autostart);
  const showMaskclaw = isMaskclawFlavor(snap.engine_flavor);
  const appName = appDisplayName(snap.engine_flavor);

  const maskclawLayout = surface === "maskclaw";

  return (
    <section className={maskclawLayout ? "mc-page settings-pane" : "settings-pane"}>
      <header className="settings-block">
        {maskclawLayout ? <h1 className="mc-h1">SETTINGS</h1> : <p className="step-kicker">Settings</p>}
        {maskclawLayout ? null : <h1>Raw config</h1>}
          <p className={maskclawLayout ? "mc-lede" : "lede"}>
            Keys stay in Windows Credential Manager. This file only names the environment variable.
            Save dry-runs the file, then restarts the engine.
          </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={autostart}
            onChange={async (e) => {
              const enabled = e.target.checked;
              await setAutostart(enabled);
              setAutostartOn(enabled);
            }}
          />
          Open {appName} when Windows starts
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={telemetry}
            onChange={async (e) => {
              const optIn = e.target.checked;
              await setTelemetryOptIn(optIn);
              setTelemetry(optIn);
            }}
          />
          Allow Switchyard telemetry (off sends SWITCHYARD_TELEMETRY_OPT_OUT=1)
        </label>
      </header>
      {maskclawLayout ? (
        <section className="mc-card">
          <h2>routes.toml</h2>
          <p className="mc-lede">Clients, targets, and routes served on port 4000.</p>
          <textarea
            className="settings-raw"
            rows={18}
            spellCheck={false}
            value={toml}
            onChange={(e) => setToml(e.target.value)}
          />
          {error && <p className="err">{error}</p>}
          <div className="mc-save">
            <button
              type="button"
              className="mc-btn primary"
              onClick={async () => {
                setError(null);
                try {
                  onChange(await saveRawToml(toml));
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Save routes
            </button>
          </div>
        </section>
      ) : (
        <>
          {showMaskclaw && <p className="toml-label">routes.toml</p>}
          <textarea className="settings-raw" value={toml} onChange={(e) => setToml(e.target.value)} />
          {error && <p className="err">{error}</p>}
          <div className="actions">
            <button
              className="btn"
              onClick={async () => {
                setError(null);
                try {
                  onChange(await saveRawToml(toml));
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Save changes
            </button>
          </div>
        </>
      )}
      {showMaskclaw && maskclawLayout && (
        <section className="mc-card">
          <h2>maskclaw.toml</h2>
          <p className="mc-lede">Detectors, dictionaries, regex, and force_local policy.</p>
          <textarea
            className="settings-raw"
            rows={18}
            spellCheck={false}
            value={maskclawToml}
            onChange={(e) => setMaskclawToml(e.target.value)}
          />
          {maskclawError && <p className="err">{maskclawError}</p>}
          <div className="mc-save">
            <button
              type="button"
              className="mc-btn primary"
              onClick={async () => {
                setMaskclawError(null);
                try {
                  onChange(await saveRawMaskclawToml(maskclawToml));
                } catch (err) {
                  setMaskclawError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Save MaskClaw
            </button>
          </div>
        </section>
      )}
      {showMaskclaw && !maskclawLayout && (
        <>
          <p className="toml-label">maskclaw.toml</p>
          <textarea
            className="settings-raw"
            value={maskclawToml}
            onChange={(e) => setMaskclawToml(e.target.value)}
          />
          {maskclawError && <p className="err">{maskclawError}</p>}
          <div className="actions">
            <button
              className="btn"
              onClick={async () => {
                setMaskclawError(null);
                try {
                  onChange(await saveRawMaskclawToml(maskclawToml));
                } catch (err) {
                  setMaskclawError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Save MaskClaw
            </button>
          </div>
        </>
      )}
    </section>
  );
}
