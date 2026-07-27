import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, beforeEach, afterEach } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const CREATE = join(dir, "..", "create-workspace.sh");
const CLEAN = join(dir, "..", "cleanup-current-workspace.sh");
const jjAvailable = spawnSync("jj", ["--version"]).status === 0;
const describeOrSkip = jjAvailable ? describe : describe.skip;
let repo: string;
function run(command: string[], cwd: string) { const r = spawnSync(command[0]!, command.slice(1), { cwd, env: process.env, encoding: "utf8", timeout: 20_000 }); return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" }; }
function init() { run(["git", "init"], repo); run(["jj", "git", "init", "--colocate"], repo); run(["jj", "describe", "-m", "base"], repo); run(["jj", "bookmark", "set", "main", "-r", "@"], repo); }
function ws(name = "issue-1") { return join(repo, ".workspaces", name); }

beforeEach(() => { repo = mkdtempSync(join(process.env.TMPDIR || "/tmp", "workspace-lifecycle-")); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describeOrSkip("workspace lifecycle scripts", () => {
  test("creator creates default-main workspace and prints pushd", () => { init(); const r = run(["bash", CREATE, "issue-1"], repo); expect(r.code).toBe(0); expect(r.out).toContain(`pushd ${run(["pwd", "-P"], repo).out.trim()}/.workspaces/issue-1`); expect(existsSync(ws())).toBe(true); });
  test("creator honors explicit revision", () => { init(); writeFileSync(join(repo, "rev.txt"), "rev\n"); run(["jj", "describe", "-m", "revision"], repo); const revision = run(["jj", "log", "-r", "@", "-T", "commit_id"], repo).out.match(/[0-9a-f]{40}/)?.[0] ?? ""; run(["jj", "new", "main"], repo); const r = run(["bash", CREATE, "issue-2", revision], repo); expect(r.code).toBe(0); expect(run(["jj", "log", "-r", "issue-2@", "--no-graph", "-T", "parents.map(|c| c.commit_id())"], repo).out).toContain(revision.slice(0, 12)); });
  test("creator rejects invalid name, revision, collision, and non-default context", () => { init(); expect(run(["bash", CREATE, "../escape"], repo).code).not.toBe(0); expect(run(["bash", CREATE, "bad", "not-a-revision"], repo).code).not.toBe(0); expect(run(["bash", CREATE, "issue-1"], repo).code).toBe(0); const before = run(["jj", "workspace", "list"], repo).out; expect(run(["bash", CREATE, "issue-1"], repo).code).not.toBe(0); expect(run(["jj", "workspace", "list"], repo).out).toBe(before); expect(run(["bash", CREATE, "issue-2"], ws()).code).not.toBe(0); });
  test("cleanup rejects dirty workspace and preserves registration", () => { init(); expect(run(["bash", CREATE, "issue-1"], repo).code).toBe(0); writeFileSync(join(ws(), "dirty.txt"), "dirty\n"); const r = run(["bash", CLEAN], ws()); expect(r.code).not.toBe(0); expect(existsSync(ws())).toBe(true); expect(run(["jj", "workspace", "list"], repo).out).toContain("issue-1"); });
  test("cleanup forgets and removes integrated clean workspace", () => { init(); expect(run(["bash", CREATE, "issue-1"], repo).code).toBe(0); const r = run(["bash", CLEAN], ws()); expect(r.code).toBe(0); expect(r.out).toContain("now run popd"); expect(existsSync(ws())).toBe(false); expect(run(["jj", "workspace", "list"], repo).out).not.toContain("issue-1"); });
  test("cleanup rejects default workspace", () => { init(); const r = run(["bash", CLEAN], repo); expect(r.code).not.toBe(0); });
});
