<purpose>
Verify RPETD intelligence integration by creating a sample task, walking it through all 5 RPETD phases with structured content, and running audit-rpetd-intelligence to validate that D-phase structured learning, E-phase evidence blocks, and T-phase QA artifacts are parseable by the audit tool.

This workflow is the DOGFOOD-02 deliverable for v2.6: it provides a reproducible procedure that exercises the audit binary against fresh, agent-authored RPETD content end-to-end. It does not modify any existing code or test infrastructure.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting. In particular, confirm that the `audit-rpetd-intelligence.cjs` binary and the `amauta.cjs` CLI are both reachable from your environment.
</required_reading>

<process>

<step name="preflight" priority="first">
**Verify the audit binary and amauta CLI are installed:**

```bash
AUDIT_BIN="$HOME/.claude/get-shit-done/bin/audit-rpetd-intelligence.cjs"
AMAUTA_CLI="$HOME/.claude/get-shit-done/bin/amauta.cjs"

if [ ! -f "$AUDIT_BIN" ]; then
  echo "ERROR: audit-rpetd-intelligence.cjs not found at $AUDIT_BIN"
  echo "Install Phase 15 tooling first (Plan 15-01)."
  exit 1
fi

if [ ! -f "$AMAUTA_CLI" ]; then
  echo "ERROR: amauta.cjs not found at $AMAUTA_CLI"
  exit 1
fi
```

If either binary is missing, abort — the workflow cannot proceed without them. Do NOT attempt to patch the environment or substitute alternative tools; surface the missing dependency and stop.
</step>

<step name="create_sample">
**Create a disposable story and task for verification:**

Use `amauta add story` and `amauta add task` to create a fresh verification task. Tag it with `verification:rpetd-intelligence` so it can be cleaned up later without ambiguity.

```bash
CLI="node $HOME/.claude/get-shit-done/bin/amauta.cjs"

STORY_ID=$($CLI add story "RPETD Intelligence Verification" \
  --content "Verify all 5 RPETD phases produce parseable structured content" 2>/dev/null \
  | grep -oE 'ST-[0-9]+' | head -1)

TASK_ID=$($CLI add task "Verification sample task" \
  --parent "$STORY_ID" \
  --agent executor-backend \
  --tags "verification:rpetd-intelligence" 2>/dev/null \
  | grep -oE 'TK-[0-9]+' | head -1)

echo "Created: STORY=$STORY_ID TASK=$TASK_ID"
```

If either ID fails to parse, STOP and report the raw output. The audit binary is useless without a real task id.
</step>

<step name="populate_rpetd">
**Walk the task through all 5 RPETD phases with the structured content the audit expects:**

Use `$CLI rpetd $TASK_ID --phase <PHASE> --content "..."` once per phase.

Each phase must include the markers the auditor looks for:

- **R-phase:** research context block (free-form, no markers required for the audit).
- **P-phase:** planning approach block (free-form, no markers required for the audit).
- **E-phase (Phase 11 / EXEC-01):** include a `PRE_EXECUTION_EVIDENCE:` block with at least one of `failure_patterns_queried`, `best_practices_queried`, `existing_style_queried`, or `security_checklist`.
- **T-phase (Phase 12 / QA-01, QA-02):** include `inherited_success_criteria`, an `EDGE_CASES:` block, and a `REGRESSION:` block.
- **D-phase (Phase 10 / LEARN-01):** include a structured LEARNING block with `WHAT:`, `WHY:`, `WHEN:`, and `TAGS:` fields.

Example D-phase content:

```
LEARNING:
WHAT: Audit binary accepts task IDs from amauta show --json
WHY: Direct require() keeps Phase 13.1 exports load-bearing
WHEN: RPETD intelligence verification runs
TAGS: verification,rpetd,audit
```

Populate the phases in order R → P → E → T → D so the audit sees a fully formed task.
</step>

<step name="run_audit">
**Invoke audit-rpetd-intelligence on the sample task:**

```bash
REPORT=$(node "$AUDIT_BIN" "$TASK_ID")
echo "$REPORT"
```

The binary always exits 0 — inspect the JSON body for the verdicts. Extract the `overall_verdict`, `d_phase.verdict`, `e_phase.verdict`, and `t_phase.verdict` fields.

If the binary errors out (`error` field populated), treat that as a hard failure and surface the error string verbatim. Do not attempt to repair the task — the whole point of this workflow is to observe what the audit sees.
</step>

<step name="report">
**Report per-phase compliance:**

Display a summary table based on the JSON response:

```
RPETD Intelligence Verification
================================
Task:    $TASK_ID
D-phase: PASS | GAPS_FOUND   (missing_fields: ...)
E-phase: PASS | GAPS_FOUND   (evidence: ...)
T-phase: PASS | GAPS_FOUND   (missing_blocks: ...)
Overall: PASS | GAPS_FOUND
```

If any phase has gaps, list the `missing_fields` (D-phase) or `missing_blocks` (T-phase) from the JSON report verbatim. Do NOT re-run the audit to try to clear the gaps — gaps here are a legitimate finding and belong in the surrounding audit report.

Leave the sample task and story in place unless the invoking operator explicitly asks for cleanup; they are the audit trail.
</step>

</process>

<notes>
This workflow is deliberately a *description* of steps for an agent to follow, not an executable shell script. The agent reads this workflow, performs each step interactively, and captures the RPETD markers the audit expects. Keeping the procedure declarative lets future agents adjust the sample content without having to touch the binary.

RPETD intelligence audit is observational. If the audit reports gaps, that is a Phase 15 finding — it does not mean this workflow failed. The workflow's contract is "ran the audit against a fresh task end-to-end," not "produced a green audit."
</notes>
