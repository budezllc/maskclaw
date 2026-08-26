import {
  cloudApiKeyEnv,
  localApiKeyEnv,
  type SecretBinding,
} from "./secretMapping";
import {
  DEFAULT_CLOUD_URLS,
  LOCAL_ORDER,
  MINIMAX_CHINA_URL,
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

const DUMMY_SECRET_VALUES = new Set([
  "local",
  "lm-studio",
  "ollama",
  "sk-unsloth-local",
]);

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
    locals: {
      unsloth: { ...base.locals.unsloth },
      lmstudio: { ...base.locals.lmstudio },
      gemma: { ...base.locals.gemma },
    },
  };
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
      form.cloud.enabled = true;
      form.cloud.provider = provider;
      form.cloud.baseUrl = baseUrl || DEFAULT_CLOUD_URLS[provider];
      form.cloud.useChinaEndpoint =
        provider === "minimax" && baseUrl.includes("minimaxi.com");
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
      if (role === "weak") {
        form.cloud.weakModelId = id;
      } else {
        form.cloud.modelId = id;
      }
      continue;
    }
    const local = localKindFromClient(llmClient);
    if (local) {
      form.locals[local].modelId = id;
    }
  }

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

/** Keep the other half of a setup form when saving Cloud or Local on its own. */
export function applySetupSlice(saved: SetupForm, slice: SetupSlice, draft: SetupForm): SetupForm {
  if (slice === "cloud") {
    return {
      telemetryOptIn: saved.telemetryOptIn,
      smartRouteId: saved.smartRouteId,
      cloud: { ...draft.cloud },
      locals: {
        unsloth: { ...saved.locals.unsloth },
        lmstudio: { ...saved.locals.lmstudio },
        gemma: { ...saved.locals.gemma },
      },
    };
  }
  return {
    telemetryOptIn: saved.telemetryOptIn,
    smartRouteId: saved.smartRouteId,
    cloud: { ...saved.cloud },
    locals: {
      unsloth: { ...draft.locals.unsloth },
      lmstudio: { ...draft.locals.lmstudio },
      gemma: { ...draft.locals.gemma },
    },
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
    locals: {
      unsloth: { ...form.locals.unsloth },
      lmstudio: { ...form.locals.lmstudio },
      gemma: { ...form.locals.gemma },
    },
  };

  const cloudVal = secrets[cloudApiKeyEnv(next.cloud.provider)];
  if (isRealSecret(cloudVal) && !isRealSecret(next.cloud.apiKey)) {
    next.cloud.apiKey = cloudVal;
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
        cloud: { ...fromToml.cloud, ...draft.cloud },
        locals: {
          unsloth: { ...fromToml.locals.unsloth, ...draft.locals.unsloth },
          lmstudio: { ...fromToml.locals.lmstudio, ...draft.locals.lmstudio },
          gemma: { ...fromToml.locals.gemma, ...draft.locals.gemma },
        },
      }
    : fromToml;
  return applyStoredSecrets(merged, secrets);
}

/** Keys to write to Credential Manager as soon as the user types them. */
export function secretsToPersist(form: SetupForm): SecretBinding[] {
  const out: SecretBinding[] = [];
  const cloudKey = form.cloud.apiKey.trim();
  if (isRealSecret(cloudKey)) {
    out.push({ envName: cloudApiKeyEnv(form.cloud.provider), value: cloudKey });
  }
  for (const kind of LOCAL_ORDER) {
    const key = form.locals[kind].apiKey.trim();
    if (isRealSecret(key)) {
      out.push({ envName: localApiKeyEnv(kind), value: key });
    }
  }
  return out;
}
