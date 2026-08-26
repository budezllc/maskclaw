import type { HostNetwork } from "@/api";
import type { Surface } from "@/surface";

export type ClientBaseUrls = {
  baseUrl: string;
  baseUrlV1: string;
  alternateBaseUrl: string | null;
  alternateBaseUrlV1: string | null;
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function isIpv4(address: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);
}

/** Pick the first non-loopback IPv4 LAN address from hostd network info. */
export function pickLanIpv4(addresses: string[] | undefined): string | null {
  if (!addresses?.length) {
    return null;
  }
  for (const address of addresses) {
    if (!isIpv4(address) || address.startsWith("127.")) {
      continue;
    }
    return address;
  }
  return null;
}

/** URLs OpenAI-compatible clients on the LAN should use (via Caddy :80, not engine :4000). */
export function applianceClientBaseUrls(hostNetwork: HostNetwork | null): ClientBaseUrls {
  const hostname = hostNetwork?.hostname?.trim() || "maskclaw";
  const primary = `http://${hostname}.local`;
  const lanIp = pickLanIpv4(hostNetwork?.addresses);
  const alternate = lanIp ? `http://${lanIp}` : null;
  return {
    baseUrl: primary,
    baseUrlV1: `${primary}/v1`,
    alternateBaseUrl: alternate,
    alternateBaseUrlV1: alternate ? `${alternate}/v1` : null,
  };
}

export function clientBaseUrls(opts: {
  surface: Surface;
  listenUrl: string;
  hostNetwork: HostNetwork | null;
}): ClientBaseUrls {
  if (opts.surface === "appliance") {
    return applianceClientBaseUrls(opts.hostNetwork);
  }
  const base = stripTrailingSlash(opts.listenUrl);
  return {
    baseUrl: base,
    baseUrlV1: `${base}/v1`,
    alternateBaseUrl: null,
    alternateBaseUrlV1: null,
  };
}
