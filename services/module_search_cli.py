"""Phase 57 MARK-02: module search CLI front-end.

Usage:
    python3 services/module_search_cli.py <query> [--registry <url>] [--json]

Returns ranked entry list from local cache, in-repo registry, or remote URL.
Exit codes:
    0 -- success
    2 -- registry/search error (matches Phase 49 lifecycle_cli convention)
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Path setup: ensure repo root is on sys.path (mirrors module_lifecycle_cli.py pattern)
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.module_search import SearchError, load_index, search


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Search the module marketplace (Phase 57 MARK-02)"
    )
    parser.add_argument(
        "query",
        help="Search query (matches name and maintainer; empty = list all)",
    )
    parser.add_argument(
        "--registry",
        default=None,
        help="Remote registry URL to fetch (overrides local cache)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of human-readable",
    )
    args = parser.parse_args(argv)

    try:
        index = load_index(args.registry)
    except SearchError as e:
        sys.stderr.write(f"ERROR ({e.error_code}): {e.detail}\n")
        return 2

    results = search(args.query, index)

    if args.json:
        print(json.dumps(
            {"schema_version": "1.0", "query": args.query, "results": results},
            indent=2,
        ))
    else:
        if not results:
            print(f"No matches for '{args.query}' in {len(index.entries)} registry entries.")
            return 0
        print(f"Found {len(results)} match(es) for '{args.query}':\n")
        for r in results:
            print(f"  {r['name']}@{r['version']}")
            print(f"    maintainer: {r['maintainer']}")
            print(f"    manifest: {r['manifest_url']}")
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
