import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const self = resolve(import.meta.filename);
const extensions = /\.(?:rs|ts|tsx|js|mjs|cjs)$/;
const rustMutation = /(?:std::env::|\benv::)(?:set_var|remove_var)\s*\(/;
const jsMutation = /(?:process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=(?!=)|delete\s+process\.env(?:\.|\[)|process\.env\s*=(?!=))/;

function isTestOrSupportFile(path: string, source: string): boolean {
  const name = relative(root, path).replaceAll("\\", "/");
  return (
    /(?:^|\/)(?:test|tests|__tests__|fixtures|support|helpers)(?:\/|$)/.test(name) ||
    /(?:\.test|\.spec|_test)\.[^.]+$/.test(name) ||
    /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(source)
  );
}

const violations: string[] = [];
for (const path of globSync("**/*", { cwd: root })) {
  const absolute = resolve(root, path);
  if (!statSync(absolute).isFile()) continue;
  if (
    absolute === self ||
    !extensions.test(path) ||
    /^(?:buck-out|target|node_modules|\.git)(?:\/|$)/.test(path)
  ) continue;
  const source = readFileSync(absolute, "utf8");
  const pattern = absolute.endsWith(".rs") ? rustMutation : jsMutation;
  if (!pattern.test(source)) continue;
  if (isTestOrSupportFile(absolute, source)) {
    const line = source.split("\n").findIndex((value) => pattern.test(value)) + 1;
    violations.push(`${relative(root, absolute)}:${line}`);
  }
}

if (violations.length > 0) {
  console.error("Forbidden parent environment mutation in test/support code:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
