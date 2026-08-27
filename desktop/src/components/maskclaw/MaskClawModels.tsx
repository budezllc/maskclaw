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
  CLOUD_ORDER,
  DEFAULT_CLOUD_URLS,
  LOCALS,
  PROVIDERS,
  emptyCloudForm,
  maskclawSetupForm,
  maskclawSmartRouteId,
  providerLabel,
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

/** Native <select>: WebView2 paints custom button lists as links and eats clicks. */
function NativeSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const known = options.some((option) => option.id === value);
  return (
    <select
      id={id}
      aria-label={label}
      className="mc-select"
      disabled={disabled}
      value={known ? value : ""}
      onChange={(event) => {
        const next = event.target.value;
        if (next) {
          onChange(next);
        }
      }}
    >
      {placeholder && !known ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
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
  return (
    <NativeSelect
      id="provider"
      label="Provider"
      value={value}
      disabled={disabled}
      options={PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label }))}
      onChange={(id) => onChange(id as CloudProvider)}
    />
  );
}

export function MaskClawModels({ configToml, busy = false, onChange }: Props) {
  const [tab, setTab] = useState<ModelsTab>("cloud");
  const [form, setForm] = useState(maskclawSetupForm);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [modelCheck, setModelCheck] = useState<string | null>(null);
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

  function patchCloud(patch: Partial<SetupForm["cloud"]>) {
    updateForm((prev) => {
      const cloud = { ...prev.cloud, ...patch };
      return {
        ...prev,
        cloud,
        clouds: { ...prev.clouds, [cloud.provider]: cloud },
      };
    });
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

  async function listCloudModels() {
    setError(null);
    setCatalogNote(null);
    const result = await probeBackend(cloudUrl, form.cloud.apiKey.trim() || undefined);
    setCatalog(result.models);
    if (!result.ok) {
      setCatalogNote(result.label);
      return;
    }
    if (result.models.length === 0) {
      setCatalogNote("Provider returned no models. Paste an id and Test it.");
      return;
    }
    setCatalogNote(`Loaded ${result.models.length} models`);
  }

  async function testCloudModel() {
    setError(null);
    const model = form.cloud.modelId.trim();
    if (!model) {
      setModelCheck("Enter a model id first.");
      return;
    }
    const result = await probeBackend(cloudUrl, form.cloud.apiKey.trim() || undefined, model);
    setModelCheck(result.ok ? `${model} works` : `${model}: ${result.label}`);
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

  const savedClouds = CLOUD_ORDER.filter(
    (id) => form.clouds[id].enabled || (form.cloud.enabled && form.cloud.provider === id),
  );

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
            Save each provider separately. Switching the list does not drop a key you already saved.
            Every saved cloud shows up in the HOME model list so you can pick it or use it as a
            fallback.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.cloud.enabled}
              disabled={locked}
              onChange={(event) => patchCloud({ enabled: event.target.checked })}
            />
            Use cloud
          </label>
          <label className="field">
            <span>Provider</span>
            <ProviderSelect
              value={form.cloud.provider}
              disabled={locked}
              onChange={(provider) => {
                updateForm((prev) => {
                  const clouds = {
                    ...prev.clouds,
                    [prev.cloud.provider]: { ...prev.cloud },
                  };
                  const next = clouds[provider] ?? {
                    ...emptyCloudForm(provider),
                    enabled: true,
                  };
                  return { ...prev, clouds, cloud: { ...next, provider } };
                });
                setCatalog([]);
                setCatalogNote(null);
                setModelCheck(null);
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
              onChange={(event) => patchCloud({ apiKey: event.target.value, enabled: true })}
            />
          </label>
          {form.cloud.provider !== "minimax" ? (
            <label className="field">
              <span>URL</span>
              <input
                id="cloud-url"
                disabled={locked}
                value={form.cloud.baseUrl}
                onChange={(event) => patchCloud({ baseUrl: event.target.value })}
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
              onChange={(event) => patchCloud({ modelId: event.target.value })}
            />
            <div className="mc-inline-actions">
              <button type="button" className="mc-btn" disabled={locked} onClick={() => void listCloudModels()}>
                List models
              </button>
              <button type="button" className="mc-btn" disabled={locked} onClick={() => void testCloudModel()}>
                Test
              </button>
            </div>
            {catalogNote ? <p className="mc-hint">{catalogNote}</p> : null}
            {catalog.length > 0 ? (
              <NativeSelect
                id="provider-models"
                label="Provider models"
                value={catalog.includes(form.cloud.modelId) ? form.cloud.modelId : ""}
                options={catalog.map((id) => ({ id, label: id }))}
                disabled={locked}
                placeholder="Choose from provider"
                onChange={(id) => patchCloud({ modelId: id })}
              />
            ) : null}
            {modelCheck ? <p className="mc-hint">{modelCheck}</p> : null}
          </label>
          <label className="field">
            <span>Weak model</span>
            <input
              id="weak-model"
              aria-label="Weak model"
              disabled={locked}
              value={form.cloud.weakModelId}
              placeholder="Optional — same provider, or leave blank for a local app"
              onChange={(event) => patchCloud({ weakModelId: event.target.value })}
            />
          </label>
          <p className="mc-hint">Talks to {cloudUrl}</p>
          {savedClouds.length > 1 ? (
            <>
              <p className="mc-hint">Saved clouds: {savedClouds.map((id) => providerLabel(id)).join(", ")}</p>
              <label className="field">
                <span>Smart routing / fallback uses</span>
                <NativeSelect
                  id="strong-provider"
                  label="Smart routing / fallback uses"
                  value={savedClouds.includes(form.strongProvider) ? form.strongProvider : savedClouds[0]}
                  options={savedClouds.map((id) => ({ id, label: providerLabel(id) }))}
                  disabled={locked}
                  onChange={(id) =>
                    updateForm((prev) => ({
                      ...prev,
                      strongProvider: id as CloudProvider,
                    }))
                  }
                />
              </label>
            </>
          ) : null}
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
