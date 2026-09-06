# What was wrong with this brief — TK-2313

Written by executor-backend on 2026-09-06 from the worktree `lane-2313-amauta`, branch
`fix/tk-2313-criteria-json-array`, base `a95f645`. Every item carries the command that measured it.
"Wrong" here includes "right, but for a reason the brief did not state" — the reader of the next
brief needs both.

## 1. The seven line numbers — correct at a95f645, and identical at HEAD

```
$ git show a95f645:amauta.py | grep -n 'split("|")'
2544 / 2546 / 2548 / 2552   (cmd_add:    criteria / deliverables / checklist / refs)
2696 / 2698 / 2700          (cmd_update: criteria / deliverables / checklist)
```
`git diff --stat a95f645 HEAD` before my edits listed only the two `.planning/lanes/tk-2313/` files, and
`md5 -q amauta.py` matched the `a95f645` blob (`fb9f19db5b7eda66d30e5ce9717f0668`). Nothing to correct;
the numbers are cited so the next reader does not re-measure them.

## 2. "2 callers" — true for shipped code in `get-shit-done/`, false as a count of emitters

`callers-at-dispatch.txt` lists `gsd-tools.cjs:1836` and `:1877`. `grep -rn -- '--criteria'` over the whole
repo (excluding `node_modules`, `data`, `.git`) found **four** literal sites, not two:

| site | what it is | in the brief's count? |
|---|---|---|
| `get-shit-done/bin/gsd-tools.cjs:1836` | story criteria, raw block text | yes |
| `get-shit-done/bin/gsd-tools.cjs:1877` | task criteria, `criteria.join(' | ')` at `:1865` | yes |
| `services/amauta-daemon.py:1300` | `flag_map` — `/api/add` and `/api/update` rewrite `body.criteria` into `--criteria` | no |
| `tests/e2e-advanced.test.cjs:714` | a test passing `'Tests pass|Coverage >80%'` | no |

The two the brief missed are the two the C3 grep also cannot see, because C3 scopes the grep to
`get-shit-done/`. Both were converted anyway (the daemon serializes a native list; the test sends an
array). A fifth emitter exists **outside this repo**: the installed copy
`~/.claude/get-shit-done/bin/gsd-tools.cjs:1836,1865,1877` — the same two lines, which is what the
running harness executes until `bin/install.js` is run. Not edited (MUST NOT WRITE).

No workflow, agent, or docs text in this repo instructs `--criteria "a|b"`:
`grep -rn -e 'pipe-separated' -e '--criteria' agents/ get-shit-done/workflows/ get-shit-done/agents/ docs/ README.md`
returned only the three argparse `help=` strings in `amauta.py` (now rewritten). The brief's D2 list of
"workflow/agent prompt text that tells an agent to write `--criteria "a|b"`" had zero members here.
BareRouter briefs that reference the syntax are prose in `~/Code/barerouter/.planning/phases/00-foundations-and-baseline/{briefs,audit-reports}/`
and `01-first-vertical-slice/01-CONTEXT.md:310`; none is an executable caller.

## 3. "The daemon's `/api/exec` passthrough if it rewrites these flags" — it does not; `/api/add` does

`services/amauta-daemon.py:2440-2456`: `/api/exec` takes `body["args"]` and hands the list to
`_run_amauta()` unchanged. The rewrite lives in `_build_args()` (`:1268-1323`), used by the
`command_map` routes (`/api/add`, `/api/update`, ...), and it forwards **only** `criteria`
(`flag_map["criteria"] = "--criteria"`, `:1300`). `deliverables`, `checklist` and `refs` are not in
`flag_map`, so a body carrying them through `/api/add` drops them silently — a pre-existing gap, not
introduced or fixed here. Measured on a private daemon (port 18913, stubbed infra detection): a
JSON-array string survives `/api/add` and `/api/exec update`; a native list is now `json.dumps`'d.

## 4. A second silent-drop path the brief did not know about

`get-shit-done/bin/gsd-amauta.cjs:567-576` (`cmdAdd`, direct/no-daemon path) builds the python argv
from an allow-list of flags that does not include `--criteria`, `--deliverables`, `--checklist` or
`--refs`. With the daemon down, `gsd-amauta.cjs add ... --criteria '[...]'` stores `success_criteria: []`
and prints `Created`. Measured (hop 6 in the report): same input via `python3 amauta.py` stored the
two-element array. This means C1's command line as written in the brief is only true through
`amauta.py` directly or through the daemon; through the Node CLI without a daemon it was already
lossy at `a95f645` for every format. Left unfixed: it is not the pipe split, the brief's MAY WRITE
for `gsd-amauta.cjs` is limited to "where it forwards these flags", and the direct path forwards none
of them. Named for the orchestrator.

## 5. "497" — the audit's number, and a second denominator in the same file

`TK-2322-inventory.json`: `full_store_sweep.items_scanned = 2440`, `flagged = 497`, verdicts
`{TRUNCATED: 495, CONCATENATED: 2}`, `cut_runs = 1224`, elements inside cut runs `3957`, of which
`3957 - 1224 = 2733` are spurious, earliest `created_at = 2026-04-14T00:03:33Z`. Every figure in the
brief is the audit's. But the same file's `totals` block uses the audit's declared window
(`created_at >= 2026-09-02 OR updated_at >= 2026-09-02`): `scanned 93, with criteria 42, TRUNCATED 9`.
The brief quotes the full-store sweep without saying so; a reader who opens `totals` first sees 9,
not 497. The `repair_ledger` says 11 flagged before repair, 9 after, in that window.

## 6. Persisted vs dispatched

Brief header: persisted `2026-09-06T22:15:52Z`. Commit `7d03d94` author/commit time
`2026-09-06T17:16:34-05:00` = `22:16:34Z`. Dispatch (`date -u` as first act): `22:18:17Z`. Claim
recorded by the store: `22:18:39Z`. Gap persisted-to-dispatch: 2 min 25 s.

## 7. Smaller mismatches

- The brief says the old code "cuts" or "refuses" a JSON array. It cuts: at `a95f645`,
  `--criteria '["run a | grep b exits 0","second"]'` stored `["[\"run a", "grep b exits 0\",\"second\"]"]`
  (2 elements, neither authored) and printed `Created`. It never refuses.
- C4 names two runners as alternatives. They are not alternatives: `scripts/run-tests.cjs` discovers
  only `tests/*.test.cjs` (`readdirSync(...).filter(f => f.endsWith('.test.cjs'))`); the 150+
  `tests/test_*.py` files run only under `python3 -m pytest`. Both were run, both arms.
- `--refs` exists only on `add` (`:5698`), so there is no `--refs-file` on `update`; the brief's
  "and siblings" is three siblings on `update`, four on `add`.
- The `add` guard was `if args.criteria:` (falsy — `--criteria ""` ignored) while `update` used
  `is not None` (`--criteria ""` stored `[""]`); the audit's §"guard asymmetry" noted this, the brief
  did not. Both now use `is not None`, and `""` is refused as "empty value".
