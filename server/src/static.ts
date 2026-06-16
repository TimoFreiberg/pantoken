// Serve the built Svelte client (client/dist) so prod is a single process. In dev
// this is unused — Vite serves the client and proxies /ws + /debug here.

import { join, normalize } from "node:path";
import { config } from "./config.js";

export async function serveStatic(pathname: string): Promise<Response | null> {
  // strip leading slash + defuse path traversal
  const rel = normalize(pathname).replace(/^([/\\]|\.\.[/\\])+/, "");
  const requested = Bun.file(join(config.clientDist, rel || "index.html"));
  if (await requested.exists()) return new Response(requested);

  // SPA fallback to index.html for client-side routes
  const index = Bun.file(join(config.clientDist, "index.html"));
  if (await index.exists()) return new Response(index);

  return null; // no build present (dev) — caller returns a hint
}
