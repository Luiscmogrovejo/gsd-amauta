<purpose>
Run project test suite, capture raw output with exit codes, and log to RPETD T-phase.
Ensures the TEST_EVIDENCE validation gate has real test output to verify.
</purpose>

## Tool Paths (Phase 10 LEARN-07 — runtime Read dedup)

At the start of any bash invocation in this workflow, Read the shared CLI variable file and paste the shell block into your bash session:

1. Use the Read tool: `/Users/luismogrovejo/.claude/get-shit-done/references/cli-variables.md`
2. Copy the "Shell Variable Block" section into the current bash session
3. If the Read fails, fall back to these hardcoded paths (one-line per variable):

```bash
# Fallback (if Read of cli-variables.md fails — uncomment to activate)
# CLI="node /Users/luismogrovejo/.claude/get-shit-done/bin/amauta.cjs"        # fallback: task CLI
# RLM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-rlm.cjs"        # fallback: codebase search
# MEM="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-memory.cjs"     # fallback: memory/learnings
# RESEARCH="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-research.cjs"  # fallback: research chain
# TOOLS="node /Users/luismogrovejo/.claude/get-shit-done/bin/gsd-tools.cjs"    # fallback: tools/audit
# LEARNING_FORMAT="/Users/luismogrovejo/.claude/get-shit-done/references/learning-format.md"  # fallback: D-phase template
# TAG_RULES="/Users/luismogrovejo/.claude/get-shit-done/config/tag-rules.json"                # fallback: tag governance
```

<core_principle>
Tests must produce raw evidence — actual command output, not summaries. The T-phase log should contain
enough detail for a validator to confirm tests actually ran and verify pass/fail status.
</core_principle>

<process>

<step name="parse_arguments">
Parse $ARGUMENTS to determine mode:

**Argument patterns:**
- Phase number (e.g., `3`, `04`): Run tests for all code in that phase
- Task ID (e.g., `TK-0042`): Run tests related to that specific task
- `--test-cmd "command"`: Override auto-detected test runner
- `--task TK-XXXX`: Explicit task ID to log T-phase to (when running by phase number)

```bash
# Parse arguments
PHASE_NUM=""
TASK_ID=""
TEST_CMD=""

# Check if argument looks like a task ID
if [[ "$ARGUMENTS" =~ TK-[0-9]+ ]]; then
  TASK_ID="${BASH_REMATCH[0]}"
fi

# Check for phase number
if [[ "$ARGUMENTS" =~ ^[0-9]+\.?[0-9]* ]]; then
  PHASE_NUM="${BASH_REMATCH[0]}"
fi

# Check for --test-cmd
if [[ "$ARGUMENTS" =~ --test-cmd[[:space:]]+[\"\']([^\"\']+)[\"\'] ]]; then
  TEST_CMD="${BASH_REMATCH[1]}"
fi

# Check for --task override
if [[ "$ARGUMENTS" =~ --task[[:space:]]+(TK-[0-9]+) ]]; then
  TASK_ID="${BASH_REMATCH[1]}"
fi
```
</step>

<step name="detect_test_runner">
**If `--test-cmd` was provided, skip detection and use that.**

Otherwise, auto-detect the project's test runner:

```bash
# Detection priority order
if [ -f "package.json" ]; then
  # Check npm scripts for test command
  TEST_SCRIPT=$(node -e "
    const pkg = require('./package.json');
    const scripts = pkg.scripts || {};
    const cmd = scripts.test || scripts['test:unit'] || scripts['test:all'] || '';
    console.log(cmd);
  " 2>/dev/null)
  if [ -n "$TEST_SCRIPT" ]; then
    TEST_CMD="npm test"
    TEST_RUNNER="npm"
  fi
fi

if [ -z "$TEST_CMD" ] && [ -f "pytest.ini" ] || [ -f "pyproject.toml" ] || [ -f "setup.cfg" ]; then
  TEST_CMD="python -m pytest -v"
  TEST_RUNNER="pytest"
fi

if [ -z "$TEST_CMD" ] && [ -f "Makefile" ]; then
  HAS_TEST_TARGET=$(grep -c '^test:' Makefile 2>/dev/null || echo "0")
  if [ "$HAS_TEST_TARGET" -gt 0 ]; then
    TEST_CMD="make test"
    TEST_RUNNER="make"
  fi
fi

if [ -z "$TEST_CMD" ] && [ -f "go.mod" ]; then
  TEST_CMD="go test ./..."
  TEST_RUNNER="go"
fi

if [ -z "$TEST_CMD" ] && [ -f "Cargo.toml" ]; then
  TEST_CMD="cargo test"
  TEST_RUNNER="cargo"
fi
```

**If no test runner detected:** Report to user and ask for the test command.

```
No test runner auto-detected. Please provide the test command:
  /amauta:test-phase {phase} --test-cmd "your test command"
```
</step>

<step name="identify_scope">
**Determine which files/tests are in scope.**

If a phase number was given, find the phase directory and identify what was built:

```bash
if [ -n "$PHASE_NUM" ]; then
  # Use gsd-tools to find phase info
  PHASE_INFO=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" find-phase "$PHASE_NUM" --raw 2>/dev/null || echo "")

  # Look for SUMMARY.md files to understand what was built
  # Also check if phase has specific test files
  PHASE_DIR=".planning/phases/$PHASE_NUM"
  if [ -d "$PHASE_DIR" ]; then
    echo "Phase directory: $PHASE_DIR"
  fi
fi

# If a task ID was given, check its RPETD phases for context
if [ -n "$TASK_ID" ]; then
  AMAUTA_CLI="node $HOME/.claude/get-shit-done/bin/amauta.cjs"
  AMAUTA_OK=$($AMAUTA_CLI health --json 2>/dev/null | grep -c '"status":"ok"' || echo "0")

  if [ "$AMAUTA_OK" = "1" ]; then
    TASK_INFO=$($AMAUTA_CLI show "$TASK_ID" --json 2>/dev/null || echo "")
  fi
fi

# Pull inherited spec criteria for T-phase evidence (Phase 12 QA-02)
if [ -n "$TASK_ID" ] && [ "$AMAUTA_OK" = "1" ]; then
  INHERITED_SPEC=$($CLI show "$TASK_ID" --json 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  isc=d.get('inherited_success_criteria','none')
  print(json.dumps(isc) if isinstance(isc,dict) else str(isc))
except: print('none')
" 2>/dev/null || echo "none")
fi
```

**Report scope to user:**
```
## Test Scope

**Target:** {Phase N / Task TK-XXXX}
**Test Command:** {TEST_CMD}
**Test Runner:** {TEST_RUNNER}

Running tests...
```
</step>

<step name="run_tests">
**Execute the test command and capture EVERYTHING.**

```bash
# Run tests, capture stdout+stderr, and exit code
TEST_OUTPUT=$(eval "$TEST_CMD" 2>&1) || true
TEST_EXIT_CODE=$?

echo "Exit code: $TEST_EXIT_CODE"
echo "---"
echo "$TEST_OUTPUT"
```

**Important:** Capture the FULL output — do not truncate. The validation gate needs to see actual
test runner output (PASS/FAIL, assertion results, exit codes).

**If tests fail (exit code != 0):** Still capture and log the output. Failed tests are valid
evidence — they show the test was actually executed.

**Build the T-phase content string:**

```
T-phase content should include:
1. The exact command that was run
2. Exit code
3. Full stdout/stderr output (or first 3000 chars if very long)
4. Summary line: "X passing, Y failing" (parsed from output)
```
</step>

<step name="regression_sweep">
Compare test results against known-good baseline from STATE.md.

Parse the baseline from STATE.md (look for "## Test Baseline" section or "~NNNN total" pattern):

bash:
```bash
# Parse test baseline from STATE.md (Phase 12 QA-06)
BASELINE_LINE=$(grep -A2 "Test Baseline" .planning/STATE.md 2>/dev/null | grep -oE '[0-9]+ pass' | head -1 || echo "")
if [ -z "$BASELINE_LINE" ]; then
  BASELINE_LINE=$(grep -oE '~[0-9]+ total' .planning/STATE.md 2>/dev/null | head -1 || echo "unknown")
fi

# Parse current counts from TEST_OUTPUT
CURRENT_PASS=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ pass(ing|ed)?' | grep -oE '[0-9]+' | tail -1 || echo "?")
CURRENT_FAIL=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ fail(ing|ed|ure)?' | grep -oE '[0-9]+' | tail -1 || echo "0")

# Build REGRESSION block (<=100 chars)
if [ "$CURRENT_FAIL" = "0" ] || [ "$CURRENT_FAIL" = "" ]; then
  REGRESSION_STATUS="none"
else
  REGRESSION_STATUS="CHECK FAILURES"
fi
REGRESSION_BLOCK="REGRESSION: after: ${CURRENT_PASS} pass / ${CURRENT_FAIL} fail. Baseline: ${BASELINE_LINE}. Regression: ${REGRESSION_STATUS}."
```

Report to user:
```
## Regression Sweep
**Baseline:** ${BASELINE_LINE}
**Current:** ${CURRENT_PASS} pass / ${CURRENT_FAIL} fail
**Regression:** ${REGRESSION_STATUS}
```
</step>

<step name="log_to_rpetd">
**Log results to RPETD T-phase on the target task.**

```bash
AMAUTA_CLI="node $HOME/.claude/get-shit-done/bin/amauta.cjs"
AMAUTA_OK=$($AMAUTA_CLI health --json 2>/dev/null | grep -c '"status":"ok"' || echo "0")

if [ "$AMAUTA_OK" = "1" ] && [ -n "$TASK_ID" ]; then
  # Compose T-phase content
  T_CONTENT="Command: ${TEST_CMD}
Exit code: ${TEST_EXIT_CODE}

\$ ${TEST_CMD}
${TEST_OUTPUT_TRUNCATED}

Result: ${PASS_COUNT} passing, ${FAIL_COUNT} failing"

  # Append regression sweep result (Phase 12 QA-06)
  if [ -n "$REGRESSION_BLOCK" ]; then
    T_CONTENT="${T_CONTENT}

${REGRESSION_BLOCK}"
  fi

  # Append inherited spec if available (Phase 12 QA-02)
  if [ -n "$INHERITED_SPEC" ] && [ "$INHERITED_SPEC" != "none" ]; then
    T_CONTENT="${T_CONTENT}

INHERITED_CRITERIA: ${INHERITED_SPEC}"
  fi

  # Log to RPETD T-phase
  $AMAUTA_CLI rpetd "$TASK_ID" --phase T --content "$T_CONTENT"

  echo ""
  echo "T-phase logged to $TASK_ID"
fi
```

**If no task ID was provided and phase number was given:** Search for in-progress tasks
assigned to this phase and log to each one. If multiple tasks, ask user which to log to.

**If no amauta daemon:** Save test output to `.planning/test-results/{phase_num}-test-output.md`
as a fallback.
</step>

<step name="report_results">
**Present results to user:**

```markdown
## Test Results

**Command:** `{TEST_CMD}`
**Exit Code:** {TEST_EXIT_CODE}
**Result:** {PASS_COUNT} passing, {FAIL_COUNT} failing

{If exit_code == 0}
### All Tests Passed
T-phase evidence logged to {TASK_ID}. Task is ready for validation.

{If exit_code != 0}
### Tests Failed
{FAIL_COUNT} test(s) failed. Review the output above.

**Options:**
1. Fix failing tests and re-run: `/amauta:test-phase {args}`
2. Debug failures: `/amauta:debug {error description}`
3. Force log anyway (for expected failures): The T-phase was still logged with failure evidence.
```

**If amauta available and tests passed:**
```
**Next:** Move task to validation:
  node ~/.claude/get-shit-done/bin/amauta.cjs status {TASK_ID} validation
```
</step>

</process>
