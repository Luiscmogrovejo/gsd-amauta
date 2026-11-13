#!/usr/bin/env python3
"""
services/party_session_cli.py — the party session CLI (container + recorded decisions)

Subprocess entry-point invoked by the Node-side `gsd-tools party <action>`
subcommands. Mirrors services/module_lifecycle_cli.py argparse + exit-code
discipline.

Phase 89 ORC-02 part 2 (plan 89-13): a party session is a container for
recorded decisions. The actions are exactly:

    python3 services/party_session_cli.py create --participants "gsd-planner,gsd-checker" [--json]
    python3 services/party_session_cli.py start <session_id> [--json]
    python3 services/party_session_cli.py terminate <session_id> [--json]
    python3 services/party_session_cli.py get <session_id> [--json] [--with-findings]
    python3 services/party_session_cli.py status [--json]
    python3 services/party_session_cli.py inspect <session_id> [--json]

`pause`, `resume` and `kill` were REMOVED. They are not unknown verbs: each one
answers a typed `party_verb_removed` message that says what replaced it, and
exits 2.

Exit codes:
    0 — success
    1 — SessionNotFoundError OR validation error
    2 — a removed verb, no PostgreSQL configured (typed `requires_postgres`),
        psycopg2.OperationalError, psycopg2.Error, IOError, or any other
        unexpected exception
"""

import argparse
import json
import os
import sys

# ── Path setup: ensure repo root is on sys.path ──────────────────────────────
# (mirrors services/module_lifecycle_cli.py L25-32)

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ── Import services ───────────────────────────────────────────────────────────

try:
    from services.party_session import (  # type: ignore
        create,
        start,
        terminate,
        get,
        list_findings,
        list_decisions,
        summarize_decisions,
        SessionNotFoundError,
    )
except Exception:
    try:
        from party_session import (  # type: ignore
            create,
            start,
            terminate,
            get,
            list_findings,
            list_decisions,
            summarize_decisions,
            SessionNotFoundError,
        )
    except Exception as _exc:
        print(json.dumps({
            "error": "import_failed",
            "detail": str(_exc),
            "schema_version": "1.0",
        }))
        sys.exit(2)


# ── The surface, and what was removed from it ─────────────────────────────────

#: The actions this CLI answers, in help order. `gsd-tools.cjs`'s KNOWN_ACTIONS
#: and its usage text carry the same list; tests/party-decisions-cli.test.cjs
#: proves the three agree.
ACTIONS = ("create", "start", "terminate", "get", "status", "inspect")

#: Verbs removed by Phase 89 ORC-02 part 2 (plan 89-13), each with the one line
#: that says what to do instead. A removed verb is not an unknown verb: it used
#: to work, so it answers with what replaced it instead of an argparse error.
REMOVED_ACTIONS = {
    "pause": (
        "There is nothing to pause: a session is a container, and its recorded "
        "decisions and findings persist whether or not anyone is working in it."
    ),
    "resume": (
        "There is nothing to resume, and no finding replay: read a session's "
        "findings with `party get <session_id> --with-findings` and its "
        "decision trail with `party inspect <session_id>`."
    ),
    "kill": (
        "Close a session with `party terminate <session_id>`. A reason is "
        "recorded as a decision (services/party_session.post_decision, type "
        "`block`), so it is part of the decision trail."
    ),
}

#: What every removed verb points at. Kept in one tuple so the text answer and
#: the JSON answer cannot disagree.
REMOVED_REPLACEMENTS = (
    "party status",
    "party inspect <session_id>",
    "party get <session_id> --with-findings",
    "party terminate <session_id>",
)

#: The `feature` key of the daemon's typed 503 for the same table
#: (services/amauta-daemon.py PG_ONLY_FEATURE_DETAIL).
PG_ONLY_FEATURE = "party_sessions"


def removed_verb_payload(action):
    """The typed answer for a removed verb.

    Args:
        action: one of the keys of REMOVED_ACTIONS.

    Returns:
        A dict with `error` = "party_verb_removed", the `action`, a `detail`
        sentence naming ORC-02 and the reason, and the `replacement` verbs.

    Raises:
        KeyError: `action` is not a removed verb.
    """
    return {
        "error": "party_verb_removed",
        "action": action,
        "detail": (
            f"`party {action}` was removed in v3.7 (ORC-02): a party session "
            "keeps only recorded decisions. It is a container row plus the "
            "decisions posted into it, not a lifecycle with transitions. "
            + REMOVED_ACTIONS[action]
        ),
        "replacement": list(REMOVED_REPLACEMENTS),
        "schema_version": "1.0",
    }


def requires_postgres_payload(exc):
    """The typed answer when no PostgreSQL is configured.

    Shaped like the daemon's `_requires_postgres_payload("party_sessions")` so a
    caller can branch on one `error` value on either path. The DSN resolver's
    own message is kept verbatim in `detail`: it names the variable to export
    and the contained DSN for tests, and dropping it would make the refusal
    less actionable, not more.

    Args:
        exc: the UnconfiguredPostgresDSN raised by services/pg_dsn.py.

    Returns:
        A dict with `error` = "requires_postgres" and `feature` =
        "party_sessions".
    """
    return {
        "error": "requires_postgres",
        "feature": PG_ONLY_FEATURE,
        "detail": (
            "Party sessions live in the party_sessions table (PostgreSQL "
            "migration 021) and have no SQLite implementation. Configure "
            "PostgreSQL to use them.\n\n" + str(exc)
        ),
        "cause": type(exc).__name__,
        "schema_version": "1.0",
    }


def answer_removed_verb(argv):
    """Answer a removed verb, if `argv` names one, and exit 2.

    Runs BEFORE argparse, which would otherwise report the verb as an invalid
    choice — true, and useless to someone whose script called it last week.

    Args:
        argv: the argument list without the program name.

    Returns:
        None when `argv` does not start with a removed verb. Does not return
        otherwise.
    """
    if not argv or argv[0] not in REMOVED_ACTIONS:
        return None
    payload = removed_verb_payload(argv[0])
    if "--json" in argv[1:]:
        print(json.dumps(payload))
    print(
        "ERROR: " + payload["detail"] + " Use instead: "
        + "; ".join(payload["replacement"]) + ".",
        file=sys.stderr,
    )
    sys.exit(2)


# ── Argparse layout ───────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(
        prog="party_session_cli",
        description=(
            "Party sessions: a container row plus its recorded decisions "
            "(Phase 89 ORC-02). "
            "Exit 0=success, 1=not found/validation, "
            "2=removed verb/no PostgreSQL/PG or IO error."
        ),
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # create
    p_create = sub.add_parser("create", help="Create a new party session")
    p_create.add_argument(
        "--participants",
        required=True,
        help="Comma-separated agent names (e.g. 'gsd-planner,gsd-checker')",
    )
    p_create.add_argument("--json", action="store_true", dest="json_mode")

    # start
    p_start = sub.add_parser("start", help="Label a session active (never refused; idempotent)")
    p_start.add_argument("session_id", help="UUID of the party session")
    p_start.add_argument("--json", action="store_true", dest="json_mode")

    # terminate
    p_terminate = sub.add_parser("terminate", help="Close a session (never refused; idempotent); its decisions stay readable")
    p_terminate.add_argument("session_id", help="UUID of the party session")
    p_terminate.add_argument("--json", action="store_true", dest="json_mode")

    # get
    p_get = sub.add_parser("get", help="Read-only session lookup")
    p_get.add_argument("session_id", help="UUID of the party session")
    p_get.add_argument("--json", action="store_true", dest="json_mode")
    p_get.add_argument(
        "--with-findings",
        action="store_true",
        dest="with_findings",
        help="Populate findings list in JSON output (default: omitted)",
    )

    # Phase 51 PARTY-04: party status
    p_status = sub.add_parser("status", help="List all party sessions with summary (Phase 51)")
    p_status.add_argument("--json", action="store_true", dest="json_mode")

    # Phase 51 PARTY-04: party inspect
    p_inspect = sub.add_parser("inspect", help="Inspect a session's ordered turn history + decision trail (Phase 51)")
    p_inspect.add_argument("session_id", help="UUID of the party session")
    p_inspect.add_argument("--json", action="store_true", dest="json_mode")

    return parser


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    answer_removed_verb(sys.argv[1:])
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.action == "create":
            # Parse participants from comma-separated string
            participants_raw = args.participants.strip()
            if not participants_raw:
                msg = "--participants must not be empty"
                if args.json_mode:
                    print(json.dumps({
                        "error": "validation_error",
                        "detail": msg,
                        "schema_version": "1.0",
                    }))
                else:
                    print(f"ERROR: {msg}", file=sys.stderr)
                sys.exit(1)
            participants_list = [p.strip() for p in participants_raw.split(",") if p.strip()]
            result = create(participants_list)
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(result["session_id"])
            sys.exit(0)

        elif args.action == "start":
            result = start(args.session_id)
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(f"session {args.session_id} started")
            sys.exit(0)

        elif args.action == "terminate":
            result = terminate(args.session_id)
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(f"session {args.session_id} terminated")
            sys.exit(0)

        elif args.action == "get":
            result = get(args.session_id)
            if result is None:
                msg = f"Session not found: {args.session_id}"
                if args.json_mode:
                    print(json.dumps({
                        "error": "SessionNotFoundError",
                        "detail": msg,
                        "schema_version": "1.0",
                    }))
                else:
                    print(f"ERROR: {msg}", file=sys.stderr)
                sys.exit(1)
            # Populate findings when --with-findings or --json is combined with --with-findings
            if args.with_findings:
                result["findings"] = list_findings(args.session_id)
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                participants_str = ", ".join(result.get("participants") or [])
                print(f"session {args.session_id}  status={result['status']}  participants=[{participants_str}]")
            sys.exit(0)

        elif args.action == "status":
            # Phase 51 PARTY-04 — list all sessions, sorted by updated_at DESC.
            from services.party_session import _get_store
            import psycopg2.extras
            rows = []
            with _get_store()._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute("""
                      SELECT session_id::text, status, participants, created_at, updated_at
                        FROM party_sessions
                       ORDER BY updated_at DESC
                    """)
                    rows = cur.fetchall()
            sessions_out = []
            for r in rows:
                participants = r["participants"]
                if isinstance(participants, str):
                    participants = json.loads(participants)
                summary = summarize_decisions(r["session_id"])
                sessions_out.append({
                    "session_id": r["session_id"],
                    "status": r["status"],
                    "participant_count": len(participants or []),
                    "decisions": summary,
                    "created_at": r["created_at"].isoformat() if hasattr(r["created_at"], "isoformat") else str(r["created_at"]),
                    "updated_at": r["updated_at"].isoformat() if hasattr(r["updated_at"], "isoformat") else str(r["updated_at"]),
                })
            result = {"schema_version": "1.0", "sessions": sessions_out}
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                if not sessions_out:
                    print("(no party sessions)")
                else:
                    for s in sessions_out:
                        d = s["decisions"]
                        print(f"{s['session_id']}  status={s['status']}  participants={s['participant_count']}  "
                              f"decisions=propose:{d['propose']}/agree:{d['agree']}/dissent:{d['dissent']}/block:{d['block']}  updated_at={s['updated_at']}")
            sys.exit(0)

        elif args.action == "inspect":
            # Phase 51 PARTY-04 — full session dict + decision trail + decision summary.
            session = get(args.session_id)
            if session is None:
                msg = f"Session not found: {args.session_id}"
                if args.json_mode:
                    print(json.dumps({"error": "SessionNotFoundError", "detail": msg, "schema_version": "1.0"}))
                else:
                    print(f"ERROR: {msg}", file=sys.stderr)
                sys.exit(1)
            # Populate findings (full ordered turn history)
            session["findings"] = list_findings(args.session_id)
            trail = list_decisions(args.session_id)
            summary = summarize_decisions(args.session_id)
            result = {
                "schema_version": "1.0",
                "session": session,
                "decision_trail": trail,
                "decision_summary": summary,
            }
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(f"Session {session['session_id']}  status={session['status']}  participants={session.get('participants') or []}")
                print(f"  findings={len(session['findings'])}  decisions={len(trail)}")
                for entry in trail:
                    print(f"  [{entry['decision_type']}] {entry['agent_name']}: {entry['content']}")
            sys.exit(0)

        else:
            parser.error(f"unknown action: {args.action}")

    except SessionNotFoundError as exc:
        if args.json_mode:
            print(json.dumps({
                "error": "SessionNotFoundError",
                "detail": str(exc),
                "schema_version": "1.0",
            }))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    except Exception as exc:
        # Catch psycopg2.OperationalError, psycopg2.Error, IOError and any unexpected error.
        # Check if it is a PG/IO class for better error naming.
        err_class = type(exc).__name__
        if err_class == "UnconfiguredPostgresDSN":
            # No PostgreSQL configured (the SQLite fallback): a typed answer a
            # caller can branch on, with the resolver's own guidance kept.
            payload = requires_postgres_payload(exc)
            if args.json_mode:
                print(json.dumps(payload))
            else:
                print(f"ERROR: {payload['detail']}", file=sys.stderr)
            sys.exit(2)
        is_pg = "psycopg2" in type(exc).__module__ if hasattr(type(exc), "__module__") else False
        is_io = isinstance(exc, (IOError, OSError))
        error_key = "pg_io_error" if (is_pg or is_io) else err_class
        if args.json_mode:
            print(json.dumps({
                "error": error_key,
                "detail": str(exc),
                "schema_version": "1.0",
            }))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    # Phase 88-13: UTF-8 stdio when the console code page is not (Windows cp1252); a no-op otherwise.
    import os as _os, sys as _sys
    _sys.path.append(_os.path.dirname(_os.path.abspath(__file__)))
    try:
        from _platform import setup_stdio
    except ImportError:  # pragma: no cover - a tree without services/ on sys.path
        def setup_stdio():  # type: ignore[misc]
            return False
    setup_stdio()
    main()
