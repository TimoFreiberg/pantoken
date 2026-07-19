// Pure URL resolution for the WebSocket connection target. Split out of
// `ws.svelte.ts` so it's unit-testable without the Svelte rune preprocessor
// (which `$state` at module scope requires).
//
// Precedence:
//   1. `envOverride` (VITE_PANTOKEN_WS_URL) — dev/test pin.
//   2. `?ws=` query param — the desktop points the browser at the bridge on
//      a loopback port (e.g. `?ws=ws://127.0.0.1:9999`). RESTRICTED to
//      loopback hosts (127.0.0.1 / localhost) so a compromised hub page,
//      dev-tools-injected script, or future XSS can't redirect the WS to an
//      attacker and exfiltrate `ClientMessage`s (which carry auth tokens via
//      `getToken()` and prompt content).
//   3. Default derivation: `${ws|wss}//${location.host}/ws`.

export function resolveWsUrl(
  location: { protocol: string; host: string; search: string },
  envOverride?: string,
): string {
  if (envOverride) return envOverride;
  const params = new URLSearchParams(location.search);
  const wsOverride = params.get("ws");
  if (wsOverride) {
    // Security: only allow loopback WS overrides. The desktop points the
    // browser at the bridge on 127.0.0.1/localhost. A crafted ?ws= pointing
    // elsewhere (e.g. ws://attacker.com/ws) would exfiltrate the entire
    // protocol stream including auth tokens and prompt content.
    try {
      const parsed = new URL(wsOverride);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        return wsOverride;
      }
    } catch {
      // Not a parseable URL — fall through to default derivation.
    }
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
