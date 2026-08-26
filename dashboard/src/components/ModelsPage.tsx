import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { ProbeOptions, ProbeResult } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { applySetupSlice, cloudKeyOnFile, formFromToml } from "@/setupHydrate";
import {
  CLOUD_ORDER,
  DEFAULT_CLOUD_MODELS,
  DEFAULT_CLOUD_URLS,
  LOCALS,
  PROVIDERS,
  defaultSetupForm,
  providerLabel,
  type CloudProvider,
  type LocalKind,
  type SetupForm,
} from "@/setupTypes";
import { cn } from "@/lib/utils";

function ThemeSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.id === value)?.label ?? value;

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        id={id}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="h-9 w-full justify-between px-2.5 font-normal text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="truncate">{current || "Choose from provider"}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </Button>
      {open ? (
        <ul
          role="listbox"
          aria-label={label}
          className="max-h-48 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground"
        >
          {options.map((option) => (
            <li key={option.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                className={cn(
                  "w-full px-2.5 py-2 text-left text-sm text-popover-foreground",
                  option.id === value ? "bg-muted" : "hover:bg-muted",
                )}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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
  const [open, setOpen] = useState(false);
  const current = PROVIDERS.find((provider) => provider.id === value)?.label ?? value;

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        id="provider"
        aria-label="Provider"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="h-9 w-full justify-between px-2.5 font-normal text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{current}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </Button>
      {open ? (
        <ul
          role="listbox"
          aria-label="Providers"
          className="flex flex-col rounded-md border border-border bg-popover text-popover-foreground"
        >
          {PROVIDERS.map((provider) => (
            <li key={provider.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={provider.id === value}
                className={cn(
                  "w-full px-2.5 py-2 text-left text-sm text-popover-foreground",
                  provider.id === value ? "bg-muted" : "hover:bg-muted",
                )}
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

export function ModelsPage({
  routesToml,
  secretFlags,
  busy,
  onApply,
  onProbe,
}: {
  routesToml: string;
  secretFlags: { name: string; set: boolean }[];
  busy: boolean;
  onApply: (form: SetupForm) => Promise<void>;
  onProbe: (url: string, options?: ProbeOptions) => Promise<ProbeResult>;
}) {
  const [form, setForm] = useState(defaultSetupForm);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [modelCheck, setModelCheck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSaved = useRef(defaultSetupForm());
  const skipHydrate = useRef(false);

  useEffect(() => {
    if (skipHydrate.current) {
      skipHydrate.current = false;
      return;
    }
    const next = formFromToml(routesToml);
    lastSaved.current = next;
    setForm(next);
  }, [routesToml]);

  const cloudUrl = useMemo(() => {
    return form.cloud.baseUrl || DEFAULT_CLOUD_URLS[form.cloud.provider];
  }, [form.cloud]);

  const keyOnFile = cloudKeyOnFile(form, secretFlags);

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
    const result = await onProbe(form.locals[kind].baseUrl);
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
    const result = await onProbe(cloudUrl, { apiKey: form.cloud.apiKey.trim() || undefined });
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
    const result = await onProbe(cloudUrl, {
      apiKey: form.cloud.apiKey.trim() || undefined,
      model,
    });
    setModelCheck(result.ok ? `${model} works` : `${model}: ${result.label}`);
  }

  async function saveSlice(slice: "cloud" | "locals") {
    setError(null);
    const next = applySetupSlice(lastSaved.current, slice, form);
    try {
      skipHydrate.current = true;
      await onApply(next);
      lastSaved.current = next;
    } catch (caught) {
      skipHydrate.current = false;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6">
      <div>
        <p className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">Models</p>
        <h1 className="font-heading text-3xl">MODELS</h1>
      </div>

      <Tabs defaultValue="cloud">
        <TabsList>
          <TabsTrigger value="cloud">Cloud</TabsTrigger>
          <TabsTrigger value="local">Local</TabsTrigger>
        </TabsList>
        <TabsContent value="cloud">
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle>Cloud key</CardTitle>
              <CardDescription>
                Save each provider separately. Switching the list does not drop a key you already saved. Every
                saved cloud shows up in the HOME model list so you can pick it or use it as a fallback.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FieldGroup>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.cloud.enabled}
                    disabled={busy}
                    onChange={(event) => patchCloud({ enabled: event.target.checked })}
                  />
                  Use cloud
                </label>
                <Field>
                  <FieldLabel htmlFor="provider">Provider</FieldLabel>
                  <ProviderSelect
                    value={form.cloud.provider}
                    disabled={busy}
                    onChange={(provider) => {
                      updateForm((prev) => {
                        const clouds = {
                          ...prev.clouds,
                          [prev.cloud.provider]: { ...prev.cloud },
                        };
                        const next = clouds[provider] ?? {
                          enabled: true,
                          provider,
                          apiKey: "",
                          modelId: DEFAULT_CLOUD_MODELS[provider],
                          weakModelId: "",
                          baseUrl: DEFAULT_CLOUD_URLS[provider],
                        };
                        return { ...prev, clouds, cloud: { ...next, provider } };
                      });
                      setCatalog([]);
                      setCatalogNote(null);
                      setModelCheck(null);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="cloud-key">API key</FieldLabel>
                  <Input
                    id="cloud-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    value={form.cloud.apiKey}
                    placeholder={keyOnFile ? "on file — paste to replace" : "paste key"}
                    onChange={(event) => patchCloud({ apiKey: event.target.value, enabled: true })}
                  />
                </Field>
                {form.cloud.provider !== "minimax" ? (
                  <Field>
                    <FieldLabel htmlFor="cloud-url">URL</FieldLabel>
                    <Input
                      id="cloud-url"
                      disabled={busy}
                      value={form.cloud.baseUrl}
                      onChange={(event) => patchCloud({ baseUrl: event.target.value })}
                    />
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="strong-model">Strong model</FieldLabel>
                  <Input
                    id="strong-model"
                    disabled={busy}
                    value={form.cloud.modelId}
                    placeholder="e.g. MiniMax-M3"
                    onChange={(event) => patchCloud({ modelId: event.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void listCloudModels()}>
                      List models
                    </Button>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void testCloudModel()}>
                      Test
                    </Button>
                  </div>
                  {catalogNote ? <p className="text-muted-foreground text-xs">{catalogNote}</p> : null}
                  {catalog.length > 0 ? (
                    <ThemeSelect
                      id="provider-models"
                      label="Provider models"
                      value={catalog.includes(form.cloud.modelId) ? form.cloud.modelId : ""}
                      options={catalog.map((id) => ({ id, label: id }))}
                      disabled={busy}
                      onChange={(id) => patchCloud({ modelId: id })}
                    />
                  ) : null}
                  {modelCheck ? <p className="text-sm">{modelCheck}</p> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="weak-model">Weak model</FieldLabel>
                  <Input
                    id="weak-model"
                    disabled={busy}
                    value={form.cloud.weakModelId}
                    placeholder="Optional — same provider, or leave blank for a local app"
                    onChange={(event) => patchCloud({ weakModelId: event.target.value })}
                  />
                </Field>
              </FieldGroup>
              <p className="font-mono text-muted-foreground text-xs">Talks to {cloudUrl}</p>
              {(() => {
                const saved = CLOUD_ORDER.filter(
                  (id) => form.clouds[id].enabled || (form.cloud.enabled && form.cloud.provider === id),
                );
                return (
                  <>
                    {saved.length > 1 ? (
                      <p className="text-muted-foreground text-sm">
                        Saved clouds: {saved.map((id) => providerLabel(id)).join(", ")}
                      </p>
                    ) : null}
                    {saved.length > 1 ? (
                      <Field>
                        <FieldLabel htmlFor="strong-provider">Smart routing / fallback uses</FieldLabel>
                        <ThemeSelect
                          id="strong-provider"
                          label="Smart routing / fallback uses"
                          value={saved.includes(form.strongProvider) ? form.strongProvider : saved[0]}
                          options={saved.map((id) => ({ id, label: providerLabel(id) }))}
                          disabled={busy}
                          onChange={(id) =>
                            updateForm((prev) => ({
                              ...prev,
                              strongProvider: id as CloudProvider,
                            }))
                          }
                        />
                      </Field>
                    ) : null}
                  </>
                );
              })()}
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => void saveSlice("cloud")}>
                  Save cloud
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="local">
          <Card>
            <CardHeader>
              <CardTitle>Tick what’s already running</CardTitle>
              <CardDescription>
                These stay off until you tick them. IPs are the defaults those apps already use. A red “Not
                running” does not block Save.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {LOCALS.map((local) => {
                const row = form.locals[local.id];
                const status = probes[local.id];
                return (
                  <div key={local.id} className="flex flex-col gap-3 border-b border-border pb-6 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          disabled={busy}
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
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void checkLocal(local.id)}>
                        Check
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor={`${local.id}-address`}>Address</FieldLabel>
                        <Input
                          id={`${local.id}-address`}
                          disabled={busy}
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
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`${local.id}-model`}>Model</FieldLabel>
                        <Input
                          id={`${local.id}-model`}
                          disabled={busy}
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
                      </Field>
                      {local.id === "unsloth" ? (
                        <Field className="sm:col-span-2">
                          <FieldLabel htmlFor="unsloth-key">Optional key</FieldLabel>
                          <Input
                            id="unsloth-key"
                            type="password"
                            autoComplete="off"
                            disabled={busy}
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
                        </Field>
                      ) : null}
                    </div>
                    {status ? (
                      <p className={status.ok ? "text-sm" : "text-destructive text-sm"}>
                        {status.ok ? "Found" : "Not running"} — {status.detail}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => void saveSlice("locals")}>
                  Save local
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
