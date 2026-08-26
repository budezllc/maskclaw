import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { clearSetupDraft, readSetupDraft, writeSetupDraft } from "./setupDraft";
import {
  applySetupSlice,
  applyStoredSecrets,
  formFromToml,
  mergeSetupState,
  secretsToPersist,
} from "./setupHydrate";
import { defaultSetupForm, maskclawSetupForm, maskclawSmartRouteId } from "./setupTypes";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function load(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

afterEach(() => {
  clearSetupDraft();
});

describe("formFromToml", () => {
  it("ticks Unsloth when that client is already in routes.toml", () => {
    const form = formFromToml(load("minimax-unsloth.toml"));
    expect(form.cloud.enabled).toBe(true);
    expect(form.cloud.provider).toBe("minimax");
    expect(form.cloud.modelId).toBe("MiniMax-M3");
    expect(form.locals.unsloth.enabled).toBe(true);
    expect(form.locals.unsloth.baseUrl).toBe("http://127.0.0.1:8888/v1");
    expect(form.locals.unsloth.modelId).toBe("unsloth/gemma-4-E4B-it-GGUF");
    expect(form.locals.lmstudio.enabled).toBe(false);
    expect(form.cloud.apiKey).toBe("");
    expect(form.locals.unsloth.apiKey).toBe("");
  });

  it("leaves local ticks off for MiniMax-only toml", () => {
    const form = formFromToml(load("minimax-only.toml"));
    expect(form.cloud.enabled).toBe(true);
    expect(form.locals.unsloth.enabled).toBe(false);
    expect(form.locals.lmstudio.enabled).toBe(false);
  });

  it("ticks Unsloth from an Unsloth-only deploy", () => {
    const form = formFromToml(load("unsloth-only.toml"));
    expect(form.cloud.enabled).toBe(false);
    expect(form.locals.unsloth.enabled).toBe(true);
    expect(form.locals.unsloth.modelId).toBe("unsloth/gemma-4-E4B-it-GGUF");
  });

  it("keeps a maskclaw auto-route id from toml", () => {
    const toml = load("minimax-unsloth.toml").replace('id = "switchyard"', 'id = "maskclaw"');
    expect(formFromToml(toml).smartRouteId).toBe("maskclaw");
  });

  it("defaults MaskClaw forms to routes.smart id maskclaw, not switchyard", () => {
    expect(defaultSetupForm().smartRouteId).toBe("switchyard");
    expect(maskclawSetupForm().smartRouteId).toBe("maskclaw");
    expect(maskclawSmartRouteId("")).toBe("maskclaw");
    expect(maskclawSmartRouteId("switchyard")).toBe("maskclaw");
    expect(maskclawSmartRouteId("custom-smart")).toBe("custom-smart");
    expect(formFromToml("", maskclawSetupForm()).smartRouteId).toBe("maskclaw");
  });
});

describe("applySetupSlice", () => {
  it("saves cloud or local without overwriting the other half", () => {
    const saved = formFromToml(load("minimax-unsloth.toml"));
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
    expect(afterLocal.smartRouteId).toBe("switchyard");
  });
});

describe("mergeSetupState", () => {
  it("keeps a draft tick even when toml has not been rewritten yet", () => {
    const fromToml = formFromToml(load("minimax-only.toml"));
    const draft = defaultSetupForm();
    draft.locals.unsloth.enabled = true;
    draft.locals.unsloth.apiKey = "sk-unsloth-keep";
    const merged = mergeSetupState(fromToml, draft, {});
    expect(merged.locals.unsloth.enabled).toBe(true);
    expect(merged.locals.unsloth.apiKey).toBe("sk-unsloth-keep");
  });

  it("fills empty key fields from Credential Manager values", () => {
    const fromToml = formFromToml(load("minimax-unsloth.toml"));
    const merged = applyStoredSecrets(fromToml, {
      MINIMAX_API_KEY: "sk-cloud-stored",
      UNSLOTH_API_KEY: "sk-unsloth-stored",
    });
    expect(merged.cloud.apiKey).toBe("sk-cloud-stored");
    expect(merged.locals.unsloth.apiKey).toBe("sk-unsloth-stored");
  });

  it("does not show dummy local placeholders as saved keys", () => {
    const fromToml = formFromToml(load("unsloth-only.toml"));
    const merged = applyStoredSecrets(fromToml, { UNSLOTH_API_KEY: "local" });
    expect(merged.locals.unsloth.apiKey).toBe("");
  });
});

describe("setup draft + persistable secrets", () => {
  it("round-trips ticks through the draft store", () => {
    const form = defaultSetupForm();
    form.locals.unsloth.enabled = true;
    writeSetupDraft(form);
    expect(readSetupDraft()?.locals.unsloth.enabled).toBe(true);
  });

  it("persists typed keys even before the local row is ticked", () => {
    const form = defaultSetupForm();
    form.locals.unsloth.enabled = false;
    form.locals.unsloth.apiKey = "sk-unsloth-typed";
    expect(secretsToPersist(form)).toEqual([
      { envName: "UNSLOTH_API_KEY", value: "sk-unsloth-typed" },
    ]);
  });
});
