import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const conf = readFileSync("desktop/tauri.conf.json", "utf8");
const readme = readFileSync("desktop/README.md", "utf8");
const runbook = readFileSync("docs/issues/mobile-access/05-mini-lifecycle.md", "utf8");

const requireText = (name: string, text: string, needles: string[]) => {
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`missing ${name} contract: ${needle}`);
  }
};
requireText("bundle", conf, ['"identifier": "dev.pantoken.app"', '"createUpdaterArtifacts": true', '"minimumSystemVersion": "13.0"']);
requireText("README", readme, [
  "SMAppService.mainApp", "signed packaged macOS app", "approval-required", "headlessly",
  "Tray **Open**", "Closing the window", "explicit **Quit**", "Cmd+Q", "bearer tokens",
  "Authorization headers", "fail-closed", "crash-loop", "retry", "signed whole-app update",
  "non-v1", "loopback-only",
]);
requireText("runbook", runbook, [
  "mini_startup_lifecycle_manual", "MINI-LIFECYCLE-01", "MINI-LIFECYCLE-02", "MINI-LIFECYCLE-03",
  "MINI-UPDATE-02", "SMAppService.mainApp", "headless", "close-to-tray", "Cmd+Q", "redacted",
  "validate-macos-app.sh",
]);
for (const text of [conf, readme, runbook]) {
  if (/\b(bind|listen|serve|run)\b[^.\n]*(?:0\.0\.0\.0|public\s+(?:network\s+)?binding|standalone\s+server)/i.test(text)) {
    throw new Error("unsupported public/standalone binding claim");
  }
}
if (conf.includes("launch-agent") || conf.includes("helper")) throw new Error("helper registration is not allowed");

const missing = spawnSync("bash", ["scripts/desktop/validate-macos-app.sh", "--app", "/tmp/pantoken-missing-contract.app"], { encoding: "utf8" });
if (missing.status === 0) throw new Error("validate-macos-app.sh accepted a missing artifact");
if (spawnSync("command -v plutil", { shell: true }).status === 0) {
  const fixture = "/tmp/pantoken-contract-fixture.app";
  spawnSync("rm", ["-rf", fixture]);
  spawnSync("mkdir", ["-p", fixture + "/Contents"]);
  const plist = fixture + "/Contents/Info.plist";
  spawnSync("plutil", ["-create", "xml1", plist]);
  spawnSync("plutil", ["-insert", "CFBundleIdentifier", "-string", "dev.pantoken.app", "-append", plist]);
  spawnSync("plutil", ["-insert", "LSMinimumSystemVersion", "-string", "13.0", "-append", plist]);
  const valid = spawnSync("bash", ["scripts/desktop/validate-macos-app.sh", "--app", fixture], { encoding: "utf8" });
  spawnSync("rm", ["-rf", fixture]);
  if (valid.status !== 0 || !valid.stdout.includes("CFBundleIdentifier=dev.pantoken.app") || !valid.stdout.includes("LSMinimumSystemVersion=13.0")) {
    throw new Error("validate-macos-app.sh rejected valid packaged metadata");
  }
}

console.log("desktop_readme_lifecycle_contract: Mini lifecycle metadata/documentation contract OK");
