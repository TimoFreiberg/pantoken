import { describe, expect, test } from "bun:test";
import { extractImageUrls, formatComments, imageExtension, parseDaemonOutput, parseIssueReference, plannedCommands, renderPrompt, zellijCleanupCommand } from "../implement-issue";

describe("implement-issue helpers", () => {
  test("parses supported issue references and rejects ambiguity", () => {
    expect(parseIssueReference(["42"]).url).toBe("https://github.com/TimoFreiberg/pantoken/issues/42");
    expect(parseIssueReference(["#7"]).number).toBe(7);
    expect(parseIssueReference(["https://github.com/TimoFreiberg/pantoken/issues/9"]).number).toBe(9);
    expect(() => parseIssueReference(["1", "2"])).toThrow("Exactly one");
    expect(() => parseIssueReference(["https://example.com/issues/1"])).toThrow();
  });

  test("extracts ordered, deduplicated HTTP image references", () => {
    expect(extractImageUrls('![a](https://x.test/a.png?x=1) <img src="https://x.test/a.png?x=1"> ![b](data:image/png;base64,x) ![c](https://x.test/attachment)')).toEqual(["https://x.test/a.png?x=1", "https://x.test/attachment"]);
  });

  test("selects safe image extensions from content type or URL", () => {
    expect(imageExtension("https://github.com/user-attachments/assets/a", "image/jpeg")).toBe("jpg");
    expect(imageExtension("https://x.test/a.webp?download=1")).toBe("webp");
    expect(imageExtension("https://x.test/a", "text/html")).toBe("bin");
  });

  test("parses daemon metadata and validates ranges", () => {
    expect(parseDaemonOutput("starting session_id=abc123 port=4321")).toEqual({ sessionId: "abc123", port: 4321 });
    expect(parseDaemonOutput("ignored", { session_id: "structured", port: 65535 })).toEqual({ sessionId: "structured", port: 65535 });
    expect(() => parseDaemonOutput("session_id=x port=0")).toThrow();
    expect(() => parseDaemonOutput("port=1234")).toThrow("session_id");
  });

  test("plans workspace under <repo>/.workspaces based off main", () => {
    const cmds = plannedCommands({ number: 42, url: "x", input: "42" }, "/repo/root");
    const wsAdd = cmds[0]!;
    expect(wsAdd.slice(0, 3)).toEqual(["jj", "workspace", "add"]);
    expect(wsAdd).toContain("/repo/root/.workspaces/issue-42");
    expect(wsAdd).toContain("--revision");
    expect(wsAdd).toContain("main");
    const polytokenNew = cmds[2]!;
    expect(polytokenNew).not.toContain("--config-dir");
    expect(polytokenNew).toContain("new");
    expect(polytokenNew).toContain("--no-attach");
    const zellij = cmds[3]!;
    expect(zellij).not.toContain("--block-until-exit");
  });

  test("renders hostile multiline issue data without shell interpolation", () => {
    const issue = { number: 4, input: "4", url: "https://github.com/TimoFreiberg/pantoken/issues/4", title: "quotes ' \" \\", body: "line 1\n{{ISSUE_TITLE}}\n日本語", comments: [] };
    expect(renderPrompt("{{ISSUE_TITLE}}\n{{ISSUE_BODY}}\n{{ISSUE_IMAGES}}", issue, [], false)).toContain(issue.body);
  });

  test("formatComments renders structured, ordered comments with authors", () => {
    expect(formatComments([])).toBe("(no comments on this issue)");
    const comments = [
      { author: "alice", body: "first", createdAt: "2024-01-01T00:00:00Z" },
      { author: "bob", body: "second", createdAt: "2024-01-02T00:00:00Z" },
    ];
    const rendered = formatComments(comments);
    expect(rendered).toContain("Comment 1 — @alice");
    expect(rendered).toContain("Comment 2 — @bob");
    expect(rendered).toContain("first");
    expect(rendered).toContain("second");
    expect(rendered).toContain("---");
  });

  test("renderPrompt substitutes {{ISSUE_COMMENTS}} into the prompt", () => {
    const issue = { number: 5, input: "5", url: "https://github.com/TimoFreiberg/pantoken/issues/5", title: "t", body: "b", comments: [{ author: "alice", body: "a comment", createdAt: "2024-01-01T00:00:00Z" }] };
    const rendered = renderPrompt("{{ISSUE_COMMENTS}}", issue, [], false);
    expect(rendered).toContain("@alice");
    expect(rendered).toContain("a comment");
  });

  test("zellijCleanupCommand builds correct cleanup string and args (AC.6)", () => {
    const result = zellijCleanupCommand("abc", "/path/to/claims.sh", 42, "123", "/tmp/context", "/scripts");
    expect(result.command).toBe("sh");
    // args[0] = -c, args[1] = sh -c string, args[2] = "--", args[3..] = positional params
    const shString = result.args[1]!;
    // Invokes the cleanup script via bash "$6"
    expect(shString).toContain('bash "$6"');
    // Correct workspace name
    expect(shString).toContain("issue-42");
    // Cleanup failure is non-fatal
    expect(shString).toContain("|| echo");
    // Exits with the TUI's original status
    expect(shString).toContain("exit $status");
    // exit $status is the final command
    expect(shString.lastIndexOf("exit $status")).toBe(shString.length - "exit $status".length);

    // Positional args: $1..$6
    const positional = result.args.slice(3);
    expect(positional[0]).toBe("abc");           // $1 = sessionId
    expect(positional[1]).toBe("/path/to/claims.sh"); // $2 = claims.sh
    expect(positional[2]).toBe("42");            // $3 = issue number
    expect(positional[3]).toBe("123");           // $4 = daemon PID
    expect(positional[4]).toBe("/tmp/context");  // $5 = context path
    expect(positional[5]).toBe("/scripts/cleanup-workspace.sh"); // $6 = script path
  });

  test("zellijCleanupCommand handles undefined daemonPid as 0 (AC.6)", () => {
    const result = zellijCleanupCommand("s", "/c", 7, undefined, "/ctx", "/sd");
    const positional = result.args.slice(3);
    expect(positional[3]).toBe("0"); // $4 = daemon PID defaults to "0"
  });
});
