import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoSecretsInToml, secretsFromSetup } from "./secretMapping";
import { applySetupSlice, formFromToml } from "./setupHydrate";
import { buildDeployment, collectUsedPairs } from "./tomlBuilder";
import { defaultSetupForm, type SetupForm } from "./setupTypes";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function load(name: string): string {
  return readFileSync(join(fixtures, name), "utf8").replace(/\r\n/g, "\n");
}

function normalize(toml: string): string {
  return toml.replace(/\r\n/g, "\n").trim() + "\n";
}

function minimaxUnslothForm(): SetupForm {
  const form = defaultSetupForm();
  form.cloud.apiKey = "sk-test-minimax-not-real";
  form.locals.unsloth.enabled = true;
  form.locals.unsloth.apiKey = "sk-unsloth-not-real";
  return form;
}

describe("buildDeployment", () => {
  it("always registers model id switchyard so clients can keep using the proxy name", () => {
    const cloudOnly = defaultSetupForm();
    expect(buildDeployment(cloudOnly).toml).toContain('id = "switchyard"');
    const localOnly = defaultSetupForm();
    localOnly.cloud.enabled = false;
    localOnly.locals.unsloth.enabled = true;
    expect(buildDeployment(localOnly).toml).toContain('id = "switchyard"');
  });

  it("starts with an empty weak model so MiniMax-only stays a single strong target", () => {
    const form = defaultSetupForm();
    expect(form.cloud.modelId).toBe("MiniMax-M3");
    expect(form.cloud.weakModelId).toBe("");
  });

  it("matches MiniMax-only golden", () => {
    const form = defaultSetupForm();
    form.cloud.apiKey = "sk-test";
    expect(normalize(buildDeployment(form).toml)).toBe(load("minimax-only.toml"));
  });

  it("matches Unsloth-only golden", () => {
    const form = defaultSetupForm();
    form.cloud.enabled = false;
    form.locals.unsloth.enabled = true;
    expect(normalize(buildDeployment(form).toml)).toBe(load("unsloth-only.toml"));
  });

  it("matches MiniMax+Unsloth classifier golden and appliance example routes", () => {
    const built = normalize(buildDeployment(minimaxUnslothForm()).toml);
    expect(built).toBe(load("minimax-unsloth.toml"));
    const live = normalize(
      readFileSync(join(repoRoot, "appliance", "deploy", "config", "routes.toml.example"), "utf8"),
    );
    expect(live).toContain('id = "maskclaw"');
  });

  it("matches LM Studio preset golden", () => {
    const form = defaultSetupForm();
    form.cloud.enabled = false;
    form.locals.lmstudio.enabled = true;
    form.locals.lmstudio.modelId = "local-model";
    expect(normalize(buildDeployment(form).toml)).toBe(load("lmstudio.toml"));
  });

  it("matches Gemma preset golden", () => {
    const form = defaultSetupForm();
    form.cloud.enabled = false;
    form.locals.gemma.enabled = true;
    expect(normalize(buildDeployment(form).toml)).toBe(load("gemma.toml"));
  });

  it("keeps Unsloth Gemma GGUF and Gemma/Ollama on distinct clients", () => {
    const form = defaultSetupForm();
    form.cloud.enabled = false;
    form.locals.unsloth.enabled = true;
    form.locals.gemma.enabled = true;
    const toml = buildDeployment(form).toml;
    const pairs = collectUsedPairs(toml);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { llm_client: "unsloth", id: "unsloth/gemma-4-E4B-it-GGUF" },
        { llm_client: "gemma", id: "gemma3" },
      ]),
    );
    expect(toml).toContain("unsloth-local");
    expect(toml).toContain("gemma-local");
  });

  it("never serializes API keys into TOML", () => {
    const form = minimaxUnslothForm();
    const { toml } = buildDeployment(form);
    const secrets = secretsFromSetup(form);
    expect(toml).not.toContain("sk-test-minimax-not-real");
    expect(toml).not.toContain("sk-unsloth-not-real");
    expect(toml).toContain('api_key_env = "MINIMAX_API_KEY"');
    expect(toml).toContain('api_key_env = "UNSLOTH_API_KEY"');
    assertNoSecretsInToml(toml, secrets);
  });

  it("uses the China MiniMax URL when requested", () => {
    const form = defaultSetupForm();
    form.cloud.useChinaEndpoint = true;
    expect(buildDeployment(form).toml).toContain("https://api.minimaxi.com/v1");
  });

  it("rejects an empty yard", () => {
    const form = defaultSetupForm();
    form.cloud.enabled = false;
    expect(() => buildDeployment(form)).toThrow(/local app/i);
  });

  it("writes the chosen MiniMax model as the strong target", () => {
    const form = defaultSetupForm();
    form.cloud.modelId = "MiniMax-M2.5";
    const toml = buildDeployment(form).toml;
    expect(toml).toContain("[targets.strong]");
    expect(toml).toContain('id = "MiniMax-M2.5"');
    expect(toml).not.toContain('id = "MiniMax-M3"');
  });

  it("writes a same-provider weak model when no local app is on", () => {
    const form = defaultSetupForm();
    form.cloud.modelId = "MiniMax-M3";
    form.cloud.weakModelId = "MiniMax-M2.5";
    const toml = buildDeployment(form).toml;
    expect(toml).toContain("[targets.strong]");
    expect(toml).toContain('id = "MiniMax-M3"');
    expect(toml).toContain("[targets.weak]");
    expect(toml).toContain('id = "MiniMax-M2.5"');
    expect(toml).toContain("[routes.weak]");
    expect(toml).toContain('target = "weak"');
  });

  it("lets a local app own the weak target when both are set", () => {
    const form = minimaxUnslothForm();
    form.cloud.weakModelId = "MiniMax-M2.5";
    const toml = buildDeployment(form).toml;
    expect(toml).toContain("[targets.weak]");
    expect(toml).toContain('id = "unsloth/gemma-4-E4B-it-GGUF"');
    expect(toml).not.toContain('id = "MiniMax-M2.5"');
  });

  it("rejects a missing strong model id", () => {
    const form = defaultSetupForm();
    form.cloud.modelId = "  ";
    expect(() => buildDeployment(form)).toThrow(/model id for minimax/i);
  });

  it("keeps every saved cloud in routes.toml so each one is a selectable model", () => {
    const saved = formFromToml(load("minimax-unsloth.toml"));
    const openaiDraft = defaultSetupForm();
    openaiDraft.cloud = {
      enabled: true,
      provider: "openai",
      apiKey: "sk-openai-not-real",
      useChinaEndpoint: false,
      modelId: "gpt-4o",
      weakModelId: "",
      baseUrl: "https://api.openai.com/v1",
    };
    openaiDraft.strongProvider = "minimax";
    const merged = applySetupSlice(saved, "cloud", openaiDraft);
    expect(merged.clouds.minimax.enabled).toBe(true);
    expect(merged.clouds.openai.enabled).toBe(true);
    const built = buildDeployment(merged);
    expect(built.toml).toContain("[llm_clients.openai]");
    expect(built.toml).toMatch(/id = "MiniMax-M3"/);
    expect(built.toml).toMatch(/id = "gpt-4o"/);
    expect(built.toml).not.toMatch(/id = "minimax-m3"/);
  });

  it("keeps a maskclaw auto-route id instead of rewriting switchyard", () => {
    const form = minimaxUnslothForm();
    form.smartRouteId = "maskclaw";
    const toml = buildDeployment(form).toml;
    expect(toml).toMatch(/\[routes\.smart\][\s\S]*id = "maskclaw"/);
    expect(toml).not.toMatch(/id = "switchyard"/);
  });
});
