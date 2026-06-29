// Resolve the "background model" setting to a concrete model + thinking level, with a
// loud `warning` channel for bad specs. Used by pilot's Settings validation against the
// cached available-models list. Pure (the only side-effecting path is `script:`, which
// spawns a user-supplied resolver script) so it can be unit-tested with a hand-rolled
// fake registry.

import { spawnSync } from "node:child_process";

/** The resolved background model. `model` is undefined when the spec is unset (null) or
 *  doesn't resolve to a registered model. `warning` is a human-readable note the Settings
 *  UI surfaces (red): a FATAL warning (no `model`) means the spec didn't resolve; a
 *  NON-FATAL warning (alongside a resolved `model`) means the model resolved but
 *  something is off (e.g. an invalid `:thinking` suffix was dropped). `model` and
 *  `warning` CAN both be set (non-fatal case); a fatal warning stands alone. */
export interface ResolvedBackgroundModel {
  /** The matched model object (carries provider/id/name/...), or undefined. Opaque to
   *  pilot — callers hand it straight to the agent's stream API. */
  model?: unknown;
  /** thinking level (`off`|`minimal`|`low`|`medium`|`high`|`xhigh`) when one was
   *  parsed from a `:thinking` suffix, else undefined (use the model/provider default). */
  thinkingLevel?: string;
  /** Note channel surfaced to the Settings UI. FATAL (no `model`): the spec didn't
   *  resolve. NON-FATAL (with `model`): the model resolved but something's off (e.g. an
   *  invalid `:thinking` level was dropped). undefined when the spec is unset or
   *  resolved cleanly. */
  warning?: string;
}

/** A read-only slice of a model registry — the only matching primitive the resolver
 *  needs. Declared locally so unit tests can pass a hand-rolled fake without constructing
 *  a real registry (which wants an AuthStorage + models.json). */
export interface BackgroundModelRegistry {
  /** Models with working credentials (the ones actually usable). */
  getAvailable(): readonly ModelLike[];
}

/** The model fields the matcher reads. A loose structural slice so pilot doesn't couple
 *  to the full model shape. `name` is optional because custom/user models may omit it. */
export interface ModelLike {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

/** The thinking-level ladder (incl. `off`). A spec's `:thinking` suffix must be one of
 *  these or it's a warning. Pilot's Settings DEFAULT_THINKING_LEVELS is the same set. */
const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Prefix marking a spec as a script to run (its stdout is then parsed as a spec).
 *  Lets an operator keep their own resolver. */
const SCRIPT_PREFIX = "script:";

/** A model id is an "alias" (stable, e.g. `claude-sonnet-4-5`) rather than a dated
 *  version (`claude-sonnet-4-5-20250929`) or a `-latest` tag. Aliases are preferred
 *  when a bare-id pattern matches several versions. */
function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

/** Find an exact model reference match. Supports either a bare model id or a canonical
 *  `provider/modelId` reference. Bare-id matches are rejected when ambiguous across
 *  providers (so a bare `gpt-4` that two providers ship resolves to nothing, not a
 *  silent pick). */
function findExactModelReferenceMatch(
  reference: string,
  models: readonly ModelLike[],
): ModelLike | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();

  // Canonical `provider/id` exact match.
  const canonical = models.filter(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === lower,
  );
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined; // ambiguous

  // `provider/id` with different casing/components.
  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const provider = trimmed.slice(0, slash).trim();
    const modelId = trimmed.slice(slash + 1).trim();
    if (provider && modelId) {
      const pm = models.filter(
        (m) =>
          m.provider.toLowerCase() === provider.toLowerCase() &&
          m.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (pm.length === 1) return pm[0];
      if (pm.length > 1) return undefined;
    }
  }

  // Bare id exact match (ambiguous across providers → reject).
  const byId = models.filter((m) => m.id.toLowerCase() === lower);
  return byId.length === 1 ? byId[0] : undefined;
}

/** Match a pattern to a model: exact reference first, then a partial (id-or-name)
 *  substring match preferring aliases over dated versions. */
function tryMatchModel(
  pattern: string,
  models: readonly ModelLike[],
): ModelLike | undefined {
  const exact = findExactModelReferenceMatch(pattern, models);
  if (exact) return exact;

  const lower = pattern.toLowerCase();
  const matches = models.filter(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      m.name?.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((m) => isAlias(m.id));
  const dated = matches.filter((m) => !isAlias(m.id));
  const pool = aliases.length > 0 ? aliases : dated;
  // Highest-sorting id wins (aliases: the alias itself; dated: the latest date).
  pool.sort((a, b) => b.id.localeCompare(a.id));
  return pool[0];
}

/** Parse a `provider/model[:thinking]` spec against the available models. Returns
 *  `{model, thinkingLevel}` on a clean resolve, `{model, warning}` when the model resolves
 *  but a `:thinking` suffix was invalid (dropped — non-fatal), or `{warning}` (no model)
 *  when the spec doesn't resolve (a fatal warning so the operator sees a bad spec;
 *  `null`/unset is the only true no-op). */
function parseSpec(
  spec: string,
  registry: BackgroundModelRegistry,
): ResolvedBackgroundModel {
  const available = registry.getAvailable();

  // Exact (incl. canonical `provider/id`) match first — no thinking suffix to consider.
  const exact = tryMatchModel(spec, available);
  if (exact) return { model: exact };

  // No exact match: if there's a `:thinking` suffix, split on the LAST colon (after any
  // provider slash) and recurse on the prefix — so a model id that itself contains a
  // colon (rare) still needs an explicit slash to disambiguate.
  const colon = spec.lastIndexOf(":");
  const slash = spec.indexOf("/");
  if (colon !== -1 && colon > slash) {
    const suffix = spec.slice(colon + 1);
    const prefix = spec.slice(0, colon);
    if (
      VALID_THINKING_LEVELS.includes(
        suffix as (typeof VALID_THINKING_LEVELS)[number],
      )
    ) {
      const inner = parseSpec(prefix, registry);
      if (inner.model) {
        // Only honour the thinking level when the prefix resolved cleanly.
        return { model: inner.model, thinkingLevel: suffix };
      }
      // Prefix didn't resolve either — fall through to the not-found warning below,
      // reporting the FULL spec so the operator sees what they typed.
    } else {
      // Invalid thinking level: recurse on the prefix. If it resolves, return the model
      // with the bad level DROPPED + a non-fatal warning (the model works, the suffix is
      // just noted). If the prefix doesn't resolve, return the inner result's warning
      // (no model): the missing model is the real problem, the bad suffix is moot.
      const inner = parseSpec(prefix, registry);
      if (inner.model) {
        return {
          model: inner.model,
          warning: `Invalid thinking level "${suffix}" in spec "${spec}" — dropped; valid: ${VALID_THINKING_LEVELS.join(", ")}.`,
        };
      }
      return {
        // Name the FULL spec (incl. the bad suffix) so the operator sees everything
        // they typed — the missing model is the real problem, but the bad suffix is moot
        // only AFTER a model resolves; until then both are wrong and both should show.
        warning: `No registered model matches "${spec}" (invalid thinking level "${suffix}" dropped; valid: ${VALID_THINKING_LEVELS.join(", ")}).`,
      };
    }
  }

  // Well-formed but matches nothing registered.
  return {
    warning: `No registered model matches "${spec}". Check the provider/model id, or connect the provider first.`,
  };
}

/** Run a `script:`-prefixed path, capture stdout, and parse it as a spec. The script is
 *  the operator's escape hatch (keep using a custom resolver). Failures are loud — a
 *  script that errors or prints nothing usable is a `warning`, never a silent no-op.
 *  Uses spawnSync (blocking) — fine for a Settings-panel validation call, not a hot path. */
function resolveScriptSpec(
  scriptPath: string,
  registry: BackgroundModelRegistry,
): ResolvedBackgroundModel {
  try {
    const res = spawnSync(scriptPath, [], {
      encoding: "utf8",
      // Don't inherit the server's stdio — capture stdout only. A script that needs
      // env inherits process.env (so it can read PI_ROLE_* etc., like a roles resolver).
      env: process.env,
      timeout: 5000,
    });
    if (res.error) {
      return {
        warning: `Failed to run background-model script "${scriptPath}": ${res.error.message}`,
      };
    }
    if (res.status !== 0) {
      const stderr = res.stderr?.trim();
      return {
        warning: `Background-model script "${scriptPath}" exited ${res.status}${stderr ? `: ${stderr}` : ""}`,
      };
    }
    const stdout = res.stdout?.trim();
    if (!stdout) {
      return {
        warning: `Background-model script "${scriptPath}" printed no spec to stdout.`,
      };
    }
    // The script's stdout is itself a spec string — recurse via parseSpec.
    return parseSpec(stdout, registry);
  } catch (e) {
    return {
      warning: `Error running background-model script "${scriptPath}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Resolve the `backgroundModel` setting. The single entry point: handles `null`
 *  (unset → no-op), `script:` paths (run → parse stdout), and plain specs (parse
 *  against the registry). Always returns a `ResolvedBackgroundModel`; the caller
 *  surfaces `warning` to the UI. Never throws — bad specs are `warning`s, not crashes. */
export function resolveBackgroundModel(
  backgroundModel: string | null | undefined,
  registry: BackgroundModelRegistry,
): ResolvedBackgroundModel {
  const spec = backgroundModel?.trim() || null;
  if (spec === null) return {}; // unset — callers fall back; not an error.
  if (spec.startsWith(SCRIPT_PREFIX)) {
    return resolveScriptSpec(spec.slice(SCRIPT_PREFIX.length).trim(), registry);
  }
  return parseSpec(spec, registry);
}
