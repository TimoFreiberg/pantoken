import { readFileSync } from "node:fs";

const conf = readFileSync("desktop/tauri.conf.json", "utf8");
const readme = readFileSync("desktop/README.md", "utf8");
const runbook = readFileSync("docs/issues/mobile-access/05-mini-lifecycle.md", "utf8");
for (const needle of ["dev.pantoken.app", "createUpdaterArtifacts", "updater", "SMAppService.mainApp"]) {
  if (!conf.includes(needle) && !readme.includes(needle)) throw new Error(`missing lifecycle contract: ${needle}`);
}
for (const needle of ["opt-in", "headless", "explicit **Quit**", "bearer tokens", "non-v1"]) {
  if (!readme.includes(needle)) throw new Error(`missing README lifecycle term: ${needle}`);
}
for (const needle of ["mini_startup_lifecycle_manual", "redacted", "Issue 06"]) {
  if (!runbook.includes(needle)) throw new Error(`missing runbook lifecycle term: ${needle}`);
}
if (conf.includes("launch-agent") || conf.includes("helper")) throw new Error("helper registration is not allowed");
console.log("Mini lifecycle metadata/documentation contract OK");
