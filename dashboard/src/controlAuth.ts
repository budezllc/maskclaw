import type { IncomingMessage } from "node:http";

export const DEV_CONTROL_HEADER = "X-MaskClaw-Dev-Token";

export function authorizeControlRequest(
  pathname: string,
  headers: IncomingMessage["headers"],
  expectedToken: string,
): boolean {
  if (!expectedToken) {
    return true;
  }
  if (pathname === "/control/health") {
    return true;
  }
  const raw = headers[DEV_CONTROL_HEADER.toLowerCase()];
  const token = Array.isArray(raw) ? raw[0] : raw;
  return token === expectedToken;
}
