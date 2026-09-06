# Brief — validate TK-2313 (criteria are a JSON array, never split on "|"), persisted 2026-09-06T23:03:53Z

- **Agent** `gsd-validator` · **Repo** `gsd-amauta` (`~/Code/gsd-amauta`, default branch `master`) · **Branch**
  `fix/tk-2313-criteria-json-array`, head `35c1549` or later, base `a95f645` · written by the `gsd-executor-backend` lane.
  Own worktree: `git -C ~/Code/gsd-amauta worktree add <scratchpad>/worktrees/val-2313-amauta origin/fix/tk-2313-criteria-json-array`;
  the shared checkout and the executor's worktree (`lane-2313-amauta`) are not yours. `claimed_by ≠ validated_by`.
- **This is a critical, the last of four.** PASS only on measurement. The executor's report is at
  `.planning/lanes/tk-2313/WHAT-WAS-WRONG-WITH-THIS-BRIEF.md` on the branch; read it, do not trust it.
- **Live process rule.** The live daemon pid 40465 and the live Postgres mirror are never touched. Every run uses a private
  `AMAUTA_DATA_DIR` under the scratchpad and, for the daemon arm, a private port with `infra_detect` stubbed to SQLite as the
  lane did (its report names the mechanism); kill only your own daemon by PID. `/opt/homebrew/bin/node` explicitly.

## Criteria — the orchestrator's verdict conditions first
- **C1 — all seven split sites.** At `a95f645`, `grep -n 'split("|")' amauta.py` lists exactly seven lines (four in
  `cmd_add`, three in `cmd_update`). On the head it lists none. Paste both.
- **C2 — a JSON array, not a separator, on every entry path.** Private data dir. (a) `add task "t" --criteria
  '["run a | grep b exits 0","second"]'` then `show --json`: two criteria, the pipe inside the first survives byte for byte.
  (b) `update <id> --criteria "a|b"` exits 1 with the "expected a JSON array" message and the store is byte-identical before
  and after (hash the data file). (c) Same two shapes through `--deliverables`, `--checklist`, `--refs`. (d) The daemon arm:
  `/api/add` with a string body and with a native list, `/api/exec update` with JSON and with `a|b`; the last one exits
  non-zero and changes nothing. (e) `gsd-amauta.cjs add/update` through your private daemon stores the array whole.
- **C3 — counter-proof.** The new test file `tests/tk-2313-criteria-json-array.test.cjs` run against the `a95f645` tree
  (the lane's `TK2313_ROOT_UNDER_TEST` mechanism; print the blob hashes of the three files under test in each arm): 0 of 14
  pass at base, 14 of 14 on the head. The cut behaviour at base must be shown: the same add at `a95f645` stores two
  fragments neither of which was authored.
- **C4 — attribute the pytest delta. This is the criterion most likely to fail.** The lane reports that at base pytest fails
  `test_daemon_integration` ×2 and `test_gates` ×4, and on the head fails `test_e2e_lifecycle` ×6, and calls that "not
  attributed". Attribute it: run `test_e2e_lifecycle` on the head and read each failure. If any failure is caused by the
  change (a test or fixture still passing `"a|b"` strings, or a caller the lane missed), the verdict is GAPS-FOUND with the
  file and line, or FAIL if the change broke a real path. If they fail for the same environmental reason at base (live
  daemon, ports, mirror), show that with the same run at base and say so. "Not attributed" is not a verdict.
- **C5 — every caller converted.** `grep -rn -- '--criteria\|--deliverables\|--checklist\|--refs' get-shit-done/ services/
  tests/ amauta.py`: each caller passes JSON. Confirm the two the lane names as pre-existing and unfixed
  (`gsd-amauta.cjs cmdAdd` no-daemon path forwards none of these flags; `/api/add flag_map` lacks three of them) are
  pre-existing at `a95f645` by reproducing one of them there, and state them as named gaps outside this task, not as this
  PR's defects. The installed copy `~/.claude/get-shit-done/bin/gsd-tools.cjs` still carries the old `join(' | ')`; that is
  expected until `bin/install.js` runs after merge; state it.
- **C6 — the 497.** `git diff --stat a95f645 HEAD -- data/` is empty; the lane's explicit statement (no migration in this
  PR; 495 of 497 are TRUNCATED and cannot be restored by any delimiter; repair is per-item under TK-2322's ledger) is
  present in its what-was-wrong file. State whether you agree that a migration is impossible rather than merely deferred;
  if a delimiter-only repair is possible for the two non-truncated items, say so as an observation.
- **C7 — the lock pin.** `35c1549` moved the JSON parse inside `_file_lock` after the lane broke the "all 17 mutating cmd_*
  functions hold the lock" test. Run that test on the head: green. Run the whole new test file after `35c1549`: 14 of 14.
- **C8 — writable set.** `git diff --name-only a95f645..HEAD` is within: `amauta.py`, `get-shit-done/bin/gsd-tools.cjs`,
  `services/amauta-daemon.py`, `tests/e2e-advanced.test.cjs`, `tests/tk-2313-criteria-json-array.test.cjs`,
  `.planning/lanes/tk-2313/`. Anything else is listed.

## Verdict
Write `.planning/lanes/tk-2313/VERDICT.md` and `.planning/lanes/tk-2313/gaps-report-<ts>.json` on the branch (`.planning`
is gitignored here: `git add -f`), committed as `luis.c.mogrovejo@gmail.com` / `luiscmogrovejo` and pushed to
`origin/fix/tk-2313-criteria-json-array` after a fetch. Include "what was wrong with this brief". PASS is a verdict; say it
when earned. Do not merge, do not install, do not restart any daemon, do not run `amauta validate`. Blast radius: your
worktree, your data dir, your daemon PID; no unscoped kill, no rm elsewhere, guard every interpolated path, quoted heredocs
only. Past 45 minutes without a commit: stop and report.
