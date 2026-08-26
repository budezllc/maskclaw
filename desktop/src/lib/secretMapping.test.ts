import { describe, expect, it } from "vitest";
import {
  assertNoSecretsInToml,
  cloudApiKeyEnv,
  localApiKeyEnv,
  secretsFromSetup,
  sidecarEnvFromSecrets,
} from "./secretMapping";
import { defaultSetupForm } from "./setupTypes";

describe("secret mapping", () => {
  it("maps providers to api_key_env names", () => {
    expect(cloudApiKeyEnv("minimax")).toBe("MINIMAX_API_KEY");
    expect(cloudApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(cloudApiKeyEnv("openai")).toBe("OPENAI_API_KEY");
    expect(cloudApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(localApiKeyEnv("unsloth")).toBe("UNSLOTH_API_KEY");
    expect(localApiKeyEnv("lmstudio")).toBe("LM_STUDIO_API_KEY");
    expect(localApiKeyEnv("gemma")).toBe("OLLAMA_API_KEY");
  });

  it("injects secrets as env and opts out of telemetry by default", () => {
    const form = defaultSetupForm();
    form.cloud.apiKey = "sk-live-example";
    form.locals.unsloth.enabled = true;
    form.locals.unsloth.apiKey = "sk-unsloth-example";
    const secrets = secretsFromSetup(form);
    const env = sidecarEnvFromSecrets(secrets, false);
    expect(env.MINIMAX_API_KEY).toBe("sk-live-example");
    expect(env.UNSLOTH_API_KEY).toBe("sk-unsloth-example");
    expect(secrets.some((secret) => secret.envName === "UNSLOTH_API_KEY")).toBe(true);
    expect(env.SWITCHYARD_TELEMETRY_OPT_OUT).toBe("1");
    expect(sidecarEnvFromSecrets(secrets, true).SWITCHYARD_TELEMETRY_OPT_OUT).toBeUndefined();
  });

  it("refuses to treat a TOML blob that contains the raw key as safe", () => {
    const secrets = [{ envName: "MINIMAX_API_KEY", value: "sk-leaked" }];
    expect(() =>
      assertNoSecretsInToml('api_key = "sk-leaked"', secrets),
    ).toThrow(/leaked/);
  });
});
