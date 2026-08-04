import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");

const adrPath = "docs/ADR-mac-mini-remote-access.md";
const adr = read(adrPath);
const design = read("docs/DESIGN.md");
const decisions = read("docs/DECISIONS.md");
const validation = read("docs/issues/mobile-access/06-validation-and-docs.md");
const architectureDocs = [
  "README.md",
  "desktop/README.md",
  "docs/ADR-mac-mini-remote-access.md",
  "docs/mac-mini-remote-access.md",
  "docs/mac-mini-remote-access-validation.md",
  "docs/DESIGN.md",
  "docs/DECISIONS.md",
  "docs/PLAN-mobile.md",
  ...["01-remote-contract.md", "02-authenticated-sidecar.md", "03-phone-bootstrap.md", "04-remote-app-updates.md", "05-mini-lifecycle.md", "06-validation-and-docs.md"].map((name) => `docs/issues/mobile-access/${name}`),
];

function requireTerms(document: string, terms: readonly string[], label: string) {
  for (const term of terms) {
    expect(document, `${label} must contain ${JSON.stringify(term)}`).toContain(term);
  }
}

function requireResolvedMarkdownLinks(document: string, documentPath: string) {
  const links = [...document.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^(?:https?:|mailto:)/.test(target));
  expect(links, `${documentPath} must link the ADR`).toContain("ADR-mac-mini-remote-access.md");
  for (const target of links) {
    expect(existsSync(join(repoRoot, dirname(documentPath), target)), `${documentPath} link target ${target}`).toBe(true);
  }
}

describe("remote access contract documentation (AC.1–AC.4)", () => {
  test("remote_access_architecture_docs", () => {
    for (const path of architectureDocs) expect(existsSync(join(repoRoot, path)), `${path} exists`).toBe(true);
    const current = architectureDocs.map(read).join("\n");
    requireTerms(current, ["private HTTPS Tailscale Serve", "127.0.0.1:<stable-port>", "loopback-only", "no Funnel", "second backend", "signed `.app` update", "PWA service-worker"], "architecture docs");
  });
  test("authoritative ADR exists and architecture links resolve (AC.1)", () => {
    expect(existsSync(join(repoRoot, adrPath))).toBe(true);
    requireTerms(adr, [
      "## Decision summary",
      "## Supported topology and security boundary",
      "## Persisted remote configuration",
      "## Token and Keychain lifecycle",
      "## `/bootstrap` exchange contract",
      "## Opt-in macOS launch-at-login and packaging",
      "## Ownership and handoff",
      "## Stale deployment and protocol inventory",
      "## Acceptance criteria and verification map",
    ], "ADR headings");
    requireResolvedMarkdownLinks(design, "docs/DESIGN.md");
    requireResolvedMarkdownLinks(decisions, "docs/DECISIONS.md");
    requireTerms(
      adr,
      [
        "Status:** Accepted v1 contract",
        "installed iPhone PWA (HTTPS)",
        "Tailscale Serve (only network-facing layer; no Funnel)",
        "proxy target: 127.0.0.1:<stable-port>",
        "Pantoken.app on Mac Mini",
        "supervises bundled pantoken-server",
        "direct port forwarding",
        "second backend",
        "PWA service-worker/client refresh",
        "signed Pantoken `.app` update",
      ],
      "ADR architecture",
    );
    requireTerms(
      design,
      [
        "ADR-mac-mini-remote-access.md",
        "Supported Mac Mini phone/PWA topology",
        "desktop-initiated remote-target mode",
        "private HTTPS Tailscale Serve",
        "127.0.0.1:<stable-port>",
        "second mobile backend",
      ],
      "DESIGN",
    );
    requireTerms(
      decisions,
      [
        "ADR-mac-mini-remote-access.md",
        "Mac Mini phone/PWA remote access (v1)",
        "desktop-initiated remote-target mode",
        "private HTTPS Tailscale Serve",
        "127.0.0.1:<stable-port>",
        "second mobile backend",
      ],
      "DECISIONS",
    );
  });

  test("configuration matrix freezes persistence and local/remote behavior (AC.2)", () => {
    requireTerms(
      adr,
      [
        "remote-access.json",
        "schema version **1**",
        "atomic",
        "absent file",
        "Malformed or unreadable JSON",
        "server data-directory migration",
        "`enabled`",
        "`hub_port`",
        "`1024..=65535`",
        "8787",
        "occupied ports",
        "never silently randomize",
        "explicit user entry and confirmation",
        "HTTPS URL",
        "endpoint_metadata",
        "verification state",
        "redacted failure reason",
        "dev.pantoken.app.remote-access",
        "bearer-token",
        "missing",
        "available",
        "unavailable",
        "revoked",
        "existing `:0` mechanism",
        "fails closed",
        "preserves sessions/data",
      ],
      "configuration contract",
    );
    expect(adr).toMatch(/\| Field \| Type \/ default \| Owner and storage boundary \| Migration \| Failure behavior \| Local vs remote rule \|/);
    const matrixRows = adr
      .split("\n")
      .filter((line) => /^\| `?(schema_version|enabled|hub_port|origin|endpoint_metadata|keychain_token)/.test(line));
    expect(matrixRows).toHaveLength(6);
    for (const row of matrixRows) {
      expect(row.split("|").length, `matrix row has all six columns: ${row}`).toBe(8);
    }
  });

  test("bootstrap contract has exact statuses, bodies, headers, and restrictions (AC.3)", () => {
    requireTerms(
      adr,
      [
        "GET /bootstrap?credential=<opaque-one-time-value>",
        "HTTP 200",
        "Content-Type: text/html",
        "HTTP 401",
        "Content-Type: application/json",
        '{ "error": "unauthorized" }',
        "POST /bootstrap",
        'Content-Type: application/json',
        '{ "credential": "..." }',
        '{ "token": "<persistent-bearer-token>" }',
        "HTTP 405",
        '{ "error": "method_not_allowed" }',
        "Allow: GET, POST",
        "10 minutes",
        "atomically consumed",
        "history.replaceState",
        "Referrer-Policy: no-referrer",
        "no-store",
        "Authorization: Bearer <token>",
        "Query-token authentication is rejected",
        "static, API, push, update, debug, and WebSocket",
        "redact the query credential",
      ],
      "bootstrap contract",
    );
    expect(adr).toMatch(/A valid credential on the initial `GET \/bootstrap`[\s\S]*?HTTP 200[\s\S]*?`Content-Type: text\/html`/);
    expect(adr).toMatch(/A missing, malformed, expired, consumed, or wrong credential on the initial GET returns the same \*\*HTTP 401\*\*[\s\S]*?`Content-Type: application\/json`[\s\S]*?\{ "error": "unauthorized" \}/);
    expect(adr).toMatch(/The page submits \*\*`POST \/bootstrap`\*\*[\s\S]*?`Content-Type: application\/json`[\s\S]*?\{ "credential": "\.\.\." \}/);
    expect(adr).toMatch(/A valid POST returns \*\*HTTP 200\*\*[\s\S]*?`Content-Type: application\/json`[\s\S]*?\{ "token": "<persistent-bearer-token>" \}/);
    expect(adr).toMatch(/Invalid POST credentials, including missing, malformed, expired, consumed, and wrong values, all return the same stable \*\*HTTP 401\*\*[\s\S]*?`Content-Type: application\/json`[\s\S]*?\{ "error": "unauthorized" \}/);
    expect(adr).toMatch(/Every method other than GET and POST returns \*\*HTTP 405\*\*[\s\S]*?`Content-Type: application\/json`[\s\S]*?\{ "error": "method_not_allowed" \}[\s\S]*?`Allow: GET, POST`/);
    requireTerms(
      adr,
      [
        "dev.pantoken.app",
        "SMAppService.mainApp",
        "register()",
        "unregister()",
        "Service Management status API",
        "without requiring a visible window",
        "Closing the main window leaves the tray, supervisor, and remote service alive",
        "Explicit Quit",
        "signed update with the same",
        "uninstall removes the app's registration",
        "visible and actionable",
        "launch agent",
        "user Login Item",
      ],
      "launch-at-login contract",
    );
  });

  test("stale inventory is scoped, classified, and owned (AC.4)", () => {
    requireTerms(
      adr,
      [
        "## Stale deployment and protocol inventory",
        "README.md",
        "desktop/README.md",
        "docs/DESIGN.md",
        "docs/DECISIONS.md",
        "docs/PLAN-mobile.md",
        "docs/issues/mobile-access/*.md",
        "deploy/**",
        "deploy/",
        "?token=",
        "PROTOCOL_VERSION",
        "protocol version",
        "protocol-version",
        "daemon compatibility/version claims",
        "direct-exposure/second-backend language",
        "File/line or stable heading",
        "Matched claim",
        "Classification",
        "Rationale",
        "Owner/action",
        "historical/qualified",
        "contradictory",
        "authoritative current protocol constants and compatibility claims",
        "docs/issues/mobile-access/06-validation-and-docs.md",
      ],
      "stale inventory",
    );
    const inventoryStart = adr.indexOf("## Stale deployment and protocol inventory");
    const inventoryEnd = adr.indexOf("### Inventory acceptance and follow-up");
    expect(inventoryStart).toBeGreaterThanOrEqual(0);
    expect(inventoryEnd).toBeGreaterThan(inventoryStart);
    const inventory = adr.slice(inventoryStart, inventoryEnd);
    const inventoryRows = inventory.split("\n").filter((line) => line.startsWith("|") && !line.startsWith("|---") && !line.includes("File/line or stable heading"));
    expect(inventoryRows.length, "inventory must contain data rows").toBeGreaterThan(0);
    for (const row of inventoryRows) {
      const columns = row.split("|").slice(1, -1).map((column) => column.trim());
      expect(columns, `inventory row must have five columns: ${row}`).toHaveLength(5);
      for (const column of columns) {
        expect(column.length, `inventory row has no empty column: ${row}`).toBeGreaterThan(0);
      }
      const classification = columns[2];
      expect(["historical/qualified", "contradictory", "authoritative current"], `known inventory classification: ${row}`).toContain(classification);
      if (classification === "contradictory") {
        expect(columns[4], `contradictory inventory row must name Issue 06: ${row}`).toContain("docs/issues/mobile-access/06-validation-and-docs.md");
      }
    }
    requireTerms(
      validation,
      ["documentation is consistent", "Mini runbook", "physical-device and tailnet checks"],
      "Issue 06 handoff",
    );
  });

  test("remote_update_docs_contract", () => {
    const desktop = read("desktop/README.md");
    requireTerms(
      desktop,
      [
        "signed whole-app update",
        "PWA service-worker `Refresh`",
        "active or initializing turn",
        "fail-closed",
        "retryable failure",
        "Authorization: Bearer <token>",
        "`/update/permit/consume`",
        "tokens never appear in URLs",
        "redact bearer tokens",
        "iOS push delivery",
      ],
      "remote update operational contract",
    );
  });

  test("issue_162_profile_contract_absence", () => {
    const productionPaths = [
      "client/src/lib/hosts/types.ts",
      "client/src/lib/profile-form.ts",
      "client/src/lib/profile-editor.svelte.ts",
      "client/src/components/ComputerSetupSheet.svelte",
      "client/src/lib/hosts/tauri-provider.ts",
      "client/src/lib/hosts/dev-provider.ts",
      "desktop/src/remote_profile.rs",
      "desktop/src/bridge.rs",
      "desktop/src/bridge/fake.rs",
      "desktop/src/remote_executor.rs",
      "desktop/src/provisioning/mod.rs",
      "desktop/src/provisioning/reconcile.rs",
      "desktop/src/remote_commands.rs",
      "desktop/src/remote_connection.rs",
      "server/pantoken-remote-layout/src/layout.rs",
    ];
    const forbidden = [
      /\bXdgMode\b/,
      /\bxdgMode\s*:/,
      /\bxdg_mode\s*:/,
      /polytoken_xdg_(?:config|data|cache)\s*\(/,
      /XDG_(?:CONFIG_HOME|DATA_HOME|CACHE_HOME)\s*=/,
    ];
    for (const path of productionPaths) {
      const source = read(path);
      for (const pattern of forbidden) {
        expect(source, `${path} must not contain ${pattern}`).not.toMatch(pattern);
      }
    }

    // Compatibility fixtures may mention legacy keys, but only in the named
    // migration/bridge/E2E assertions. This keeps the migration escape hatch
    // explicit without allowing the removed profile contract back into helpers
    // or unrelated tests.
    const compatibilityFixtures = [
      ["client/src/lib/profile-form.test.ts", ["legacy_draft_keys_are_dropped_on_persist"]],
      ["client/src/lib/hosts/tauri-provider.test.ts", ["tauri_profile_command_omits_xdg_mode", "tauri_profile_response_without_xdg_mode_maps"]],
      ["desktop/src/remote_profile.rs", ["remote_profile_legacy_xdg_keys_are_dropped_on_reserialization"]],
      ["desktop/src/bridge.rs", ["ssh_command_from_profile_has_no_xdg_assignments"]],
      ["e2e/computers-section.e2e.ts", ["host_add_profile_payload_omits_xdg_mode_and_preserves_advanced_fields", "host_edit_profile_payload_omits_xdg_mode_and_preserves_advanced_fields"]],
      ["e2e/container-setup.e2e.ts", ["docker_add_profile_payload_omits_xdg_mode_and_preserves_advanced_fields", "docker_edit_profile_payload_omits_xdg_mode_and_preserves_advanced_fields"]],
    ] as const;
    for (const [path, testNames] of compatibilityFixtures) {
      const source = read(path);
      const literalOffsets = [...source.matchAll(/["'`]xdg(?:Mode|_mode)["'`]/g)].map((match) => match.index!);
      const allowedRanges = testNames.map((testName) => {
        const start = source.indexOf(testName);
        expect(start, `${path} must define ${testName}`).toBeGreaterThanOrEqual(0);
        const candidates = [
          source.indexOf("\n  test(", start + testName.length),
          source.indexOf("\ntest(", start + testName.length),
          source.indexOf("\n    #[test]", start + testName.length),
          source.indexOf("\n    #[tokio::test]", start + testName.length),
        ].filter((offset) => offset >= 0);
        return [start, candidates.length ? Math.min(...candidates) : source.length] as const;
      });
      for (const offset of literalOffsets) {
        expect(
          allowedRanges.some(([start, end]) => offset >= start && offset < end),
          `${path} legacy key literal must be inside a named compatibility test`,
        ).toBe(true);
      }
    }

    expect(read("server/pantoken-server/src/remote/runtime.rs")).toContain("inherited_xdg_assignments");
    // The parity harness is intentionally outside this production-source allowlist;
    // it may export isolated XDG roots for test safety.
  });

  test("issue_162_documentation_contract", () => {
    const decisions = read("docs/DECISIONS.md");
    const decisionStart = decisions.indexOf("## Remote deployment Phase 3: XDG roots are always shared");
    const decisionEnd = decisions.indexOf("## Remote deployment Phase 3: channel derivation", decisionStart);
    const decisionSection = decisions.slice(decisionStart, decisionEnd);
    requireTerms(decisionSection, ["always use the remote user's existing", "no profile-level XDG isolation choice", "legacy `xdgMode`", "`xdg_mode`", "omitted", "rewritten"], "issue-162 decision");
    expect(decisionSection).not.toContain("isolated by default");

    const design = read("docs/DESIGN.md");
    const designStart = design.indexOf("**XDG roots**");
    const designSection = design.slice(designStart, designStart + 650);
    requireTerms(designSection, ["always use", "existing polytoken XDG roots", "no XDG mode", "generic bridge/runtime", "Legacy", "dropped"], "issue-162 design");
    expect(designSection).not.toContain("Default is `Isolated`");

    const docker = read("docs/docker-target-guide.md");
    const cleanupStart = docker.indexOf("## Cleanup and uninstall");
    const cleanupSection = docker.slice(cleanupStart, cleanupStart + 900);
    expect(cleanupSection).not.toContain("Isolated XDG");
    requireTerms(cleanupSection, ["Managed polytoken binaries", "Session state and logs"], "issue-162 Docker cleanup");
  });

  test("remote_contract_docs_cover_issue_147", () => {
    const desktop = read("desktop/README.md");
    const contract = read("docs/issues/mobile-access/01-remote-contract.md");
    requireTerms(
      desktop,
      [
        "local/remote mode",
        "persisted `hub_port` (8787",
        "never randomizes",
        "127.0.0.1",
        "remote-access.json` (schema 1)",
        "dev.pantoken.app.remote-access",
        "bearer-token",
        "omits `PANTOKEN_TOKEN`",
        "authenticated internal `/health` and `/update/state` calls",
        "HTTP `401` with body",
        "`unauthorized`",
        "HTTP `405` precedence",
        "`?token=` with `401`",
        "first Hello message",
        "issue #148/03",
        "no loopback/static auth exemption",
      ],
      "desktop issue-147 contract",
    );
    requireTerms(
      contract,
      [
        "stable hub port, default `8787`",
        "random loopback-port behavior for local-only mode",
        "Remote mode is deterministic",
        "127.0.0.1",
        "macOS Keychain",
        "fails closed",
        "Authorization: Bearer",
        "query-token authentication on ordinary static, API, and WebSocket routes",
        "PWA service-worker updates",
        "signed `.app` updates",
      ],
      "remote contract issue-147 boundary",
    );
    expect(desktop).not.toContain("Everything else in the environment passes through");
    expect(desktop).not.toContain("Picks a free loopback port.\n");
  });
});
