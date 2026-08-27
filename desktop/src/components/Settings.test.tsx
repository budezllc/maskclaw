/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveRawMaskclawToml = vi.fn<(toml: string) => Promise<AppSnapshot>>();

vi.mock("../api", () => ({
  saveRawMaskclawToml: (toml: string) => saveRawMaskclawToml(toml),
  saveRawToml: async () => undefined,
  setAutostart: async () => undefined,
  setTelemetryOptIn: async () => undefined,
}));

import { Settings } from "./Settings";

const MASKCLAW_TOML = `[detectors]
email = true
phone = true
ssn = true
credit_card = true
jwt = true
aws_key = true
api_key = true
`;

const snap: AppSnapshot = {
  needs_setup: false,
  listen_url: "http://127.0.0.1:4000",
  engine_state: "running",
  last_error: null,
  telemetry_opt_in: false,
  autostart: true,
  engine_flavor: "maskclaw",
  config_toml: "schema_version = 1\n",
  maskclaw_toml: MASKCLAW_TOML,
  logs: [],
  routing_tail: [],
};

describe("Settings detectors", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
    saveRawMaskclawToml.mockReset();
  });

  function mount(node: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(node);
    });
  }

  it("uses appliance-style switches that persist a single toggle", async () => {
    saveRawMaskclawToml.mockImplementation(async (toml) => ({
      ...snap,
      maskclaw_toml: toml,
    }));
    const onChange = vi.fn();
    mount(<Settings snap={snap} onChange={onChange} surface="maskclaw" />);
    expect(host?.textContent).not.toContain("Switchyard telemetry");
    expect(host?.textContent).not.toContain("MaskClaw telemetry");
    expect(host?.querySelector('input[type="checkbox"][role="switch"]')).toBeNull();
    const email = host?.querySelector("#detector-email") as HTMLButtonElement;
    expect(email.tagName).toBe("BUTTON");
    expect(email.getAttribute("role")).toBe("switch");
    expect(email.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      email.click();
      email.click();
    });
    expect(saveRawMaskclawToml).toHaveBeenCalledTimes(1);
    expect(saveRawMaskclawToml.mock.calls[0][0]).toContain("email = false");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(email.getAttribute("aria-checked")).toBe("false");
  });
});
