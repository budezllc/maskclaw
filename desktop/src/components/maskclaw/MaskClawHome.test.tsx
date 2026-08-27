/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaskClawHome } from "./MaskClawHome";
import { adaptStats } from "../../lib/statsAdapter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MaskClawHome", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
  });

  function mount(node: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(node);
    });
  }

  it("matches the appliance HOME board minus BOX-only copy", () => {
    mount(
      <MaskClawHome
        listenUrl="http://127.0.0.1:4000"
        logs={['{"model":"maskclaw"}']}
        lastError={null}
        stats={adaptStats({
          total_requests: 10,
          total_errors: 0,
          models: { "qwen2.5-coder-7b": { calls: 10, errors: 0, model_call_latency: { avg_ms: 450 } } },
        })}
        routes={[
          {
            id: "lmstudio-local",
            track: "01",
            displayName: "lmstudio-local",
            contextWindow: null,
            streaming: true,
            toolCalling: false,
          },
        ]}
        modelsPayload={{ default_model: "maskclaw" }}
        backendIdsByRoute={{ "lmstudio-local": ["qwen2.5-coder-7b"] }}
        engineUp={true}
        probes={[]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={() => {}}
      />,
    );
    expect(host?.textContent).toContain("HOME");
    expect(host?.textContent).toContain("Engine live");
    expect(host?.textContent).toContain("Stop");
    expect(host?.textContent).not.toContain("Start");
    expect(host?.textContent).toContain("Test connections");
    expect(host?.textContent).not.toContain("Probe backends");
    const clientToggle = [...host!.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Client target"),
    ) as HTMLButtonElement;
    expect(clientToggle.getAttribute("aria-expanded")).toBe("false");
    expect(host?.textContent).not.toContain("Base URL v1");
    act(() => {
      clientToggle.click();
    });
    expect(clientToggle.getAttribute("aria-expanded")).toBe("true");
    expect(host?.textContent).toContain("OpenAI-compatible client");
    expect(host?.textContent).toContain("Base URL v1");
    expect(host?.textContent).toContain("lmstudio-local");
    expect(host?.textContent).toContain("qwen2.5-coder-7b");
  });

  it("lets connection results be dismissed", () => {
    const onDismiss = vi.fn();
    mount(
      <MaskClawHome
        listenUrl="http://127.0.0.1:4000"
        logs={[]}
        lastError={null}
        stats={null}
        routes={[]}
        modelsPayload={null}
        backendIdsByRoute={{}}
        engineUp={false}
        probes={[{ url: "http://127.0.0.1:1234/v1", ok: false, label: "Not running", detail: "down", models: [] }]}
        busy={false}
        resetting={false}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onReset={() => {}}
        onProbe={() => {}}
        onDismissProbes={onDismiss}
      />,
    );
    expect(host?.textContent).toContain("Engine down");
    const dismiss = host!.querySelector('[aria-label="Dismiss connection results"]') as HTMLButtonElement;
    act(() => {
      dismiss.click();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
