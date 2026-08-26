import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, ProbeResult } from "../../api";
import { loadSetupSecrets, persistSecrets, probeBackend, saveSetup } from "../../api";
import {
  applySetupSlice,
  cloudKeyOnFile,
  formFromToml,
  secretFlagsFromRecord,
  secretsToPersist,
} from "../../lib/setupHydrate";
import {
  DEFAULT_CLOUD_MODELS,
  DEFAULT_CLOUD_URLS,
  LOCALS,
  PROVIDERS,
  maskclawSetupForm,
  maskclawSmartRouteId,
  type CloudProvider,
  type LocalKind,
  type SetupForm,
} from "../../lib/setupTypes";

export type ModelsTab = "cloud" | "local";

interface Props {
  configToml: string;
  busy?: boolean;
  onChange: (snap: AppSnapshot) => void;
}

function ProviderSelect({
  value,
  disabled,
  onChange,
}: {
  value: CloudProvider;
  disabled: boolean;
  onChange: (provider: CloudProvider) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PROVIDERS.find((provider) => provider.id === value)?.label ?? value;

  return (
    <div className="mc-provider">
      <button
        type="button"
        id="provider"
        aria-label="Provider"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="mc-select"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{current}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul role="listbox" aria-label="Providers" className="mc-options">
          {PROVIDERS.map((provider) => (
            <li key={provider.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={provider.id === value}
                className={provider.id === value ? "active" : ""}
                onClick={() => {
                  onChange(provider.id);
                  setOpen(false);
                }}
              >
                {provider.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MaskClawModels({ configToml, busy = false, onChange }: Props) {
  const [tab, setTab] = useState<ModelsTab>("cloud");
  const [form, setForm] = useState(maskclawSetupForm);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [secretFlags, setSecretFlags] = useState<{ name: string; set: boolean }[]>([]);
  const lastSaved = useRef(maskclawSetupForm());
  const skipHydrate = useRef(false);

  useEffect(() => {
    if (skipHydrate.current) {
      skipHydrate.current = false;
      return;
    }
    let cancelled = false;
    void loadSetupSecrets()
      .catch(() => ({} as Record<string, string>))
      .then((secrets) => {
        if (cancelled) return;
        const next = formFromToml(configToml, maskclawSetupForm());
        lastSaved.current = next;
        setForm(next);
        setSecretFlags(secretFlagsFromRecord(secrets));
      });
    return () => {
      cancelled = true;
    };
  }, [configToml]);

  const cloudUrl = useMemo(() => {
    return form.cloud.baseUrl || DEFAULT_CLOUD_URLS[form.cloud.provider];
  }, [form.cloud]);

  const keyOnFile = cloudKeyOnFile(form, secretFlags);
  const locked = busy || saving;

  function updateForm(updater: (prev: SetupForm) => SetupForm) {
    setForm(updater);
  }

  async function checkLocal(kind: LocalKind) {
    const result = await probeBackend(form.locals[kind].baseUrl, form.locals[kind].apiKey);
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

  async function saveSlice(slice: "cloud" | "locals") {
    setError(null);
    setSaving(true);
    const next = applySetupSlice(lastSaved.current, slice, form);
    next.smartRouteId = maskclawSmartRouteId(next.smartRouteId);
    try {
      skipHydrate.current = true;
      const secrets = secretsToPersist(next);
      if (secrets.length > 0) {
        await persistSecrets(secrets);
      }
      const snap = await saveSetup(next);
      lastSaved.current = next;
      onChange(snap);
    } catch (caught) {
      skipHydrate.current = false;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mc-page">
      <div>
        <p className="mc-eyebrow">Models</p>
        <h1 className="mc-h1">MODELS</h1>
      </div>

      <div className="mc-tabs" role="tablist" aria-label="Model source">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cloud"}
          onClick={() => setTab("cloud")}
        >
          Cloud
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "local"}
          onClick={() => setTab("local")}
        >
          Local
        </button>
      </div>

      {tab === "cloud" ? (
        <section className="mc-card" role="tabpanel">
          <h2>Cloud key</h2>
          <p className="mc-lede">
            MaskClaw is a proxy. Paste a key you already have. Leave this off if you only use apps on this
            box.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.cloud.enabled}
              disabled={locked}
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  cloud: { ...prev.cloud, enabled: event.target.checked },
                }))
              }
            />
            Use cloud
          </label>
          <label className="field">
            <span>Provider</span>
            <ProviderSelect
              value={form.cloud.provider}
              disabled={locked}
              onChange={(provider) => {
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
            />
          </label>
          <label className="field">
            <span>API key</span>
            <input
              id="cloud-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              value={form.cloud.apiKey}
              placeholder={keyOnFile ? "on file — paste to replace" : "paste key"}
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  cloud: { ...prev.cloud, apiKey: event.target.value, enabled: true },
                }))
              }
            />
          </label>
          {form.cloud.provider !== "minimax" ? (
            <label className="field">
              <span>URL</span>
              <input
                id="cloud-url"
                disabled={locked}
                value={form.cloud.baseUrl}
                onChange={(event) =>
                  updateForm((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, baseUrl: event.target.value },
                  }))
                }
              />
            </label>
          ) : null}
          <label className="field">
            <span>Strong model</span>
            <input
              id="strong-model"
              aria-label="Strong model"
              disabled={locked}
              value={form.cloud.modelId}
              placeholder="e.g. MiniMax-M3"
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  cloud: { ...prev.cloud, modelId: event.target.value },
                }))
              }
            />
          </label>
          <label className="field">
            <span>Weak model</span>
            <input
              id="weak-model"
              aria-label="Weak model"
              disabled={locked}
              value={form.cloud.weakModelId}
              placeholder="Optional — same provider, or leave blank for a local app"
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  cloud: { ...prev.cloud, weakModelId: event.target.value },
                }))
              }
            />
          </label>
          <p className="mc-hint">Talks to {cloudUrl}</p>
          {error ? <p className="err">{error}</p> : null}
          <div className="mc-save">
            <button type="button" className="mc-btn primary" disabled={locked} onClick={() => void saveSlice("cloud")}>
              Save cloud
            </button>
          </div>
        </section>
      ) : (
        <section className="mc-card" role="tabpanel">
          <h2>Tick what’s already running</h2>
          <p className="mc-lede">
            These stay off until you tick them. IPs are the defaults those apps already use. A red “Not
            running” does not block Save.
          </p>
          {LOCALS.map((local) => {
            const row = form.locals[local.id];
            const status = probes[local.id];
            return (
              <div key={local.id} className="mc-local">
                <div className="mc-local-head">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      aria-label={local.label}
                      checked={row.enabled}
                      disabled={locked}
                      onChange={(event) =>
                        updateForm((prev) => ({
                          ...prev,
                          locals: {
                            ...prev.locals,
                            [local.id]: { ...prev.locals[local.id], enabled: event.target.checked },
                          },
                        }))
                      }
                    />
                    {local.label}
                  </label>
                  <button
                    type="button"
                    className="mc-btn"
                    disabled={locked}
                    onClick={() => void checkLocal(local.id)}
                  >
                    Check
                  </button>
                </div>
                <div className="mc-local-fields">
                  <label className="field">
                    <span>Address</span>
                    <input
                      id={`${local.id}-address`}
                      disabled={locked}
                      value={row.baseUrl}
                      onChange={(event) =>
                        updateForm((prev) => ({
                          ...prev,
                          locals: {
                            ...prev.locals,
                            [local.id]: { ...prev.locals[local.id], baseUrl: event.target.value },
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Model</span>
                    <input
                      id={`${local.id}-model`}
                      disabled={locked}
                      value={row.modelId}
                      onChange={(event) =>
                        updateForm((prev) => ({
                          ...prev,
                          locals: {
                            ...prev.locals,
                            [local.id]: { ...prev.locals[local.id], modelId: event.target.value },
                          },
                        }))
                      }
                    />
                  </label>
                  {local.id === "unsloth" ? (
                    <label className="field">
                      <span>Optional key</span>
                      <input
                        id="unsloth-key"
                        type="password"
                        autoComplete="off"
                        disabled={locked}
                        value={row.apiKey}
                        placeholder="sk-unsloth-…"
                        onChange={(event) =>
                          updateForm((prev) => ({
                            ...prev,
                            locals: {
                              ...prev.locals,
                              unsloth: { ...prev.locals.unsloth, apiKey: event.target.value },
                            },
                          }))
                        }
                      />
                    </label>
                  ) : null}
                </div>
                {status ? (
                  <p className={status.ok ? "mc-hint" : "err"}>
                    {status.ok ? "Found" : "Not running"} — {status.detail}
                  </p>
                ) : null}
              </div>
            );
          })}
          {error ? <p className="err">{error}</p> : null}
          <div className="mc-save">
            <button type="button" className="mc-btn primary" disabled={locked} onClick={() => void saveSlice("locals")}>
              Save local
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
