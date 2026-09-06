# VERDICT — TK-2313 (criteria are a JSON array, never split on "|")

**GAPS-FOUND.** Written by gsd-validator, dispatched `2026-09-06T23:04:19Z` (brief persisted `23:03:53Z`, 26 s earlier),
verdict written `2026-09-06T231544Z`. Head validated `042c1cc` (code identical to `35c1549`; `042c1cc` adds only VAL-BRIEF.md), base
`a95f645`. Own worktrees only: `val-2313-amauta` (head) and `val-2313-base` (detached at `a95f645`) under the scratchpad;
private `AMAUTA_DATA_DIR` per run; private daemon on `127.0.0.1:18918` with `infra_detect` stubbed to SQLite; own daemon
PIDs 58049 / 58304 / 60701 each stopped by PID; live daemon 40465 and Postgres mirror untouched. `/opt/homebrew/bin/node`
and `/opt/homebrew/bin/python3` (3.14.3) throughout. Gaps report: `gaps-report-2026-09-06T231544Z.json` beside this file.

The fix is right and complete on every production path (C1, C2, C3, C5, C6, C7, C8 hold, each measured). One criterion
fails: **C4**. The change reddens ten pre-existing tests that are green at the base, through a fixture the lane's grep could
not see. That is recoverable in one line, so GAPS-FOUND, not FAIL.

## Per criterion

**C1 — seven split sites: PASS.**
```
$ grep -n 'split("|")' <a95f645>/amauta.py
2544:            item["success_criteria"] = [s.strip() for s in args.criteria.split("|")]
2546:            item["deliverables"] = [s.strip() for s in args.deliverables.split("|")]
2548:            item["validation_checklist"] = [s.strip() for s in args.checklist.split("|")]
2552:            refs = [r.strip() for r in args.refs.split("|") if r.strip()]
2696:            item["success_criteria"] = [s.strip() for s in args.criteria.split("|")]; changed.append("success_criteria")
2698:            item["deliverables"] = [s.strip() for s in args.deliverables.split("|")]; changed.append("deliverables")
2700:            item["validation_checklist"] = [s.strip() for s in args.checklist.split("|")]; changed.append("validation_checklist")
exit=0  count=7      (2544-2552 inside cmd_add, def at :2507; 2696-2700 inside cmd_update, def at :2661)
$ grep -n 'split("|")' <head>/amauta.py
exit=1  count=0
```
Wider sweep on the head (`split('|')` either quote, `join(' | ')`/`join('|')`) over amauta.py, services/, get-shit-done/bin/:
only `gsd-tools.cjs:2275 out.split('|')` (parses a `val|n` probe string, unrelated) and `lib/audit-runner.cjs:122` (a regex
alternation builder). Nothing on a criteria path.

**C2 — JSON array on every entry path: PASS.** Private data dirs, head unless stated.
- (a) `add task t --criteria '["run a | grep b exits 0","second"]'` → exit 0, `show --json` → `["run a | grep b exits 0", "second"]`.
- (b) `update TK-0001 --criteria "a|b"` → exit 1, `--criteria: expected a JSON array of strings ... first offending character 'a'
  at offset 0`; `md5 tasks.json` before `90231b2a…` after `90231b2a…` (byte-identical); criteria unchanged on re-read.
  Same at base for contrast: exit 0, "Updated", store `1f00f422…` → `7aaa8cc2…`, criteria became `["a", "b"]`.
- (c) `add` with all four as JSON → stored `{"success_criteria": ["c | d"], "deliverables": ["x | y", "z"],
  "validation_checklist": ["k1 | k2"], "doc_refs": [{"path": "src/a|b.py"...}, {"path": "docs/n.md"...}]}`. `update` with `a|b`
  on `--deliverables`, `--checklist`, `--criteria`: each refused naming its own flag, hash-same=yes ×3. `add` with `a|b` on
  each of the four: refused ×4, items stayed at 1 (`['t4']`).
- (d) private daemon (`infra_detected backend=sqlite`, `daemon_started port=18918`): `/api/add` string body → TK-0001 stored
  `["run a | grep b exits 0", "second"]`; `/api/add` native list → TK-0002 stored the same array; `/api/exec
  ["update","TK-0001","--criteria","[\"x | y\",\"z\"]"]` → `exit_code 0`, stored `["x | y", "z"]`; `/api/exec
  ["update","TK-0001","--criteria","a|b"]` → `exit_code 1`, refusal text, `tasks.json same=yes`. `/api/exec` with
  `--deliverables '["d | e"]' --checklist '["k | l"]'` → exit 0, both stored whole (the exec passthrough carries all flags).
- (e) `gsd-amauta.cjs` through the private daemon (`GSD_AMAUTA_PORT=18918`, no auto-start needed): `add ... --criteria
  '[...]'` exit 0 → `show --json` `["run a | grep b exits 0", "second"]`; `update --criteria '["p | q"]'` exit 0 → stored;
  `update --criteria 'a|b'` **exit 1**, refusal, `tasks.json` same=yes. The private sqlite mirror holds the add-time array whole.

**C3 — counter-proof: PASS.** Same test file, `TK2313_ROOT_UNDER_TEST` switched:
```
head  amauta.py 8500d63e (md5 67b58a5c…)  amauta-daemon.py 515ef8a3 (cc1d6765…)  gsd-tools.cjs 8a7df9b8 (e4ddb50b…)  → tests 14 pass 14 fail 0  exit 0
base  amauta.py 071127ad (md5 fb9f19db…)  amauta-daemon.py 95e37cce (bc8d9584…)  gsd-tools.cjs b4d56784 (b3331cda…)  → tests 14 pass 0  fail 14 exit 1
```
Cut behaviour shown directly at `a95f645`: the same `add` stores `["[\"run a", "grep b exits 0\",\"second\"]"]` — two
fragments, neither authored, exit 0, "Created".

**C4 — attribute the pytest delta: GAPS-FOUND.** Not "not attributed" and not six: **ten**.
```
base a95f645: python3 -m pytest tests/test_e2e_lifecycle.py -v → 10 passed in 0.32s, exit 0
head 042c1cc: python3 -m pytest tests/test_e2e_lifecycle.py -v → 10 failed in 2.57s, exit 1
   every failure: amauta.py _refuse_list_flag ← _parse_list_flag(flag='--criteria', raw='All tests pass|No errors')
```
Cause: `tests/test_e2e_lifecycle.py:55` — `_make_add_args()` builds the `cmd_add` Namespace with
`criteria="All tests pass|No errors"`, the old pipe format. Every test in the file calls `cmd_add` first, so all ten hit
`sys.exit(1)`. It is caused by the change, by a test fixture still passing "a|b" — the brief's first named GAPS-FOUND case.
It is not a real-path break: every production emitter (`gsd-tools.cjs:1838/1881`, daemon `_build_args`,
`e2e-advanced.test.cjs:714`) sends JSON. The lane's `grep -rn -- '--criteria'` is structurally blind to this site because it
is a keyword argument, not a flag; the adversarial grep that finds it is
`grep -rn -E '(criteria|deliverables|checklist|refs)\s*=\s*["'"'"'][^"'"'"']*\|' tests/*.py` → exactly this one line.
`tests/test_phase12_inherit_spec.py` (the only other `criteria=` file) passes lists to `_new_item`, 8/8 on both arms.
The lane's other reds are environmental and identical on both arms: `tests/test_daemon_integration.py tests/test_gates.py`
→ `6 failed, 45 passed` at base and on the head (same six node ids: mirror-sync ×2, validate-gates ×4).
Fix: `criteria=json.dumps(["All tests pass", "No errors"])` at `:55`. One line; then re-run the file on the head.

**C5 — every caller converted: PASS, with two pre-existing gaps confirmed at base.** The brief's grep over
`get-shit-done/ services/ tests/ amauta.py` lists only: `gsd-tools.cjs:1838` (`storyCriteriaJson`) and `:1881`
(`criteriaJson`), both `JSON.stringify`; daemon `flag_map` `"criteria": "--criteria"` with the list→`json.dumps` hop;
`e2e-advanced.test.cjs:714` `JSON.stringify([...])`; the new test file; argparse help text. Reproduced at `a95f645` **and**
on the head: `gsd-amauta.cjs add task cjs-direct --criteria '[...]'` with no daemon → exit 0, "Created", stored
`success_criteria: []` (cmdAdd's allow-list forwards none of the four flags; `gsd-amauta.cjs` is byte-unchanged by this PR).
`/api/add` body `deliverables: ["will | drop"]` → TK-0004 created with `deliverables: []` (flag_map lacks
deliverables/checklist/refs). Both are named gaps outside this task, not this PR's defects. The installed copy
`~/.claude/get-shit-done/bin/gsd-tools.cjs:1865` still reads `criteria.join(' | ')`; expected until `bin/install.js`
runs after merge — and note that after merge and before install, the running harness's plan-to-tasks will be refused
loudly by the new amauta.py rather than cut silently.

**C6 — the 497: PASS.** `git diff --stat a95f645 HEAD -- data/` → empty (0 lines). The lane's explicit statement is
**not** in WHAT-WAS-WRONG-WITH-THIS-BRIEF.md (its §5 carries the numbers and a second denominator, `totals.flagged = 9`
in the audit window); the sentence lives in commit `c27bd97`'s message ("criteria that carry a genuine pipe are
unrepairable by any delimiter, so the wire format is now a JSON array") and the lane BRIEF's D3 ("history is not repaired
here. The 497 corrupted items are TK-2322's repair ledger"). On the question asked: for the 495 TRUNCATED, a byte-exact
automated migration is impossible, not merely deferred — `split("|")` also `strip()`ped every fragment, so the whitespace
around each cut is gone and `a|b` / `a | b` / `a |b` are indistinguishable after the fact; only a heuristic re-join is
possible, which is what TK-2322's per-item ledger does with a human-verified reconstruction. Observation: the 2
CONCATENATED items, `ST-0182` and `ST-0183` (read from the store file, not through the daemon), each hold two criteria
joined by a literal `"\n- "` markdown separator; a delimiter-only repair of those two is possible through the new
`update --criteria '[...]'` path.

**C7 — the lock pin: PASS.** `tests/17-01-archive-toctou.test.cjs` "all 17 mutating cmd_* functions have _file_lock
wrapping (AST check)": on the head ✔ (159 ms); on `c27bd97` (pre-pin, via `git archive`) ✖ — so the pin has a red arm.
The new file after `35c1549` (head tree, identical code): 14/14, exit 0 (C3 above).

**C8 — writable set: PASS.** `git diff --name-only a95f645..HEAD`: `.planning/lanes/tk-2313/{BRIEF.md, VAL-BRIEF.md,
WHAT-WAS-WRONG-WITH-THIS-BRIEF.md, callers-at-dispatch.txt}`, `amauta.py`, `get-shit-done/bin/gsd-tools.cjs`,
`services/amauta-daemon.py`, `tests/e2e-advanced.test.cjs`, `tests/tk-2313-criteria-json-array.test.cjs`. Nothing else.

## The executor worktree's uncommitted `agents/gsd-validator.md`

`git -C lane-2313-amauta diff -- agents/gsd-validator.md` (read only): +7 lines under Gate 4 adding an EXCEPTION that
accepts a commit SHA in place of a PR URL while the commit is unreachable from any remote-tracking ref. It is not on the
branch, not in this task's writable set, and has nothing to do with JSON-array criteria: **it does not belong to this
change.** It would not have helped this task either — `35c1549` is reachable from `origin/fix/tk-2313-criteria-json-array`,
so even the amended rule demands a PR URL, and none exists (`gh pr list --head fix/tk-2313-criteria-json-array` → `[]`
as Luiscmogrovejo). An executor lane editing the validator's gate text is a scope concern for the orchestrator.

## Gates (amauta protocol, informational — `amauta validate` not run per brief)

Divergence pre-gate scan: all four reports under barerouter `phases/00-foundations-and-baseline/divergence-reports/`
carry an `orchestrator_response`. RPETD R/P/E/T/D all non-empty. Gate 1 branch: `fix/tk-2313-criteria-json-array` in D.
Gate 2 LEARNING: present in D (per `show`). Gate 3: T carries blob hashes and 14/14 vs 0/14 output. Gate 4: no PR URL —
none exists; the brief forbids merge and does not ask for one; recorded, not graded.

## What was wrong with this brief

1. **"test_e2e_lifecycle ×6"** — it is ×10 (10/10 at head, 10/10 green at base). The lane's count was carried into the
   brief unverified.
2. **C5's grep cannot see C4's defect.** `grep -rn -- '--criteria…'` matches flag literals; the failing site is a
   Namespace keyword `criteria="…|…"` in `tests/test_e2e_lifecycle.py:55`. A brief whose caller census is a flag grep will
   miss every argparse-bypassing test. Include the keyword form in the census next time.
3. **C6 says the lane's explicit statement "is present in its what-was-wrong file."** It is not; §5 of that file has the
   audit numbers only. The statement is in commit `c27bd97`'s message and in the lane BRIEF's D3.
4. **"infra_detect stubbed to SQLite as the lane did (its report names the mechanism)"** — the lane's report says only
   "port 18913, stubbed infra detection". No mechanism. Mine: a shim `infra_detect.py` in the cwd (sys.path[0] under
   `python3 -c`), `sys.path.insert(1, <services>)`, `runpy.run_path(daemon, run_name="__main__")` with argv `run`,
   `GSD_RLM_ENABLED=false GSD_REDIS_ENABLED=false`. The daemon's `/api/health` GET does not exist (`Unknown GET route`);
   readiness was polled on `/api/status`.
5. **The brief's isolation rule is incomplete.** "Private `AMAUTA_DATA_DIR` for every command" leaves
   `GSD_POSTGRES_URL=postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta` in the ambient shell; `amauta.py:416-419` takes it as
   the memory DSN, `_mem_backend()` infers postgres from it, and `infra_detect` gives it priority 1. Every command after
   discovery ran `env -u GSD_POSTGRES_URL`; the ones before it (C2 a/b, the node test file, which inherits `process.env`)
   touched only `add/update/show`, none of which calls `_mem_log_event`/`_pg_conn`, so nothing reached PG — but that is
   luck the brief did not arrange. The rule should be: unset `GSD_POSTGRES_URL`/`AMAUTA_MEMORY_DATABASE_URL` and stub
   `infra_detect`, both.
6. **"the live Postgres mirror"** is on `:5433`; the daemon's default `DATA_DIR` is `<repo>/data`, not `~/.amauta` — the
   497 live in `~/Code/gsd-amauta/data/tasks.json` (2482 items today; `~/.amauta/tasks.json` has 6). The brief did not
   say where the store is; C6's observation had to read it.
7. **Whole-suite pytest hangs** on the 24th collected test, `tests/test_27_mrr_validation.py::test_rlm_mrr_validation`,
   without the RLM service; C4's "run pytest" needs that deselected (or `pytest-timeout`, which is not installed).
8. Minor: head is `042c1cc`, "35c1549 or later" holds (docs-only on top). The `timeout` binary is absent from this shell.

## Addendum — whole-suite pytest delta (written after the verdict commit)

`python3 -m pytest tests/ -q -rf --deselect tests/test_27_mrr_validation.py::test_rlm_mrr_validation`, private data dir,
`GSD_POSTGRES_URL` unset, dead daemon port, 1414 collected:

```
base a95f645: 22 failed, 1361 passed, 25 skipped, 1 deselected, 5 errors in 117.67s   exit 1
head 042c1cc: 33 failed, 1350 passed, 25 skipped, 1 deselected, 5 errors in 120.90s   exit 1
```
Node-id diff (`comm` over the sorted `FAILED` lines): **red on base only: none.** Red on head only: the ten
`tests/test_e2e_lifecycle.py` ids (C4) and `tests/test_rlm_enrichment.py::TestEnrichmentTiming::test_all_phases_under_budget`,
a 1.5 s wall-clock budget that ran on the head while three private-daemon sessions of mine were competing for the CPU;
isolated it passes 3/3 on the head (0.10/0.10/0.13 s) and 3/3 at base (0.12/0.21/0.10 s) — contention, not the change.
The 22 shared reds (gates ×4, daemon mirror ×2, pg_substrate/pg_integration under the unset DSN, grammar_strip ×5,
a2a_registry ×3, behavioral ×2, capability_access, amauta_mcp_tools) are identical on both arms and are not this PR's.
So the pytest delta caused by the change is exactly the ten C4 ids, and nothing else.
