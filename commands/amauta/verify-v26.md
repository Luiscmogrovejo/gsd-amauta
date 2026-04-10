---
name: amauta:verify-v26
description: Run end-to-end v2.6 milestone verification audit
argument-hint: [--skip-behavioral]
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---
<objective>
Run the v2.6 end-to-end dogfood verification. Executes `scripts/verify-v26.cjs`
to produce an audit report covering all DOGFOOD-01..05 criteria, runs behavioral
tests (unless `--skip-behavioral`), and generates both JSON and Markdown reports
at `.planning/milestones/v2.2-phases/15-dogfood/15-AUDIT-REPORT.{json,md}`.

Phase 15 passes on audit completeness, not audit cleanliness — gaps found by
the audit are legitimate findings, not failures of this command.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/verify-rpetd-intelligence.md
</execution_context>

<process>
Execute the verification by running `node scripts/verify-v26.cjs` from the
project root.

If `--skip-behavioral` is passed in the command arguments, set
`SKIP_BEHAVIORAL=1` in the environment before running the script. The
deterministic checks will still execute — only the 30-minute behavioral
suite is skipped.

```bash
if arguments contain "--skip-behavioral"; then
  SKIP_BEHAVIORAL=1 node scripts/verify-v26.cjs
else
  node scripts/verify-v26.cjs
fi
```

After completion, read `15-AUDIT-REPORT.md` and display:

1. The **Summary** section (table of environment + phases audited)
2. The **Per-Criterion Results** table (DOGFOOD-01..05 with verdicts)
3. Any entries in **Hygiene Debt Observed**
4. The **Dogfood Ledger Status** line

Report the overall audit verdict. If the audit finds gaps, note them as
*expected findings*: Phase 15's contract is to observe the v2.6 pipeline
accurately, not to produce a green report. The `verify-v26.cjs` script always
exits 0 — the report body carries the real verdicts.

If the script prints `environment_missing`, surface that the behavioral tests
were skipped and recommend running with `ANTHROPIC_API_KEY` set when full
coverage is required.
</process>
