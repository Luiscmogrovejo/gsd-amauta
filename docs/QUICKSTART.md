# GSD-Amauta Quickstart

This guide takes you from zero to your first shipped feature phase in about 15 minutes.

**Prerequisites:** Node.js >= 20, Docker (for PostgreSQL + Valkey), Python 3.11+, Claude Code or any MCP-compatible AI coding agent.

---

## Step 1: Install

Install the GSD-Amauta CLI globally. Note: v3.3.0 is the first public release — the package will appear on npmjs.com once the tag is pushed.

```bash
npm install -g gsd-amauta
```

Verify the install:

```bash
gsd-amauta --version
```

Expected output:

```text
gsd-amauta 3.3.0
```

---

## Step 2: Start infrastructure

GSD-Amauta uses PostgreSQL (with pgvector) for persistent memory and Valkey for caching. Both run in Docker.

```bash
docker compose -f $(npm root -g)/gsd-amauta/docker/docker-compose.yml up -d
```

Expected output:

```text
[+] Running 3/3
 ✔ Network gsd-network      Created
 ✔ Container gsd-postgres   Started
 ✔ Container gsd-valkey     Started
```

If you already have PostgreSQL running on port 5432, set `GSD_PG_HOST` and `GSD_PG_PORT` before continuing.

---

## Step 3: Run init

The `init` command runs a 7-step setup: detects your IDE, installs agents and skills, runs database migrations, and starts the daemon.

```bash
npx gsd-amauta init
```

Expected output:

```text
[1/7] Detecting IDEs...
[2/7] Installing agents, commands, skills...
[3/7] Detecting infrastructure...
[4/7] Running migrations...
[5/7] Starting daemon...
[6/7] Verifying system...
[7/7] Running assertions...

Step                     Status   Duration     Message
----------------------------------------------------------------------
detect_ides              pass     112ms        1 IDE(s) detected
install_skills           pass     2341ms       install complete
detect_infra             pass     198ms        pg-docker on 5432
migrations               pass     1102ms       24 migrations applied
start_daemon             pass     843ms        daemon started on port 18799
verify                   pass     91ms         health ok
run_assertions           pass     204ms        5/5 pass

gsd-amauta installed (5.1s) — run `gsd-amauta doctor` to verify.
```

If any step shows `fail`, run `gsd-amauta doctor` for diagnostics:

```bash
gsd-amauta doctor
```

For full debug output (stack traces, raw error detail):

```bash
npx gsd-amauta init --verbose
```

---

## Step 4: Open your project in Claude Code

Open your project directory in Claude Code. GSD-Amauta installs slash commands that Claude Code picks up automatically from `~/.claude/`.

If this is a brand-new project, use:

```
/amauta:new-milestone
```

GSD-Amauta will ask you a few questions about your project goal, tech stack, and milestone scope, then write `.planning/PROJECT.md` and `.planning/ROADMAP.md`.

If you already have `.planning/PROJECT.md`, skip to Step 5.

---

## Step 5: Plan your first phase

The RPETD pipeline (Research → Plan → Execute → Test → Deliver) breaks every feature into phases. A phase is a unit of work plannable in one sitting and executable in one session.

Plan Phase 1:

```
/amauta:plan-phase 1
```

The planner agent will:

1. Search your project memory for prior learnings relevant to this phase
2. Decompose the phase goal into tasks with concrete acceptance criteria
3. Write plan files to `.planning/phases/01-*/`
4. Register tasks in the task board

Expected output in Claude Code:

```text
## Planning Complete

Phase: 1 — [your phase name]
Plans created: 2
Waves: Wave 1 (parallel) -> Wave 2 (sequential)
Tasks: 6 total

Plans written:
  .planning/phases/01-.../01-01-PLAN.md
  .planning/phases/01-.../01-02-PLAN.md
```

Review the plan files before executing. Each task has:
- `<action>` — concrete instructions for the executor
- `<acceptance_criteria>` — grep-verifiable pass conditions
- `<files_expected>` — exact files to create or modify

To skip the research step and plan faster (useful for well-defined phases):

```
/amauta:plan-phase 1 --skip-research
```

---

## Step 6: Execute the phase

Once you are satisfied with the plan:

```
/amauta:execute-phase 1
```

The orchestrator dispatches each task to the right specialist agent based on file type:

- `executor-backend` — Python, Node.js, APIs, databases
- `executor-frontend` — React, CSS, UI components
- `executor-infra` — Docker, CI/CD, deployment scripts
- `executor-general` — Documentation, config, agent definitions

Agents run through 5 mandatory phases: **R**esearch → **P**lan → **E**xecute → **T**est → **D**eliver (RPETD). Each phase is gated — an agent cannot skip to Execute without completing Research and Plan first. This is not a soft guideline; it is enforced by the harness.

When an agent discovers a plan-vs-reality mismatch (called a "divergence"), it surfaces it as a first-class observation instead of silently fixing it. You decide: absorb, escalate, or replan.

Expected outcome:

```text
Phase 1 complete.
Tasks: 6/6 pass
Commits: 4 (feat: ..., test: ..., chore: ...)
```

---

## Step 7: Verify and ship

Check the task board:

```bash
amauta board
```

Run your test suite:

```bash
npm test
```

Review commits created by the executors and push:

```bash
git log --oneline -5
git push origin main
```

That is it — your first phase is shipped. GSD-Amauta stored everything it learned (patterns, failures, validated approaches) in PostgreSQL. Future phases start with that context already loaded.

---

## What's next

**Explore community modules:**

```bash
gsd-amauta module search payments        # Search the registry
gsd-amauta module install registry:stripe-integration@1.0.0
```

**Monitor A2A agent-to-agent activity (v3.3+):**

```bash
gsd-amauta a2a tail                      # Stream live agent-to-agent exchanges
```

**Run a full system health check:**

```bash
gsd-amauta doctor
```

**Upgrade to the latest release:**

```bash
npm install -g gsd-amauta@latest
npx gsd-amauta init --upgrade
```

**Read more:**

- [CONTRIBUTING.md](../CONTRIBUTING.md) — PR workflow, commit conventions, test policy
- [README.md](../README.md) — Feature overview, CLI reference, comparison table
- [docs/PRODUCTION.md](PRODUCTION.md) — Production deployment notes
- [SECURITY.md](../SECURITY.md) — Responsible disclosure policy

---

*GSD-Amauta v3.3.0 "The Dialect" — [GitHub](https://github.com/Luiscmogrovejo/gsd-amauta)*
