import { describe, expect, test } from "vitest";
import {
  validateProfileDraft,
  type ProfileFormDraft,
  type ComputerSetupDraft,
  type SetupError,
  isDirty,
  defaultDraft,
  draftFromProfile,
  normalizeError,
  toValidationDraft,
  draftToExecutionTargetProfile,
} from "./profile-form.js";
import type { RemoteProfile } from "./hosts/types.js";

function baseDraft(overrides: Partial<ProfileFormDraft> = {}): ProfileFormDraft {
  return {
    label: "My server",
    sshDestination: "user@host",
    port: "",
    remoteRootOverride: "",
    serverPath: "",
    executionTarget: { kind: "host" },
    dockerContainerName: "",
    dockerUser: "",
    dockerWorkdir: "",
    dockerPantokenRoot: "",
    ...overrides,
  };
}

describe("validateProfileDraft", () => {
  test("valid draft returns null", () => {
    expect(validateProfileDraft(baseDraft())).toBeNull();
  });

  test("empty name returns error", () => {
    expect(validateProfileDraft(baseDraft({ label: "" }))).toBe("Name is required");
    expect(validateProfileDraft(baseDraft({ label: "  " }))).toBe("Name is required");
  });

  test("empty sshDestination returns error", () => {
    expect(validateProfileDraft(baseDraft({ sshDestination: "" }))).toBe("SSH destination is required");
    expect(validateProfileDraft(baseDraft({ sshDestination: "  " }))).toBe("SSH destination is required");
  });

  test("invalid port returns error", () => {
    expect(validateProfileDraft(baseDraft({ port: "0" }))).toBe("Port must be an integer between 1 and 65535");
    expect(validateProfileDraft(baseDraft({ port: "65536" }))).toBe("Port must be an integer between 1 and 65535");
    expect(validateProfileDraft(baseDraft({ port: "abc" }))).toBe("Port must be an integer between 1 and 65535");
    expect(validateProfileDraft(baseDraft({ port: "1.5" }))).toBe("Port must be an integer between 1 and 65535");
  });

  test("valid port is accepted", () => {
    expect(validateProfileDraft(baseDraft({ port: "22" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ port: "1" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ port: "65535" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ port: "" }))).toBeNull();
  });

  test("non-absolute remoteRootOverride returns error", () => {
    expect(validateProfileDraft(baseDraft({ remoteRootOverride: "relative/path" }))).toBe(
      "Remote-root override must be an absolute path (starting with /)",
    );
  });

  test("non-absolute serverPath returns error", () => {
    expect(validateProfileDraft(baseDraft({ serverPath: "relative/path" }))).toBe(
      "Server path must be an absolute path (starting with /)",
    );
  });

  test("absolute paths are accepted", () => {
    expect(validateProfileDraft(baseDraft({ remoteRootOverride: "/abs/path" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ serverPath: "/usr/local/bin/server" }))).toBeNull();
  });

  test("docker target without container name returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "", user: "root", pantokenRoot: "/root" } });
    draft.dockerContainerName = "";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "/root";
    expect(validateProfileDraft(draft)).toBe("Container name is required for Docker targets");
  });

  test("docker target without user returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "", pantokenRoot: "/root" } });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "";
    draft.dockerPantokenRoot = "/root";
    expect(validateProfileDraft(draft)).toBe("User is required for Docker targets");
  });

  test("docker target without pantokenRoot returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "" } });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "";
    expect(validateProfileDraft(draft)).toBe("Pantoken root is required for Docker targets");
  });

  test("docker target with non-absolute pantokenRoot returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "relative" } });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "relative";
    expect(validateProfileDraft(draft)).toBe("Pantoken root must be an absolute path (starting with /)");
  });

  test("docker target with non-absolute workdir returns error", () => {
    const draft = baseDraft({
      executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "/root" },
    });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "/root";
    draft.dockerWorkdir = "relative";
    expect(validateProfileDraft(draft)).toBe("Workdir must be an absolute path (starting with /)");
  });

  test("valid docker target with all fields returns null", () => {
    const draft = baseDraft({
      executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "/root", workdir: "/workspace" },
    });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "/root";
    draft.dockerWorkdir = "/workspace";
    expect(validateProfileDraft(draft)).toBeNull();
  });
});

// ── Helpers for draft tests ──────────────────────────────────────────────────

function baseSetupDraft(overrides: Partial<ComputerSetupDraft> = {}): ComputerSetupDraft {
  return {
    name: "",
    sshDestination: "",
    port: "22",
    executionTarget: "host",
    polytokenPolicy: "requireExisting",
    serverPath: "",
    remoteRootOverride: "",
    xdgMode: "isolated",
    containerName: "",
    containerUser: "",
    containerWorkdir: "",
    pantokenRoot: "",
    ...overrides,
  };
}

function makeHostProfile(overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id: "test-1",
    label: "Test server",
    sshDestination: "user@host",
    port: 22,
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: { kind: "host" },
    riskAcknowledgements: {},
    ...overrides,
  };
}

function makeDockerProfile(overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id: "test-docker-1",
    label: "Docker server",
    sshDestination: "user@host",
    port: 2222,
    polytokenPolicy: "offerInstall",
    xdgMode: "shared",
    executionTarget: {
      kind: "dockerContainer",
      containerName: "my-container",
      user: "root",
      workdir: "/workspace",
      pantokenRoot: "/root/.local/share/pantoken",
    },
    riskAcknowledgements: {},
    ...overrides,
  };
}

describe("defaultDraft", () => {
  test("host intent produces host draft with defaults", () => {
    const draft = defaultDraft({ kind: "new", initialTarget: "host" });
    expect(draft.executionTarget).toBe("host");
    expect(draft.port).toBe("22");
    expect(draft.polytokenPolicy).toBe("requireExisting");
    expect(draft.xdgMode).toBe("isolated");
    expect(draft.name).toBe("");
  });

  test("docker intent produces docker draft", () => {
    const draft = defaultDraft({ kind: "new", initialTarget: "dockerContainer" });
    expect(draft.executionTarget).toBe("docker");
  });

  test("edit intent derives environment from profile", () => {
    const profile = makeDockerProfile();
    const draft = defaultDraft({ kind: "edit", profile });
    expect(draft.executionTarget).toBe("docker");
  });
});

describe("draftFromProfile", () => {
  test("host profile produces clean host draft", () => {
    const profile = makeHostProfile();
    const draft = draftFromProfile(profile);
    expect(draft.name).toBe("Test server");
    expect(draft.sshDestination).toBe("user@host");
    expect(draft.port).toBe("22");
    expect(draft.executionTarget).toBe("host");
    expect(draft.containerName).toBe("");
    expect(draft.polytokenPolicy).toBe("requireExisting");
  });

  test("docker profile produces docker draft with container fields", () => {
    const profile = makeDockerProfile();
    const draft = draftFromProfile(profile);
    expect(draft.executionTarget).toBe("docker");
    expect(draft.containerName).toBe("my-container");
    expect(draft.containerUser).toBe("root");
    expect(draft.containerWorkdir).toBe("/workspace");
    expect(draft.pantokenRoot).toBe("/root/.local/share/pantoken");
    expect(draft.port).toBe("2222");
    expect(draft.polytokenPolicy).toBe("offerInstall");
    expect(draft.xdgMode).toBe("shared");
  });

  test("port defaults to 22 when absent", () => {
    const profile = makeHostProfile({ port: undefined });
    const draft = draftFromProfile(profile);
    expect(draft.port).toBe("22");
  });

  test("round-trip: draftFromProfile → defaultDraft(edit) match for host", () => {
    const profile = makeHostProfile();
    const fromProfile = draftFromProfile(profile);
    const fromDefault = defaultDraft({ kind: "edit", profile });
    // Both should agree on executionTarget
    expect(fromProfile.executionTarget).toBe(fromDefault.executionTarget);
  });
});

describe("isDirty", () => {
  test("clean new draft vs default → not dirty", () => {
    const baseline = defaultDraft({ kind: "new", initialTarget: "host" });
    const current = structuredClone(baseline);
    expect(isDirty(baseline, current)).toBe(false);
  });

  test("clean edit draft vs loaded profile → not dirty", () => {
    const profile = makeDockerProfile();
    const draft = draftFromProfile(profile);
    // baseline should equal current when nothing changed
    expect(isDirty(draft, structuredClone(draft))).toBe(false);
  });

  test("changing port → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, port: "2222" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing executionTarget → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, executionTarget: "docker" as const };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing serverPath → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, serverPath: "/usr/local/bin/server" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing xdgMode → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, xdgMode: "shared" as const };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing remoteRootOverride → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, remoteRootOverride: "/custom/root" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing name → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, name: "My Server" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing sshDestination → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, sshDestination: "newuser@newhost" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing polytokenPolicy → dirty", () => {
    const baseline = baseSetupDraft();
    const current = { ...baseline, polytokenPolicy: "offerInstall" as const };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing containerName → dirty", () => {
    const baseline = baseSetupDraft({ executionTarget: "docker" });
    const current = { ...baseline, containerName: "new-container" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing containerUser → dirty", () => {
    const baseline = baseSetupDraft({ executionTarget: "docker" });
    const current = { ...baseline, containerUser: "newuser" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing pantokenRoot → dirty", () => {
    const baseline = baseSetupDraft({ executionTarget: "docker" });
    const current = { ...baseline, pantokenRoot: "/new/root" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("changing containerWorkdir → dirty", () => {
    const baseline = baseSetupDraft({ executionTarget: "docker" });
    const current = { ...baseline, containerWorkdir: "/new/workdir" };
    expect(isDirty(baseline, current)).toBe(true);
  });

  test("null baseline → not dirty", () => {
    expect(isDirty(null, baseSetupDraft())).toBe(false);
  });

  test("null current → not dirty", () => {
    expect(isDirty(baseSetupDraft(), null)).toBe(false);
  });
});

describe("normalizeError", () => {
  test("Error instance → summary from message, detail from stack", () => {
    const err = new Error("Connection refused");
    const result = normalizeError(err, "connect");
    expect(result.summary).toBe("Connection refused");
    expect(result.operation).toBe("connect");
    expect(result.retryable).toBe(true);
    // detail should contain something (stack or toString)
    expect(result.detail).toBeTruthy();
  });

  test("Error with cause → detail from cause", () => {
    const cause = new Error("SSH handshake failed");
    const err = new Error("Connection refused", { cause });
    const result = normalizeError(err, "connect");
    expect(result.summary).toBe("Connection refused");
    expect(result.detail).toContain("SSH handshake failed");
  });

  test("string error → summary from string, no detail", () => {
    const result = normalizeError("Something went wrong", "save");
    expect(result.summary).toBe("Something went wrong");
    expect(result.detail).toBeUndefined();
    expect(result.operation).toBe("save");
  });

  test("plain object with message → summary from message", () => {
    const result = normalizeError({ message: "Object error" }, "inspect");
    expect(result.summary).toBe("Object error");
    expect(result.detail).toBeTruthy();
  });

  test("plain object without message → summary from JSON", () => {
    const result = normalizeError({ code: 42 }, "inspect");
    expect(result.summary).toBeTruthy();
    expect(result.operation).toBe("inspect");
  });

  test("null → summary is 'Unknown error'", () => {
    const result = normalizeError(null, "connect");
    expect(result.summary).toBe("Unknown error");
    expect(result.operation).toBe("connect");
  });

  test("undefined → summary is 'Unknown error'", () => {
    const result = normalizeError(undefined, "connect");
    expect(result.summary).toBe("Unknown error");
  });

  test("number → summary is string representation", () => {
    const result = normalizeError(42, "connect");
    expect(result.summary).toBe("42");
  });
});

describe("toValidationDraft", () => {
  test("host draft maps correctly", () => {
    const draft = baseSetupDraft({ name: "My Server", sshDestination: "user@host" });
    const vd = toValidationDraft(draft);
    expect(vd.label).toBe("My Server");
    expect(vd.sshDestination).toBe("user@host");
    expect(vd.port).toBe("22");
    expect(vd.executionTarget.kind).toBe("host");
  });

  test("docker draft maps correctly", () => {
    const draft = baseSetupDraft({
      executionTarget: "docker",
      containerName: "my-container",
      containerUser: "root",
      pantokenRoot: "/root",
      containerWorkdir: "/workspace",
    });
    const vd = toValidationDraft(draft);
    expect(vd.executionTarget.kind).toBe("dockerContainer");
    if (vd.executionTarget.kind === "dockerContainer") {
      expect(vd.executionTarget.containerName).toBe("my-container");
      expect(vd.executionTarget.user).toBe("root");
      expect(vd.executionTarget.pantokenRoot).toBe("/root");
      expect(vd.executionTarget.workdir).toBe("/workspace");
    }
  });

  test("empty workdir becomes undefined", () => {
    const draft = baseSetupDraft({
      executionTarget: "docker",
      containerName: "c",
      containerUser: "root",
      pantokenRoot: "/root",
      containerWorkdir: "",
    });
    const vd = toValidationDraft(draft);
    if (vd.executionTarget.kind === "dockerContainer") {
      expect(vd.executionTarget.workdir).toBeUndefined();
    }
  });
});

describe("draftToExecutionTargetProfile", () => {
  test("host draft → host target", () => {
    const draft = baseSetupDraft({ executionTarget: "host" });
    const target = draftToExecutionTargetProfile(draft);
    expect(target.kind).toBe("host");
  });

  test("docker draft → docker target", () => {
    const draft = baseSetupDraft({
      executionTarget: "docker",
      containerName: "c",
      containerUser: "root",
      pantokenRoot: "/root",
    });
    const target = draftToExecutionTargetProfile(draft);
    expect(target.kind).toBe("dockerContainer");
    if (target.kind === "dockerContainer") {
      expect(target.containerName).toBe("c");
      expect(target.user).toBe("root");
      expect(target.pantokenRoot).toBe("/root");
    }
  });
});
