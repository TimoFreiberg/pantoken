// Client authentication boundary. Persistent bearer credentials are accepted only
// from the dedicated /bootstrap exchange (or deliberate manual recovery entry).
const KEY = "pantoken_token";

export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function captureBootstrapCredential(
  url: URL,
): { credential: string | null; scrubbedUrl: string | null } {
  if (url.pathname !== "/bootstrap") return { credential: null, scrubbedUrl: null };
  const credential = url.searchParams.get("credential");
  if (!credential) return { credential: null, scrubbedUrl: null };
  url.searchParams.delete("credential");
  return { credential, scrubbedUrl: url.toString() };
}

/** Compatibility-only pure helper retained for existing recovery tests. Runtime auth
 * never calls it, so ordinary query tokens are not accepted by the application flow. */
export function captureTokenFromUrl(
  url: URL,
  kv: Pick<TokenStore, "getItem" | "setItem">,
): { token: string | null; scrubbedUrl: string | null } {
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    kv.setItem(KEY, fromUrl);
    url.searchParams.delete("token");
    return { token: fromUrl, scrubbedUrl: url.toString() };
  }
  return { token: kv.getItem(KEY), scrubbedUrl: null };
}

export function getToken(): string | null {
  const token = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  return token && token.trim() ? token : null;
}

export function setToken(token: string): void {
  localStorage.setItem(KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}

export async function exchangeBootstrapCredential(
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher("/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("bootstrap exchange failed");
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) throw new Error("bootstrap exchange failed");
  setToken(body.token);
  return body.token;
}

export async function bootstrapFromCurrentUrl(
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  if (typeof location === "undefined") return null;
  const result = captureBootstrapCredential(new URL(location.href));
  if (!result.credential) return getToken();
  // Scrub before network activity so a failed exchange cannot leak the setup URL.
  if (result.scrubbedUrl && typeof history !== "undefined") {
    history.replaceState(null, "", result.scrubbedUrl);
  }
  return exchangeBootstrapCredential(result.credential, fetcher);
}

export function authenticatedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}
