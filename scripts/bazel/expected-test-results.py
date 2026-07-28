#!/usr/bin/env python3
"""Run server Bazel tests and allowlist only the two known Cargo-layout failures."""
from __future__ import annotations
import json, pathlib, re, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "scripts/bazel/expected-test-targets.txt"
ALLOW = {"//server-rs/pantoken-server:remote_runtime_tests", "//server-rs/pantoken-server:resume_and_recovery_tests"}
DIAG = re.compile(r"^pantoken-server binary not found$", re.I | re.M)
TERMINAL = {"PASSED", "FAILED", "FLAKY", "TIMEOUT", "INCOMPLETE", "NO_STATUS"}
def labels_from_query() -> set[str]:
    p = subprocess.run(["bazel", "query", 'kind(".*_test rule", //server-rs/...)'], cwd=ROOT, text=True, capture_output=True)
    if p.returncode: raise SystemExit(f"Bazel query failed:\n{p.stderr}")
    return {x.strip() for x in p.stdout.splitlines() if x.strip().startswith("//")}
def main() -> int:
    expected = {x.strip() for x in MANIFEST.read_text().splitlines() if x.strip() and not x.startswith("#")}
    if labels_from_query() != expected: print("target set differs from independent Bazel query", file=sys.stderr); return 1
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f: bep = f.name
    p = subprocess.run(["bazel", "test", *sorted(expected), f"--build_event_json_file={bep}", "--test_output=errors"], cwd=ROOT, text=True, capture_output=True)
    results: dict[str, str] = {}; logs: dict[str, str] = {}; infrastructure_error = False; finished_code = None
    for line in pathlib.Path(bep).read_text().splitlines():
        try: event = json.loads(line)
        except json.JSONDecodeError: continue
        summary = event.get("testSummary"); identity = event.get("id", {}).get("testSummary", {})
        label = (summary or {}).get("label") or identity.get("label")
        status = (summary or {}).get("overallStatus")
        if label and status in TERMINAL:
            if label in results: print(f"duplicate terminal result: {label}", file=sys.stderr); return 1
            results[label] = status
        if event.get("aborted") or event.get("error"): infrastructure_error = True
        if event.get("finished"):
            finished_code = event["finished"].get("exitCode", {}).get("name")
        if summary and label:
            for result in (summary.get("failed", []) or []):
                uri = result.get("uri", "")
                if uri.startswith("file://"):
                    path = pathlib.Path(uri[7:]); logs[label] = path.read_text(errors="replace") if path.exists() else ""
    if infrastructure_error or finished_code not in ("SUCCESS", "TESTS_FAILED") or set(results) != expected:
        print("Bazel startup/loading/analysis/infrastructure failure or incomplete result set", file=sys.stderr); return 1
    for label, status in results.items():
        if label in ALLOW:
            if status != "FAILED" or not DIAG.search(logs.get(label, "")):
                print(f"allowlisted failure changed for {label}", file=sys.stderr); return 1
        elif status != "PASSED": print(f"unexpected result {label}: {status}", file=sys.stderr); return 1
    if p.returncode != 0 and not all(results[x] == "FAILED" for x in ALLOW): return 1
    print("Bazel test result allowlist passed"); return 0
if __name__ == "__main__": sys.exit(main())
