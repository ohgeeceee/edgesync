"""Print raw+gzip sizes of the initial-load shell so we can verify the
<150 KB gzipped budget. Run manually; not part of the build pipeline
because gzip size is informational only.
"""
import gzip
import os
import sys
from pathlib import Path

FILES = [
    "public/index.html",
    "public/app.js",
    "public/app.css",
    "public/sw.js",
    "public/manifest.webmanifest",
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/icons/apple-touch-icon.png",
    "public/icons/favicon-32.png",
]

ROOT = Path(__file__).resolve().parent.parent
BUDGET_BYTES = 150 * 1024

def main() -> int:
    total_raw = total_gz = 0
    for rel in FILES:
        path = ROOT / rel
        if not path.exists():
            print(f"{rel:42s} MISSING")
            continue
        raw = path.read_bytes()
        gz = gzip.compress(raw, compresslevel=9)
        total_raw += len(raw)
        total_gz += len(gz)
        print(f"{rel:42s} {len(raw):>7d} raw   {len(gz):>5d} gz")
    print("-" * 60)
    print(f"{'TOTAL':42s} {total_raw:>7d} raw   {total_gz:>5d} gz "
          f"({total_gz / 1024:.1f} KB)")
    if total_gz > BUDGET_BYTES:
        print(f"⚠️  OVER BUDGET by {total_gz - BUDGET_BYTES} bytes")
        return 1
    print(f"✅ under 150 KB gzipped budget "
          f"(headroom {BUDGET_BYTES - total_gz} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
