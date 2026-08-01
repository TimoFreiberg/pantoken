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
