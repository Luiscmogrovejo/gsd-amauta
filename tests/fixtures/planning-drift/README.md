# planning-drift fixtures

Seven minimal `.planning`-shaped trees. `.planning/` is gitignored in this repository,
so CI can only test `gsd-tools planning-drift` against these committed trees.
They are generated once and committed as plain files; edit them by hand if a check changes.

`tests/88-09-planning-drift.test.cjs` parses this file. The `expected-ids` line of each
tree is the contract: the set of finding ids the verb must emit for it, no more, no fewer.
Do not restate these lists anywhere else.

### tree: `agree`
- expected-ids: (none)
- expected-exit: 0
- Three complete phases on disk, and a fourth, `Phase 94.1`, listed as `Not started`
  with an unticked box, a Phase Map row and no directory. An unstarted phase with no
  directory is not drift, and the decimal number covers the heading regex.

### tree: `disagree`
- expected-ids: DRIFT_PHASE_NOT_IN_ROADMAP, DRIFT_ROADMAP_PHASE_MISSING_DIR, DRIFT_STATE_PROGRESS, DRIFT_STATE_PHASE_MAP, DRIFT_REQUIREMENT_TOTAL, DRIFT_PLAN_WITHOUT_SUMMARY, DRIFT_SUMMARY_WITHOUT_VERIFICATION
- expected-exit: 1
- Exactly one instance of each: `phases/99-orphan` has no heading; Phase 13 is
  `In progress` with no directory; STATE says 2 completed phases, the table says 3;
  the STATE Phase Map lists phase 77; REQUIREMENTS states 5 against 4 ids; `11-02-PLAN.md`
  has no summary; phase 12 has a summary and no VERIFICATION.

### tree: `exceptions`
- expected-ids: DRIFT_PHASE_NOT_IN_ROADMAP, DRIFT_ROADMAP_PHASE_MISSING_DIR, DRIFT_STATE_PROGRESS, DRIFT_STATE_PHASE_MAP, DRIFT_REQUIREMENT_TOTAL, DRIFT_PLAN_WITHOUT_SUMMARY, DRIFT_SUMMARY_WITHOUT_VERIFICATION
- expected-exit: 1
- The `disagree` tree plus a `drift-exceptions.json` recording only the plan-without-summary
  entry. That finding is still reported, with `excepted: true`, and does not count toward the
  exit code; the other six still do.

### tree: `archived-milestone`
- expected-ids: (none)
- expected-exit: 0
- Phase 20 appears only in `milestones/v3.4-ROADMAP.md`; phase 21 appears only in the
  ROADMAP's collapsed "Earlier Work" block. Neither is reported (the real records
  produce 64 spurious W007 warnings from `validate health` for this case).

### tree: `unreadable-goal`
- expected-ids: DRIFT_ROADMAP_HEADING_UNPARSEABLE, DRIFT_ROADMAP_FIELD_UNREADABLE
- expected-exit: 1
- Phase 91 uses `## Phase 91 — Name` (an em dash, no colon: the heading regex skips it).
  Phase 92 writes `**Goal**:` with the colon outside the bold. Phase 93 is the control with
  every field in the exact shape the parser needs and must not be reported. All three have a
  directory and an `In progress` row, so only the two parse findings can appear.

### tree: `skip-ledger-agrees`
- expected-ids: (none)
- expected-exit: 0
- The `agree` tree with phase 94.1 renamed to **13** (the new findings need an INTEGER
  owning phase, and the decimal coverage stays in `agree`), plus a `Carried Test
  Obligations` ledger with the four-column `Class id` form and its own
  `tests/skip-exceptions.json`. Two entries of class `fixture-pending` name
  `owner_phase: 13`; the ledger row for that class names Phase 13; phase 13 is
  `Not started`. A ledger row whose `Class id` is `—` deliberately has no entry and
  must stay silent — the real ROADMAP's Voyage row is exactly that case.

### tree: `skip-ledger-disagrees`
- expected-ids: DRIFT_SKIP_OWNER_PHASE_COMPLETE, DRIFT_SKIP_LEDGER_MISMATCH
- expected-exit: 1
- The same tree with one case of each direction, four findings in total: an entry whose
  `owner_phase` is **11**, which the progress table marks `Complete`
  (`DRIFT_SKIP_OWNER_PHASE_COMPLETE`) and which therefore also disagrees with its ledger
  row (`DIFFERING PHASE`); an entry of class `fixture-orphan` with no ledger row
  (`ENTRY WITH NO LEDGER ROW`); and a ledger row `fixture-ghost` with no entry
  (`LEDGER ROW WITH NO ENTRY`). The `—` row must still be silent.

## Rule: the exceptions file these two trees read

`planningDrift(root)` resolves it with ONE expression: `tests/skip-exceptions.json`
under the directory that CONTAINS the planning records — the parent of a root named
`.planning` (the operator's real repository) and the root itself for a fixture tree,
which is a self-contained, repository-shaped directory carrying its own `tests/`.
**An absent file produces no finding at all**: the five trees above have none, and a
"missing file" finding would turn all thirteen pre-existing findings into noise in every
repository that runs the verb.

## Rule: the loose heading scan

`phases/91-*` exists but its heading is skipped by the strict heading regex, so a naive
directory-vs-roadmap check would also report `DRIFT_PHASE_NOT_IN_ROADMAP` and the tree
would yield three findings. The verb first scans the raw ROADMAP for any heading matching
`/^#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\b/` (no colon required) and treats every phase
number it yields as accounted for in both directions. One unparseable heading therefore
produces exactly one finding, naming the fix, and does not cascade.
