import { describe, expect, it } from "vitest";
import { applianceClientBaseUrls, clientBaseUrls, pickLanIpv4 } from "./clientTarget";
import type { HostNetwork } from "./api";

const network: HostNetwork = {
  hostname: "maskclaw",
  addresses: ["192.168.68.138", "fd33::1"],
  wifiAvailable: false,
  interfaces: [],
  wifi: { available: false, radioOn: false, connectedSsid: null, networks: [] },
  active: null,
};

describe("clientTarget", () => {
  it("picks the first LAN IPv4", () => {
    expect(pickLanIpv4(network.addresses)).toBe("192.168.68.138");
    expect(pickLanIpv4(["127.0.0.1", "10.0.0.5"])).toBe("10.0.0.5");
  });

  it("shows maskclaw.local with IP alternate on appliance", () => {
    const urls = applianceClientBaseUrls(network);
    expect(urls.baseUrl).toBe("http://maskclaw.local");
    expect(urls.baseUrlV1).toBe("http://maskclaw.local/v1");
    expect(urls.alternateBaseUrl).toBe("http://192.168.68.138");
    expect(urls.alternateBaseUrlV1).toBe("http://192.168.68.138/v1");
  });

  it("keeps engine listen URL for local sidecar", () => {
    const urls = clientBaseUrls({
      surface: "local",
      listenUrl: "http://127.0.0.1:4000",
      hostNetwork: network,
    });
    expect(urls.baseUrl).toBe("http://127.0.0.1:4000");
    expect(urls.baseUrlV1).toBe("http://127.0.0.1:4000/v1");
    expect(urls.alternateBaseUrl).toBeNull();
  });

  it("uses custom hostname for .local on appliance", () => {
    const urls = applianceClientBaseUrls({ ...network, hostname: "pi-lab" });
    expect(urls.baseUrl).toBe("http://pi-lab.local");
  });
});
