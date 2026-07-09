---
name: amauta:audit
description: Run the read-only domain auditors on-demand and report the findings they filed
argument-hint: [domain] [--scope <files>]
allowed-tools:
  - Read
  - Bash
---
<objective>
Run the read-only auditor detects for a single domain (or all domains when no domain is given) over the working tree or an explicit scope, file each hit to the findings substrate as an `audit` finding, and report the open audit findings the sweep returns.

This command is read-only: it runs the auditors' documented grep/regex/config detects and files findings — it NEVER edits code, never patches, and never auto-tickets. Turning findings into gated fix-tasks is the Phase-79 remediation router's job (separation of powers: auditors file, executors fix, the validator gates).
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/audit.md
</execution_context>

<process>
Execute the audit workflow from @~/.claude/get-shit-done/workflows/audit.md end-to-end.
Parse the optional `[domain]` argument (default: all domains) and the optional `--scope <files>` flag from the command arguments and pass both through to the workflow.
</process>
