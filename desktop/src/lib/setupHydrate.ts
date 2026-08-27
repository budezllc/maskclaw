import { cloudApiKeyEnv, localApiKeyEnv, type SecretBinding } from "./secretMapping";
import {
  CLOUD_ORDER,
  DEFAULT_CLOUD_URLS,
  LOCAL_ORDER,
  MINIMAX_CHINA_URL,
  defaultClouds,
  defaultSetupForm,
  type CloudProvider,
  type LocalKind,
  type SetupForm,
} from "./setupTypes";

const CLOUD_PROVIDERS = new Set<CloudProvider>([
  "minimax",
  "openrouter",
  "openai",
  "anthropic",
  "custom",
]);

const DUMMY_SECRET_VALUES = new Set(["local", "lm-studio", "ollama", "sk-unsloth-local"]);

interface TomlTable {
  header: string;
  fields: Record<string, string>;
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

export function parseTomlTables(toml: string): TomlTable[] {
  const tables: TomlTable[] = [];
  let current: TomlTable | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = { header: header[1], fields: {} };
      tables.push(current);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (kv && current) {
      current.fields[kv[1]] = unquoteToml(kv[2]);
    }
  }
  return tables;
}

function localKindFromClient(name: string): LocalKind | null {
  if (name === "unsloth") {
    return "unsloth";
  }
  if (name === "lmstudio") {
    return "lmstudio";
  }
  if (name === "gemma" || name === "ollama") {
    return "gemma";
  }
  return null;
}

function isRealSecret(value: string | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !DUMMY_SECRET_VALUES.has(trimmed);
}

/** Rebuild the setup form from a deployed routes.toml (keys never live in TOML). */
export function formFromToml(toml: string, base: SetupForm = defaultSetupForm()): SetupForm {
  const form: SetupForm = {
    telemetryOptIn: base.telemetryOptIn,
    smartRouteId: base.smartRouteId,
    cloud: { ...base.cloud, enabled: false },
    clouds: defaultClouds(),
    strongProvider: "minimax",
    locals: {
      unsloth: { ...base.locals.unsloth },
      lmstudio: { ...base.locals.lmstudio },
      gemma: { ...base.locals.gemma },
    },
  };
  for (const provider of CLOUD_ORDER) {
    form.clouds[provider].enabled = false;
  }
  if (!toml.trim()) {
    return form;
  }

  const tables = parseTomlTables(toml);
  const clients = tables.filter((table) => table.header.startsWith("llm_clients."));
  const targets = tables.filter((table) => table.header.startsWith("targets."));

  for (const client of clients) {
    const name = client.header.slice("llm_clients.".length);
    const baseUrl = client.fields.base_url ?? "";
    if (CLOUD_PROVIDERS.has(name as CloudProvider)) {
      const provider = name as CloudProvider;
      const entry = form.clouds[provider];
      entry.enabled = true;
      entry.provider = provider;
      entry.baseUrl = baseUrl || DEFAULT_CLOUD_URLS[provider];
      entry.useChinaEndpoint = provider === "minimax" && baseUrl.includes("minimaxi.com");
    }
    const local = localKindFromClient(name);
    if (local) {
      form.locals[local].enabled = true;
      if (baseUrl) {
        form.locals[local].baseUrl = baseUrl;
      }
    }
  }

  for (const target of targets) {
    const role = target.header.slice("targets.".length);
    const id = target.fields.id ?? "";
    const llmClient = target.fields.llm_client ?? "";
    if (!id) {
      continue;
    }
    if (CLOUD_PROVIDERS.has(llmClient as CloudProvider)) {
      const provider = llmClient as CloudProvider;
      if (role === "weak") {
        form.clouds[provider].weakModelId = id;
      } else {
        form.clouds[provider].modelId = id;
      }
      if (role === "strong") {
        form.strongProvider = provider;
      }
      continue;
    }
    const local = localKindFromClient(llmClient);
    if (local) {
      form.locals[local].modelId = id;
    }
  }

  const enabled = CLOUD_ORDER.filter((provider) => form.clouds[provider].enabled);
  const editor = form.clouds[form.strongProvider]?.enabled
    ? form.strongProvider
    : (enabled[0] ?? "minimax");
  form.cloud = { ...form.clouds[editor] };
  if (form.cloud.provider === "minimax" && form.cloud.useChinaEndpoint) {
    form.cloud.baseUrl = MINIMAX_CHINA_URL;
  }

  const routeTables = tables.filter((table) => table.header.startsWith("routes."));
  const classifier = routeTables.find((table) => table.fields.type === "llm_classifier");
  const smart = routeTables.find((table) => table.header === "routes.smart");
  const smartId = (classifier?.fields.id ?? smart?.fields.id ?? "").trim();
  if (smartId) {
    form.smartRouteId = smartId;
  }

  return form;
}

export type SetupSlice = "cloud" | "locals";

function withCloudEditor(form: SetupForm): SetupForm {
  return {
    ...form,
    clouds: {
      ...form.clouds,
      [form.cloud.provider]: { ...form.cloud },
    },
  };
}

/** Keep the other half of a setup form when saving Cloud or Local on its own. */
export function applySetupSlice(saved: SetupForm, slice: SetupSlice, draft: SetupForm): SetupForm {
  const savedSynced = withCloudEditor(saved);
  const draftSynced = withCloudEditor(draft);
  if (slice === "cloud") {
    const provider = draftSynced.cloud.provider;
    const clouds = {
      ...savedSynced.clouds,
      [provider]: { ...draftSynced.cloud },
    };
    const strongProvider = clouds[savedSynced.strongProvider]?.enabled
      ? savedSynced.strongProvider
      : (CLOUD_ORDER.find((id) => clouds[id].enabled) ?? provider);
    return {
      telemetryOptIn: savedSynced.telemetryOptIn,
      cloud: { ...draftSynced.cloud },
      clouds,
      strongProvider:
        draftSynced.strongProvider && clouds[draftSynced.strongProvider]?.enabled
          ? draftSynced.strongProvider
          : strongProvider,
      locals: {
        unsloth: { ...savedSynced.locals.unsloth },
        lmstudio: { ...savedSynced.locals.lmstudio },
        gemma: { ...savedSynced.locals.gemma },
      },
      smartRouteId: savedSynced.smartRouteId,
    };
  }
  return {
    telemetryOptIn: savedSynced.telemetryOptIn,
    cloud: { ...savedSynced.cloud },
    clouds: savedSynced.clouds,
    strongProvider: savedSynced.strongProvider,
    locals: {
      unsloth: { ...draftSynced.locals.unsloth },
      lmstudio: { ...draftSynced.locals.lmstudio },
      gemma: { ...draftSynced.locals.gemma },
    },
    smartRouteId: savedSynced.smartRouteId,
  };
}

export function cloudKeyOnFile(form: SetupForm, flags: { name: string; set: boolean }[]): boolean {
  const name = cloudApiKeyEnv(form.cloud.provider);
  return flags.some((flag) => flag.name === name && flag.set);
}

export function secretFlagsFromRecord(secrets: Record<string, string>): { name: string; set: boolean }[] {
  return Object.entries(secrets).map(([name, value]) => ({
    name,
    set: Boolean(value && value.trim()),
  }));
}

export function applyStoredSecrets(
  form: SetupForm,
  secrets: Record<string, string>,
): SetupForm {
  const next: SetupForm = {
    ...form,
    cloud: { ...form.cloud },
    clouds: { ...form.clouds },
    locals: {
      unsloth: { ...form.locals.unsloth },
      lmstudio: { ...form.locals.lmstudio },
      gemma: { ...form.locals.gemma },
    },
  };

  for (const provider of CLOUD_ORDER) {
    const cloud = { ...next.clouds[provider] };
    const cloudVal = secrets[cloudApiKeyEnv(provider)];
    if (isRealSecret(cloudVal) && !isRealSecret(cloud.apiKey)) {
      cloud.apiKey = cloudVal;
    }
    next.clouds[provider] = cloud;
  }
  next.cloud = { ...next.clouds[next.cloud.provider] };
  const editorVal = secrets[cloudApiKeyEnv(next.cloud.provider)];
  if (isRealSecret(editorVal) && !isRealSecret(next.cloud.apiKey)) {
    next.cloud.apiKey = editorVal;
  }

  for (const kind of LOCAL_ORDER) {
    const val = secrets[localApiKeyEnv(kind)];
    if (isRealSecret(val) && !isRealSecret(next.locals[kind].apiKey)) {
      next.locals[kind].apiKey = val;
    }
  }

  return next;
}

export function mergeSetupState(
  fromToml: SetupForm,
  draft: SetupForm | null,
  secrets: Record<string, string>,
): SetupForm {
  const merged: SetupForm = draft
    ? {
        telemetryOptIn: draft.telemetryOptIn,
        smartRouteId: fromToml.smartRouteId || draft.smartRouteId,
        strongProvider: draft.strongProvider ?? fromToml.strongProvider,
        cloud: { ...fromToml.cloud, ...draft.cloud },
        clouds: { ...fromToml.clouds, ...draft.clouds },
        locals: {
          unsloth: { ...fromToml.locals.unsloth, ...draft.locals.unsloth },
          lmstudio: { ...fromToml.locals.lmstudio, ...draft.locals.lmstudio },
          gemma: { ...fromToml.locals.gemma, ...draft.locals.gemma },
        },
      }
    : fromToml;
  return applyStoredSecrets(merged, secrets);
}

/**
 * Map each passthrough route id to the upstream model id the engine records in /v1/stats.
 * Classifier routes are omitted: their answer calls land on strong/weak model ids, not the route id.
 */
export function backendIdsByRoute(toml: string): Record<string, string[]> {
  const tables = parseTomlTables(toml);
  const targetIds: Record<string, string> = {};
  for (const table of tables) {
    if (!table.header.startsWith("targets.")) continue;
    const name = table.header.slice("targets.".length);
    const id = table.fields.id;
    if (name && id) targetIds[name] = id;
  }
  const mapped: Record<string, string[]> = {};
  for (const table of tables) {
    if (!table.header.startsWith("routes.")) continue;
    const routeId = table.fields.id;
    const target = table.fields.target;
    if (!routeId || table.fields.type === "llm_classifier") continue;
    const backend = target ? targetIds[target] : undefined;
    if (backend) mapped[routeId] = [backend];
  }
  return mapped;
}

/** Keys to write to Credential Manager as soon as the user types them. */
export function secretsToPersist(form: SetupForm): SecretBinding[] {
  const out: SecretBinding[] = [];
  const clouds = { ...form.clouds, [form.cloud.provider]: { ...form.cloud } };
  for (const provider of CLOUD_ORDER) {
    const cloudKey = clouds[provider].apiKey.trim();
    if (isRealSecret(cloudKey)) {
      out.push({ envName: cloudApiKeyEnv(provider), value: cloudKey });
    }
  }
  for (const kind of LOCAL_ORDER) {
    const key = form.locals[kind].apiKey.trim();
    if (isRealSecret(key)) {
      out.push({ envName: localApiKeyEnv(kind), value: key });
    }
  }
  return out;
}
