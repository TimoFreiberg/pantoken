// A focused, deterministic perf measurement of the per-token hot path:
//   foldEvent(state, assistantDelta)  →  parseMarkdownToStructure(content)
// which is exactly what runs on every streamed token in the real app
// (server folds + forwards one assistantDelta per token; client folds the
// same event into the same SessionState and markstream re-parses the whole
// bubble content on each content change).
//
// This isolates the dominant per-token cost (C1 in the analysis) without a
// browser, and lets us compare "re-parse whole bubble per token" (today)
// against a hypothetical coalesced / batched variant. Run:
//   bun run scripts/perf-streaming.ts

import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { foldEvent, initialSessionState } from "../protocol/src/index.js";

// Resolve the real parser the app uses (a transitive dep of markstream-svelte).
// Two hops because Bun ignores require.resolve's `paths` option and the
// isolated-install store keeps transitive deps out of client/node_modules:
// resolve markstream-svelte from client/, realpath into the store (where its
// deps are siblings), then resolve the parser from there.
const markstreamReal = realpathSync(
  Bun.resolveSync("markstream-svelte", `${process.cwd()}/client`),
);
const parserPath = Bun.resolveSync(
  "stream-markdown-parser",
  dirname(markstreamReal),
);
const { parseMarkdownToStructure, getMarkdown } = await import(parserPath);

// A representative long assistant answer: prose + a fenced code block + a list,
// the kind that's expensive to re-parse per token.
const ANSWER = `I'll add a lightweight health endpoint and a test that hits it.

Let me look at how routes are currently registered. The server uses \`Bun.serve\`
with a fetch handler that switches on \`url.pathname\`, so a new route is one branch.

\`\`\`ts
// server/src/index.ts
if (url.pathname === "/health") {
  return Response.json({ ok: true, ts: Date.now() });
}
\`\`\`

The test hits it with the real server on an ephemeral port:

\`\`\`ts
import { test, expect } from "bun:test";

test("GET /health returns ok", async () => {
  const res = await fetch(\`http://localhost:\${port}/health\`);
  expect(res.ok).toBe(true);
  const body = await res.json();
  expect(body.ok).toBe(true);
});
\`\`\`

A few notes:

- Keep the handler synchronous so it never blocks the event loop.
- Return a stable shape so a probe can alert on a missing field.
- Don't log here — it's a hot path polled every few seconds.

That should be enough to wire up a green smoke test.`;

// Split into ~3-word deltas, exactly like the mock's deltas() helper (fixtures.ts).
function toDeltas(text: string, chunk = 3): string[] {
  const words = text.split(/(\s+)/);
  const deltas: string[] = [];
  let buf = "";
  let n = 0;
  for (const w of words) {
    buf += w;
    if (++n % chunk === 0) {
      deltas.push(buf);
      buf = "";
    }
  }
  if (buf) deltas.push(buf);
  return deltas;
}

function baseEvent(sessionId: string): {
  sessionRef: { sessionId: string; workspaceId: string };
  timestamp: string;
} {
  return {
    sessionRef: { sessionId, workspaceId: sessionId },
    timestamp: new Date().toISOString(),
  };
}

function measure(label: string, fn: () => void, iters: number) {
  // warm up
  for (let i = 0; i < Math.min(3, iters); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const total = performance.now() - start;
  return { label, iters, totalMs: total, perOpMs: total / iters };
}

const markdown = getMarkdown("perf", { customHtmlTags: [] });

// --- Scenario 1: fold one assistant turn token-by-token (the server+client fold cost) ---
function foldStream() {
  const state = initialSessionState();
  const base = baseEvent("s1");
  foldEvent(state, {
    ...base,
    type: "userMessage",
    id: "u1",
    text: "add a health route",
  });
  const deltas = toDeltas(ANSWER);
  for (const d of deltas) {
    foldEvent(state, {
      ...base,
      type: "assistantDelta",
      text: d,
      channel: "text",
    });
  }
}

// --- Scenario 2: fold + re-parse the WHOLE bubble per token (today's client cost) ---
function foldAndReparseStream() {
  const state = initialSessionState();
  const base = baseEvent("s2");
  foldEvent(state, {
    ...base,
    type: "userMessage",
    id: "u1",
    text: "add a health route",
  });
  const deltas = toDeltas(ANSWER);
  let text = "";
  for (const d of deltas) {
    foldEvent(state, {
      ...base,
      type: "assistantDelta",
      text: d,
      channel: "text",
    });
    text += d;
    // This is what markstream's parsedNodes $derived does on every content change.
    parseMarkdownToStructure(text, markdown, { final: false });
  }
}

// --- Scenario 3 (hypothetical): parse only every Nth token (coalesced) ---
function foldAndCoalescedParse(batch: number) {
  const state = initialSessionState();
  const base = baseEvent("s3");
  foldEvent(state, {
    ...base,
    type: "userMessage",
    id: "u1",
    text: "add a health route",
  });
  const deltas = toDeltas(ANSWER);
  let text = "";
  let sinceParse = 0;
  for (const d of deltas) {
    foldEvent(state, {
      ...base,
      type: "assistantDelta",
      text: d,
      channel: "text",
    });
    text += d;
    if (++sinceParse >= batch) {
      parseMarkdownToStructure(text, markdown, { final: false });
      sinceParse = 0;
    }
  }
  // final parse at the end
  parseMarkdownToStructure(text, markdown, { final: true });
}

const ITERS = 5;
const deltas = toDeltas(ANSWER);
console.log(
  `Answer length: ${ANSWER.length} chars across ${deltas.length} deltas (~${deltas.length} tokens)\n`,
);

const fold = measure("fold only (per token, no parse)", foldStream, ITERS);
const full = measure(
  "fold + re-parse whole bubble per token (TODAY)",
  foldAndReparseStream,
  ITERS,
);
const c2 = measure(
  "fold + parse every 2nd token (coalesced x2)",
  () => foldAndCoalescedParse(2),
  ITERS,
);
const c5 = measure(
  "fold + parse every 5th token (coalesced x5)",
  () => foldAndCoalescedParse(5),
  ITERS,
);
const c10 = measure(
  "fold + parse every 10th token (coalesced x10)",
  () => foldAndCoalescedParse(10),
  ITERS,
);

function row(r: { label: string; totalMs: number; perOpMs: number }) {
  return `${r.label.padEnd(52)} ${r.totalMs.toFixed(1).padStart(7)}ms total  (${r.perOpMs.toFixed(2)}ms/stream)`;
}

console.log(row(fold));
console.log(row(full));
console.log(row(c2));
console.log(row(c5));
console.log(row(c10));

console.log(
  `\nRe-parse overhead per full stream: ${(full.totalMs - fold.totalMs).toFixed(1)}ms ` +
    `(${(((full.totalMs - fold.totalMs) / full.totalMs) * 100).toFixed(0)}% of today's cost).`,
);
console.log(
  `Coalescing x5 saves ${(((full.totalMs - c5.totalMs) / full.totalMs) * 100).toFixed(0)}% of that.`,
);
console.log(
  `Coalescing x10 saves ${(((full.totalMs - c10.totalMs) / full.totalMs) * 100).toFixed(0)}% of that.`,
);
