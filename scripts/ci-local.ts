import { cpus, platform } from "node:os";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

export type Host = "linux" | "macos";
export type GateName = "web-check" | "web-e2e" | "web-live" | "rust-server" | "desktop" | "buck2";
export type GateStatus = "passed" | "failed" | "skipped" | "blocked";
export interface GateResult { name: GateName; status: GateStatus; exitCode: number; logPath?: string; reason?: string; }
export interface GateSpec { name: GateName; commands: string[]; env?: Record<string, string>; host?: Host; }
export interface RunnerOptions {
  host?: Host;
  cpuCount?: number;
  mockPartitions?: number;
  shardCount?: number;
  vitePortBase?: number;
  liveVitePort?: number;
  logRoot?: string;
  retainLogs?: boolean;
  selectedGates?: GateName[];
  env?: NodeJS.ProcessEnv;
  execute?: (spec: GateSpec, logPath: string) => Promise<number>;
}

export const GATE_NAMES: GateName[] = ["web-check", "web-e2e", "web-live", "rust-server", "desktop", "buck2"];
export const usefulMockPartitions = 4;

export function currentHost(value = platform()): Host | undefined {
  if (value === "linux") return "linux";
  if (value === "darwin") return "macos";
  return undefined;
}

export function mockShardCount(cpuCount = cpus().length, usefulPartitions = usefulMockPartitions, ceiling = 4): number {
  if (!Number.isFinite(cpuCount) || cpuCount < 1) throw new Error("CPU count must be positive");
  return Math.max(1, Math.min(Math.floor(cpuCount), Math.floor(usefulPartitions), Math.floor(ceiling)));
}

export function mockShardPorts(count: number, base = 15173, stride = 10): number[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("shard count must be positive");
  if (!Number.isInteger(base) || !Number.isInteger(stride) || stride < 1) throw new Error("invalid port allocation");
  return Array.from({ length: count }, (_, index) => base + index * stride);
}

export function selectGates(host = currentHost()): Array<{ name: GateName; status: "applicable" | "skipped"; reason?: string }> {
  const unavailable = (name: GateName) => ({ name, status: "skipped" as const, reason: "host unavailable" });
  const result: Array<{ name: GateName; status: "applicable" | "skipped"; reason?: string }> = [
    { name: "web-check", status: host === "linux" ? "applicable" : "skipped", ...(host === "linux" ? {} : unavailable("web-check")) },
    { name: "web-e2e", status: host === "linux" ? "applicable" : "skipped", ...(host === "linux" ? {} : unavailable("web-e2e")) },
    { name: "web-live", status: host === "linux" ? "applicable" : "skipped", ...(host === "linux" ? {} : unavailable("web-live")) },
    { name: "rust-server", status: host === "linux" ? "applicable" : "skipped", ...(host === "linux" ? {} : unavailable("rust-server")) },
    host === "macos" ? { name: "desktop", status: "applicable" } : unavailable("desktop"),
    host === "macos" ? { name: "buck2", status: "applicable" } : unavailable("buck2"),
  ];
  return result;
}

export interface PrerequisiteCheck { command: string; requiredBy: GateName[]; available: boolean; }
export function prerequisiteChecks(host = currentHost()): PrerequisiteCheck[] {
  const checks: PrerequisiteCheck[] = [
    { command: "pnpm", requiredBy: ["web-check", "web-e2e", "web-live", "desktop"], available: false },
    { command: "just", requiredBy: ["web-e2e", "web-live", "rust-server", "buck2"], available: false },
  ];
  if (host === "linux" || host === "macos") checks.push(
    { command: "cargo", requiredBy: ["rust-server", "desktop", "buck2"], available: false },
    { command: "buck2", requiredBy: ["rust-server", "buck2", "web-e2e", "web-live"], available: false },
    { command: "python3", requiredBy: ["rust-server", "buck2"], available: false },
    ...(host === "macos" ? [{ command: "cargo-nextest", requiredBy: ["desktop"] as GateName[], available: false }] : []),
  );
  return checks;
}

async function commandOnPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of (env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      await access(resolve(directory, command), constants.X_OK);
      return true;
    } catch { /* keep checking PATH entries */ }
  }
  return false;
}

export async function resolvePrerequisites(host = currentHost(), env: NodeJS.ProcessEnv = process.env, which: (command: string) => Promise<boolean> = (command) => commandOnPath(command, env)): Promise<{ checks: PrerequisiteCheck[]; blocked: string[] }> {
  const selected = new Set(selectGates(host).filter((gate) => gate.status === "applicable").map((gate) => gate.name));
  const checks = prerequisiteChecks(host);
  const blocked: string[] = [];
  for (const check of checks) {
    check.available = await which(check.command);
    if (!check.available && check.requiredBy.some((gate) => selected.has(gate))) blocked.push(`${check.command} (required by ${check.requiredBy.filter((gate) => selected.has(gate)).join(", ")})`);
  }
  return { checks, blocked };
}

function requirePath(_directory: string, _command: string): boolean {
  // The default is intentionally conservative and replaced by the CLI's `command -v` probe.
  return false;
}

export function gateSpecs(options: RunnerOptions = {}): GateSpec[] {
  const host = options.host ?? currentHost();
  const shards = options.shardCount ?? mockShardCount(options.cpuCount);
  const ports = mockShardPorts(shards, options.vitePortBase ?? 15173);
  const specs: GateSpec[] = [
    { name: "web-check", commands: ["pnpm run check", "pnpm run test"] },
    { name: "web-e2e", commands: ports.map((port, i) => `PANTOKEN_E2E_VITE_PORT=${port} pnpm run test:e2e --shard=${i + 1}/${shards}`) },
    { name: "web-live", commands: [`PANTOKEN_E2E_LIVE_VITE_PORT=${options.liveVitePort ?? 15273} pnpm run test:e2e:live`], env: { PANTOKEN_DRIVER: "fake" } },
  ];
  if (host === "linux") specs.push({ name: "rust-server", commands: ["cargo fmt --all -- --check", "bash scripts/ci/retry-transient.sh 'just buck2-clippy'", "bash scripts/ci/retry-transient.sh 'just build-rs && just build-server-rs'", "just test-rs", "just targets-check-rs", "just test-inventory-check-rs"] });
  if (host === "macos") {
    specs.push({ name: "desktop", commands: ["pnpm run build", "bash scripts/ci/retry-transient.sh 'pnpm exec tsx scripts/desktop/build-hub.ts --debug'", "pnpm run test", "cargo fmt --check -p pantoken-desktop", "cargo clippy --locked -p pantoken-desktop --all-targets -- -D warnings", "cargo nextest run -p pantoken-desktop"] });
    specs.push({ name: "buck2", commands: ["bash scripts/ci/retry-transient.sh 'just buck2-clippy'", "bash scripts/ci/retry-transient.sh 'just build-rs && just build-server-rs'", "just test-rs", "just targets-check-rs", "just test-inventory-check-rs"] });
  }
  return specs;
}

const activeChildren = new Set<ReturnType<typeof spawn>>();
process.once("SIGINT", () => { terminateChildren(); process.exitCode = 130; });
process.once("SIGTERM", () => { terminateChildren(); process.exitCode = 143; });

function terminateChildren(): void {
  for (const child of activeChildren) {
    if (child.pid && !child.killed) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  }
}

async function executeCommand(gate: GateName, command: string, env: NodeJS.ProcessEnv, chunks: Buffer[]): Promise<number> {
  return await new Promise((resolveCode) => {
    const startedAt = Date.now();
    console.log(`[ci-local] ${gate}: starting ${command}`);
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[ci-local] ${gate}: still running (${elapsed}s)`);
    }, 60_000);
    const child = spawn("bash", ["-o", "pipefail", "-c", command], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    activeChildren.add(child);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) => {
      clearInterval(heartbeat);
      activeChildren.delete(child);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[ci-local] ${gate}: ${code === 0 ? "passed" : `failed (exit ${code ?? 1})`} after ${elapsed}s: ${command}`);
      resolveCode(code ?? 1);
    });
    child.on("error", (error) => {
      clearInterval(heartbeat);
      activeChildren.delete(child);
      chunks.push(Buffer.from(String(error)));
      console.log(`[ci-local] ${gate}: failed to start after ${Math.round((Date.now() - startedAt) / 1000)}s: ${command}`);
      resolveCode(1);
    });
  });
}

async function executeProcess(spec: GateSpec, logPath: string, env: NodeJS.ProcessEnv): Promise<number> {
  const chunks: Buffer[] = [];
  const mergedEnv = { ...env, ...spec.env };
  // Playwright's mock shards are independent CI processes. Run them concurrently;
  // each has its own Vite port and dev.ts auto-assigns its backend/data ports.
  const codes = spec.name === "web-e2e"
    ? await Promise.all(spec.commands.map((command) => executeCommand(spec.name, command, mergedEnv, chunks)))
    : [];
  if (spec.name !== "web-e2e") {
    for (const command of spec.commands) {
      const code = await executeCommand(spec.name, command, mergedEnv, chunks);
      codes.push(code);
      if (code !== 0) break;
    }
  }
  await writeFile(logPath, Buffer.concat(chunks));
  return codes.some((code) => code !== 0) ? 1 : 0;
}

export async function runGates(options: RunnerOptions = {}): Promise<GateResult[]> {
  const root = resolve(options.logRoot ?? "target/ci-local", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(root, { recursive: true });
  const selected = new Set(options.selectedGates ?? GATE_NAMES);
  const host = options.host ?? currentHost();
  const applicable = new Set(selectGates(host).filter((gate) => gate.status === "applicable").map((gate) => gate.name));
  const selectedSpecs = gateSpecs(options).filter((spec) => selected.has(spec.name) && applicable.has(spec.name));
  const results: GateResult[] = selectGates(host).filter((gate) => !selected.has(gate.name) || gate.status === "skipped").map((gate) => ({ name: gate.name, status: "skipped", exitCode: 0, reason: gate.reason ?? "not selected" }));
  const execute = options.execute ?? ((spec, logPath) => executeProcess(spec, logPath, options.env ?? process.env));
  const launched = await Promise.all(selectedSpecs.map(async (spec) => {
    const logPath = resolve(root, `${spec.name}.log`);
    const code = await execute(spec, logPath);
    const result: GateResult = { name: spec.name, status: code === 0 ? "passed" : "failed", exitCode: code, logPath };
    if (code === 0 && !options.retainLogs) await rm(logPath, { force: true });
    return result;
  }));
  results.push(...launched);
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

export async function main(): Promise<number> {
  const env = process.env;
  const host = currentHost();
  const prerequisites = await resolvePrerequisites(host, env, async (command) => await new Promise<boolean>((resolveProbe) => {
    const child = spawn("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    child.on("close", (code) => resolveProbe(code === 0));
    child.on("error", () => resolveProbe(false));
  }));
  if (prerequisites.blocked.length) { console.error(`BLOCKED: missing applicable prerequisites: ${prerequisites.blocked.join(", ")}`); return 1; }
  const results = await runGates({ host, cpuCount: Number(env.PANTOKEN_CI_CPUS) || undefined, shardCount: Number(env.PANTOKEN_CI_E2E_SHARDS) || undefined, retainLogs: env.PANTOKEN_CI_RETAIN_LOGS === "1" });
  for (const result of results) console.log(`${result.name}: ${result.status.toUpperCase()}${result.reason ? ` (${result.reason})` : ""}${result.logPath ? ` — ${result.logPath}` : ""}`);
  return results.some((result) => result.status === "failed" || result.status === "blocked") ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
