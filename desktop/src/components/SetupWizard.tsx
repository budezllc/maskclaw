import { useEffect, useMemo, useState } from "react";
import type { AppSnapshot, ProbeResult } from "../api";
import { loadSetupSecrets, persistSecrets, probeBackend, saveSetup } from "../api";
import { readSetupDraft, writeSetupDraft } from "../lib/setupDraft";
import { formFromToml, mergeSetupState, secretsToPersist } from "../lib/setupHydrate";
import {
  DEFAULT_CLOUD_MODELS,
  DEFAULT_CLOUD_URLS,
  LOCALS,
  PROVIDERS,
  defaultSetupForm,
  type CloudProvider,
  type LocalKind,
  type SetupForm,
} from "../lib/setupTypes";

interface Props {
  configToml: string;
  appName?: string;
  onDone: (snap: AppSnapshot) => void;
}

export function SetupWizard({ configToml, appName = "Switchyard", onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState(defaultSetupForm);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSetupSecrets()
      .catch(() => ({} as Record<string, string>))
      .then((secrets) => {
        if (cancelled) {
          return;
        }
        setForm(mergeSetupState(formFromToml(configToml), readSetupDraft(), secrets));
      });
    return () => {
      cancelled = true;
    };
  }, [configToml]);

  function updateForm(updater: (prev: SetupForm) => SetupForm) {
    setForm((prev) => {
      const next = updater(prev);
      writeSetupDraft(next);
      const secrets = secretsToPersist(next);
      if (secrets.length > 0) {
        void persistSecrets(secrets).catch(() => undefined);
      }
      return next;
    });
  }

  const cloudUrl = useMemo(() => {
    if (form.cloud.provider === "minimax") {
      return form.cloud.useChinaEndpoint
        ? "https://api.minimaxi.com/v1"
        : DEFAULT_CLOUD_URLS.minimax;
    }
    return form.cloud.baseUrl || DEFAULT_CLOUD_URLS[form.cloud.provider];
  }, [form.cloud]);

  async function checkLocal(kind: LocalKind) {
    const url = form.locals[kind].baseUrl;
    const result = await probeBackend(url, form.locals[kind].apiKey);
    setProbes((prev) => ({ ...prev, [kind]: result }));
    if (result.ok && result.models[0] && !form.locals[kind].modelId) {
      updateForm((prev) => ({
        ...prev,
        locals: {
          ...prev.locals,
          [kind]: { ...prev.locals[kind], modelId: result.models[0] },
        },
      }));
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const snap = await saveSetup(form);
      onDone(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wizard">
      <header className="wizard-head">
        <p className="step-kicker">Setup · step {step} of 2</p>
        <h1>{step === 1 ? "Paste a cloud key" : "Tick what’s already running"}</h1>
        {step === 1 ? (
          <p className="lede">
            {appName} is a proxy. Paste a key you already have. Skip this step if you only use
            apps on this PC.
          </p>
        ) : (
          <p className="lede">
            These stay off until you tick them. IPs are the defaults those apps already use. A red
            “Not running” does not block Start.
          </p>
        )}
      </header>

      {step === 1 && (
        <>
          <div className="wizard-body">
            <label className="field">
              <span>Provider</span>
              <select
                value={form.cloud.provider}
                onChange={(e) => {
                  const provider = e.target.value as CloudProvider;
                  updateForm((prev) => ({
                    ...prev,
                    cloud: {
                      ...prev.cloud,
                      provider,
                      modelId: DEFAULT_CLOUD_MODELS[provider],
                      weakModelId: "",
                      baseUrl: DEFAULT_CLOUD_URLS[provider],
                    },
                  }));
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {form.cloud.provider === "minimax" && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.cloud.useChinaEndpoint}
                  onChange={(e) =>
                    updateForm((prev) => ({
                      ...prev,
                      cloud: { ...prev.cloud, useChinaEndpoint: e.target.checked },
                    }))
                  }
                />
                Use China endpoint
              </label>
            )}
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                value={form.cloud.apiKey}
                onChange={(e) =>
                  updateForm((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, apiKey: e.target.value, enabled: true },
                  }))
                }
                placeholder="Paste key — stored in Windows Credential Manager"
              />
            </label>
            {form.cloud.provider !== "minimax" && (
              <label className="field">
                <span>URL</span>
                <input
                  value={form.cloud.baseUrl}
                  onChange={(e) =>
                    updateForm((prev) => ({
                      ...prev,
                      cloud: { ...prev.cloud, baseUrl: e.target.value },
                    }))
                  }
                />
              </label>
            )}
            <label className="field">
              <span>Strong model</span>
              <input
                value={form.cloud.modelId}
                onChange={(e) =>
                  updateForm((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, modelId: e.target.value },
                  }))
                }
                placeholder="e.g. MiniMax-M3"
              />
            </label>
            <label className="field">
              <span>Weak model</span>
              <input
                value={form.cloud.weakModelId}
                onChange={(e) =>
                  updateForm((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, weakModelId: e.target.value },
                  }))
                }
                placeholder="Optional — same provider, or leave blank for a local app"
              />
            </label>
          </div>
          <footer className="wizard-foot">
            <p className="probe">Talks to {cloudUrl}</p>
            <div className="actions">
              <button
                className="btn ghost"
                onClick={() => {
                  updateForm((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, enabled: false, apiKey: "" },
                  }));
                  setStep(2);
                }}
              >
                Skip — local only
              </button>
              <button
                className="btn"
                onClick={() => {
                  updateForm((prev) => ({ ...prev, cloud: { ...prev.cloud, enabled: true } }));
                  setStep(2);
                }}
              >
                Continue
              </button>
            </div>
          </footer>
        </>
      )}

      {step === 2 && (
        <>
          <div className="wizard-body">
            {LOCALS.map((local) => {
              const row = form.locals[local.id];
              const status = probes[local.id];
              return (
                <div className="local-row" key={local.id}>
                  <div className="local-row-head">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) =>
                          updateForm((prev) => ({
                            ...prev,
                            locals: {
                              ...prev.locals,
                              [local.id]: { ...prev.locals[local.id], enabled: e.target.checked },
                            },
                          }))
                        }
                      />
                      <strong>{local.label}</strong>
                    </label>
                    <button className="btn ghost" type="button" onClick={() => void checkLocal(local.id)}>
                      Check
                    </button>
                  </div>
                  <div className="local-row-fields">
                    <div className="field">
                      <label>Address</label>
                      <input
                        value={row.baseUrl}
                        onChange={(e) =>
                          updateForm((prev) => ({
                            ...prev,
                            locals: {
                              ...prev.locals,
                              [local.id]: { ...prev.locals[local.id], baseUrl: e.target.value },
                            },
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Model</label>
                      <input
                        value={row.modelId}
                        onChange={(e) =>
                          updateForm((prev) => ({
                            ...prev,
                            locals: {
                              ...prev.locals,
                              [local.id]: { ...prev.locals[local.id], modelId: e.target.value },
                            },
                          }))
                        }
                      />
                    </div>
                    {local.id === "unsloth" && (
                      <div className="field">
                        <label>Optional key</label>
                        <input
                          type="password"
                          value={row.apiKey}
                          onChange={(e) =>
                            updateForm((prev) => ({
                              ...prev,
                              locals: {
                                ...prev.locals,
                                [local.id]: { ...prev.locals[local.id], apiKey: e.target.value },
                              },
                            }))
                          }
                          placeholder="sk-unsloth-…"
                        />
                      </div>
                    )}
                  </div>
                  {status && (
                    <p className={`probe ${status.ok ? "ok" : "bad"}`}>
                      {status.ok ? "Found" : "Not running"} — {status.detail}
                    </p>
                  )}
                </div>
              );
            })}
            {error && <p className="err">{error}</p>}
          </div>
          <footer className="wizard-foot">
            <div className="actions">
              <button className="btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="btn" disabled={busy} onClick={() => void start()}>
                Start
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
