import { describe, expect, it } from "vitest";
import { extractModelIds } from "./probeModels";
import { assertNoSecretsInToml, secretsFromSetup } from "./secretMapping";
import { applySetupSlice, backendIdsByRoute, formFromToml } from "./setupHydrate";
import { defaultSetupForm } from "./setupTypes";
import { buildDeployment } from "./tomlBuilder";

function normalize(toml: string): string {
  return toml.replace(/\r\n/g, "\n").trim() + "\n";
}

const MINIMAX_ONLY = `schema_version = 1

[llm_clients.minimax]
format = "openai_chat"
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[targets.strong]
id = "MiniMax-M3"
llm_client = "minimax"

[routes.smart]
id = "switchyard"
type = "passthrough"
target = "strong"
context_window = 1000000
tool_calling = true
reasoning = true

[routes.minimax]
id = "MiniMax-M3"
type = "passthrough"
target = "strong"
context_window = 1000000
tool_calling = true
reasoning = true
`;

const MINIMAX_UNSLOTH = `schema_version = 1

[llm_clients.minimax]
format = "openai_chat"
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[llm_clients.unsloth]
format = "openai_chat"
base_url = "http://127.0.0.1:8888/v1"
api_key_env = "UNSLOTH_API_KEY"

[targets.strong]
id = "MiniMax-M3"
llm_client = "minimax"

[targets.weak]
id = "unsloth/gemma-4-E4B-it-GGUF"
llm_client = "unsloth"
extra_body = { chat_template_kwargs = { enable_thinking = false } }

[routes.smart]
id = "switchyard"
type = "llm_classifier"
mode = "capability"
classifier_target = "strong"
strong_target = "strong"
weak_target = "weak"
base_threshold = 0.5
threshold_step = 0.1
session_affinity = true
message_hash_fallback = true
context_window = 1000000
tool_calling = true
reasoning = true

[routes.minimax]
id = "MiniMax-M3"
type = "passthrough"
target = "strong"
context_window = 1000000
tool_calling = true
reasoning = true

[routes.local]
id = "unsloth-local"
type = "passthrough"
target = "weak"
tool_calling = true
`;

describe("buildDeployment", () => {
  it("matches MiniMax-only and MiniMax+Unsloth without putting keys in toml", () => {
    const cloud = defaultSetupForm();
    cloud.cloud.apiKey = "sk-test-minimax-not-real";
    const built = buildDeployment(cloud);
    expect(normalize(built.toml)).toBe(normalize(MINIMAX_ONLY));
    expect(built.toml).not.toContain("minimaxi.com");
    assertNoSecretsInToml(built.toml, secretsFromSetup(cloud));

    const both = defaultSetupForm();
    both.cloud.apiKey = "sk-test-minimax-not-real";
    both.locals.unsloth.enabled = true;
    both.locals.unsloth.apiKey = "sk-unsloth-not-real";
    const combo = buildDeployment(both);
    expect(normalize(combo.toml)).toBe(normalize(MINIMAX_UNSLOTH));
    assertNoSecretsInToml(combo.toml, secretsFromSetup(both));
  });

  it("hydrates provider, strong model, and local apps from routes.toml", () => {
    const form = formFromToml(MINIMAX_UNSLOTH);
    expect(form.cloud.provider).toBe("minimax");
    expect(form.cloud.modelId).toBe("MiniMax-M3");
    expect(form.locals.unsloth.enabled).toBe(true);
    expect(form.locals.unsloth.modelId).toBe("unsloth/gemma-4-E4B-it-GGUF");
    expect(form.cloud.apiKey).toBe("");
    expect(form.smartRouteId).toBe("switchyard");
  });

  it("keeps a renamed smart route id when models are saved", () => {
    const renamed = MINIMAX_UNSLOTH.replace('id = "switchyard"', 'id = "maskclaw"');
    const form = formFromToml(renamed);
    expect(form.smartRouteId).toBe("maskclaw");
    const rebuilt = buildDeployment(form);
    expect(rebuilt.toml).toMatch(/id = "maskclaw"/);
    expect(rebuilt.toml).not.toMatch(/id = "switchyard"/);
    const sliced = applySetupSlice(form, "locals", defaultSetupForm());
    expect(sliced.smartRouteId).toBe("maskclaw");
    expect(buildDeployment(sliced).toml).not.toMatch(/id = "switchyard"/);
  });

  it("saves cloud or local without overwriting the other half", () => {
    const saved = formFromToml(MINIMAX_UNSLOTH);
    const cloudDraft = defaultSetupForm();
    cloudDraft.cloud.modelId = "MiniMax-M4";
    const afterCloud = applySetupSlice(saved, "cloud", cloudDraft);
    expect(afterCloud.cloud.modelId).toBe("MiniMax-M4");
    expect(afterCloud.locals.unsloth.enabled).toBe(true);
    expect(afterCloud.locals.unsloth.modelId).toBe("unsloth/gemma-4-E4B-it-GGUF");

    const localDraft = defaultSetupForm();
    localDraft.locals.lmstudio.enabled = true;
    localDraft.locals.lmstudio.modelId = "gemma-4-e4b-it";
    const afterLocal = applySetupSlice(saved, "locals", localDraft);
    expect(afterLocal.cloud.modelId).toBe("MiniMax-M3");
    expect(afterLocal.locals.unsloth.enabled).toBe(false);
    expect(afterLocal.locals.lmstudio.enabled).toBe(true);
    expect(afterLocal.locals.lmstudio.modelId).toBe("gemma-4-e4b-it");
  });

  it("keeps every saved cloud in routes.toml so each one is a selectable model", () => {
    const saved = formFromToml(MINIMAX_UNSLOTH);
    const openaiDraft = defaultSetupForm();
    openaiDraft.cloud = {
      enabled: true,
      provider: "openai",
      apiKey: "sk-openai-not-real",
      modelId: "gpt-4o",
      weakModelId: "",
      baseUrl: "https://api.openai.com/v1",
    };
    openaiDraft.strongProvider = "minimax";
    const merged = applySetupSlice(saved, "cloud", openaiDraft);
    expect(merged.clouds.minimax.enabled).toBe(true);
    expect(merged.clouds.minimax.modelId).toBe("MiniMax-M3");
    expect(merged.clouds.openai.enabled).toBe(true);
    expect(merged.clouds.openai.modelId).toBe("gpt-4o");
    const secrets = secretsFromSetup(merged);
    expect(secrets.map((item) => item.envName)).toContain("OPENAI_API_KEY");

    const built = buildDeployment(merged);
    expect(built.toml).toContain("[llm_clients.minimax]");
    expect(built.toml).toContain("[llm_clients.openai]");
    expect(built.toml).toContain("[llm_clients.unsloth]");
    expect(built.toml).toContain("[routes.minimax]");
    expect(built.toml).toContain("[routes.openai]");
    expect(built.toml).toMatch(/id = "MiniMax-M3"/);
    expect(built.toml).not.toMatch(/id = "minimax-m3"/);
    expect(built.toml).toMatch(/id = "gpt-4o"/);
    expect(built.toml).toContain("[targets.strong]");
    expect(built.toml).toContain("[targets.openai_target]");
    expect(backendIdsByRoute(built.toml)["gpt-4o"]).toEqual(["gpt-4o"]);
    expect(backendIdsByRoute(built.toml)["MiniMax-M3"]).toEqual(["MiniMax-M3"]);

    const round = formFromToml(built.toml);
    expect(round.clouds.minimax.enabled).toBe(true);
    expect(round.clouds.openai.enabled).toBe(true);
    expect(round.clouds.openai.modelId).toBe("gpt-4o");
    expect(round.strongProvider).toBe("minimax");
  });

  it("can point smart-routing fallback at any saved cloud", () => {
    const form = defaultSetupForm();
    form.cloud.apiKey = "sk-test-minimax-not-real";
    form.clouds.openai = {
      enabled: true,
      provider: "openai",
      apiKey: "sk-openai-not-real",
      modelId: "gpt-4o",
      weakModelId: "",
      baseUrl: "https://api.openai.com/v1",
    };
    form.strongProvider = "openai";
    const built = buildDeployment(form);
    expect(built.toml).toMatch(/\[targets\.strong\]\s+id = "gpt-4o"\s+llm_client = "openai"/);
    expect(built.toml).toContain("[targets.minimax_target]");
    expect(built.toml).toMatch(/\[targets\.minimax_target\]\s+id = "MiniMax-M3"/);
  });

  it("maps passthrough tracks to backend model ids used in /v1/stats", () => {
    expect(backendIdsByRoute(MINIMAX_UNSLOTH)).toEqual({
      "MiniMax-M3": ["MiniMax-M3"],
      "unsloth-local": ["unsloth/gemma-4-E4B-it-GGUF"],
    });
    expect(backendIdsByRoute(MINIMAX_ONLY)).toEqual({
      switchyard: ["MiniMax-M3"],
      "MiniMax-M3": ["MiniMax-M3"],
    });
    const studio = defaultSetupForm();
    studio.cloud.apiKey = "sk-test-minimax-not-real";
    studio.locals.lmstudio.enabled = true;
    studio.locals.lmstudio.modelId = "qwen2.5-coder-7b";
    const combo = buildDeployment(studio);
    expect(backendIdsByRoute(combo.toml)["lmstudio-local"]).toEqual(["qwen2.5-coder-7b"]);
    expect(combo.toml).toContain('classifier_target = "strong"');
    expect(combo.toml).toContain('weak_target = "weak"');
  });

  it("parses model ids from an OpenAI-style models list", () => {
    expect(extractModelIds('{"data":[{"id":"gemma3"},{"id":"other"}]}')).toEqual(["gemma3", "other"]);
    expect(extractModelIds("<html>")).toEqual([]);
  });

  it("does not emit a hyphenated slug alongside the real provider model id", () => {
    const form = defaultSetupForm();
    form.cloud.enabled = false;
    form.clouds.minimax.enabled = false;
    form.clouds.openrouter = {
      enabled: true,
      provider: "openrouter",
      apiKey: "sk-or-not-real",
      modelId: "nvidia/nemotron-3.5-lightning:free",
      weakModelId: "",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    form.cloud = { ...form.clouds.openrouter };
    form.strongProvider = "openrouter";
    const built = buildDeployment(form);
    expect(built.toml).toContain('id = "nvidia/nemotron-3.5-lightning:free"');
    expect(built.toml).not.toContain("nvidia-nemotron-3-5-lightning-free");
    expect(built.toml).not.toContain("[routes.openrouter_pin]");
  });
});
