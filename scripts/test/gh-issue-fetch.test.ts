import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "gh-issue-fetch.sh");

let tempDir: string;
let fakeBin: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "gh-fetch-test-"));
  fakeBin = join(tempDir, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a fake gh binary that prints canned issue JSON. */
function writeFakeGh(json: string): void {
  writeFileSync(join(fakeBin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${json}\nJSON\n`);
  chmod(join(fakeBin, "gh"));
}

/** Write a fake curl that serves tiny images based on URL extension. */
function writeFakeCurl(): void {
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  *.png) ct="image/png" ;;
  *.jpg) ct="image/jpeg" ;;
  *.svg) ct="image/svg+xml" ;;
  *.gif) ct="image/gif" ;;
  *) ct="text/html" ;;
esac
hdr=""; out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-D" ]; then shift; hdr="$1"; fi
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
printf 'HTTP/1.1 200 OK\\r\\nContent-Type: %s\\r\\n\\r\\n' "$ct" > "$hdr"
printf 'fake-image-data' > "$out"
echo "200"
`,
  );
  chmod(join(fakeBin, "curl"));
}

function chmod(path: string): void {
  spawnSync("chmod", ["+x", path]);
}

function runScript(issueNumber: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [SCRIPT, issueNumber], {
    cwd: tempDir,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

describe("gh-issue-fetch.sh (AC.1)", () => {
  test("gh_issue_fetch_downloads_and_writes: fetches issue, downloads images, writes issue.md and marker", () => {
    const issueJson = JSON.stringify({
      title: "Test issue",
      body: "Here is a screenshot:\n\n![diagram](https://example.com/img/diagram.png)\n\nAnd: ![pic](https://example.com/pic.jpg)\n\n<img src=\"https://example.com/svg/logo.svg\" alt=\"logo\">\n\nSpaces form: ![spaced](<https://example.com/path with spaces.png>)",
      comments: [
        { author: { login: "alice" }, body: "![comment-screenshot](https://example.com/commented.png)", createdAt: "2024-01-01T00:00:00Z" },
      ],
    });
    writeFakeGh(issueJson);
    writeFakeCurl();

    const result = runScript("42");
    expect(result.exitCode).toBe(0);

    // .implement-issue-number written with the issue number
    const markerPath = join(tempDir, ".implement-issue-number");
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8").trim()).toBe("42");

    // Find the work dir (printed in stdout)
    const mdMatch = result.stdout.match(/issue body \+ comments: (.+)/i);
    expect(mdMatch).not.toBeNull();
    const issueMdPath = mdMatch![1]!.trim();
    expect(existsSync(issueMdPath)).toBe(true);
    const issueMd = readFileSync(issueMdPath, "utf-8");
    expect(issueMd).toContain("Implement GitHub Issue #42");
    expect(issueMd).toContain("Test issue");
    expect(issueMd).toContain("https://github.com/TimoFreiberg/pantoken/issues/42");
    expect(issueMd).toContain("### Comment 1 — @alice");
    expect(issueMd).toContain("comment-screenshot");

    // Screenshots downloaded: png, jpg, svg from body + png from comment + png from <url with spaces> = 5
    const imagesMatch = result.stdout.match(/Screenshots:\n([\s\S]*?)(?:\nMarker|$)/i);
    const screenshotLines = (imagesMatch?.[1] ?? "").split("\n").filter((l) => l.trim().startsWith("- "));
    expect(screenshotLines.length).toBe(5);

    // Verify image files exist on disk with correct extensions
    const imagesDir = join(dirname(issueMdPath), "images");
    const files = readdirSync(imagesDir).filter((f) => !f.startsWith("."));
    expect(files.length).toBe(5);
    const extensions = files.map((f) => f.split(".").pop()).sort();
    expect(extensions).toEqual(["jpg", "png", "png", "png", "svg"]);
  });

  test("handles an issue with no images", () => {
    const issueJson = JSON.stringify({
      title: "No images issue",
      body: "Just text, no images here.",
      comments: [],
    });
    writeFakeGh(issueJson);
    writeFakeCurl();

    const result = runScript("7");
    expect(result.exitCode).toBe(0);

    expect(readFileSync(join(tempDir, ".implement-issue-number"), "utf-8").trim()).toBe("7");

    const mdMatch = result.stdout.match(/issue body \+ comments: (.+)/i);
    const issueMd = readFileSync(mdMatch![1]!.trim(), "utf-8");
    expect(issueMd).toContain("No images issue");
    expect(issueMd).toContain("(no screenshots in this issue)");
    expect(issueMd).toContain("(no comments on this issue)");
  });

  test("exits non-zero on bad issue number", () => {
    writeFakeGh('{"title":"x","body":"y","comments":[]}');
    writeFakeCurl();
    const result = runScript("notanumber");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("positive integer");
  });

  test("exits non-zero when gh auth fails", () => {
    // Write a fake gh that exits non-zero for `auth status`
    writeFileSync(
      join(fakeBin, "gh"),
      `#!/usr/bin/env bash
if [ "$1" = "auth" ]; then exit 1; fi
cat <<'JSON'
{"title":"x","body":"y","comments":[]}
JSON
`,
    );
    chmod(join(fakeBin, "gh"));
    writeFakeCurl();

    const result = runScript("42");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not authenticated");
  });
});
