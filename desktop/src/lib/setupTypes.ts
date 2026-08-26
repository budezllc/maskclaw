export type CloudProvider =
  | "minimax"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "custom";

export type LocalKind = "unsloth" | "lmstudio" | "gemma";

export interface CloudForm {
  enabled: boolean;
  provider: CloudProvider;
  apiKey: string;
  useChinaEndpoint: boolean;
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
  locals: Record<LocalKind, LocalForm>;
  telemetryOptIn: boolean;
  /** Route id clients send for auto-routing (`routes.smart`). */
  smartRouteId: string;
}

export const DEFAULT_CLOUD_URLS: Record<CloudProvider, string> = {
  minimax: "https://api.minimax.io/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  custom: "",
};

export const MINIMAX_CHINA_URL = "https://api.minimaxi.com/v1";

export const DEFAULT_CLOUD_MODELS: Record<CloudProvider, string> = {
  minimax: "MiniMax-M3",
  openrouter: "",
  openai: "",
  anthropic: "",
  custom: "",
};

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
  return {
    cloud: {
      enabled: true,
      provider: "minimax",
      apiKey: "",
      useChinaEndpoint: false,
      modelId: DEFAULT_CLOUD_MODELS.minimax,
      weakModelId: "",
      baseUrl: DEFAULT_CLOUD_URLS.minimax,
    },
    locals: {
      unsloth: { ...DEFAULT_LOCALS.unsloth },
      lmstudio: { ...DEFAULT_LOCALS.lmstudio },
      gemma: { ...DEFAULT_LOCALS.gemma },
    },
    telemetryOptIn: false,
    smartRouteId: "switchyard",
  };
}

/** MaskClaw auto-route id. Stock Switchyard keeps `switchyard`. */
export const MASKCLAW_SMART_ROUTE_ID = "maskclaw";

export function maskclawSetupForm(): SetupForm {
  return { ...defaultSetupForm(), smartRouteId: MASKCLAW_SMART_ROUTE_ID };
}

export function maskclawSmartRouteId(id: string | undefined): string {
  const trimmed = id?.trim() ?? "";
  return !trimmed || trimmed === "switchyard" ? MASKCLAW_SMART_ROUTE_ID : trimmed;
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
