#!/usr/bin/env tsx
// refresh-metadata.ts — add already-built desktop asset metadata to the
// macOS headless metadata without rebuilding, re-signing, or merging targets.
//
//   tsx scripts/headless/refresh-metadata.ts <macos-metadata.json> <desktop-dir>
//
// The publish job remains responsible for merging release-metadata-linux.json.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMain } from "../lib/node-compat.js";

export interface HeadlessTargetMetadata {
  targetTriple: string;
  asset: string;
  signature: string;
  assetSha256: string;
  signatureSha256: string;
}

export interface ReleaseMetadata {
  tag: string;
  version: string;
  buildSha: string;
  releaseRepo: string;
  desktopAsset: string;
  desktopSignature: string;
  latestJsonAsset: string;
  headlessTargets: HeadlessTargetMetadata[];
  assetSha256: Record<string, string>;
}

export interface DesktopAssetHashes {
  desktopAssetSha256: string;
  desktopSignatureSha256: string;
  latestJsonSha256: string;
}

const DESKTOP_ASSET = "Pantoken.app.tar.gz";
const DESKTOP_SIGNATURE = "Pantoken.app.tar.gz.sig";
const LATEST_JSON = "latest.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`metadata field ${field} must be a string`);
  return value;
}

function validateMetadata(value: unknown): asserts value is ReleaseMetadata {
  if (!isRecord(value)) throw new Error("metadata must be a JSON object");

  for (const field of ["tag", "version", "buildSha", "releaseRepo", "desktopAsset", "desktopSignature", "latestJsonAsset"]) {
    requireString(value[field], field);
  }

  if (!Array.isArray(value.headlessTargets)) {
    throw new Error("metadata field headlessTargets must be an array");
  }
  for (const [index, target] of value.headlessTargets.entries()) {
    if (!isRecord(target)) throw new Error(`metadata headlessTargets[${index}] must be an object`);
    for (const field of ["targetTriple", "asset", "signature", "assetSha256", "signatureSha256"]) {
      requireString(target[field], `headlessTargets[${index}].${field}`);
    }
  }

  if (!isRecord(value.assetSha256)) {
    throw new Error("metadata field assetSha256 must be an object");
  }
  for (const [asset, hash] of Object.entries(value.assetSha256)) {
    requireString(hash, `assetSha256.${asset}`);
  }
}

/**
 * Purely refresh the desktop fields and hashes in an existing macOS metadata
 * object. Headless targets and their hashes are copied unchanged; Linux
 * metadata is intentionally not accepted as an input to this function.
 */
export function refreshMetadata(
  metadata: unknown,
  hashes: DesktopAssetHashes,
): ReleaseMetadata {
  validateMetadata(metadata);
  for (const [field, hash] of Object.entries(hashes)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`${field} must be a lowercase SHA256 digest`);
    }
  }

  return {
    ...metadata,
    desktopAsset: DESKTOP_ASSET,
    desktopSignature: DESKTOP_SIGNATURE,
    latestJsonAsset: LATEST_JSON,
    headlessTargets: metadata.headlessTargets.map((target) => ({ ...target })),
    assetSha256: {
      ...metadata.assetSha256,
      [DESKTOP_ASSET]: hashes.desktopAssetSha256,
      [DESKTOP_SIGNATURE]: hashes.desktopSignatureSha256,
      [LATEST_JSON]: hashes.latestJsonSha256,
    },
  };
}

async function sha256(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`desktop asset not found: ${path}`);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  if (!existsSync(path)) throw new Error(`metadata file not found: ${path}`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`could not parse metadata ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Refresh a macOS metadata file from the three already-built desktop assets. */
export async function refreshMetadataFile(
  metadataPath: string,
  desktopBundleDir: string,
): Promise<void> {
  const hashes: DesktopAssetHashes = {
    desktopAssetSha256: await sha256(join(desktopBundleDir, DESKTOP_ASSET)),
    desktopSignatureSha256: await sha256(join(desktopBundleDir, DESKTOP_SIGNATURE)),
    latestJsonSha256: await sha256(join(desktopBundleDir, LATEST_JSON)),
  };
  const refreshed = refreshMetadata(await readJson(metadataPath), hashes);
  await writeFile(metadataPath, `${JSON.stringify(refreshed, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [metadataPath, desktopBundleDir] = process.argv.slice(2);
  if (!metadataPath || !desktopBundleDir) {
    throw new Error("usage: refresh-metadata.ts <macos-metadata.json> <desktop-dir>");
  }
  await refreshMetadataFile(metadataPath, desktopBundleDir);
  console.log(`refreshed desktop metadata in ${metadataPath}`);
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`refresh-metadata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
