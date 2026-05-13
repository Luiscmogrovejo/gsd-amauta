#!/usr/bin/env python3
"""
services/party_session_cli.py — Phase 50 PARTY-01 / PARTY-02

Subprocess entry-point invoked by the Node-side `gsd-tools party <action>`
subcommands. Mirrors services/module_lifecycle_cli.py argparse + exit-code
discipline.

Usage:
    python3 services/party_session_cli.py create --participants "gsd-planner,gsd-checker" [--json]
    python3 services/party_session_cli.py start <session_id> [--json]
    python3 services/party_session_cli.py pause <session_id> [--json]
    python3 services/party_session_cli.py resume <session_id> [--json]
    python3 services/party_session_cli.py terminate <session_id> [--json]
    python3 services/party_session_cli.py get <session_id> [--json] [--with-findings]

Exit codes (frozen — Phase 50 CONTEXT §Area 5):
    0 — success
    1 — InvalidTransitionError OR SessionNotFoundError OR validation error
    2 — psycopg2.OperationalError, psycopg2.Error, IOError, or any other unexpected exception
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
        pause,
        resume,
        terminate,
        get,
        list_findings,
        post_decision,
        list_decisions,
        summarize_decisions,
        post_finding,
        InvalidTransitionError,
        SessionNotFoundError,
    )
except Exception:
    try:
        from party_session import (  # type: ignore
            create,
            start,
            pause,
            resume,
            terminate,
            get,
            list_findings,
            post_decision,
            list_decisions,
            summarize_decisions,
            post_finding,
            InvalidTransitionError,
            SessionNotFoundError,
        )
    except Exception as _exc:
        print(json.dumps({
            "error": "import_failed",
            "detail": str(_exc),
            "schema_version": "1.0",
        }))
        sys.exit(2)


# ── Argparse layout ───────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(
        prog="party_session_cli",
        description=(
            "Phase 50 PARTY-01/PARTY-02: party session lifecycle CLI. "
            "Exit 0=success, 1=invalid transition/not found/validation, 2=PG/IO error."
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
    p_start = sub.add_parser("start", help="Transition session from created to active")
    p_start.add_argument("session_id", help="UUID of the party session")
    p_start.add_argument("--json", action="store_true", dest="json_mode")

    # pause
    p_pause = sub.add_parser("pause", help="Transition session from active to paused")
    p_pause.add_argument("session_id", help="UUID of the party session")
    p_pause.add_argument("--json", action="store_true", dest="json_mode")

    # resume
    p_resume = sub.add_parser("resume", help="Transition session from paused to active; replays findings")
    p_resume.add_argument("session_id", help="UUID of the party session")
    p_resume.add_argument("--json", action="store_true", dest="json_mode")

    # terminate
    p_terminate = sub.add_parser("terminate", help="Transition session from active/paused to terminated")
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

    # Phase 51 PARTY-04: party kill
    p_kill = sub.add_parser("kill", help="Terminate a session with an audit-trail row (Phase 51)")
    p_kill.add_argument("session_id", help="UUID of the party session")
    p_kill.add_argument("-r", "--reason", default="no reason given", help="Operator-supplied reason for termination")
    p_kill.add_argument("--json", action="store_true", dest="json_mode")

    return parser


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
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

        elif args.action == "pause":
            result = pause(args.session_id)
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(f"session {args.session_id} paused")
            sys.exit(0)

        elif args.action == "resume":
            result = resume(args.session_id)
            n = len(result.get("findings") or [])
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(f"session {args.session_id} resumed ({n} findings replayed)")
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

        elif args.action == "kill":
            # Phase 51 PARTY-04 — terminate + audit row. Exit 1 when session not found
            # or already-terminated (InvalidTransitionError); exit 2 on PG/IO failure.
            reason = args.reason or "no reason given"
            terminated = terminate(args.session_id)   # may raise InvalidTransitionError / SessionNotFoundError
            audit_id = post_finding(
                session_id=args.session_id,
                agent_name="operator",
                finding_type="kill",
                content=f"Session killed by operator. Reason: {reason}",
                confidence=1.0,
                severity="info",
            )
            result = {
                "schema_version": "1.0",
                "session": terminated,
                "audit_finding_id": audit_id,
                "reason": reason,
            }
            if args.json_mode:
                print(json.dumps(result, default=str))
            else:
                print(f"session {args.session_id} killed  audit_finding_id={audit_id}  reason={reason!r}")
            sys.exit(0)

        else:
            parser.error(f"unknown action: {args.action}")

    except InvalidTransitionError as exc:
        if args.json_mode:
            print(json.dumps({
                "error": "InvalidTransitionError",
                "detail": str(exc),
                "schema_version": "1.0",
            }))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

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
    main()
