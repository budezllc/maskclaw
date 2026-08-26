export type CloudProvider = "minimax" | "openrouter" | "openai" | "anthropic" | "custom";

export type LocalKind = "unsloth" | "lmstudio" | "gemma";

export interface CloudForm {
  enabled: boolean;
  provider: CloudProvider;
  apiKey: string;
  modelId: string;
  weakModelId: string;
  baseUrl: string;
}

export interface LocalForm {
  enabled: boolean;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface SetupForm {
  cloud: CloudForm;
  /** Every cloud provider that has been saved. `cloud` is the one currently edited. */
  clouds: Record<CloudProvider, CloudForm>;
  /** Cloud used as classifier strong / smart-routing fallback. */
  strongProvider: CloudProvider;
  locals: Record<LocalKind, LocalForm>;
  /** Route id clients send for auto-routing (`routes.smart`). */
  smartRouteId: string;
}

export const CLOUD_ORDER: CloudProvider[] = [
  "minimax",
  "openrouter",
  "openai",
  "anthropic",
  "custom",
];

export const DEFAULT_CLOUD_URLS: Record<CloudProvider, string> = {
  minimax: "https://api.minimax.io/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  custom: "",
};

export const DEFAULT_CLOUD_MODELS: Record<CloudProvider, string> = {
  minimax: "MiniMax-M3",
  openrouter: "",
  openai: "",
  anthropic: "",
  custom: "",
};

export function emptyCloudForm(provider: CloudProvider): CloudForm {
  return {
    enabled: false,
    provider,
    apiKey: "",
    modelId: DEFAULT_CLOUD_MODELS[provider],
    weakModelId: "",
    baseUrl: DEFAULT_CLOUD_URLS[provider],
  };
}

export function defaultClouds(): Record<CloudProvider, CloudForm> {
  const minimax = { ...emptyCloudForm("minimax"), enabled: true };
  return {
    minimax,
    openrouter: emptyCloudForm("openrouter"),
    openai: emptyCloudForm("openai"),
    anthropic: emptyCloudForm("anthropic"),
    custom: emptyCloudForm("custom"),
  };
}

export const DEFAULT_LOCALS: Record<LocalKind, LocalForm> = {
  unsloth: {
    enabled: false,
    baseUrl: "http://127.0.0.1:8888/v1",
    modelId: "unsloth/gemma-4-E4B-it-GGUF",
    apiKey: "",
  },
  lmstudio: {
    enabled: false,
    baseUrl: "http://127.0.0.1:1234/v1",
    modelId: "",
    apiKey: "lm-studio",
  },
  gemma: {
    enabled: false,
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "gemma3",
    apiKey: "ollama",
  },
};

export function defaultSetupForm(): SetupForm {
  const clouds = defaultClouds();
  return {
    cloud: { ...clouds.minimax },
    clouds,
    strongProvider: "minimax",
    locals: {
      unsloth: { ...DEFAULT_LOCALS.unsloth },
      lmstudio: { ...DEFAULT_LOCALS.lmstudio },
      gemma: { ...DEFAULT_LOCALS.gemma },
    },
    smartRouteId: "switchyard",
  };
}

export const LOCAL_ORDER: LocalKind[] = ["unsloth", "lmstudio", "gemma"];

export const PROVIDERS: { id: CloudProvider; label: string }[] = [
  { id: "minimax", label: "MiniMax" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "custom", label: "Custom" },
];

export const LOCALS: { id: LocalKind; label: string }[] = [
  { id: "unsloth", label: "Unsloth" },
  { id: "lmstudio", label: "LM Studio" },
  { id: "gemma", label: "Gemma / Ollama" },
];

export function providerLabel(id: CloudProvider): string {
  return PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
}
