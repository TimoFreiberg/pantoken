// Client-side auth token handling. A token can arrive via `?token=…` (handy for a
// one-tap link), which we persist to localStorage and then scrub from the URL so it
// doesn't linger in history. Sent to the server in the WS hello.

const KEY = "pilot_token";

export function getToken(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    localStorage.setItem(KEY, fromUrl);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString());
    return fromUrl;
  }
  return localStorage.getItem(KEY);
}

export function setToken(t: string): void {
  localStorage.setItem(KEY, t.trim());
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}
