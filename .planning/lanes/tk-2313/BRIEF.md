# Brief — TK-2313: criteria are a JSON array, not a pipe-split string

- **Persisted 2026-09-06T22:15:52Z**, committed and pushed on this branch before dispatch. Dispatch time is in your own
  report; compare the two.
- **Agent** `gsd-executor-backend` · **Repo** `~/Code/gsd-amauta` (the harness source; **not** `~/.claude/get-shit-done`, which
  is the installed copy) · **Base** `master` = `a95f645` · **Branch** `fix/tk-2313-criteria-json-array` · **Worktree** `/private/tmp/claude-501/-Users-luismogrovejo-Code-barerouter/8660fe74-b01f-4758-82d5-9393daf19df3/scratchpad/worktrees/lane-2313-amauta` — yours alone.
- **Task** TK-2313 — claim it. Read it with `show TK-2313 --json`; its notes carry the TK-2322 audit's scope correction.
- **Live-tool hazard, stated first:** the running daemon (pid 40465, port 18799) executes
  `/Users/luismogrovejo/Code/gsd-amauta/amauta.py` **from the source checkout**, and every lane in this session uses it.
  You edit the worktree copy only. You never restart, signal, or reconfigure the daemon. Merging to master changes what
  the daemon runs at its next restart; that restart is the orchestrator's call, not yours.

## SUP-11 properties

| # | Property | Where |
|---|---|---|
| 1 | Disjoint file set | *MAY WRITE* — `amauta.py`'s add/update paths, the CLI callers that emit `--criteria`, their tests; a different repository from every product lane |
| 2 | A criterion that can fail | C1 (a criterion containing a literal pipe round-trips whole; the old code cuts it), C3 (every caller converted, proven by grep) |
| 3 | Read-only files named | *MUST NOT WRITE* |
| 4 | Do not soften | *Rules* |
| 5 | Answer written **to disk by you** | *Required* |

## The defect, measured
- `amauta.py:2544,2546,2548,2552` (`cmd_add`) and `:2696,2698,2700` (`cmd_update`): `args.criteria.split("|")` and the same for
  `deliverables`, `validation_checklist`, `refs`; `cmd_update` **replaces the whole list**. A criterion that contains a
  shell pipe (`a | b`) is cut; six criteria joined with `@@` were stored as one (note of 2026-09-03).
- TK-2322's audit (`website` `.planning/phases/00-foundations-and-baseline/audit-reports/TK-2322-inventory.json` and the
  `.md` beside it): 497 of 2440 store items affected back to 2026-04-14 — 495 TRUNCATED, 2 CONCATENATED, 1224 cuts,
  2733 spurious elements. Truncation dominates; criteria carrying genuine pipes are unrepairable by any delimiter.
- Callers that emit these flags at dispatch time: 2 lines, listed in `callers-at-dispatch.txt` beside this brief.
  Verify the list yourself; it was produced by grep, not by reading.

## Three decisions
**D1 — the wire format is a JSON array.** `--criteria` (and `--deliverables`, `--checklist`, `--refs`) accept a JSON
array string; a value that does not parse as a JSON array of strings is refused with a message naming the flag and
the first offending character — **not** split on anything. Add `--criteria-file <path>` (and siblings) for long lists.
No escape syntax. If a caller today passes `a|b`, that call must fail loudly after this change, not silently store
`["a|b"]`; write the refusal so the fix for the caller is obvious.
**D2 — every caller in this repo is converted in the same PR.** `gsd-tools.cjs plan-to-tasks`, any workflow/agent
prompt text that tells an agent to write `--criteria "a|b"`, and the daemon's `/api/exec` passthrough if it rewrites
these flags. C3 proves it by grep. Callers outside this repo (BareRouter briefs) are named in your report, not edited.
**D3 — history is not repaired here.** The 497 corrupted items are TK-2322's repair ledger; this PR stops the
bleeding and adds the detector's negative arm as a test. Do not rewrite `data/tasks.json` or the PG mirror.

## Criteria
- **C1 — round-trip with a pipe.** `add task "t" --criteria '["run a | grep b exits 0","second"]'` then `show --json`
  reads back exactly two criteria, the first containing the pipe. At `a95f645` the same input is refused or cut
  (paste which). On a **private store** (`AMAUTA_DATA_DIR` under the scratchpad; the daemon is not yours).
- **C2 — update replaces with the array, and only the fields sent.** `update --criteria '[...]'` replaces criteria and
  touches no other list; `update --deliverables '[...]'` likewise. A non-array value (`--criteria "a|b"`) exits non-zero
  with the flag named and stores nothing.
- **C3 — no pipe-split path remains** (`grep -n 'split("|")' amauta.py` empty) **and every caller emits JSON**
  (`grep -rn -- '--criteria' get-shit-done/ ` shows only JSON-array forms; paste it).
- **C4 — the suite.** Existing tests green (name the runner: `python -m pytest` or the repo's `scripts/run-tests.cjs`);
  new tests for C1/C2 red at `a95f645` (run them against a copy of the old `amauta.py`, provenance printed), green on
  the branch. Set-compare failing test names, not counts; this suite has non-deterministic members.
- **C5 — the daemon path.** The daemon dispatches `add`/`update` through `services/amauta-daemon.py`; show that the
  JSON array survives that hop (a private daemon on a port of your own with `AMAUTA_DATA_DIR` set, or the direct
  `runDirect` path with the reason stated). Never the live daemon.
- **C6 — nothing outside MAY WRITE** (`git diff --stat`).
- **C7 — the "what was wrong" file** (below).

## Files you MAY WRITE
`amauta.py` (the add/update/refs paths and their argparse help), `get-shit-done/bin/gsd-tools.cjs` (plan-to-tasks emit),
`get-shit-done/bin/gsd-amauta.cjs` only where it forwards these flags, `services/amauta-daemon.py` only where it
forwards them, workflow and agent prompt text that instructs the old syntax, `tests/`, `docs/` for the flag syntax, and
`.planning/lanes/tk-2313/`.

## Files you may READ but MUST NOT WRITE
`data/` (the live store and its backups), `bin/install.js`, `get-shit-done/bin/gsd-amauta.cjs`'s verdict writer
(TK-2339, just landed), anything under `~/.claude/`, the PG database on 5433.

## Standing rules
Blast radius is the worktree: kill only by PID of a process you started (your private daemon included); no `rm` outside
`/private/tmp/claude-501/-Users-luismogrovejo-Code-barerouter/8660fe74-b01f-4758-82d5-9393daf19df3/scratchpad/worktrees/lane-2313-amauta` and `/private/tmp/claude-501/-Users-luismogrovejo-Code-barerouter/8660fe74-b01f-4758-82d5-9393daf19df3/scratchpad`; guard every interpolated path with `[ -n "$VAR" ] || exit 1`; quoted heredocs only. Use
`/opt/homebrew/bin/node` explicitly. `GSD_AMAUTA_NO_AUTO_START=1` and a port of your own for any CLI run. Commit as
`luis.c.mogrovejo@gmail.com`. Push the branch; **do not merge to master and do not run `bin/install.js`** — both change the
live tool and are the orchestrator's call after a verdict.

## Rules
Do not soften. If a decision above contradicts a source you read, cite the line and stop on that item only. Every
claim carries its command.

## Required — written to disk by you
`.planning/lanes/tk-2313/WHAT-WAS-WRONG-WITH-THIS-BRIEF.md`. Candidates: the seven line numbers (measured on
`a95f645`); whether 2 callers is the real count; whether the daemon forwards these flags at all; whether "497"
is the audit's number or the orchestrator's memory of it.
