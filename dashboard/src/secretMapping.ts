import { CLOUD_ORDER, LOCAL_ORDER, type CloudProvider, type LocalKind, type SetupForm } from "./setupTypes";

export function cloudApiKeyEnv(provider: CloudProvider): string {
  switch (provider) {
    case "minimax":
      return "MINIMAX_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "custom":
      return "CUSTOM_API_KEY";
  }
}

export function localPlaceholder(kind: LocalKind): string {
  switch (kind) {
    case "unsloth":
      return "sk-unsloth-local";
    case "lmstudio":
      return "lm-studio";
    case "gemma":
      return "ollama";
  }
}

export function localApiKeyEnv(kind: LocalKind): string {
  switch (kind) {
    case "unsloth":
      return "UNSLOTH_API_KEY";
    case "lmstudio":
      return "LM_STUDIO_API_KEY";
    case "gemma":
      return "OLLAMA_API_KEY";
  }
}

export interface SecretBinding {
  envName: string;
  value: string;
}

export function secretsFromSetup(form: SetupForm): SecretBinding[] {
  const out: SecretBinding[] = [];
  const clouds = { ...form.clouds, [form.cloud.provider]: { ...form.cloud } };
  for (const provider of CLOUD_ORDER) {
    const cloud = clouds[provider];
    if (cloud.enabled && cloud.apiKey.trim()) {
      out.push({
        envName: cloudApiKeyEnv(provider),
        value: cloud.apiKey.trim(),
      });
    }
  }
  for (const kind of LOCAL_ORDER) {
    const local = form.locals[kind];
    if (local.enabled) {
      out.push({
        envName: localApiKeyEnv(kind),
        value: local.apiKey.trim() || localPlaceholder(kind),
      });
    }
  }
  return out;
}

export function assertNoSecretsInToml(toml: string, secrets: SecretBinding[]): void {
  for (const secret of secrets) {
    if (secret.value && toml.includes(secret.value)) {
      throw new Error(`secret value for ${secret.envName} leaked into TOML`);
    }
  }
}

export function secretValuesRecord(form: SetupForm): Record<string, string> {
  const values: Record<string, string> = {};
  for (const binding of secretsFromSetup(form)) {
    values[binding.envName] = binding.value;
  }
  return values;
}
