import { cloudApiKeyEnv, localApiKeyEnv } from "./secretMapping";
import {
  DEFAULT_CLOUD_URLS,
  LOCAL_ORDER,
  MINIMAX_CHINA_URL,
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

function cloudBaseUrl(form: SetupForm): string {
  if (form.cloud.provider === "minimax") {
    return form.cloud.useChinaEndpoint ? MINIMAX_CHINA_URL : DEFAULT_CLOUD_URLS.minimax;
  }
  if (form.cloud.provider === "custom") {
    return form.cloud.baseUrl.replace(/\/$/, "");
  }
  return (form.cloud.baseUrl || DEFAULT_CLOUD_URLS[form.cloud.provider]).replace(
    /\/$/,
    "",
  );
}

function cloudFormat(provider: CloudProvider): string {
  return provider === "anthropic" ? "anthropic_messages" : "openai_chat";
}

function cloudClientName(provider: CloudProvider): string {
  return provider;
}

function cloudRouteId(provider: CloudProvider, modelId: string): string {
  if (provider === "minimax" && (!modelId || modelId === "MiniMax-M3")) {
    return "minimax-m3";
  }
  const slug = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `${provider}-cloud`;
}

function cloudStrongModelId(form: SetupForm): string {
  return form.cloud.modelId.trim();
}

function cloudWeakModelId(form: SetupForm): string {
  return form.cloud.weakModelId.trim();
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
  const id = form.smartRouteId?.trim();
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
  const cloudOn = form.cloud.enabled;
  const locals = enabledLocals(form);
  if (!cloudOn && locals.length === 0) {
    throw new Error("Turn on a cloud key or at least one local app before starting.");
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

  let cloudTarget: string | undefined;
  if (cloudOn) {
    const name = cloudClientName(form.cloud.provider);
    const env = cloudApiKeyEnv(form.cloud.provider);
    apiKeyEnvs.push(env);
    clients.push({
      name,
      format: cloudFormat(form.cloud.provider),
      baseUrl: cloudBaseUrl(form),
      apiKeyEnv: env,
    });
    const modelId = cloudStrongModelId(form);
    if (!modelId) {
      throw new Error("Enter the strong model id your cloud account already uses.");
    }
    rememberPair(name, modelId);
    targets.push({ name: "strong", id: modelId, llmClient: name });
    cloudTarget = "strong";
    const weakId = cloudWeakModelId(form);
    if (weakId && locals.length === 0) {
      rememberPair(name, weakId);
      targets.push({ name: "weak", id: weakId, llmClient: name });
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
    const targetName = localTargets.length === 0 && cloudOn ? "weak" : `${kind}_target`;
    const extraBody =
      kind === "unsloth" ? "{ chat_template_kwargs = { enable_thinking = false } }" : undefined;
    targets.push({ name: targetName, id: modelId, llmClient: client, extraBody });
    localTargets.push({ kind, target: targetName });
  }

  const firstLocal = localTargets[0];

  if (cloudOn && firstLocal) {
    const smartFields = [
      `type = "llm_classifier"`,
      `mode = "capability"`,
      `classifier_target = "${firstLocal.target}"`,
      `strong_target = "strong"`,
      `weak_target = "${firstLocal.target}"`,
      `base_threshold = 0.5`,
      `threshold_step = 0.1`,
      `session_affinity = true`,
      `message_hash_fallback = true`,
    ];
    if (form.cloud.provider === "minimax") {
      smartFields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
    }
    routes.push({
      table: "smart",
      id: smartRouteId(form),
      type: "llm_classifier",
      fields: smartFields,
    });

    const cloudFields = [`type = "passthrough"`, `target = "strong"`];
    if (form.cloud.provider === "minimax") {
      cloudFields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
    }
    routes.push({
      table: form.cloud.provider === "minimax" ? "minimax" : "cloud",
      id: cloudRouteId(form.cloud.provider, form.cloud.modelId),
      type: "passthrough",
      fields: cloudFields,
    });

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
    const fields = [`type = "passthrough"`, `target = "strong"`];
    if (form.cloud.provider === "minimax") {
      fields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
    }
    routes.push({
      table: form.cloud.provider === "minimax" ? "minimax" : "cloud",
      id: cloudRouteId(form.cloud.provider, form.cloud.modelId || "cloud"),
      type: "passthrough",
      fields,
    });
    if (cloudWeakModelId(form)) {
      const weakFields = [`type = "passthrough"`, `target = "weak"`];
      if (form.cloud.provider === "minimax") {
        weakFields.push(`context_window = 1000000`, `tool_calling = true`, `reasoning = true`);
      }
      routes.push({
        table: "weak",
        id: cloudRouteId(form.cloud.provider, cloudWeakModelId(form)),
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
  ensureSmartRoute(
    routes,
    form,
    fallbackTarget,
    cloudOn && form.cloud.provider === "minimax",
  );

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
