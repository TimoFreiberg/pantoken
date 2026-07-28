#!/usr/bin/env python3
"""Generate and compare deterministic headless archive inputs under two roots."""
from __future__ import annotations
import hashlib, io, pathlib, re, shutil, sys, tarfile, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / "scripts/bazel/path-stability-fixtures"
ABS = re.compile(rb"(?:[A-Za-z]:[\\/]|//[^/]+/|/(?:Users|home|private/tmp|tmp|execroot|sandbox)/)[^\s\"']*")
BAD = re.compile(rb"(?:HOME=|CARGO_MANIFEST_DIR=|/sandbox/|/execroot/|/tmp/|/private/tmp/|checkout[-_ ]root)", re.I)
def synthesize(root: pathlib.Path) -> None:
    """Create the same minimal inputs consumed by root BUILD archive assembly."""
    shutil.copytree(FIX, root / "metadata", dirs_exist_ok=True)
    (root / "VERSION").write_text("0.0.0-dev\n")
    (root / "BUILD_SHA").write_text("0000000000000000000000000000000000000000\n")
    client = root / "client-dist"; client.mkdir()
    (client / "index.html").write_text("<!doctype html><html></html>\n")
def archive(root: pathlib.Path, out: pathlib.Path) -> None:
    with tarfile.open(out, "w:gz", compresslevel=9, format=tarfile.GNU_FORMAT) as tar:
        for source in sorted(root.rglob("*")):
            if source.is_file():
                rel = source.relative_to(root).as_posix(); data = source.read_bytes()
                info = tarfile.TarInfo(rel); info.size = len(data); info.mtime = 0
                info.uid = info.gid = 0; info.uname = info.gname = ""; info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
def manifest(path: pathlib.Path) -> list[tuple[str, str]]:
    with tarfile.open(path, "r:gz") as tar:
        entries=[]
        for member in sorted(tar.getmembers(), key=lambda x: x.name):
            if member.name.startswith("/") or ".." in pathlib.PurePosixPath(member.name).parts:
                raise ValueError(f"unsafe archive member: {member.name}")
            data = tar.extractfile(member).read() if member.isfile() else b""
            if BAD.search(data) or ABS.search(data): raise ValueError(f"forbidden path bytes in {member.name}")
            entries.append((member.name, hashlib.sha256(data).hexdigest()))
        return entries
def main() -> int:
    if not FIX.exists(): print(f"missing fixture directory: {FIX}", file=sys.stderr); return 1
    with tempfile.TemporaryDirectory(prefix="bazel-path-") as td:
        base=pathlib.Path(td); archives=[]
        for name in ("checkout-a/deeper/root", "checkout-b/other/root"):
            root=base/name; root.mkdir(parents=True); synthesize(root)
            out=base/(name.split("/")[0] + ".tar.gz"); archive(root, out); archives.append(out)
            for p in root.rglob("*"):
                if p.is_file() and (BAD.search(p.read_bytes()) or ABS.search(p.read_bytes())):
                    print(f"forbidden local path in generated input {p}", file=sys.stderr); return 1
        if manifest(archives[0]) != manifest(archives[1]):
            print("normalized archive member/content manifests differ", file=sys.stderr); return 1
    print("Bazel path stability check passed"); return 0
if __name__ == "__main__": sys.exit(main())
