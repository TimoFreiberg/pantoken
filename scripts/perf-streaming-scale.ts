// Scaling check: does the per-token re-parse cost grow with answer length (O(n²))?
// Measures one full stream at increasing answer sizes.

import { foldEvent, initialSessionState } from "../protocol/src/index.js";

const parserPath = require.resolve("stream-markdown-parser", {
  paths: [`${process.cwd()}/client`],
});
const { parseMarkdownToStructure, getMarkdown } = await import(parserPath);

const markdown = getMarkdown("perf-scale", { customHtmlTags: [] });

const PARA = `Here is a paragraph with some \`inline code\` and a [link](https://example.com) and **bold** text to make the parser do real work. `;

function buildAnswer(repeats: number): string {
  let s = `Sure, here's a longer answer.\n\n`;
  for (let i = 0; i < repeats; i++) s += PARA + "\n\n";
  s += "```\nconst x = finalCode();\n```\n";
  return s;
}

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

function baseEvent(sessionId: string) {
  return {
    sessionRef: { sessionId, workspaceId: sessionId },
    timestamp: new Date().toISOString(),
  };
}

function streamAndReparse(answer: string) {
  const state = initialSessionState();
  const base = baseEvent("scale");
  foldEvent(state, { ...base, type: "userMessage", id: "u1", text: "go" });
  const deltas = toDeltas(answer);
  let text = "";
  for (const d of deltas) {
    foldEvent(state, {
      ...base,
      type: "assistantDelta",
      text: d,
      channel: "text",
    });
    text += d;
    parseMarkdownToStructure(text, markdown, { final: false });
  }
}

console.log(
  "answer chars | deltas | total ms | ms/delta | ms per 1k chars streamed\n",
);
console.log("-".repeat(72));
for (const repeats of [2, 5, 10, 20, 40, 80]) {
  const answer = buildAnswer(repeats);
  const deltas = toDeltas(answer);
  // warmup
  streamAndReparse(answer);
  const start = performance.now();
  const ITERS = 3;
  for (let i = 0; i < ITERS; i++) streamAndReparse(answer);
  const total = (performance.now() - start) / ITERS;
  const perDelta = total / deltas.length;
  const perK = (total / answer.length) * 1000;
  console.log(
    `${String(answer.length).padStart(11)} | ${String(deltas.length).padStart(6)} | ${total.toFixed(1).padStart(7)} | ${perDelta.toFixed(2).padStart(7)} | ${perK.toFixed(2).padStart(6)}`,
  );
}
console.log(
  "\nIf ms-per-1k-chars-streamed climbs with size, the per-token path is super-linear (O(n²)).",
);
