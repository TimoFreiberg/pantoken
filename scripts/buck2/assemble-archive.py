#!/usr/bin/env python3
"""Deterministic archive assembler for the Buck2 headless POC.

Produces a reproducible .tar.gz archive with:
- Sorted paths
- Fixed mtime (epoch 0)
- Fixed uid/gid (0/0) and uname/gname (root/root)
- Fixed file modes (0755 for executables, 0644 for files)
- Sorted tar entries
- Deterministic gzip header (no timestamp, no filename, compression level 9)

Uses Python's tarfile + gzip modules rather than ambient BSD/GNU tar,
ensuring the same output regardless of host tar variant.

Usage: assemble-archive.py <output.tar.gz> <staging-dir>
"""

import gzip
import io
import os
import sys
import tarfile
import tempfile

def make_deterministic_tar(staging_dir: str, output_path: str) -> None:
    """Create a deterministic tar.gz from the staging directory contents."""
    # Collect all files with their relative paths
    entries = []
    for root, dirs, files in os.walk(staging_dir):
        dirs.sort()  # deterministic traversal
        for fname in sorted(files):
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, staging_dir)
            entries.append((rel, full))

    # Sort by relative path for deterministic entry order
    entries.sort(key=lambda e: e[0])

    # Create tar to an in-memory buffer first, then gzip
    tar_buf = io.BytesIO()
    with tarfile.open(fileobj=tar_buf, mode="w") as tar:
        for rel, full in entries:
            ti = tarfile.TarInfo(name=rel)
            stat = os.stat(full)
            ti.size = stat.st_size
            # Fixed metadata for reproducibility
            ti.mtime = 0
            ti.uid = 0
            ti.gid = 0
            ti.uname = "root"
            ti.gname = "root"
            # Set mode: 0755 for executables, 0644 for regular files
            if os.access(full, os.X_OK):
                ti.mode = 0o755
            else:
                ti.mode = 0o644
            with open(full, "rb") as f:
                tar.addfile(ti, f)

    # Write gzip with deterministic header
    # mtime=0 removes the timestamp from the gzip header
    # compresslevel=9 for maximum compression
    tar_bytes = tar_buf.getvalue()
    with open(output_path, "wb") as out:
        with gzip.GzipFile(
            filename="",  # no filename in header
            mode="wb",
            compresslevel=9,
            fileobj=out,
            mtime=0,
        ) as gz:
            gz.write(tar_bytes)

    # Print the sha256 for verification
    import hashlib
    with open(output_path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    print(f"sha256:{sha}", file=sys.stderr)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <output.tar.gz> <staging-dir>", file=sys.stderr)
        return 1

    output_path = sys.argv[1]
    staging_dir = sys.argv[2]

    if not os.path.isdir(staging_dir):
        print(f"Error: staging dir does not exist: {staging_dir}", file=sys.stderr)
        return 1

    make_deterministic_tar(staging_dir, output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
