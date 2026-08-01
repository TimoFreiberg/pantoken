export type RemoteAccessStatusCode =
  | "disabled"
  | "missing-token"
  | "endpoint-unverified"
  | "serve-not-configured"
  | "wrong-target"
  | "hub-unavailable"
  | "authentication-failure"
  | "ready";

export interface RemoteAccessStatus {
  code: RemoteAccessStatusCode;
  origin: string | null;
  port: number;
  detail: string;
}

const DETAILS: Record<RemoteAccessStatusCode, string> = {
  disabled: "Phone access is disabled.",
  "missing-token": "Unlock Keychain or enable phone access on the Mac.",
  "endpoint-unverified": "Verify the configured private HTTPS origin.",
  "serve-not-configured": "Configure Tailscale Serve to proxy the loopback port.",
  "wrong-target": "The origin reached a different service.",
  "hub-unavailable": "The Pantoken hub is unavailable; retry after it starts.",
  "authentication-failure": "The endpoint rejected Pantoken authentication.",
  ready: "Phone access is ready over the private endpoint.",
};

export function formatRemoteAccessStatus(
  code: RemoteAccessStatusCode,
  origin: string | null,
  port: number,
): RemoteAccessStatus {
  return { code, origin: origin ? redactOrigin(origin) : null, port, detail: DETAILS[code] };
}

export function redactOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return "configured HTTPS origin";
  }
}
