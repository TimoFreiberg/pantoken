// Adds a `// Journey: <title>` comment above every `test(` / `test.fixme(`
// declaration that isn't already preceded by a `//` comment line. Idempotent.
// Usage: node .e2e-add-journey-comments.mjs <file...>
import { readFileSync, writeFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  let prev = "";
  let changed = 0;
  for (const line of lines) {
    const m = line.match(/^(\s*)test(?:\.fixme)?\(\s*"((?:[^"\\]|\\.)*)"/);
    if (m && !prev.trimStart().startsWith("//")) {
      out.push(`${m[1]}// Journey: ${m[2]}`);
      changed++;
    }
    out.push(line);
    if (line.trim() !== "") prev = line;
  }
  if (changed) writeFileSync(file, out.join("\n"));
  console.log(`${file}: +${changed} journey comments`);
}
