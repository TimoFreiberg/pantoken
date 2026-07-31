import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buckConfigCiContents,
  writeBuckConfigCi,
  buildViaBuck2,
} from "./lib/headless-build.js";
import { headlessTargetForTriple } from "./desktop/release-constants.js";

const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.BUCK2_FAKE_ARGS_LOG;
  delete process.env.BUCK2_FAKE_OUT;
});

describe("buckConfigCiContents", () => {
  it("serializes the [pantoken] block with release_build=1", () => {
    const contents = buckConfigCiContents({
      version: "0.2.1",
      buildSha: "0123456789abcdef0123456789abcdef01234567",
      releaseBuild: true,
    });
    expect(contents).toBe(
      "[pantoken]\n" +
        "version = 0.2.1\n" +
        "build_sha = 0123456789abcdef0123456789abcdef01234567\n" +
        "release_build = 1\n",
    );
  });

  it("serializes release_build=0 when releaseBuild is false", () => {
    const contents = buckConfigCiContents({
      version: "0.0.0",
      buildSha: "0123456789abcdef0123456789abcdef01234567",
      releaseBuild: false,
    });
    expect(contents).toContain("release_build = 0\n");
  });
});

describe("writeBuckConfigCi", () => {
  it("writes the config file at the repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "buckconfig-write-"));
    try {
      const path = writeBuckConfigCi(dir, {
        version: "1.0.0",
        buildSha: "0123456789abcdef0123456789abcdef01234567",
        releaseBuild: true,
      });
      expect(path).toBe(join(dir, ".buckconfig.ci"));
      expect(readFileSync(path, "utf8")).toContain("version = 1.0.0");
      expect(readFileSync(path, "utf8")).toContain("release_build = 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildViaBuck2", () => {
  it("builds both targets with the release config and copies them to the release asset paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "buck2-build-"));
    const fakeBin = mkdtempSync(join(tmpdir(), "buck2-bin-"));
    const fakeOut = mkdtempSync(join(tmpdir(), "buck2-out-"));
    const argsLog = join(fakeOut, "args.log");
    try {
      // Fake buck2 that records args, touches fake outputs, and prints
      // `--show-output`-style lines for the two known targets.
      const script = join(fakeBin, "buck2");
      writeFileSync(
        script,
        `#!/usr/bin/env bash
set -euo pipefail
echo "$@" > "$BUCK2_FAKE_ARGS_LOG"
TARGET="\${!#}"
case "$TARGET" in
  "//:pantoken_headless_unsigned")
    touch "$BUCK2_FAKE_OUT/archive.tar.gz"
    echo "$TARGET $BUCK2_FAKE_OUT/archive.tar.gz"
    ;;
  "//server/pantoken-tar-validate:pantoken_tar_validate")
    touch "$BUCK2_FAKE_OUT/validator"
    echo "$TARGET $BUCK2_FAKE_OUT/validator"
    ;;
  *)
    echo "unexpected target: $TARGET" >&2
    exit 1
    ;;
esac
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${fakeBin}:${ORIGINAL_PATH}`;
      process.env.BUCK2_FAKE_ARGS_LOG = argsLog;
      process.env.BUCK2_FAKE_OUT = fakeOut;

      const outputDir = join(root, "target", "release", "headless");
      mkdirSync(outputDir, { recursive: true });
      const archivePath = await buildViaBuck2({
        root,
        version: "0.2.1",
        buildSha: "0123456789abcdef0123456789abcdef01234567",
        outputDir,
        asset: "pantoken-headless-macos-aarch64.tar.gz",
      });

      // .buckconfig.ci written with the release config
      expect(readFileSync(join(root, ".buckconfig.ci"), "utf8")).toBe(
        "[pantoken]\n" +
          "version = 0.2.1\n" +
          "build_sha = 0123456789abcdef0123456789abcdef01234567\n" +
          "release_build = 1\n",
      );
      // Both buck2 invocations pass the config file
      const args = readFileSync(argsLog, "utf8").trim();
      expect(args).toContain("--config-file");
      expect(args).toContain(".buckconfig.ci");
      // Archive copied to the release asset path
      expect(archivePath).toBe(
        join(outputDir, "pantoken-headless-macos-aarch64.tar.gz"),
      );
      expect(existsSync(archivePath)).toBe(true);
      // Validator copied to target/release with exec bit
      const validatorPath = join(root, "target", "release", "pantoken-tar-validate");
      expect(existsSync(validatorPath)).toBe(true);
      const mode = statSync(validatorPath).mode;
      expect(mode & 0o111).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(fakeOut, { recursive: true, force: true });
    }
  });
});

describe("headless asset-path derivation (used by --builder buck2)", () => {
  it("maps both release target triples to their archive asset names", () => {
    expect(headlessTargetForTriple("aarch64-apple-darwin").asset).toBe(
      "pantoken-headless-macos-aarch64.tar.gz",
    );
    expect(headlessTargetForTriple("x86_64-unknown-linux-gnu").asset).toBe(
      "pantoken-headless-linux-x86_64.tar.gz",
    );
  });
});
