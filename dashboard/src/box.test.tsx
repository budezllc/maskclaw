import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { BoxPage, LoginScreen, SetupPasswordScreen } from "./components/BoxPage";
import type { HostNetwork } from "./api";

afterEach(() => {
  cleanup();
});

const network: HostNetwork = {
  hostname: "maskclaw",
  addresses: ["192.168.1.20"],
  wifiAvailable: true,
  interfaces: [
    { name: "eth0", type: "ethernet", state: "connected", connected: true, ip: "192.168.1.20" },
    { name: "wlan0", type: "wifi", state: "disconnected", connected: false, ip: null },
  ],
  wifi: {
    available: true,
    radioOn: true,
    connectedSsid: null,
    networks: [{ ssid: "Office", signal: 80, security: "WPA2" }],
  },
  active: { device: "eth0", type: "ethernet" },
};

describe("Box page", () => {
  it("sets a dashboard password and joins wifi", () => {
    const onSetPassword = vi.fn();
    const onWifi = vi.fn();
    const onEthernet = vi.fn();
    const onSetHostname = vi.fn();
    render(
      <BoxPage
        session={{ ok: true, passwordSet: false, loggedIn: false }}
        network={network}
        busy={false}
        onSetPassword={onSetPassword}
        onLogout={() => {}}
        onSetHostname={onSetHostname}
        onEthernet={onEthernet}
        onWifi={onWifi}
      />,
    );
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correcthorse" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(onSetPassword).toHaveBeenCalledWith("correcthorse", undefined);

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "office-pi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save hostname" }));
    expect(onSetHostname).toHaveBeenCalledWith("office-pi");

    fireEvent.click(screen.getByRole("button", { name: "Use Ethernet" }));
    expect(onEthernet).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("Wi-Fi network"), { target: { value: "Office" } });
    fireEvent.change(screen.getByLabelText("Wi-Fi password"), { target: { value: "psk" } });
    fireEvent.click(screen.getByRole("button", { name: "Join Wi-Fi" }));
    expect(onWifi).toHaveBeenCalledWith("Office", "psk");

    const ca = screen.getByRole("link", { name: "Download CA" });
    expect(ca.getAttribute("href")).toBe("/host/ca.crt");
    expect(ca.getAttribute("download")).toBe("maskclaw-caddy-root.crt");
    expect(screen.getByText(/Trusted Root Certification Authorities/)).toBeTruthy();
    expect(screen.getByText(/Automatically select the certificate store/)).toBeTruthy();
    expect(screen.getByText(/certutil -addstore/)).toBeTruthy();
  });

  it("shows a login screen that submits the password", () => {
    const onLogin = vi.fn();
    render(<LoginScreen busy={false} error={null} onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correcthorse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onLogin).toHaveBeenCalledWith("correcthorse");
  });

  it("shows a setup screen that requires token and eight characters", () => {
    const onSetPassword = vi.fn();
    render(<SetupPasswordScreen busy={false} error={null} onSetPassword={onSetPassword} />);
    const submit = screen.getByRole("button", { name: "Set password" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correcthorse" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "bootstrap-token" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSetPassword).toHaveBeenCalledWith("correcthorse", "bootstrap-token");
  });
});
