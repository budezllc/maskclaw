import { cloudApiKeyEnv, localApiKeyEnv } from "./secretMapping";
import {
  CLOUD_ORDER,
  DEFAULT_CLOUD_URLS,
  LOCAL_ORDER,
  defaultClouds,
  type CloudForm,
  type CloudProvider,
  type LocalKind,
  type SetupForm,
} from "./setupTypes";

export interface BuiltDeployment {
  toml: string;
  apiKeyEnvs: string[];
}

interface ClientSpec {
  name: string;
  format: string;
  baseUrl: string;
  apiKeyEnv: string;
}

interface TargetSpec {
  name: string;
  id: string;
  llmClient: string;
  extraBody?: string;
}

interface RouteSpec {
  table: string;
  id: string;
  type: string;
  fields: string[];
}

function cloudBaseUrl(cloud: CloudForm): string {
  if (cloud.provider === "custom") {
    return cloud.baseUrl.replace(/\/$/, "");
  }
  return (cloud.baseUrl || DEFAULT_CLOUD_URLS[cloud.provider]).replace(/\/$/, "");
}

function resolvedClouds(form: SetupForm): Record<CloudProvider, CloudForm> {
  const clouds = form.clouds ?? defaultClouds();
  return {
    ...clouds,
    [form.cloud.provider]: { ...form.cloud },
  };
}

function enabledCloudProviders(form: SetupForm): CloudProvider[] {
  const clouds = resolvedClouds(form);
  return CLOUD_ORDER.filter((provider) => clouds[provider].enabled);
}

function cloudTargetName(provider: CloudProvider, strongProvider: CloudProvider): string {
  return provider === strongProvider ? "strong" : `${provider}_target`;
}

function cloudRouteTable(provider: CloudProvider): string {
  return provider === "minimax" ? "minimax" : provider;
}

function cloudFormat(provider: CloudProvider): string {
  return provider === "anthropic" ? "anthropic_messages" : "openai_chat";
}

function cloudClientName(provider: CloudProvider): string {
  return provider;
}

function cloudRouteId(provider: CloudProvider, modelId: string): string {
  return modelId.trim() || `${provider}-cloud`;
}

function pickStrongProvider(form: SetupForm, enabled: CloudProvider[]): CloudProvider {
  if (enabled.includes(form.strongProvider)) {
    return form.strongProvider;
  }
  return enabled[0];
}

function localClientName(kind: LocalKind): string {
  return kind === "lmstudio" ? "lmstudio" : kind;
}

function localRouteId(kind: LocalKind): string {
  switch (kind) {
    case "unsloth":
      return "unsloth-local";
    case "lmstudio":
      return "lmstudio-local";
    case "gemma":
      return "gemma-local";
  }
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function enabledLocals(form: SetupForm): LocalKind[] {
  return LOCAL_ORDER.filter((kind) => form.locals[kind].enabled);
}

function uniquePairKey(client: string, id: string): string {
  return `${client}\u0000${id}`;
}

/** Keep the auto-route id already in toml. Saving models used to force switchyard. */
function smartRouteId(form: SetupForm): string {
  const id = form.smartRouteId.trim();
  return id || "switchyard";
}

function ensureSmartRoute(
  routes: RouteSpec[],
  form: SetupForm,
  fallbackTarget: string,
  minimaxExtras: boolean,
): void {
  const id = smartRouteId(form);
  if (routes.some((route) => route.id === id)) {
    return;
  }
  const fields = [`type = "passthrough"`, `target = "${fallbackTarget}"`];
  if (minimaxExtras) {
    fields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
  } else if (fallbackTarget.includes("unsloth") || fallbackTarget === "weak") {
    fields.push(`tool_calling = true`);
  }
  routes.unshift({
    table: "smart",
    id,
    type: "passthrough",
    fields,
  });
}

export function buildDeployment(form: SetupForm): BuiltDeployment {
  const clouds = resolvedClouds(form);
  const enabledClouds = enabledCloudProviders(form);
  const locals = enabledLocals(form);
  if (enabledClouds.length === 0 && locals.length === 0) {
    throw new Error("Turn on a cloud key or at least one local app before saving.");
  }

  const clients: ClientSpec[] = [];
  const targets: TargetSpec[] = [];
  const routes: RouteSpec[] = [];
  const apiKeyEnvs: string[] = [];
  const pairs = new Set<string>();

  const rememberPair = (client: string, id: string) => {
    const key = uniquePairKey(client, id);
    if (pairs.has(key) && client && id) {
      // Same pair reused as classifier + weak is allowed; collisions across
      // distinct roles (two locals sharing one client+id) are not.
    }
    pairs.add(key);
  };

  const strongProvider = enabledClouds.length ? pickStrongProvider(form, enabledClouds) : undefined;
  let cloudTarget: string | undefined;
  const strongCloud = strongProvider ? clouds[strongProvider] : undefined;
  const cloudWeakId = strongCloud?.weakModelId.trim() ?? "";

  for (const provider of enabledClouds) {
    const cloud = clouds[provider];
    const name = cloudClientName(provider);
    const env = cloudApiKeyEnv(provider);
    apiKeyEnvs.push(env);
    clients.push({
      name,
      format: cloudFormat(provider),
      baseUrl: cloudBaseUrl(cloud),
      apiKeyEnv: env,
    });
    const modelId = cloud.modelId.trim();
    if (!modelId) {
      throw new Error(`Enter the model id for ${provider}.`);
    }
    rememberPair(name, modelId);
    const targetName = cloudTargetName(provider, strongProvider ?? provider);
    targets.push({ name: targetName, id: modelId, llmClient: name });
    if (provider === strongProvider) {
      cloudTarget = targetName;
    }
    if (provider === strongProvider && cloudWeakId && locals.length === 0) {
      rememberPair(name, cloudWeakId);
      targets.push({ name: "weak", id: cloudWeakId, llmClient: name });
    }
  }

  const localTargets: { kind: LocalKind; target: string }[] = [];
  for (const kind of locals) {
    const local = form.locals[kind];
    const client = localClientName(kind);
    const env = localApiKeyEnv(kind);
    apiKeyEnvs.push(env);
    clients.push({
      name: client,
      format: "openai_chat",
      baseUrl: local.baseUrl.replace(/\/$/, ""),
      apiKeyEnv: env,
    });
    const modelId = local.modelId.trim();
    if (!modelId) {
      throw new Error(`Enter a model name for ${kind}.`);
    }
    rememberPair(client, modelId);
    const targetName = localTargets.length === 0 && enabledClouds.length > 0 ? "weak" : `${kind}_target`;
    const extraBody =
      kind === "unsloth" ? "{ chat_template_kwargs = { enable_thinking = false } }" : undefined;
    targets.push({ name: targetName, id: modelId, llmClient: client, extraBody });
    localTargets.push({ kind, target: targetName });
  }

  const firstLocal = localTargets[0];

  function pushCloudPassthrough(provider: CloudProvider) {
    const cloud = clouds[provider];
    const target = cloudTargetName(provider, strongProvider ?? provider);
    const fields = [`type = "passthrough"`, `target = "${target}"`];
    if (provider === "minimax") {
      fields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
    }
    routes.push({
      table: cloudRouteTable(provider),
      id: cloudRouteId(provider, cloud.modelId || provider),
      type: "passthrough",
      fields,
    });
  }

  const cloudOn = enabledClouds.length > 0;
  const minimaxStrong = strongProvider === "minimax";

  if (cloudOn && firstLocal) {
    // Judge on cloud: local GGUF models usually cannot emit the capability JSON,
    // and a failed verdict fail-opens to the strong cloud for the rest of the session.
    const smartFields = [
      `type = "llm_classifier"`,
      `mode = "capability"`,
      `classifier_target = "strong"`,
      `strong_target = "strong"`,
      `weak_target = "${firstLocal.target}"`,
      `base_threshold = 0.5`,
      `threshold_step = 0.1`,
      `session_affinity = true`,
      `message_hash_fallback = true`,
    ];
    if (minimaxStrong) {
      smartFields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
    }
    routes.push({
      table: "smart",
      id: smartRouteId(form),
      type: "llm_classifier",
      fields: smartFields,
    });

    for (const provider of enabledClouds) {
      pushCloudPassthrough(provider);
    }

    for (const local of localTargets) {
      const fields = [`type = "passthrough"`, `target = "${local.target}"`];
      if (local.kind === "unsloth") {
        fields.push(`tool_calling = true`);
      }
      routes.push({
        table: local.kind === "unsloth" ? "local" : local.kind,
        id: localRouteId(local.kind),
        type: "passthrough",
        fields,
      });
    }
  } else if (cloudOn && cloudTarget) {
    for (const provider of enabledClouds) {
      pushCloudPassthrough(provider);
    }
    if (cloudWeakId) {
      const weakFields = [`type = "passthrough"`, `target = "weak"`];
      if (minimaxStrong) {
        weakFields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
      }
      routes.push({
        table: "weak",
        id: cloudRouteId(strongProvider ?? "minimax", cloudWeakId),
        type: "passthrough",
        fields: weakFields,
      });
    }
  } else {
    for (const local of localTargets) {
      const fields = [`type = "passthrough"`, `target = "${local.target}"`];
      if (local.kind === "unsloth") {
        fields.push(`tool_calling = true`);
      }
      routes.push({
        table: local.kind === "unsloth" ? "local" : local.kind,
        id: localRouteId(local.kind),
        type: "passthrough",
        fields,
      });
    }
  }

  const fallbackTarget = cloudTarget ?? localTargets[0]?.target ?? "strong";
  ensureSmartRoute(routes, form, fallbackTarget, cloudOn && minimaxStrong);

  const lines: string[] = ["schema_version = 1", ""];
  for (const client of clients) {
    lines.push(`[llm_clients.${client.name}]`);
    lines.push(`format = ${quoteToml(client.format)}`);
    lines.push(`base_url = ${quoteToml(client.baseUrl)}`);
    lines.push(`api_key_env = ${quoteToml(client.apiKeyEnv)}`);
    lines.push("");
  }
  for (const target of targets) {
    lines.push(`[targets.${target.name}]`);
    lines.push(`id = ${quoteToml(target.id)}`);
    lines.push(`llm_client = ${quoteToml(target.llmClient)}`);
    if (target.extraBody) {
      lines.push(`extra_body = ${target.extraBody}`);
    }
    lines.push("");
  }
  for (const route of routes) {
    lines.push(`[routes.${route.table}]`);
    lines.push(`id = ${quoteToml(route.id)}`);
    for (const field of route.fields) {
      lines.push(field);
    }
    lines.push("");
  }

  return { toml: lines.join("\n").trimEnd() + "\n", apiKeyEnvs };
}

export function collectUsedPairs(toml: string): Array<{ llm_client: string; id: string }> {
  const targets: Array<{ llm_client: string; id: string }> = [];
  const blocks = toml.split(/\[targets\./).slice(1);
  for (const block of blocks) {
    const body = block.split("\n").slice(1).join("\n");
    const id = /id\s*=\s*"([^"]+)"/.exec(body)?.[1];
    const client = /llm_client\s*=\s*"([^"]+)"/.exec(body)?.[1];
    if (id && client) targets.push({ llm_client: client, id });
  }
  return targets;
}
