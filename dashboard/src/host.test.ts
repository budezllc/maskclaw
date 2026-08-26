import { describe, expect, it, vi } from "vitest";
import {
  connectEthernet,
  connectWifi,
  fetchHostNetwork,
  fetchHostSession,
  hostLogin,
  setDashboardPassword,
  setHostname,
} from "./api";

describe("host api", () => {
  it("treats a 401 session as locked", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, passwordSet: true, loggedIn: false }), { status: 401 }),
    );
    await expect(fetchHostSession(fetcher as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      passwordSet: true,
      loggedIn: false,
    });
  });

  it("posts login and password with JSON bodies", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/host/login") {
        return new Response(JSON.stringify({ ok: true, passwordSet: true, loggedIn: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "invalid password" }), { status: 401 });
    });
    await expect(hostLogin("correcthorse", fetcher as unknown as typeof fetch)).resolves.toMatchObject({
      loggedIn: true,
    });
    await expect(setDashboardPassword("newhorse1", "wrong", fetcher as unknown as typeof fetch)).rejects.toThrow(
      /invalid password/,
    );
  });

  it("reads network and writes hostname and links", async () => {
    const network = {
      hostname: "office-pi",
      addresses: ["192.168.1.20"],
      wifiAvailable: true,
      interfaces: [],
      wifi: { available: true, radioOn: true, connectedSsid: null, networks: [] },
      active: null,
    };
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (!init || init.method === "GET") {
        return new Response(JSON.stringify(network), { status: 200 });
      }
      return new Response(JSON.stringify({ ...network, hostname: "office-pi" }), { status: 200 });
    });
    await expect(fetchHostNetwork(fetcher as unknown as typeof fetch)).resolves.toMatchObject({ hostname: "office-pi" });
    await expect(setHostname("office-pi", fetcher as unknown as typeof fetch)).resolves.toMatchObject({
      hostname: "office-pi",
    });
    await expect(connectEthernet(fetcher as unknown as typeof fetch)).resolves.toBeTruthy();
    await expect(connectWifi("Office", "psk", fetcher as unknown as typeof fetch)).resolves.toBeTruthy();
    const wifiCall = fetcher.mock.calls.find((call) => call[0] === "/host/network/wifi");
    expect(wifiCall?.[1]).toMatchObject({ method: "POST" });
  });
});
