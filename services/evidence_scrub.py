#!/usr/bin/env python3
"""
Evidence Scrub — shared secret-redaction registry for build-log/evidence text.

Phase 68 MOBL-04: signing identities, provisioning-profile identifiers,
keystore passwords, and API tokens captured in Xcode/Gradle build output
must never reach task evidence (RPETD/notes) or memory unscrubbed.

Dual-runtime pair (single-source discipline -- Phase 69-01's "shared
canonical resolver, not a second copy to drift" lineage): this module is
the Python half; the Node twin is scrubEvidence() in
get-shit-done/bin/gsd-amauta.cjs. BOTH read the SAME registry file --
get-shit-done/config/evidence-scrub-patterns.json -- neither hardcodes a
second pattern list.

Path resolution mirrors services/capability_schema.py::load_capability_catalog:
1. GSD_EVIDENCE_SCRUB_PATTERNS_PATH env override (test/hook seam) --
   AUTHORITATIVE when set; no fallthrough to the repo-local/~/.claude
   candidates if the override path is missing or unparseable.
2. <this file's dir>/../get-shit-done/config/evidence-scrub-patterns.json
   (repo-local)
3. ~/.claude/get-shit-done/config/evidence-scrub-patterns.json

Fail-open discipline (house pattern per services/capability_access.py): a
missing/unparseable registry degrades the write to UNSCRUBBED with a LOUD
one-time stderr warning -- never blocks the harness. The loaded-patterns
cache uses a distinct FAILURE SENTINEL (not None) so a broken load
short-circuits to "no patterns" on every subsequent call instead of
re-reading (and re-failing) the file on every scrub_text() invocation.

Kill switch: GSD_EVIDENCE_SCRUB=off returns input unchanged with an empty
hit list, in scrub_text() and in every call site that wraps it (daemon,
Node CLI -- env-seam twin learning).
"""

import json
import os
import re
import sys

_PATTERNS_ENV_OVERRIDE = "GSD_EVIDENCE_SCRUB_PATTERNS_PATH"
SCRUB_VERSION = "1.0"

# Distinct failure sentinel (never None/[] confusable with "loaded-but-empty").
_FAILURE_SENTINEL = object()
_PATTERNS_CACHE = None  # None (not yet loaded) | _FAILURE_SENTINEL | list[compiled dict]
_LOAD_WARNED = False


def _candidate_paths():
    override = os.environ.get(_PATTERNS_ENV_OVERRIDE)
    if override:
        return [override]
    here = os.path.dirname(os.path.abspath(__file__))
    return [
        os.path.join(here, "..", "get-shit-done", "config", "evidence-scrub-patterns.json"),
        os.path.join(os.environ.get("HOME", ""), ".claude", "get-shit-done", "config", "evidence-scrub-patterns.json"),
    ]


def _warn_once(message):
    global _LOAD_WARNED
    if not _LOAD_WARNED:
        print(f"[evidence_scrub] {message}", file=sys.stderr)
        _LOAD_WARNED = True


def load_patterns(force_reload=False):
    """Load + compile the shared scrub-pattern registry.

    Returns a list of {"name", "compiled": re.Pattern, "replacement"} dicts,
    or [] when the registry is missing/unparseable/empty (fail-open --
    never raises, never blocks a write). Caches a FAILURE SENTINEL
    (distinct from a valid-but-empty patterns list) so a broken load
    short-circuits on every subsequent call instead of re-reading the file
    each time.
    """
    global _PATTERNS_CACHE

    if not force_reload:
        if _PATTERNS_CACHE is _FAILURE_SENTINEL:
            return []
        if _PATTERNS_CACHE is not None:
            return _PATTERNS_CACHE

    for p in _candidate_paths():
        if not p:
            continue
        try:
            if os.path.exists(p):
                with open(p, "r") as f:
                    data = json.load(f)
                raw_patterns = data.get("patterns", [])
                compiled = []
                for entry in raw_patterns:
                    name = entry["name"]
                    flags = re.IGNORECASE if entry.get("flags") == "i" else 0
                    compiled.append({
                        "name": name,
                        "compiled": re.compile(entry["regex"], flags),
                        "replacement": entry.get("replacement", f"[scrubbed:{name}]"),
                    })
                _PATTERNS_CACHE = compiled
                return _PATTERNS_CACHE
        except Exception as e:
            _warn_once(f"failed to load {p}: {e}")
            continue

    _warn_once(
        "evidence-scrub-patterns.json not found in any candidate path "
        "-- evidence will NOT be scrubbed (fail-open)"
    )
    _PATTERNS_CACHE = _FAILURE_SENTINEL
    return []


def scrub_text(text):
    """Apply every registered pattern to text; return (scrubbed_text, hit_names).

    - Returns (text, []) unchanged when GSD_EVIDENCE_SCRUB=off (kill switch).
    - Returns (text, []) unchanged when the pattern registry is empty or
      unavailable (fail-open -- a broken registry never blocks a write).
    - hit_names lists each pattern NAME that matched at least once, in
      registry order, with no duplicates (one entry per pattern, regardless
      of how many occurrences it replaced).
    - Never raises.
    """
    if text is None:
        return text, []
    if os.environ.get("GSD_EVIDENCE_SCRUB") == "off":
        return text, []

    patterns = load_patterns()
    if not patterns:
        return text, []

    hits = []
    scrubbed = text
    for pattern in patterns:
        scrubbed, count = pattern["compiled"].subn(pattern["replacement"], scrubbed)
        if count > 0:
            hits.append(pattern["name"])
    return scrubbed, hits
