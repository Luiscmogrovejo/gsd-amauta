<purpose>
Run the read-only domain auditors on-demand for a single domain (or all domains) and report the findings they filed to the substrate. Drives the `gsd-tools audit` verb, which runs the shared audit-runner engine's documented detects over the scope, POSTs each hit as an `audit` finding, then reports the open-audit sweep. Read-only: this workflow never fixes, patches, or auto-tickets — it files advisory findings and reports them.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="parse_args">
**Parse arguments:**

- `DOMAIN` — the first positional argument, if present. One of the nine auditor domains: `backend`, `infra`, `models`, `harness-self`, `frontend`, `api-connections`, `agentic-flow`, `mobile`, `general`. When absent, the audit runs ALL domains.
- `SCOPE` — the value following `--scope`, a comma-separated list of files to audit. When absent, the auditors' documented default scope is used (repo-level detects always inspect the tree read-only).

```
DOMAIN=""        # first positional arg, or empty for all domains
SCOPE_FLAG=""    # "--scope <files>" if the --scope flag is present
if arguments contain a domain token; then DOMAIN="<token>"; fi
if arguments contain "--scope <files>"; then SCOPE_FLAG="--scope <files>"; fi
```
</step>

<step name="run_audit">
**Run the auditors via the audit verb:**

The `gsd-tools audit` verb drives the shared `audit-runner` engine: it runs the domain's (or all domains') documented read-only detects over the scope, POSTs each hit to the findings substrate as `finding_type='audit'` (`POST /api/findings`), then reports the SUBS-04 sweep (`GET /api/findings?status=open&type=audit`) of what landed.

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" audit $DOMAIN $SCOPE_FLAG
```

The verb runs the detects regardless of the substrate's state, but it is NOT silent about failing to file what it found. Exit codes:

- `0` — every detected finding was posted and the sweep returned successfully.
- `1` — the substrate was unreachable, the findings endpoint returned an HTTP error, or `posted < detected`. The detections are still printed; they were not (all) recorded.

Parse the JSON report:
- `domain`: the audited domain (or `all`)
- `detected`: number of findings the detects produced
- `posted`: number filed to the substrate
- `not_posted`: `detected - posted`
- `post_errors[]`: one entry per finding that failed to file (`rule_id`, `file_path`, `daemon`, `status`, `body`)
- `findings_endpoint`: `{ ok, status, error }` for the sweep request
- `open_findings[]`: the open audit findings from the sweep (`rule_id`, `domain`, `severity`, `file_path`, `evidence`, `suggested_fix`), or `null` when the sweep did not succeed
- `daemon`: `false` when the substrate was unreachable

`open_findings: null` means UNKNOWN. Never report it as "0 open".
</step>

<step name="format_output">
**Format and display results**, grouping the open findings by domain and severity:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 AMAUTA Audit — {domain or "all domains"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Detected: N | Filed to substrate: N | Not filed: N | Substrate: up | down | HTTP <status>
```

**Findings by domain/severity:**
```
## {domain} — {severity}

- [{rule_id}] {file_path}
  Evidence: {evidence}
  Suggested fix: {suggested_fix}
```

**If the substrate was unreachable (`daemon: false`):**
```
Substrate unreachable — detections shown above were NOT filed.
Start the daemon and re-run to record them as findings.   (verb exit 1)
```

**If the substrate answered with an HTTP error (`findings_endpoint.ok: false`):**
```
Findings endpoint returned HTTP {status}: {error}.
The open-findings sweep is UNKNOWN, not empty — do NOT report "0 open".
Fix the daemon error and re-run.                          (verb exit 1)
```

**If some findings were detected but not filed (`not_posted > 0`):**
```
{not_posted} of {detected} finding(s) were NOT recorded: {post_errors summary}.
This audit is incomplete — the substrate does not hold what was found. (verb exit 1)
```

A non-zero exit from the verb is a reportable failure of the audit, not a
clean result. Never summarize a failed run as "N detected, 0 posted, 0 open"
with a success line.

**If no findings:**
```
No audit findings — the detects fired clean over the scope.
```
</step>

<step name="note_advisory">
**Note the advisory boundary** in the output footer:

```
---
These are advisory findings recorded in the substrate. This command is
read-only — it never fixes code and never auto-creates tickets. To remediate,
route findings through the Phase-79 router (findings-to-plan → plan-to-tasks),
which turns them into FIDEL-gated fix-tasks. Auditors file, executors fix,
the validator gates (separation of powers).
```
</step>

</process>

<success_criteria>
- [ ] `[domain]` argument parsed (default: all domains)
- [ ] `--scope <files>` flag parsed and passed through
- [ ] `gsd-tools audit` verb invoked with the domain and scope
- [ ] Detected + posted counts reported
- [ ] Open audit findings from the SUBS-04 sweep reported, grouped by domain/severity
- [ ] Daemon-down case reported AND surfaced as a failure (exit 1), not a clean result
- [ ] HTTP-error case reported: `open_findings: null` is UNKNOWN, never "0 open"
- [ ] `posted < detected` reported as an incomplete audit (exit 1)
- [ ] Advisory boundary noted — read-only, never fixes, never auto-tickets
</success_criteria>
