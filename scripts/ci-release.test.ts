import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static assertions on .github/workflows/ci.yml guarding the release-path
// invariants introduced by the "Buck2 release-authoritative" cutover:
//   - both release-prepare jobs build headless via `build.ts --builder buck2`
//   - no `cargo build` remains in the headless release path
//   - the Buck2⇄Cargo parity comparison step is gone (no CI consumer)
//   - the buck2 gate job is in the release job's `needs`
//   - the buck2 job exercises the release configuration (release_build=1)
//     and validates the archive with the same config file; those
//     release-config steps are skipped on PRs
//     (if: github.event_name != 'pull_request') and run on tags,
//     non-release main pushes, and manual dispatches
const CI_YML = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const ci = readFileSync(CI_YML, "utf8");

/** Extract a top-level job block (from `  <name>:` to the next job or EOF). */
function jobBlock(name: string): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`job '${name}' not found in ci.yml`);
  const end = lines.findIndex(
    (l, i) => i > start && /^  \S/.test(l) && !l.startsWith("    "),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The PR-skip gating expression used on the buck2 job's release-config steps. */
const PR_GATING = "if: github.event_name != 'pull_request'";

/** Extract a step block (from `- name: <name>` to the next step or job end). */
function stepBlock(job: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = job.match(
    new RegExp(`- name: ${escaped}[\\s\\S]*?(?=\\n      - |\\n  [A-Za-z]|$)`),
  );
  if (!m) throw new Error(`step '${name}' not found in job block`);
  return m[0];
}

describe("ci.yml release path (Buck2-authoritative)", () => {
  it("release-prepare builds headless via build.ts --builder buck2", () => {
    const block = jobBlock("release-prepare");
    expect(block).toContain("--builder buck2");
    expect(block).toContain('--tag "${{ github.ref_name }}"');
  });

  it("release-prepare configures the remote cache before any buck2 daemon starts", () => {
    // buck2 freezes the RE client config at daemon startup, so a daemon
    // started before .buckconfig.local exists (publish.ts's tauri build runs
    // build-hub.ts, which invokes buck2) breaks the later headless build with
    // "(No engine address)". The cache steps must precede publish.ts — the
    // daemon started during publish.ts already has the RE config, and the
    // headless build reuses it as-is. No daemon restart is performed (a
    // `buck2 kill` was removed: it forced a cold re-download of every
    // third-party crate from crates.io for no benefit — a needless
    // network-failure window; v0.2.94's release died in one).
    const block = jobBlock("release-prepare");
    const publishIdx = block.indexOf("Build signed desktop release artifacts");
    const tailscaleIdx = block.indexOf("Connect to Tailscale");
    const cacheIdx = block.indexOf("Configure remote cache");
    expect(tailscaleIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(tailscaleIdx).toBeLessThan(publishIdx);
    expect(cacheIdx).toBeLessThan(publishIdx);
    expect(block).not.toMatch(/buck2 kill/);
  });

  it("release-prepare-linux builds headless via build.ts --builder buck2", () => {
    const block = jobBlock("release-prepare-linux");
    expect(block).toContain("--builder buck2");
    expect(block).toContain("--target x86_64-unknown-linux-gnu");
    expect(block).toContain('--tag "${{ github.ref_name }}"');
  });

  it("has no cargo build in the release-prepare jobs (headless is Buck2-built)", () => {
    expect(jobBlock("release-prepare")).not.toMatch(/cargo\s+build/);
    expect(jobBlock("release-prepare-linux")).not.toMatch(/cargo\s+build/);
  });

  it("has no parity comparison step in the release path", () => {
    // The parity step (buck2-parity-compare.sh with continue-on-error) lived
    // in the release jobs; scope the assertions there so unrelated future
    // uses of continue-on-error elsewhere don't trip them.
    expect(jobBlock("release-prepare")).not.toContain("buck2-parity-compare.sh");
    expect(jobBlock("release-prepare")).not.toContain("continue-on-error");
    expect(jobBlock("release-prepare-linux")).not.toContain("buck2-parity-compare.sh");
    expect(jobBlock("release-prepare-linux")).not.toContain("continue-on-error");
  });

  it("puts the buck2 gate job in the release job's needs", () => {
    const block = jobBlock("release");
    expect(block).toMatch(/needs:\s*\[[^\]]*\bbuck2\b[^\]]*\]/);
  });

  it("runs the buck2 job's archive step in the release configuration", () => {
    const block = jobBlock("buck2");
    const archiveStep = block.match(
      /Buck2 archive build[\s\S]*?buck2 build [^\n]*\/\/:pantoken_headless_unsigned/,
    );
    expect(archiveStep).not.toBeNull();
    expect(archiveStep![0]).toContain("release_build = 1");
    expect(archiveStep![0]).toContain("--config-file .buckconfig.ci");
  });

  it("validates the archive with the same release config file", () => {
    const block = jobBlock("buck2");
    const validationStep = block.match(
      /Buck2 archive validation[\s\S]*?run: just validate-archive-rs-ci/,
    );
    expect(validationStep).not.toBeNull();
    // The recipe itself passes --config-file .buckconfig.ci so the sh_test
    // rebuilds its archive resource under the release config.
    const justfile = readFileSync(
      resolve(import.meta.dirname, "../justfile"),
      "utf8",
    );
    const recipe = justfile.match(/validate-archive-rs-ci:[\s\S]*?buck2 test[^\n]*/);
    expect(recipe).not.toBeNull();
    expect(recipe![0]).toContain("--config-file .buckconfig.ci");
  });

  it("gates the buck2 job's release-config steps on PRs", () => {
    const block = jobBlock("buck2");
    // Exactly the three release-config steps carry the PR-skip gating — no
    // other buck2 step (clippy, dev build/test, manifest checks, cache setup).
    expect(block.match(/if: github.event_name != 'pull_request'/g)).toHaveLength(3);
    for (const step of [
      "Determine PANTOKEN_VERSION",
      "Buck2 archive build",
      "Buck2 archive validation",
    ]) {
      expect(stepBlock(block, step)).toContain(PR_GATING);
    }
  });

  it("does not gate the release-prepare jobs on PRs", () => {
    // The PR-skip gating is scoped to the buck2 gate job's release-config
    // steps; the tag-only release jobs must never inherit it.
    expect(jobBlock("release-prepare")).not.toContain(PR_GATING);
    expect(jobBlock("release-prepare-linux")).not.toContain(PR_GATING);
  });

  it("wraps buck2 build steps in retry-transient.sh but never test steps", () => {
    // Transient crates.io DNS/network failures get exactly one retry (see
    // scripts/ci/retry-transient.sh), and only on build steps. Test steps are
    // deliberately unwrapped: test failures must never be retried.
    for (const job of ["rust-server", "buck2"]) {
      const block = jobBlock(job);
      expect(stepBlock(block, "Buck2 clippy")).toContain("retry-transient.sh");
      expect(stepBlock(block, "Buck2 build")).toContain("retry-transient.sh");
      expect(stepBlock(block, "Buck2 test")).not.toContain("retry-transient.sh");
    }
    expect(stepBlock(jobBlock("buck2"), "Buck2 archive build")).toContain(
      "retry-transient.sh",
    );
    expect(
      stepBlock(jobBlock("release-prepare"), "Build headless release artifact"),
    ).toContain("retry-transient.sh");
    expect(
      stepBlock(
        jobBlock("release-prepare"),
        "Build signed desktop release artifacts",
      ),
    ).toContain("retry-transient.sh");
  });

  it("release-prepare waits for Linux and preflights the staged signed artifact", () => {
    const block = jobBlock("release-prepare");
    expect(block).toMatch(/needs:\s*release-prepare-linux/);

    const download = stepBlock(block, "Download Linux release artifacts for desktop digest");
    expect(download).toContain("actions/download-artifact@v4");
    expect(download).toContain("name: signed-release-artifacts-linux");
    expect(download).toContain("path: target/release/headless");

    const preflight = stepBlock(block, "Preflight staged Linux release artifacts");
    for (const path of [
      "target/release/headless/pantoken-headless-linux-x86_64.tar.gz",
      "target/release/headless/pantoken-headless-linux-x86_64.tar.gz.sig",
      "target/release/headless/release-metadata-linux.json",
    ]) {
      expect(preflight).toContain(`test -f ${path}`);
    }
    const downloadStart = block.indexOf("      - name: Download Linux release artifacts for desktop digest");
    const preflightStart = block.indexOf("      - name: Preflight staged Linux release artifacts");
    const nextStepAfterDownload = block.indexOf("\n      - ", downloadStart + 1);
    expect(downloadStart).toBeGreaterThan(-1);
    expect(nextStepAfterDownload + 1).toBe(preflightStart);
  });

  it("builds both headless targets before desktop packaging and verifies the embedded digest", () => {
    const block = jobBlock("release-prepare");
    const downloadIdx = block.indexOf("Download Linux release artifacts for desktop digest");
    const preflightIdx = block.indexOf("Preflight staged Linux release artifacts");
    const headlessIdx = block.indexOf("Build headless release artifact");
    const desktopIdx = block.indexOf("Build signed desktop release artifacts");
    const refreshIdx = block.indexOf("Refresh macOS release metadata with desktop assets");
    const verifyIdx = block.indexOf("Verify embedded Linux digest");
    const assembleIdx = block.indexOf("Assemble retained release bundle");
    const uploadIdx = block.indexOf("Upload signed release artifacts");

    expect(downloadIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeGreaterThan(downloadIdx);
    expect(headlessIdx).toBeGreaterThan(preflightIdx);
    expect(desktopIdx).toBeGreaterThan(headlessIdx);
    expect(refreshIdx).toBeGreaterThan(desktopIdx);
    expect(verifyIdx).toBeGreaterThan(refreshIdx);
    expect(assembleIdx).toBeGreaterThan(refreshIdx);
    expect(assembleIdx).toBeGreaterThan(verifyIdx);
    expect(uploadIdx).toBeGreaterThan(assembleIdx);

    const refresh = stepBlock(block, "Refresh macOS release metadata with desktop assets");
    expect(refresh).toContain("scripts/headless/refresh-metadata.ts");
    expect(refresh).toContain("target/release/headless/release-metadata.json");
    expect(refresh).toContain("target/release/bundle/macos");

    const verify = stepBlock(block, "Verify embedded Linux digest");
    expect(verify).toContain('PANTOKEN_RELEASE_BUILD: "1"');
    expect(verify).toContain("cargo test --locked -p pantoken-desktop embedded_manifest_contains_real_linux_digest");
  });

  it("retains release validation, signing, smoke-test, and artifact upload contracts", () => {
    const block = jobBlock("release-prepare");
    expect(stepBlock(block, "Build signed desktop release artifacts")).toMatch(
      /TAURI_SIGNING_PRIVATE_KEY:.*PANTOKEN_BUILD_SHA:/s,
    );
    expect(stepBlock(block, "Build headless release artifact")).toContain(
      "TAURI_SIGNING_PRIVATE_KEY_TEXT",
    );
    expect(stepBlock(block, "Validate Buck2-built archive (release config)")).toContain(
      "just validate-archive-rs-ci",
    );
    expect(stepBlock(block, "Install trusted tar validator for preparation")).toContain(
      "test -x target/release/pantoken-tar-validate",
    );
    expect(stepBlock(block, "Validate headless artifact")).toContain(
      "pantoken-headless-macos-aarch64.tar.gz",
    );
    expect(stepBlock(block, "Smoke-test compiled headless artifact")).toMatch(
      /tar -xzf target\/release\/headless\/pantoken-headless-macos-aarch64\.tar\.gz[\s\S]*smoke-test\.ts/,
    );
    const assemble = stepBlock(block, "Assemble retained release bundle");
    for (const path of [
      "Pantoken.app.tar.gz",
      "Pantoken.app.tar.gz.sig",
      "latest.json",
      "pantoken-headless-macos-aarch64.tar.gz",
      "pantoken-headless-macos-aarch64.tar.gz.sig",
      "release-metadata.json",
    ]) {
      expect(assemble).toContain(path);
    }
    const upload = stepBlock(block, "Upload signed release artifacts");
    expect(upload).toContain("name: signed-release-artifacts-macos");
    expect(upload).toContain("path: target/release/release-bundle");
  });

  it("publishes refreshed macOS metadata merged with the Linux metadata", () => {
    const block = jobBlock("release");
    const downloadIdx = block.indexOf("Download Linux release artifacts");
    const mergeIdx = block.indexOf("Merge Linux artifacts into release bundle");
    const merge = stepBlock(block, "Merge Linux artifacts into release bundle");
    expect(downloadIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(downloadIdx);
    expect(merge).toContain("scripts/headless/merge-metadata.ts");
    expect(merge).toContain("target/release/release-bundle/release-metadata.json");
    expect(merge).toContain("target/release/release-bundle-linux/release-metadata-linux.json");
    expect(merge.indexOf("release-metadata.json")).toBeLessThan(
      merge.indexOf("release-metadata-linux.json"),
    );
  });

  it("documents the cross-runner handoff and headless-before-desktop ordering", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../desktop/README.md"), "utf8");
    const publishing = readme.slice(readme.indexOf("## Publishing a release"));
    expect(publishing).toContain("release-prepare-linux");
    expect(publishing).toMatch(/depends on that job\s+completing/);
    expect(publishing).toContain("target/release/headless");
    expect(publishing).toContain("macOS headless artifact before the desktop");
  });
});
