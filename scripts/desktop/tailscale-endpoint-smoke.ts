import { request } from "node:https";

export type EndpointClass = "endpoint-unverified" | "wrong-target" | "hub-unavailable" | "authentication-failure" | "healthy";
export type ProbeResult = { status: number; body?: unknown; transport?: "tls" | "parse" | "timeout" | "connection" };

export function classifyEndpoint(result: ProbeResult): EndpointClass {
  if (result.transport) return "endpoint-unverified";
  if (result.status === 401 || result.status === 403) return "authentication-failure";
  if (result.status >= 500) return "hub-unavailable";
  if (result.status < 200 || result.status >= 300) return "endpoint-unverified";
  const body = result.body as { service?: unknown } | undefined;
  return body?.service === "pantoken-server" ? "healthy" : "wrong-target";
}

function parseOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" && origin.pathname !== "") {
    throw new Error("origin must be an HTTPS host URL without credentials or a path");
  }
  origin.pathname = "/health";
  return origin;
}

function probe(url: URL, token: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = request(url, { headers: { authorization: `Bearer ${token}` }, timeout: 5000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let body: unknown;
        try { body = JSON.parse(text); } catch { resolve({ status: res.statusCode ?? 0, transport: "parse" }); return; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, transport: "timeout" }); });
    req.on("error", () => resolve({ status: 0, transport: "connection" }));
    req.end();
  });
}

async function main() {
  if (process.argv.includes("--unit")) {
    const cases: Array<[ProbeResult, EndpointClass]> = [
      [{ status: 200, body: { service: "pantoken-server" } }, "healthy"],
      [{ status: 200, body: { service: "other" } }, "wrong-target"],
      [{ status: 401 }, "authentication-failure"],
      [{ status: 503 }, "hub-unavailable"],
      [{ status: 0, transport: "tls" }, "endpoint-unverified"],
      [{ status: 200, body: {} }, "wrong-target"],
    ];
    for (const [input, expected] of cases) if (classifyEndpoint(input) !== expected) throw new Error(`classifier mismatch for ${expected}`);
    console.log("tailscale endpoint classifier: ok");
    return;
  }
  const originArg = process.argv.find((arg) => arg === "--origin") ? process.argv[process.argv.indexOf("--origin") + 1] : process.env.PANTOKEN_TAILSCALE_ORIGIN;
  if (!originArg) { console.log("SKIP: provide --origin <HTTPS-origin> or PANTOKEN_TAILSCALE_ORIGIN"); return; }
  const token = process.env.PANTOKEN_REMOTE_TOKEN;
  if (!token) throw new Error("PANTOKEN_REMOTE_TOKEN is required for the opt-in smoke");
  let result: ProbeResult;
  try { result = await probe(parseOrigin(originArg), token); } catch { result = { status: 0, transport: "tls" }; }
  const classification = classifyEndpoint(result);
  console.log(classification);
  if (classification !== "healthy") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
