"""The Python half of the skip gate (plan 88-19, FND-04).

``scripts/skip-gate.cjs`` is the Node half. **The two must not drift**, so the rules
are implemented here in the same order, with the same names, and
``tests/88-19-skip-gate.test.cjs`` PROVES they agree rather than asserting it: it
feeds the same fixture exceptions file and the same synthetic observation list to
both through their ``--evaluate`` interfaces and compares the verdicts field by
field. A change to any rule must be made in both files; the parity test is what
fails otherwise.

The rules, restated (the authoritative prose is the header of
``scripts/skip-gate.cjs``):

1. The match key is ``(file, name, platform)`` and nothing else. The exceptions file
   is FLAT: one entry per test per platform. ``reason_class`` is a grouping LABEL the
   gate never matches, counts or deduplicates on.
2. An entry is applicable when its runner owns the file (the Python gate owns
   ``*.py`` and the ``(collection)`` pseudo-file; the Node gate owns ``*.cjs``), its
   ``platform`` is ``all`` or the current one, and its ``context`` is ``any`` — or
   ``local`` with ``CI`` unset.
3. ``context: "local"`` is refused under CI, with its own code and message.
4. Staleness is a FULL-RUN property, over applicable entries only, on the key of
   rule 1. A partial run (a file, a node id, ``-k``, ``-m``, ``--deselect``,
   ``--lf``) checks unlisted skips but not staleness.
5. Fail closed: an unreadable, non-array, duplicate-keyed or schema-violating file
   is a red run.
6. A skipped suite cannot be excused (Node only; pytest has no equivalent event).
7. A ``todo`` test cannot be excused (Node only).

Identity of a pytest observation — chosen to reproduce the identity plan 88-16
generated the file from, which was the JUnit XML CI already writes:

* a test:       ``tests/test_x.py::test_name[param]`` -> file ``tests/test_x.py``,
                name ``test_name[param]``
* a collection: the whole module could not be collected, and the XML has no file for
                it -> file ``(collection)``, name ``tests.test_x`` (the module's
                dotted path), which is exactly what the four existing
                ``(collection)`` entries carry.

Example:
    >>> entry = {"name": "t", "file": "tests/a.py", "platform": "all",
    ...          "context": "any", "reason": "r", "reason_class": "c",
    ...          "owner": "o", "owner_phase": 88, "exit_criterion": "e"}
    >>> result = evaluate([entry], [], runner="python", platform="linux",
    ...                   ci=False, explicit=True)
    >>> result["exit_code"]
    0
"""

import json
import os
import sys

#: The session exit status the gate sets. 4 is the live-store canary's and 5 the
#: stray-process check's in scripts/run-tests.cjs; pytest itself uses 0-5.
EXIT_SKIP_GATE = 6

#: Finding codes. Identical strings to scripts/skip-gate.cjs CODES.
CODES = {
    "UNLISTED": "SKIP_UNLISTED",
    "LOCAL_UNDER_CI": "SKIP_LOCAL_ENTRY_UNDER_CI",
    "SUITE": "SKIP_SUITE_HIDES_TESTS",
    "TODO": "SKIP_TODO_NOT_ALLOWED",
    "STALE": "SKIP_EXCEPTION_STALE",
    "UNREADABLE": "SKIP_EXCEPTIONS_UNREADABLE",
    "MALFORMED": "SKIP_EXCEPTIONS_MALFORMED",
    "NO_EVIDENCE": "SKIP_GATE_NO_EVIDENCE",
    "XFAIL_COUNT": "SKIP_XFAIL_COUNT_CHANGED",
}

#: Repo-relative path of the exceptions file, as it is named in every message.
EXCEPTIONS_REL = "tests/skip-exceptions.json"

#: The reason_class whose entries are the STRICT xfails plan 88-19-03 counts apart
#: from skips. Named here, once, so the expected number is derived and never typed.
STRICT_XFAIL_CLASS = "stale-metric-xfail"

_PLATFORMS = ("all", "darwin", "linux", "win32")
_CONTEXTS = ("any", "local")


def _is_nonempty_str(value):
    """True when ``value`` is a string with non-blank content."""
    return isinstance(value, str) and value.strip() != ""


#: field -> predicate, mirroring SCHEMA in scripts/skip-gate.cjs.
SCHEMA = {
    "name": lambda v: isinstance(v, str) and len(v) > 0,
    "file": lambda v: isinstance(v, str) and len(v) > 0,
    "platform": lambda v: v in _PLATFORMS,
    "context": lambda v: v in _CONTEXTS,
    "reason": _is_nonempty_str,
    "reason_class": _is_nonempty_str,
    "owner": _is_nonempty_str,
    "owner_phase": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "exit_criterion": _is_nonempty_str,
}

#: The order SCHEMA fields are reported in, so both halves name them identically.
SCHEMA_ORDER = [
    "name", "file", "platform", "context", "reason", "reason_class", "owner",
    "owner_phase", "exit_criterion",
]


def runner_of(file_value):
    """Which runner owns an entry, from its ``file`` field (rule 2).

    Args:
        file_value: the entry's ``file``.

    Returns:
        str: ``"node"``, ``"python"`` or ``"unowned"``.

    Example:
        >>> runner_of("tests/a.test.cjs"), runner_of("(collection)")
        ('node', 'python')
    """
    name = str(file_value or "")
    if name.endswith((".cjs", ".mjs", ".js")):
        return "node"
    if name.endswith(".py") or name == "(collection)":
        return "python"
    return "unowned"


def load_exceptions(path):
    """Read and validate the exceptions file. Fails closed (rule 5).

    Args:
        path: absolute path of ``tests/skip-exceptions.json``.

    Returns:
        tuple: ``(entries, problems)``. ``problems`` is a list of
        ``{"code", "detail"}``; when it is non-empty ``entries`` is empty.

    Raises:
        Nothing: every failure is returned as a problem, because a gate that raises
        is a gate that can be mistaken for a pass.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        return [], [{
            "code": CODES["UNREADABLE"],
            "detail": (
                "%s could not be read (%s). The gate fails closed: a run without "
                "the exceptions file is red, never green." % (EXCEPTIONS_REL, exc)
            ),
        }]
    try:
        doc = json.loads(text)
    except ValueError as exc:
        return [], [{
            "code": CODES["UNREADABLE"],
            "detail": "%s is not valid JSON: %s" % (EXCEPTIONS_REL, exc),
        }]
    if not isinstance(doc, list):
        return [], [{
            "code": CODES["MALFORMED"],
            "detail": (
                "%s must be a FLAT JSON array of entries, one per test per platform; "
                "got %s" % (EXCEPTIONS_REL, type(doc).__name__)
            ),
        }]

    problems = []
    seen = {}
    for index, entry in enumerate(doc):
        where = "entry #%d (%s :: %s)" % (
            index + 1,
            (entry or {}).get("file", "no file") if isinstance(entry, dict) else "no file",
            (entry or {}).get("name", "no name") if isinstance(entry, dict) else "no name",
        )
        if not isinstance(entry, dict):
            problems.append({"code": CODES["MALFORMED"], "detail": "%s is not an object" % where})
            continue
        bad = [k for k in SCHEMA_ORDER if not SCHEMA[k](entry.get(k))]
        if bad:
            problems.append({
                "code": CODES["MALFORMED"],
                "detail": "%s has invalid or missing field(s): %s" % (where, ", ".join(bad)),
            })
            continue
        if runner_of(entry["file"]) == "unowned":
            problems.append({
                "code": CODES["MALFORMED"],
                "detail": (
                    "%s names a file no runner owns; the Node gate owns *.cjs and the "
                    'Python gate owns *.py and "(collection)"' % where
                ),
            })
            continue
        key = "%s|%s|%s" % (entry["file"], entry["name"], entry["platform"])
        if key in seen:
            problems.append({
                "code": CODES["MALFORMED"],
                "detail": (
                    "%s duplicates the key (file, name, platform) of entry #%d; the file "
                    "is flat and every key is unique" % (where, seen[key] + 1)
                ),
            })
            continue
        seen[key] = index
    return ([] if problems else doc), problems


def is_applicable(entry, runner, platform, ci):
    """Whether an entry applies to this runner, platform and context (rule 2)."""
    if runner_of(entry["file"]) != runner:
        return False
    if entry["platform"] != "all" and entry["platform"] != platform:
        return False
    if entry["context"] == "local" and ci:
        return False
    return True


def evaluate(entries, observed, runner, platform, ci, explicit):
    """Apply the gate to one run. The Node half's ``evaluate`` in Python.

    Args:
        entries: validated exceptions entries.
        observed: list of ``{"kind", "file", "name", "reason"}``; ``kind`` is
            ``skip``, ``xfail``, ``suite-skip``, ``suite-todo`` or ``todo``.
        runner: ``"node"`` or ``"python"``.
        platform: ``darwin`` / ``linux`` / ``win32``.
        ci: whether ``CI`` is set and non-empty.
        explicit: whether this was a PARTIAL run.

    Returns:
        dict: ``{"exit_code", "findings", "counts"}``, findings sorted by
        ``(code, file, name, platform)`` in code-point order so the two halves
        produce the same list.
    """
    findings = []
    applicable = [e for e in entries if is_applicable(e, runner, platform, ci)]
    by_key = {"%s|%s" % (e["file"], e["name"]): e for e in applicable}
    matched = set()

    for item in observed:
        file_value = str(item.get("file") or "")
        name = str(item.get("name") or "")
        kind = str(item.get("kind") or "skip")
        reason = str(item.get("reason") or "")

        if kind in ("suite-skip", "suite-todo"):
            findings.append({
                "code": CODES["SUITE"],
                "file": file_value,
                "name": name,
                "platform": platform,
                "detail": (
                    "a skipped suite hides every test inside it from this gate and is not "
                    "counted as a skip by the runner, so it cannot be excused by an entry. "
                    "Skip the individual tests instead, each with its own entry in %s. "
                    "(reason: %s)" % (EXCEPTIONS_REL, reason or "none given")
                ),
            })
            continue
        if kind == "todo":
            findings.append({
                "code": CODES["TODO"],
                "file": file_value,
                "name": name,
                "platform": platform,
                "detail": (
                    "a {todo} test does not run and the skip counter never sees it, so it "
                    "bypasses this gate. Make it run, or skip it with an entry in %s. "
                    "(note: %s)" % (EXCEPTIONS_REL, reason or "none given")
                ),
            })
            continue

        key = "%s|%s" % (file_value, name)
        if key in by_key:
            matched.add(key)
            continue

        same_test = [e for e in entries if e["file"] == file_value and e["name"] == name]
        local_blocked = [
            e for e in same_test
            if e["context"] == "local" and ci
            and e["platform"] in ("all", platform)
            and runner_of(e["file"]) == runner
        ]
        if local_blocked:
            findings.append({
                "code": CODES["LOCAL_UNDER_CI"],
                "file": file_value,
                "name": name,
                "platform": platform,
                "detail": (
                    'the only entry for this test is context: "local", and CI is set. A '
                    "local-only entry excuses a skip ONLY when CI is unset; a CI cell may "
                    'never be quietened by one. Make the test run on CI, or give it a '
                    'context: "any" entry with its own reason. (reason: %s)'
                    % (reason or "none given")
                ),
            })
            continue
        other = sorted({e["platform"] for e in same_test})
        if other:
            detail = (
                "no entry in %s for platform %s; this test has entries for %s only. "
                "(reason: %s)" % (EXCEPTIONS_REL, platform, ", ".join(other), reason or "none given")
            )
        else:
            detail = (
                "no entry in %s for (file, name, platform=%s). A skip needs a true reason, "
                "an owner_phase and an exit_criterion. (reason: %s)"
                % (EXCEPTIONS_REL, platform, reason or "none given")
            )
        findings.append({
            "code": CODES["UNLISTED"],
            "file": file_value,
            "name": name,
            "platform": platform,
            "detail": detail,
        })

    if not explicit:
        for entry in applicable:
            key = "%s|%s" % (entry["file"], entry["name"])
            if key in matched:
                continue
            findings.append({
                "code": CODES["STALE"],
                "file": entry["file"],
                "name": entry["name"],
                "platform": entry["platform"],
                "detail": (
                    "this entry excused nothing on a full %s run on %s: the test no longer "
                    "skips. Delete the entry — that is the normal, green path when the "
                    "work its exit_criterion names is done. (owner_phase %s, reason_class %s)"
                    % (runner, platform, entry["owner_phase"], entry["reason_class"])
                ),
            })

    findings.sort(key=lambda f: (f["code"], f["file"], f["name"], f["platform"]))
    return {
        "exit_code": EXIT_SKIP_GATE if findings else 0,
        "findings": findings,
        "counts": {
            "observed_skips": len([o for o in observed if o.get("kind") in ("skip", "xfail")]),
            "applicable_entries": len(applicable),
            "matched_entries": len(matched),
            "stale_checked": not explicit,
        },
    }


def strict_xfail_check(entries, observed, platform, ci, explicit):
    """Count strict xfails apart from skips, and report a change (plan 88-19-03).

    An ``xfail`` that starts PASSING under ``strict`` is reported by pytest as a
    failure, so the session is already red — but only the COUNT makes the quieter
    direction visible, and only the count says by how much. The expected number is
    derived from the entries carrying ``reason_class: "stale-metric-xfail"`` that
    apply to this platform; it is five on every platform today (five
    ``test_grammar_strip`` cases × one entry each), and it is never typed as a
    literal.

    Args:
        entries: validated exceptions entries.
        observed: the run's observations.
        platform: the current platform.
        ci: whether ``CI`` is set.
        explicit: whether this was a partial run (then the check is skipped).

    Returns:
        list: zero or one finding.
    """
    if explicit:
        return []
    expected = [
        e for e in entries
        if e.get("reason_class") == STRICT_XFAIL_CLASS
        and is_applicable(e, "python", platform, ci)
    ]
    wanted = {"%s|%s" % (e["file"], e["name"]) for e in expected}
    seen = {
        "%s|%s" % (o.get("file"), o.get("name"))
        for o in observed if o.get("kind") == "xfail"
    }
    got = wanted & seen
    if len(got) == len(wanted):
        return []
    missing = sorted(wanted - seen)
    return [{
        "code": CODES["XFAIL_COUNT"],
        "file": EXCEPTIONS_REL,
        "name": STRICT_XFAIL_CLASS,
        "platform": platform,
        "detail": (
            "%d strict xfail(s) expected from the %s entries, %d observed. A strict xfail "
            "that starts PASSING is an xpass and a failure, and this count is what makes it "
            "visible. Not observed as xfail: %s"
            % (len(wanted), STRICT_XFAIL_CLASS, len(got), ", ".join(missing) or "none")
        ),
    }]


def format_result(result, runner, platform, ci, explicit):
    """Render a gate result for a terminal, in the Node half's style."""
    head = "--- skip gate (%s, %s, CI=%s, %s) ---" % (
        runner, platform, "set" if ci else "unset",
        "PARTIAL run: staleness not checked" if explicit else "full run",
    )
    if not result["findings"]:
        return "%s\nskip gate: %d skip(s), all listed; %d/%d applicable entries matched" % (
            head, result["counts"]["observed_skips"],
            result["counts"]["matched_entries"], result["counts"]["applicable_entries"],
        )
    lines = ["%s %s :: %s\n    %s" % (f["code"], f["file"], f["name"], f["detail"])
             for f in result["findings"]]
    return "\n".join(
        [head] + lines
        + ["--- skip gate: %d finding(s); exit %d ---" % (len(result["findings"]), EXIT_SKIP_GATE)]
    )


def ci_is_set(environ=None):
    """Whether ``CI`` is set to something meaningful (the Node half's rule)."""
    env = os.environ if environ is None else environ
    value = str(env.get("CI") or "").strip()
    return bool(value) and value.lower() != "false"


def _main(argv):
    """``--evaluate <input.json>``: the parity interface the Node test drives."""
    if len(argv) == 2 and argv[0] == "--evaluate":
        with open(argv[1], encoding="utf-8") as handle:
            data = json.load(handle)
        entries = data.get("entries")
        if entries is None:
            entries, problems = load_exceptions(data["exceptionsFile"])
            if problems:
                out = {
                    "exit_code": EXIT_SKIP_GATE,
                    "findings": [{
                        "code": p["code"], "file": EXCEPTIONS_REL, "name": "",
                        "platform": data.get("platform"), "detail": p["detail"],
                    } for p in problems],
                }
                sys.stdout.write(json.dumps(out, indent=2) + "\n")
                return EXIT_SKIP_GATE
        result = evaluate(
            entries,
            data.get("observed") or [],
            data["runner"],
            data["platform"],
            bool(data.get("ci")),
            bool(data.get("explicit")),
        )
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
        return result["exit_code"]
    sys.stderr.write(
        "usage: python tests/support/skip_gate.py --evaluate <input.json>\n"
        "The gate itself runs from tests/conftest.py; this mode exists for the\n"
        "cross-language parity test in tests/88-19-skip-gate.test.cjs.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
