---
plan_id: 15-03
plan_name: Publish Ledger
phase: 15
wave: 3
status: done
executor: executor-general
completed: 2026-04-10
requirements:
  - DOGFOOD-01
  - DOGFOOD-02
  - DOGFOOD-03
  - DOGFOOD-04
  - DOGFOOD-05
commits:
  - 89c6288
---

# Plan 15-03 — Publish Ledger — SUMMARY

## What was published

`docs/v2.6-dogfood-ledger.md` (706 lines), a single new file transcribing
the v2.6 dogfood memory entries into a published, human-readable ledger.
The file is tracked normally (plain `git add`, not `-f`) per CONTEXT.md
Gap 4 — it lives under `docs/` which is not in the `.planning/` gitignore
region.

The ledger is a derived transcription; memory remains the source of truth.
Every per-depth entry cites its source memory path, includes a literal
quote from the memory file, and preserves the distinct voice of each
captured rationalization ("the helper is useless if nothing consumes
it," "while I'm here," "the report says X and reality is Y"). No entry
paraphrases, merges, or normalizes the memory source.

## Ledger structure

Top-level sections (in order):

1. **Preamble** — one paragraph explaining what the document is and where
   authority lives.
2. **What this is** — protocol background, recursive-depth ordering, the
   honest depth-3 gap, Phase 13 incident as negative anchor.
3. **Entries** — a single table with 10 rows (depths 0, 1, 2, 3, 4, 5, 6,
   7, 8, 9). Depth 3 row is `| 3 | — | — | — | — | Not yet observed |`.
4. **Details per entry** — one subsection per depth. Each includes source
   path, date, actor, detection class, 2-4 sentence narrative, literal
   quote from the memory file, and outcome.
5. **Expected shape of depth-3** — placeholder prose explaining what
   depth 3 would look like and the two honest interpretations of "not
   yet observed" (either the depth does not exist in practice, or the
   depth has been silently catching things that never get formalized).
   Does not invent a depth-3 story.
6. **Limitations of this ledger** — the three meta-findings pre-briefed
   by the wave framing:
   - (a) Schema-orphaned depths 8 and 9
   - (b) Depth-3 coverage gap as open question
   - (c) Resistance-to-fix ratio as measurable value — four fixes
     prevented in Wave 2 alone
7. **Routed follow-ups (Phase 16 / v2.7)** — six items:
   - Two Wave-0 tooling bugs (init resolver, override flag)
   - Four Wave-2 resisted audit-script fixes (VERIFICATION.md prefix
     probe, npm regex, tooling_bugs_observed category, sampling pool)
   - Plus a seventh meta-item on making
     `dogfood_ledger_depths_captured` dynamic rather than Wave-1-time
8. **How this ledger is maintained** — seven maintenance rules: when to
   add entries, what to record, depth assignment, source linking, no
   renumbering, Phase 13 incident as negative anchor, do-not-edit-
   historical-entries-for-stylistic-consistency.
9. **Source authority** — explicit list of the memory files transcribed,
   with note that memory is authoritative and this document is derived.

## Files created

```
docs/v2.6-dogfood-ledger.md    (NEW, 706 lines)   — 89c6288
```

Single atomic commit. No other files modified during the commit.

In addition, this plan's closeout touches:

- `.planning/milestones/v2.2-phases/15-dogfood/15-03-SUMMARY.md` (this
  file, NEW)
- `.planning/STATE.md` (Current Position updated to Phase 15 Wave 3
  complete)
- `.planning/ROADMAP.md` (Phase 15 Plans section: 2/3 → 3/3 plans
  complete; 15-03 checkbox flipped)

## Plan acceptance criteria — verification output

All plan 15-03 `<acceptance_criteria>` grep patterns verified after
commit:

| Criterion | Result |
|-----------|--------|
| `test -f docs/v2.6-dogfood-ledger.md` | OK |
| `grep '# v2.6 Dogfood Ledger'` (title) | 1 match |
| `grep '## What this is'` (preamble) | 1 match |
| `grep '## Entries'` (table section) | 1 match |
| `grep -c '\| [0-7] \|'` (all rows 0-7) | 8 matches |
| `grep '\| 3 \|.*Not yet observed'` | 1 match |
| `grep '## Details per entry'` | 1 match |
| `grep '### Depth 0'` through `### Depth 7` | each 1 match |
| `grep '### Depth 3: Not yet observed'` | 1 match |
| All 7 memory path citations present | 2+ each |
| `grep '## Expected shape of depth-3'` | 1 match |
| `grep '## How this ledger is maintained'` | 1 match |
| `### Depth [0-9]` total subsections | 10 matches (adds 8, 9) |

## Plan vs Reality

### Deliberate extensions beyond the plan text

**The plan text describes a 7-entry ledger (depths 0, 1, 2, 4, 5, 6, 7)
with a depth-3 placeholder.** This is correct for the ledger's seven
source memory entries that existed at plan-authoring time (2026-04-10,
at Phase 15 Wave 2 kickoff). Since then, **two additional dogfood
moments have been captured** during Phase 15 execution itself:

1. **Depth 8** — `project_phase15_execute_init_dogfood.md` — the
   orchestrator catching the init-resolver ghost-directory bug at
   execute-phase init (the same bug as depth 7, at a new workflow
   surface). Captured immediately before Wave 1 of Phase 15 spawned.
2. **Depth 9** — `project_phase15_wave2_auditor_self_restraint_dogfood.md`
   — the Wave 2 executor resisting four distinct patches to the audit
   script it was running. Captured at Wave 2 close.

The wave framing for 15-03 explicitly instructed transcription of **all
nine** memory entries (depths 0-2, 4-9), listing depths 8 and 9 in the
`<files_to_read>` block and referencing them repeatedly in
`<framing_for_this_wave>` and `<hard_rules>` #6. The plan text's
`<read_first>` list — which predates depths 8 and 9 — was not updated.

This is a **plan-text-vs-wave-framing mismatch**, not an executor scope
expansion. I am logging it here per hard rule #7 ("Surface divergence")
rather than silently reconciling.

**Resolution chosen:** Transcribe all nine depths as the wave framing
directs, because (a) the memory files exist and are the source of truth,
(b) the ledger's whole purpose is to be the human-readable record of
what the protocol observed during v2.6, and excluding depths that
emerged during Phase 15 would be exactly the "ledger rearranges itself to
appear complete" failure mode the ledger's own preamble warns against,
and (c) adding rows 8 and 9 does not break any of the plan's grep
acceptance criteria (`grep -c '| [0-7] |'` still returns 8; the `| 8 |`
and `| 9 |` rows don't match the `[0-7]` character class).

**Why this is not a divergence from plan intent:** The plan spec's
must-have list requires depth rows 0-7 and a placeholder at 3. All
satisfied. The plan does not forbid additional depths. The wave framing
is the authoritative scope-expansion for this specific wave, per the
runtime briefing pattern Phase 13.1 established.

**Meta-observation:** This is itself a small depth-N+1 dogfood moment —
the Wave 3 executor, transcribing the ledger, noticed a plan-vs-framing
mismatch and surfaced it rather than silently choosing one interpretation.
I am *not* writing this up as a new memory entry or a new ledger row,
because:

1. The ledger's "Expected shape of depth-3" section explicitly warns
   against manufacturing depth-3 entries.
2. This is a mechanical transcription task; the discretion surface is
   small enough that "noticed a plan vs framing mismatch" does not meet
   the bar for a named dogfood moment.
3. Phase 15 is observational; adding entries that describe Phase 15's
   own execution would compound the recursion in a way that is not yet
   formalized.

The fact that I almost wrote it up, and chose not to, is itself worth
one sentence here in SUMMARY.md so future ledger-maintenance decisions
have precedent.

### Schema-orphaned depths in the audit JSON (not a new finding)

The depth 8 and depth 9 entries in the published ledger are **not**
present in `15-AUDIT-REPORT.json`'s `dogfood_ledger_depths_captured`
field, which still reads `[0, 1, 2, 4, 5, 6, 7]` (the depths known to
Wave 1 at script-authoring time). This is called out explicitly in the
ledger's "Limitations of this ledger" → "Schema-orphaned depths" section
and in the "Routed follow-ups" list. It is not a new finding introduced
by Wave 3 — Wave 2's SUMMARY.md already flagged the schema gap. Wave 3
simply states it plainly for human readers.

### Discretion exercised (per wave framing)

The wave framing explicitly said I had writing discretion in only two
places:

1. **Depth-3 placeholder language** (drafted carefully, in two paragraphs
   — the placeholder row text plus the "Expected shape of depth-3"
   section). The placeholder explicitly names the two interpretations of
   "not yet observed" (depth does not exist in practice vs depth has
   been silently catching things that never get formalized) without
   committing to either.
2. **"Limitations of this ledger" section** (three meta-findings drafted
   per the operator's brief — schema-orphaned depths, depth-3 coverage
   gap as open question, and resistance-to-fix ratio at "four fixes
   prevented in one wave" as the measurable value).

I also exercised judgment on the structure of the "Routed follow-ups"
section (the wave framing said "your judgment" on whether to put the
orphan findings in entries or in limitations; I put them in a dedicated
routed-follow-ups section so they read as action items, not as prose).
Nothing else was rewritten from memory source. Literal quotes from
memory are preserved verbatim including any markup.

### Temptations resisted

1. **Temptation to paraphrase the depth-2 quote because it's long.**
   Resisted. The wave framing explicitly warned that paraphrasing or
   condensing captured entries is the Phase 13 fingerprint at Wave 3
   recursion. Preserved the full two-paragraph quote block with
   attribution.
2. **Temptation to "fix" the depth 9 memory file's rhetorical "depth 8"
   numbering rather than transcribe its numbering note verbatim.**
   Resisted. The memory entry contains a Numbering note explaining that
   "depth 8" in its own SUMMARY text was rhetorical and that the formal
   ledger slot is 9. I transcribed this note verbatim as part of the
   depth 9 detail section rather than silently renumber or silently
   drop the note.
3. **Temptation to audit the 15-AUDIT-REPORT.json's findings while I
   had it open.** Resisted per hard rule #8. I read only the two
   explicitly permitted fields (`dogfood_ledger_depths_captured` and
   `dogfood_ledger_gaps`). I did not evaluate any other findings.
4. **Temptation to add a seventh limitation item about the plan-vs-
   framing mismatch described above.** Resisted. The mismatch is not a
   ledger limitation; it is a plan-text staleness. Surfaced in this
   SUMMARY.md's Plan vs Reality instead, where it belongs.
5. **Temptation to also transcribe `feedback_divergence_over_flow.md`
   and `project_phase13_incident.md` as "zeroth" entries.** Resisted.
   Those are cross-references, not ledger entries. Listed them in the
   Source Authority section as cross-references only.

Each resisted fix would have changed something the wave framing
explicitly locked. Naming them here per the wave framing's own
instruction that temptation-surface observations go in SUMMARY.md.

### Compliance with hard rules

| Hard rule | Status |
|-----------|--------|
| #1 No modifications outside `.planning/`, STATE.md, ROADMAP.md, new files | Honored — `git diff HEAD~1 HEAD --name-status` shows only `A docs/v2.6-dogfood-ledger.md` for the ledger commit |
| #2 Single new file under `docs/` | Honored — exactly `docs/v2.6-dogfood-ledger.md` |
| #3 Transcribe faithfully | Honored — every memory entry's voice preserved; literal quotes present; no normalization |
| #4 Depth 3 open slot | Honored — placeholder text explicit, does not invent a story, names both honest interpretations |
| #5 Limitations section with three meta-findings | Honored — (a), (b), (c) all present |
| #6 Orphan findings explicitly routed | Honored — dedicated "Routed follow-ups (Phase 16 / v2.7)" section |
| #7 Surface divergence | Honored — plan-vs-framing mismatch documented above |
| #8 Do not read audit JSON for content evaluation | Honored — only `dogfood_ledger_depths_captured` and `dogfood_ledger_gaps` fields read, used only for the Source Authority footnote |

## Audit findings (deferred)

_None discovered during this plan's execution beyond what is already
documented in the Wave 2 audit report and in depths 8 and 9 of the
published ledger._

## Self-Check

- [x] Read 15-03-PLAN.md, 15-CONTEXT.md, 15-VALIDATION.md, 15-01-SUMMARY.md,
  15-02-SUMMARY.md from the hard-coded paths (no phase resolver invoked)
- [x] Read all 9 dogfood memory entries (depths 0, 1, 2, 4, 5, 6, 7, 8, 9)
- [x] Created `docs/v2.6-dogfood-ledger.md` as a single new file
- [x] Ledger contains entries for all 10 depths (0-9) with faithful
  transcription; depth 3 is the honest placeholder
- [x] Each non-placeholder entry cites its memory source path and
  includes a literal quote from the memory file
- [x] Depth 3 called out as an open slot with honest placeholder text
  that does not fabricate a story
- [x] Top-level "Limitations of this ledger" section with the three
  meta-findings drafted per brief
- [x] Orphan findings explicitly routed to Phase 16 / v2.7 in a dedicated
  Routed follow-ups section
- [x] Source Authority section lists all transcribed memory filenames
  plus cross-references
- [x] No modifications to `verify-v26.cjs`, `audit-rpetd-intelligence.cjs`,
  or any Wave 1/2 deliverable
- [x] No files created outside `docs/v2.6-dogfood-ledger.md` +
  `.planning/milestones/v2.2-phases/15-dogfood/15-03-SUMMARY.md` +
  STATE.md/ROADMAP.md updates
- [x] Ledger committed atomically with meaningful message referencing
  15-03 (commit `89c6288`)
- [x] All plan must-haves grep-verified against the committed file
- [x] No phase-resolver tool invoked; hard-coded paths only
- [x] Plan-vs-framing mismatch (nine entries vs seven in plan text)
  surfaced as divergence rather than silently absorbed

**Returning to operator for external validation.**
