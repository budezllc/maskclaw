/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupForm } from "../../lib/setupTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveSetup = vi.fn<(form: SetupForm) => Promise<{ engine_flavor: string }>>(async () => ({
  engine_flavor: "maskclaw",
}));

vi.mock("../../api", () => ({
  loadSetupSecrets: async () => ({}),
  persistSecrets: async () => undefined,
  probeBackend: async () => ({
    url: "",
    ok: false,
    label: "Not running",
    detail: "down",
    models: [] as string[],
  }),
  saveSetup: (form: SetupForm) => saveSetup(form),
}));

import { MaskClawModels } from "./MaskClawModels";

const TOML = `schema_version = 1

[llm_clients.minimax]
format = "openai_chat"
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[targets.strong]
id = "MiniMax-M3"
llm_client = "minimax"
`;

describe("MaskClawModels", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
    saveSetup.mockClear();
  });

  async function renderPage() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<MaskClawModels configToml={TOML} onChange={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("shows cloud and local on tabs, and saves each half separately", async () => {
    await renderPage();
    expect(host?.textContent).toContain("MODELS");
    expect(host?.textContent).not.toMatch(/step 1 of 2/i);
    const cloudTab = [...(host?.querySelectorAll('[role="tab"]') ?? [])];
    expect(cloudTab.map((tab) => tab.textContent)).toEqual(["Cloud", "Local"]);
    expect(host?.querySelector(".mc-save")).toBeTruthy();
    const provider = host?.querySelector('[aria-label="Provider"]') as HTMLSelectElement;
    expect(provider).toBeTruthy();
    expect(provider.tagName).toBe("SELECT");
    expect([...provider.options].map((option) => option.textContent)).toEqual([
      "MiniMax",
      "OpenRouter",
      "OpenAI",
      "Anthropic",
      "Custom",
    ]);
    await act(async () => {
      provider.value = "openrouter";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((host?.querySelector("#cloud-url") as HTMLInputElement)?.value).toContain("openrouter.ai");
    expect(host?.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => {
      provider.value = "minimax";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host?.textContent).toContain("List models");
    expect(host?.textContent).toContain("Test");
    expect(host?.textContent).toContain("Save each provider separately");
    expect(host?.textContent).not.toMatch(/China endpoint/i);
    expect([...host!.querySelectorAll("button")].some((btn) => btn.textContent === "Start")).toBe(false);

    await act(async () => {
      (cloudTab.find((tab) => tab.textContent === "Local") as HTMLButtonElement).click();
    });
    expect(host?.textContent).toContain("Unsloth");
    expect(host?.textContent).toContain("LM Studio");
    expect(host?.textContent).toContain("Gemma / Ollama");
    expect((host?.querySelector("#unsloth-address") as HTMLInputElement).value).toBe("http://127.0.0.1:8888/v1");
    await act(async () => {
      (host?.querySelector('[aria-label="Unsloth"]') as HTMLInputElement).click();
    });
    await act(async () => {
      ([...host!.querySelectorAll("button")].find((btn) => btn.textContent === "Save local") as HTMLButtonElement).click();
    });
    expect(saveSetup).toHaveBeenCalledOnce();
    const savedLocal = saveSetup.mock.calls[0][0];
    expect(savedLocal.cloud.modelId).toBe("MiniMax-M3");
    expect(savedLocal.locals.unsloth.enabled).toBe(true);
    expect(savedLocal.smartRouteId).toBe("maskclaw");

    await act(async () => {
      ([...host!.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Cloud") as HTMLButtonElement).click();
    });
    await act(async () => {
      ([...host!.querySelectorAll("button")].find((btn) => btn.textContent === "Save cloud") as HTMLButtonElement).click();
    });
    expect(saveSetup).toHaveBeenCalledTimes(2);
    const savedCloud = saveSetup.mock.calls[1][0];
    expect(savedCloud.cloud.modelId).toBe("MiniMax-M3");
    expect(savedCloud.locals.unsloth.enabled).toBe(true);
    expect(savedCloud.smartRouteId).toBe("maskclaw");
  });
});
