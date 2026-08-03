import fs from "node:fs";

const source = fs.readFileSync("e2e/polish.e2e.ts", "utf8");
const titles = [
  "Ctrl/Cmd+Up/Down step through user prompts",
  "prev/next prompt-nav buttons are visible on hover and step through prompts",
];

function extractBody(title) {
  const marker = `test(\"${title}\"`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing target test: ${title}`);
  const arrow = source.indexOf("=> {", start);
  if (arrow < 0) throw new Error(`Missing body: ${title}`);
  const open = arrow + 3;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let comment = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (comment === "line") {
      if (ch === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (ch === "*" && next === "/") { comment = null; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (quote === "`" && ch === "$") continue;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") { comment = "line"; i += 1; continue; }
    if (ch === "/" && next === "*") { comment = "block"; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`Unbalanced body: ${title}`);
}

function requireBody(body, pattern, description) {
  if (!pattern.test(body)) throw new Error(`Missing ${description}`);
}

function rejectBody(body, pattern, description) {
  if (pattern.test(body)) throw new Error(`Forbidden ${description}`);
}

const [keyboard, hover] = titles.map(extractBody);
for (const body of [keyboard, hover]) {
  rejectBody(body, /page\\s*\\.\\s*waitForTimeout\\s*\\(\\s*50\\s*\\)/, "50ms viewport sleep");
  rejectBody(
    body,
    /getByTestId\\(\\s*[\"']prompt-nav-(?:up|down)[\"']\\s*\\)[\\s\\S]{0,160}\\.press\\(\\s*[\"']Enter[\"']\\s*\\)/,
    "Enter activation of prompt navigation",
  );
}
requireBody(keyboard, /atPrompt\(page,\s*i\)/, "indexed keyboard prompt assertions");
requireBody(keyboard, /for\s*\(\s*let\s+i\s*=\s*last;[\s\S]*?i\s*--\s*\)/, "upward traversal");
requireBody(keyboard, /for\s*\(\s*let\s+i\s*=\s*1;[\s\S]*?i\s*<=\s*last/, "downward traversal");
requireBody(keyboard, /waitForPrompt\(page,\s*0\)/, "oldest clamp");
requireBody(keyboard, /atBottom/, "live-bottom assertion");
requireBody(hover, /atPrompt\(page,\s*i\)/, "indexed hover prompt assertions");
requireBody(hover, /waitForPrompt\(page,\s*0\)/, "hover oldest clamp");
requireBody(hover, /upBtn[\s\S]*?toBeVisible\(\)/, "up button visibility");
requireBody(hover, /downBtn[\s\S]*?toBeVisible\(\)/, "down button visibility");
requireBody(hover, /title.*Previous prompt/, "previous tooltip");
requireBody(hover, /title.*Next prompt/, "next tooltip");
console.log("prompt navigation regression checks passed");
