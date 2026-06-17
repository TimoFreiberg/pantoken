// Pure helpers for the Settings panel's provider + favorites logic, kept out of
// pi-driver so they're unit-testable without the pi SDK. No pi imports here — just
// the small shapes the driver feeds in.

import type { ProviderInfo } from "@pilot/protocol";

/** Providers pilot offers a plain API-key field for. Mirrors pi-gui's curated
 *  DESKTOP_API_KEY set: providers whose creds are just an API key (no OAuth dance,
 *  no external/CLI-managed config). Everything else is shown only if already authed. */
export const API_KEY_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "azure-openai-responses",
  "cerebras",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

export function apiKeySetupSupported(providerId: string): boolean {
  return API_KEY_PROVIDER_IDS.has(providerId);
}

/** The minimal shapes we read off pi's AuthStorage / ModelRegistry. */
export interface AuthCred {
  readonly type: "oauth" | "api_key";
}
export interface AuthStatusLike {
  readonly configured: boolean;
  readonly source?: string;
}
export interface ModelLike {
  readonly provider: string;
  readonly id: string;
}

/** Classify where a provider's working credential comes from, so the UI knows whether
 *  it can be removed here (auth_file) or is owned elsewhere (env/external/oauth).
 *  Ported from pi-gui's `inferProviderAuthSource`. */
export function inferAuthSource(
  auth: AuthCred | undefined,
  status: AuthStatusLike,
  keySetupSupported: boolean,
): ProviderInfo["authSource"] {
  if (auth?.type === "oauth") return "oauth";
  if (auth?.type === "api_key") return "auth_file";
  switch (status.source) {
    case "stored":
      return "auth_file";
    case "environment":
      return "env";
    case "fallback":
    case "models_json_command":
    case "models_json_key":
    case "runtime":
      return "external";
  }
  if (!status.configured) return "none";
  return keySetupSupported ? "env" : "external";
}

/** A favorites pattern (pi's `enabledModels` / `--models` format) matched against one
 *  concrete model. We accept the forms pilot writes (`provider/modelId`) plus the
 *  common CLI-authored ones (`provider:modelId`, bare `modelId`, `provider/*`). We do
 *  NOT do pi's broad substring/fuzzy match — being strict here avoids a CLI pattern
 *  silently over-selecting models in the GUI; an unmatched fuzzy pattern just won't
 *  show as favorited until re-picked. */
export function patternMatchesModel(
  pattern: string,
  provider: string,
  modelId: string,
): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === `${provider}/${modelId}`) return true;
  if (p === `${provider}:${modelId}`) return true;
  if (p === modelId) return true;
  if (p.endsWith("/*") && p.slice(0, -2) === provider) return true;
  return false;
}

/** Resolve stored favorites patterns to the concrete `provider:modelId` refs among the
 *  currently-available models — what the client filters the picker by. */
export function resolveFavorites(
  patterns: readonly string[] | undefined,
  available: readonly ModelLike[],
): string[] {
  if (!patterns || patterns.length === 0) return [];
  const refs: string[] = [];
  for (const m of available) {
    if (patterns.some((p) => patternMatchesModel(p, m.provider, m.id)))
      refs.push(`${m.provider}:${m.id}`);
  }
  return refs;
}

/** Compute the new `enabledModels` patterns to persist when the GUI sets favorites.
 *  Selected refs (`provider:modelId`) are stored as pi's `provider/modelId` form.
 *  Existing patterns that DON'T resolve to any currently-available model are preserved
 *  — that keeps CLI-authored globs (`anthropic/*`) and favorites for offline providers
 *  from being silently dropped when the GUI rewrites the set. Patterns that DO resolve
 *  to an available model are replaced by the explicit selection (the documented
 *  glob-flattening trade-off). Returns undefined when the result is empty, which clears
 *  pi's filter (all models enabled) rather than persisting an empty array. */
export function mergeFavoritePatterns(
  existing: readonly string[] | undefined,
  selectedRefs: readonly string[],
  available: readonly ModelLike[],
): string[] | undefined {
  const preserved = (existing ?? []).filter(
    (p) => !available.some((m) => patternMatchesModel(p, m.provider, m.id)),
  );
  const selected = selectedRefs
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => ref.replace(":", "/")); // provider:modelId -> provider/modelId
  const next = [...new Set([...preserved, ...selected])];
  return next.length > 0 ? next : undefined;
}
