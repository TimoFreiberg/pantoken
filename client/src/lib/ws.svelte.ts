// Compatibility delegation layer: the module-level WS singleton.
//
// The transport logic now lives in `WsClient` (ws-client.svelte.ts). This
// module preserves the existing exports by delegating to a single `WsClient`
// instance, so all current importers (store, pull-to-refresh, delivery) work
// unchanged. In single-host mode (browser/e2e), this singleton IS the active
// connection. In multi-host mode (stage 4+), the coordinator wraps additional
// `WsClient` instances for remote hosts.

import { type ClientMessage, type ResumeToken, type ServerMessage } from "@pantoken/protocol";
import { WsClient, type ConnectionState, type IWsClient, type MessageListener } from "./ws-client.svelte.js";
import { resolveWsUrl } from "./ws-url.js";

const defaultClient = new WsClient(() =>
  resolveWsUrl(window.location, import.meta.env.VITE_PANTOKEN_WS_URL),
);
defaultClient.isCompatibilitySingleton = true;

/** The compatibility singleton WsClient instance. Exported so the
 *  HostCoordinator can return it as the `selectedClient` when the local host
 *  is selected — the local host's messages flow through this singleton (wired
 *  by store.start()), not through a coordinator-created WsClient. */
export const compatibilityClient: IWsClient = defaultClient;

export function connectionState(): ConnectionState {
  return defaultClient.connectionState();
}
export function reconnectAttempts(): number {
  return defaultClient.reconnectAttempts();
}
export function connect(): void {
  defaultClient.connect();
}
export function forceReconnect(): void {
  defaultClient.forceReconnect();
}
export function send(msg: ClientMessage): boolean {
  return defaultClient.send(msg);
}
export function disconnect(): void {
  defaultClient.disconnect();
}
export function setResumeProvider(fn: (() => ResumeToken | null) | null): void {
  defaultClient.setResumeProvider(fn);
}
export function onMessage(listener: MessageListener): () => void {
  return defaultClient.onMessage(listener);
}

export { resolveWsUrl } from "./ws-url.js";
export type { ConnectionState } from "./ws-client.svelte.js";
export type { ServerMessage } from "@pantoken/protocol";
