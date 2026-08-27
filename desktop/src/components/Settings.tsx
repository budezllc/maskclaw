import { useRef, useState } from "react";
import type { AppSnapshot } from "../api";
import { saveRawMaskclawToml, saveRawToml, setAutostart, setTelemetryOptIn } from "../api";
import { appDisplayName, isMaskclawFlavor } from "../lib/engineFlavor";
import { DETECTOR_KEYS, DETECTOR_LABELS, parseDetectors, setDetectorLine, type DetectorKey } from "../lib/tomlEdit";

interface Props {
  snap: AppSnapshot;
  onChange: (snap: AppSnapshot) => void;
  surface?: "yard" | "maskclaw";
}

function DetectorSwitch({
  id,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      className="mc-switch"
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="mc-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function Settings({ snap, onChange, surface = "yard" }: Props) {
  const [toml, setToml] = useState(snap.config_toml);
  const [maskclawToml, setMaskclawToml] = useState(snap.maskclaw_toml);
  const [error, setError] = useState<string | null>(null);
  const [maskclawError, setMaskclawError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState(snap.telemetry_opt_in);
  const [autostart, setAutostartOn] = useState(snap.autostart);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const showMaskclaw = isMaskclawFlavor(snap.engine_flavor);
  const appName = appDisplayName(snap.engine_flavor);
  const maskclawLayout = surface === "maskclaw";
  const detectors = parseDetectors(maskclawToml);

  async function onDetector(key: DetectorKey, enabled: boolean) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    const next = setDetectorLine(maskclawToml, key, enabled);
    setMaskclawToml(next);
    setMaskclawError(null);
    setBusy(true);
    try {
      const nextSnap = await saveRawMaskclawToml(next);
      setMaskclawToml(nextSnap.maskclaw_toml);
      onChange(nextSnap);
    } catch (err) {
      setMaskclawError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

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
        {maskclawLayout ? null : (
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
            Allow MaskClaw telemetry (off sends SWITCHYARD_TELEMETRY_OPT_OUT=1)
          </label>
        )}
      </header>
      {maskclawLayout ? (
        <section className="mc-card">
          <h2>Built-in detectors</h2>
          <p className="mc-lede">Updates maskclaw.toml and restarts the engine.</p>
          <div className="mc-detectors">
            {DETECTOR_KEYS.map((key) => (
              <div key={key} className="mc-detector-row">
                <span>{DETECTOR_LABELS[key]}</span>
                <DetectorSwitch
                  id={`detector-${key}`}
                  checked={detectors[key]}
                  disabled={busy}
                  onCheckedChange={(checked) => void onDetector(key, checked)}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}
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
              disabled={busy}
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
              disabled={busy}
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
