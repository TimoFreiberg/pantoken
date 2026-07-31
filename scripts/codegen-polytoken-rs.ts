// Regenerates server/pantoken-daemon-types/src/lib.rs from the polytoken
// binary's own self-describing OpenAPI spec (`polytoken openapi`).
//
// The generated file contains serde types for every OpenAPI component schema,
// including the DaemonEvent discriminated union. Types use the same
// JSON wire format as the daemon: internally-tagged enums use `type`
// (or `kind` where the spec says so), camelCase field names via
// `#[serde(rename_all = "camelCase")]` where appropriate.
//
// Run: `just codegen-polytoken-rs`
//
// The binary path is resolved the same way pantoken resolves it at runtime:
// $PATH, or $PANTOKEN_POLYTOKEN_BIN.

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnAsync } from "./lib/node-compat.js";

const BIN_ENV = "PANTOKEN_POLYTOKEN_BIN";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(SCRIPT_DIR, "../server/pantoken-daemon-types/src/lib.rs");

function resolveBin(): string {
  if (process.env[BIN_ENV]) return process.env[BIN_ENV];
  return "polytoken";
}

interface JsonSchema {
  type?: string | string[];
  enum?: string[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  $ref?: string;
  description?: string;
  format?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  nullable?: boolean;
}

interface OpenApiSpec {
  components?: { schemas?: Record<string, JsonSchema> };
}

// ── Rust type name from a $ref ──────────────────────────────────────
function refToRust(ref: string): string {
  const name = ref.split("/").pop()!;
  return toRustName(name);
}

function toRustName(name: string): string {
  // Already PascalCase from the spec, but handle some edge cases
  return name;
}

// ── Convert a JSON schema property to a Rust type string ────────────
function schemaToRustType(schema: JsonSchema, schemas: Record<string, JsonSchema>): string {
  // $ref
  if (schema.$ref) {
    return refToRust(schema.$ref);
  }

  // oneOf → enum (but if it's just null + something, make it Option)
  if (schema.oneOf) {
    const nonNull = schema.oneOf.filter((s) => !(s.type === "null"));
    const hasNull = schema.oneOf.some((s) => s.type === "null");
    if (nonNull.length === 1 && hasNull) {
      const only = nonNull[0];
      if (only) {
        return `Option<${schemaToRustType(only, schemas)}>`;
      }
    }
    // Multiple non-null oneOf variants — use serde_json::Value for now
    // (these are rare and usually discriminated unions handled separately)
    return "serde_json::Value";
  }

  // anyOf → similar to oneOf
  if (schema.anyOf) {
    const nonNull = schema.anyOf.filter((s) => !(s.type === "null"));
    const hasNull = schema.anyOf.some((s) => s.type === "null");
    if (nonNull.length === 1 && hasNull) {
      const only = nonNull[0];
      if (only) {
        return `Option<${schemaToRustType(only, schemas)}>`;
      }
    }
    return "serde_json::Value";
  }

  // allOf → usually a $ref + something; take the first ref
  if (schema.allOf) {
    const ref = schema.allOf.find((s) => s.$ref);
    if (ref) return refToRust(ref.$ref!);
    return "serde_json::Value";
  }

  const t = Array.isArray(schema.type) ? schema.type : [schema.type];
  const isNullable = t.includes("null") || schema.nullable;

  // enum of strings
  if (schema.enum && (!schema.type || schema.type === "string")) {
    // Will be emitted as a separate enum type
    // For inline references, just use the value type
    const rustType = "String";
    return isNullable ? `Option<${rustType}>` : rustType;
  }

  const nonNullType = t.find((x) => x !== "null");

  let rustType: string;
  switch (nonNullType) {
    case "string":
      if (schema.enum) {
        // This is an inline enum — it should have been extracted as a named schema
        rustType = "String";
      } else {
        rustType = "String";
      }
      break;
    case "integer":
      if (schema.format === "int64") {
        rustType = "i64";
      } else if (schema.format === "int32") {
        rustType = "i32";
      } else {
        rustType = "i64";
      }
      break;
    case "number":
      rustType = "f64";
      break;
    case "boolean":
      rustType = "bool";
      break;
    case "array":
      if (schema.items) {
        rustType = `Vec<${schemaToRustType(schema.items, schemas)}>`;
      } else {
        rustType = "Vec<serde_json::Value>";
      }
      break;
    case "object":
      // If it has properties, it's a struct — but inline objects are rare in this spec.
      // Use a map for free-form objects.
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        rustType = `std::collections::HashMap<String, ${schemaToRustType(schema.additionalProperties, schemas)}>`;
      } else {
        rustType = "serde_json::Value";
      }
      break;
    case "null":
      rustType = "()";
      break;
    default:
      // No type info — could be a $ref that was resolved, or a free-form
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        rustType = `std::collections::HashMap<String, ${schemaToRustType(schema.additionalProperties, schemas)}>`;
      } else {
        rustType = "serde_json::Value";
      }
  }

  return isNullable ? `Option<${rustType}>` : rustType;
}

// ── Generate a Rust struct from an object schema ────────────────────
function generateStruct(name: string, schema: JsonSchema, schemas: Record<string, JsonSchema>): string {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const fields: string[] = [];

  for (const [propName, propSchema] of Object.entries(props)) {
    const rustName = toSnakeCase(propName);
    let rustType = schemaToRustType(propSchema, schemas);

    // If not required and not already Option, wrap in Option
    if (!required.has(propName) && !rustType.startsWith("Option<")) {
      rustType = `Option<${rustType}>`;
    }

    const serdeRename = propName !== rustName ? `#[serde(rename = "${propName}")]\n    ` : "";
    const skipIfNone = !required.has(propName) ? `#[serde(skip_serializing_if = "Option::is_none", default)]\n    ` : "";
    fields.push(`    ${skipIfNone}${serdeRename}pub ${rustName}: ${rustType},`);
  }

  return `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ${name} {
${fields.join("\n")}
}`;
}

// ── Generate a Rust enum from a oneOf with internal discriminator ────
function generateDiscriminatedEnum(
  name: string,
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
): string {
  const variants = schema.oneOf || [];
  const variantDefs: string[] = [];

  for (const variant of variants) {
    if (variant.type === "null") continue;

    const props = variant.properties || {};
    const typeProp = props["type"];
    const kindProp = props["kind"];
    const discriminantProp = typeProp || kindProp;

    if (discriminantProp && discriminantProp.enum && discriminantProp.enum.length === 1) {
      const tag = discriminantProp.enum[0];
      if (tag === undefined) continue;
      const variantName = toPascalCase(tag);
      const required = new Set(variant.required || []);

      // Collect the non-discriminator fields
      const fields: string[] = [];
      for (const [propName, propSchema] of Object.entries(props)) {
        if (propName === "type" || propName === "kind") continue;

        const rustName = toSnakeCase(propName);
        let rustType = schemaToRustType(propSchema, schemas);

        if (!required.has(propName) && !rustType.startsWith("Option<")) {
          rustType = `Option<${rustType}>`;
        }

        const serdeRename = propName !== rustName ? `#[serde(rename = "${propName}")]\n        ` : "";
        const skipIfNone = !required.has(propName) ? `#[serde(skip_serializing_if = "Option::is_none", default)]\n        ` : "";
        fields.push(`        ${skipIfNone}${serdeRename}${rustName}: ${rustType},`);
      }

      if (fields.length === 0) {
        variantDefs.push(`    ${variantName},`);
      } else {
        variantDefs.push(`    ${variantName} {
${fields.join("\n")}
    },`);
      }
    } else if (variant.$ref) {
      // A variant that's a $ref to another schema
      const refName = refToRust(variant.$ref);
      variantDefs.push(`    ${refName}(${refName}),`);
    } else if (!variantDefs.some((definition) => definition.includes("    Unknown(serde_json::Value),"))) {
      // Unknown variant shape — use one catch-all for any number of opaque variants.
      variantDefs.push(`    /// Unknown variant (forward-compatible)\n    Unknown(serde_json::Value),`);
    }
  }

  const tag = schema.properties?.["type"] ? "type" : "kind";
  // Check which discriminator the variants actually use
  const usesType = variants.some((v) => v.properties?.["type"]);
  const usesKind = variants.some((v) => v.properties?.["kind"]);
  const actualTag = usesType ? "type" : usesKind ? "kind" : "type";

  const largeEnumAllow = new Set(["DaemonEvent", "StateDelta"]).has(name)
    ? `#[allow(clippy::large_enum_variant, reason = "generated wire type mirrors daemon OpenAPI shape")]\n`
    : "";

  return `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
${largeEnumAllow}#[serde(tag = "${actualTag}", rename_all = "snake_case")]
pub enum ${name} {
${variantDefs.join("\n")}
}`;
}

// ── Generate a Rust enum from a string enum schema ──────────────────
function generateStringEnum(name: string, schema: JsonSchema): string {
  const variants = schema.enum || [];

  // Check if values are snake_case (daemon convention) or camelCase
  const isSnakeCase = variants.every((v) => !v.includes("-") && (v === v.toLowerCase()));

  const renameAttr = isSnakeCase ? `#[serde(rename_all = "snake_case")]` : "";

  const variantDefs = variants.map((v) => {
    const variantName = toPascalCase(v);
    // If the original value isn't snake_case, we need a per-variant rename
    if (!isSnakeCase) {
      return `    #[serde(rename = "${v}")]\n    ${variantName},`;
    }
    return `    ${variantName},`;
  });

  return `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
${renameAttr}
pub enum ${name} {
${variantDefs.join("\n")}
}`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function toSnakeCase(s: string): string {
  // Convert camelCase to snake_case
  return s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function toPascalCase(s: string): string {
  // Convert snake_case or kebab-case to PascalCase
  return s
    .split(/[_\-\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

// ── Main codegen ─────────────────────────────────────────────────────

async function main() {
  const bin = resolveBin();

  // Capture the OpenAPI spec
  const result = await spawnAsync([bin, "openapi"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.code !== 0) {
    console.error(`polytoken openapi failed (exit ${result.code}): ${result.stderr}`);
    process.exit(1);
  }
  const openapiJson = result.stdout;

  // Capture the daemon version from `polytoken --version`.
  //
  // The OpenAPI spec's `info.version` is a static "0.1.0" that has never tracked
  // daemon releases, so it cannot serve as a compatibility target. Instead we
  // capture the CLI version at codegen time. The live corpus tests (AC.12 in the
  // remote-deployment master plan) remain the true spec-drift gate; this constant
  // is a floor, not a proof.
  const versionResult = await spawnAsync([bin, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (versionResult.code !== 0) {
    console.error(`polytoken --version failed (exit ${versionResult.code}): ${versionResult.stderr}`);
    process.exit(1);
  }
  const versionRaw = versionResult.stdout.trim();
  // Strip the leading "polytoken " prefix: "polytoken 0.5.0-unstable.9" → "0.5.0-unstable.9"
  const daemonVersion = versionRaw.replace(/^polytoken\s+/, "");
  const semverRe =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (!semverRe.test(daemonVersion)) {
    console.error(
      `polytoken --version returned an unparseable version: ${JSON.stringify(versionRaw)}`,
    );
    console.error(
      "  expected semver like '0.5.0' or '0.5.0-unstable.9' (with optional prerelease)",
    );
    process.exit(1);
  }

  const spec: OpenApiSpec = JSON.parse(openapiJson);
  const schemas = spec.components?.schemas;
  if (!schemas || !("DaemonEvent" in schemas)) {
    console.error("OpenAPI spec is missing DaemonEvent schema — cannot codegen safely.");
    process.exit(1);
  }

  // Generate Rust types
  const daemonEventNames = (schemas["DaemonEvent"]?.oneOf || []).flatMap((variant) => {
    const discriminant = variant.properties?.["type"] || variant.properties?.["kind"];
    const name = discriminant?.enum?.[0];
    return typeof name === "string" ? [name] : [];
  });
  const daemonEventNamesRust = daemonEventNames.map((name) => `    "${name}",`).join("\n");

  const parts: string[] = [
    `//! Auto-generated daemon wire types from \`polytoken openapi\`.
//!
//! This crate intentionally models the daemon's exhaustive wire vocabulary. Some
//! generated structs/enums/variants are unused by the Rust server until the daemon
//! bumps or a later porting phase wires that endpoint/event kind, so this generated
//! file keeps a crate-level dead_code allowance. Do not copy this pattern into
//! hand-written server modules; annotate those gaps at item level instead.
//!
//! Regenerate after a polytoken bump: \`just codegen-polytoken-rs\`
//! DO NOT EDIT MANUALLY.

#![allow(dead_code)]

// ── Compatibility target (sourced from \`polytoken --version\`, NOT OpenAPI) ──
//
// This constant is the polytoken daemon version this build was codegen'd against.
// Source: \`polytoken --version\` at codegen time. The OpenAPI spec's \`info.version\`
// is a static "0.1.0" that does NOT track daemon releases — do not use it as a
// compatibility target.
//
// This constant records the generation target only. Behavioral compatibility is
// checked separately by deterministic HTTP/SSE contracts, corpus replay, and live-path tests.
//
// Regenerate: \`just codegen-polytoken-rs\`
`,
    `//! Compatibility target: the polytoken daemon version this build was codegen'd
//! against. Sourced from \`polytoken --version\` at codegen, NOT from \`info.version\`
//! in the OpenAPI spec (which is a static "0.1.0"). This records the generation
//! target; deterministic contracts and live-path tests establish behavioral compatibility.
pub const POLYTOKEN_DAEMON_TARGET_VERSION: &str = "${daemonVersion}";

/// Public-schema-derived wire names for every current \`DaemonEvent\` variant.
/// Handwritten compatibility code compares its explicit dispositions to this
/// constant so a newly generated event cannot remain silently unclassified.
pub const DAEMON_EVENT_VARIANT_NAMES: &[&str] = &[
${daemonEventNamesRust}
];
`,
  ];

  // First pass: collect string enums (so we can reference them from structs)
  const enumSchemas = new Set<string>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.enum && (schema.type === "string" || !schema.type)) {
      enumSchemas.add(name);
    }
  }

  // Generate enums first
  for (const name of sortedKeys(schemas)) {
    const schema = schemas[name];
    if (!schema) continue;
    if (enumSchemas.has(name)) {
      parts.push(generateStringEnum(name, schema));
      parts.push("");
    }
  }

  // Generate structs and discriminated unions
  for (const name of sortedKeys(schemas)) {
    if (enumSchemas.has(name)) continue;

    const schema = schemas[name];
    if (!schema) continue;

    // Skip type aliases (simple $ref schemas)
    if (schema.$ref) {
      parts.push(`pub type ${name} = ${refToRust(schema.$ref)};`);
      parts.push("");
      continue;
    }

    // oneOf with a discriminator → enum
    if (schema.oneOf) {
      // Check if this is a discriminated union (variants have `type` or `kind`)
      const isDiscriminated = schema.oneOf.some(
        (v) => v.properties?.["type"] || v.properties?.["kind"],
      );
      if (isDiscriminated) {
        parts.push(generateDiscriminatedEnum(name, schema, schemas));
        parts.push("");
        continue;
      }
      // Non-discriminated oneOf → use serde_json::Value
      parts.push(`pub type ${name} = serde_json::Value;`);
      parts.push("");
      continue;
    }

    // allOf → usually a struct extending another
    if (schema.allOf) {
      const ref = schema.allOf.find((s) => s.$ref);
      if (ref) {
        // It's a type that extends another — for now, alias
        // (most allOf in this spec are intersection types)
        parts.push(`pub type ${name} = ${refToRust(ref.$ref!)};`);
        parts.push("");
        continue;
      }
    }

    // Object → struct
    if (schema.type === "object" || schema.properties) {
      // Check if it's a wrapper (only one property that's the full value)
      const propKeys = Object.keys(schema.properties || {});
      if (propKeys.length === 0 && schema.additionalProperties) {
        // It's a map type
        if (typeof schema.additionalProperties === "object") {
          parts.push(`pub type ${name} = std::collections::HashMap<String, ${schemaToRustType(schema.additionalProperties, schemas)}>;`);
        } else {
          parts.push(`pub type ${name} = std::collections::HashMap<String, serde_json::Value>;`);
        }
        parts.push("");
        continue;
      }
      parts.push(generateStruct(name, schema, schemas));
      parts.push("");
      continue;
    }

    // Simple type alias
    if (schema.type === "string") {
      parts.push(`pub type ${name} = String;`);
      parts.push("");
      continue;
    }
    if (schema.type === "integer") {
      const intType = schema.format === "int64" ? "i64" : "i32";
      parts.push(`pub type ${name} = ${intType};`);
      parts.push("");
      continue;
    }

    // Fallback
    parts.push(`pub type ${name} = serde_json::Value;`);
    parts.push("");
  }

  const output = parts.join("\n");
  writeFileSync(OUT_PATH, output);
  const rustfmt = spawnSync("rustfmt", [OUT_PATH], { stdio: "inherit" });
  if (rustfmt.status !== 0) {
    console.error("rustfmt failed on generated daemon types");
    process.exit(rustfmt.status ?? 1);
  }

  // Count variants in DaemonEvent for the summary
  const daemonEvent = schemas["DaemonEvent"];
  const variantCount = daemonEvent?.oneOf?.length ?? 0;

  console.log(
    `✓ generated ${OUT_PATH.replace(SCRIPT_DIR + "/../", "")} ` +
      `(${output.split("\n").length} lines, ${Object.keys(schemas).length} schemas, ` +
      `${variantCount} DaemonEvent variants)`,
  );
  console.log("  regenerate after a polytoken bump: just codegen-polytoken-rs");
}

function sortedKeys<T>(obj: Record<string, T>): string[] {
  return Object.keys(obj).sort();
}

await main();
