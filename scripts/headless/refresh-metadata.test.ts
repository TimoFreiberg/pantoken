import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  refreshMetadata,
  refreshMetadataFile,
  type ReleaseMetadata,
} from "./refresh-metadata.js";

const LINUX_METADATA = "release-metadata-linux.json";

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function metadata(): ReleaseMetadata {
  return {
    tag: "v0.2.112",
    version: "0.2.112",
    buildSha: "a".repeat(40),
    releaseRepo: "TimoFreiberg/pantoken",
    desktopAsset: "",
    desktopSignature: "",
    latestJsonAsset: "",
    headlessTargets: [{
      targetTriple: "aarch64-apple-darwin",
      asset: "pantoken-headless-macos-aarch64.tar.gz",
      signature: "pantoken-headless-macos-aarch64.tar.gz.sig",
      assetSha256: "1".repeat(64),
      signatureSha256: "2".repeat(64),
    }],
    assetSha256: {
      "pantoken-headless-macos-aarch64.tar.gz": "1".repeat(64),
      "pantoken-headless-macos-aarch64.tar.gz.sig": "2".repeat(64),
    },
  };
}

describe("refreshMetadata", () => {
  it("adds desktop hashes while preserving macOS headless metadata", () => {
    const original = metadata();
    const originalAssetSha256 = { ...original.assetSha256 };
    const refreshed = refreshMetadata(original, {
      desktopAssetSha256: "3".repeat(64),
      desktopSignatureSha256: "4".repeat(64),
      latestJsonSha256: "5".repeat(64),
    });

    expect(refreshed.desktopAsset).toBe("Pantoken.app.tar.gz");
    expect(refreshed.desktopSignature).toBe("Pantoken.app.tar.gz.sig");
    expect(refreshed.latestJsonAsset).toBe("latest.json");
    expect(refreshed.assetSha256).toMatchObject({
      "Pantoken.app.tar.gz": "3".repeat(64),
      "Pantoken.app.tar.gz.sig": "4".repeat(64),
      "latest.json": "5".repeat(64),
    });
    expect(refreshed.headlessTargets).toEqual(original.headlessTargets);
    expect(refreshed.headlessTargets).not.toBe(original.headlessTargets);
    expect(refreshed.headlessTargets[0]).not.toBe(original.headlessTargets[0]);
    expect(refreshed.assetSha256).toMatchObject(originalAssetSha256);
    expect(refreshed.assetSha256).not.toBe(original.assetSha256);
    expect(refreshed.assetSha256[original.headlessTargets[0]!.asset]).toBe("1".repeat(64));
    expect(refreshed.assetSha256[original.headlessTargets[0]!.signature]).toBe("2".repeat(64));
    expect(original.assetSha256).toEqual(originalAssetSha256);
    expect(original.desktopAsset).toBe("");
  });
});

describe("refreshMetadataFile", () => {
  it("hashes desktop fixture files and leaves separate Linux metadata untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "refresh-metadata-"));
    try {
      const metadataPath = join(root, "release-metadata.json");
      const linuxMetadataPath = join(root, LINUX_METADATA);
      const desktopDir = join(root, "desktop");
      await mkdir(desktopDir);
      await writeFile(metadataPath, `${JSON.stringify(metadata(), null, 2)}\n`);
      const linuxMetadata = JSON.stringify({ ...metadata(), headlessTargets: [] });
      await writeFile(linuxMetadataPath, linuxMetadata);
      const assets = {
        "Pantoken.app.tar.gz": "desktop archive",
        "Pantoken.app.tar.gz.sig": "desktop signature",
        "latest.json": "desktop manifest",
      };
      for (const [name, content] of Object.entries(assets)) {
        await writeFile(join(desktopDir, name), content);
      }

      await refreshMetadataFile(metadataPath, desktopDir);
      const refreshed = JSON.parse(await readFile(metadataPath, "utf8")) as ReleaseMetadata;
      expect(refreshed.assetSha256["Pantoken.app.tar.gz"]).toBe(digest(assets["Pantoken.app.tar.gz"]));
      expect(refreshed.assetSha256["Pantoken.app.tar.gz.sig"]).toBe(digest(assets["Pantoken.app.tar.gz.sig"]));
      expect(refreshed.assetSha256["latest.json"]).toBe(digest(assets["latest.json"]));
      expect(await readFile(linuxMetadataPath, "utf8")).toBe(linuxMetadata);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing desktop archive", false],
    ["missing metadata", true],
  ])("fails for %s", async (_name, isMetadata) => {
    const root = await mkdtemp(join(tmpdir(), "refresh-metadata-invalid-"));
    try {
      const metadataPath = join(root, "release-metadata.json");
      const desktopDir = join(root, "desktop");
      await mkdir(desktopDir);
      if (!isMetadata) {
        await writeFile(metadataPath, `${JSON.stringify(metadata())}\n`);
        await writeFile(join(desktopDir, "Pantoken.app.tar.gz.sig"), "sig");
        await writeFile(join(desktopDir, "latest.json"), "json");
      } else {
        for (const name of ["Pantoken.app.tar.gz", "Pantoken.app.tar.gz.sig", "latest.json"]) {
          await writeFile(join(desktopDir, name), "asset");
        }
      }
      await expect(refreshMetadataFile(metadataPath, desktopDir)).rejects.toThrow(
        isMetadata ? "metadata file not found" : "desktop asset not found",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails for malformed JSON and structurally invalid metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "refresh-metadata-structure-"));
    try {
      const metadataPath = join(root, "release-metadata.json");
      const desktopDir = join(root, "desktop");
      await mkdir(desktopDir);
      for (const name of ["Pantoken.app.tar.gz", "Pantoken.app.tar.gz.sig", "latest.json"]) {
        await writeFile(join(desktopDir, name), "asset");
      }

      await writeFile(metadataPath, "not json");
      await expect(refreshMetadataFile(metadataPath, desktopDir)).rejects.toThrow("could not parse metadata");

      for (const invalid of [
        { ...metadata(), headlessTargets: undefined },
        { ...metadata(), headlessTargets: {} },
        { ...metadata(), assetSha256: undefined },
        { ...metadata(), assetSha256: [] },
      ]) {
        await writeFile(metadataPath, JSON.stringify(invalid));
        await expect(refreshMetadataFile(metadataPath, desktopDir)).rejects.toThrow(/headlessTargets|assetSha256/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
