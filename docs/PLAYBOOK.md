# GSD-Amauta Playbook
## The Complete Step-by-Step Guide to Running a Project

> **How to get the best outputs, follow the pipeline correctly, use validation,
> research, and memory — from first command to shipped milestone.**

---

## Table of Contents

1. [What You're Working With](#1-what-youre-working-with)
2. [Before You Start: Service Setup](#2-before-you-start-service-setup)
3. [Starting a New Project — Step by Step](#3-starting-a-new-project--step-by-step)
4. [The RPETD Pipeline — How Every Task Works](#4-the-rpetd-pipeline--how-every-task-works)
5. [How Research Works](#5-how-research-works)
6. [How Validation Works (Independent Validator)](#6-how-validation-works-independent-validator)
7. [How Memory Works](#7-how-memory-works)
8. [Agent Roles and When to Use Each](#8-agent-roles-and-when-to-use-each)
9. [Best Practices: Getting Better Outputs](#9-best-practices-getting-better-outputs)
10. [Full Command Cheat Sheet](#10-full-command-cheat-sheet)
11. [Example: Complete Project from Scratch](#11-example-complete-project-from-scratch)
12. [Troubleshooting the Pipeline](#12-troubleshooting-the-pipeline)

---

## 1. What You're Working With

GSD-Amauta is two systems fused together:

```
┌──────────────────────────────────────────────────────────────────┐
│  GSD (Get Shit Done)          │  Amauta                          │
│  ─────────────────────────    │  ──────────────────────────────  │
│  Slash commands in Claude     │  Task management + agent system  │
│  /amauta:new-project             │  amauta.cjs board            │
│  /amauta:plan-phase              │  11 specialist agents            │
│  /amauta:execute-phase           │  RPETD pipeline enforcement      │
│  Creates .planning/ files     │  PostgreSQL memory               │
│  Phase-based project flow     │  RLM code context engine         │
│  Roadmap → Plans → Summaries  │  Perplexity research chain       │
└──────────────────────────────────────────────────────────────────┘
```

**GSD** = the project planning layer (roadmap, phases, plans, summaries).
**Amauta** = the task execution layer (tasks, RPETD, agents, validation, memory).

They work together: GSD creates the "what to build" structure, Amauta tracks "who is building what and how well."

### The 11 Agents

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOU (User)                               │
│                            │                                    │
│              ┌─────────────▼─────────────┐                     │
│              │       gsd-operator        │  ← Start here       │
│              │   Master Orchestrator     │                      │
│              └──┬──────┬──────┬──────────┘                     │
│                 │      │      │                                  │
│        ┌────────▼┐  ┌──▼────┐ └──────────────┐                 │
│        │planner  │  │resear-│                 │                 │
│        │         │  │cher   │           ┌─────▼──────┐         │
│        └────┬────┘  └───────┘           │  checker   │         │
│             │                           │(pre/post)  │         │
│     ┌───────▼──────────────────┐        └────────────┘         │
│     │     EXECUTOR WAVE        │                                │
│     │  frontend │ backend      │                                │
│     │  infra    │ general      │                                │
│     └───────────┬──────────────┘                                │
│                 │  (RPETD complete)                             │
│                 ▼                                               │
│          ┌──────────────┐                                       │
│          │  gsd-validator│  ← Independent. Never the executor  │
│          │  (external)   │                                      │
│          └──────┬────────┘                                      │
│                 │                                               │
│          PASS ──┤── FAIL → sub-tasks → executor → retry        │
│                 ▼                                               │
│            Task DONE                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Before You Start: Service Setup

Every session, verify the three services are running:

```bash
# 1. PostgreSQL (task state + memory)
docker start gsd-postgres
docker ps --filter name=gsd-postgres   # should show "healthy"

# 2. Amauta daemon (HTTP wrapper for task manager)
python3 ~/gsd-amauta/services/amauta-daemon.py start
curl -s http://127.0.0.1:18799/health | python3 -m json.tool

# 3. RLM service (code context engine)
python3 ~/gsd-amauta/services/rlm-service.py &
curl -s http://127.0.0.1:18798/health | python3 -m json.tool
```

Expected health output:
```json
{
  "status": "ok",
  "daemon": "amauta-daemon",
  "port": 18799,
  "pg_available": true,
  "pg_health": { "status": "ok" }
}
```

**Graceful degradation:** If any service is down, the system still works —
tasks fall back to JSON files, memory falls back to STATE.md, context falls
back to direct file reads. You lose features, not functionality.

---

## 3. Starting a New Project — Step by Step

### Step 1: Open Claude Code

```bash
claude --dangerously-skip-permissions
```

The `--dangerously-skip-permissions` flag lets agents write files, run tests,
and commit code without interrupting you for confirmation on every step.
Only use this when you trust the agents (which you should, with GSD-Amauta).

### Step 2: Start the Operator

Type in Claude Code:

```
@gsd-operator
```

Or spawn it directly from your first message:

```
I want to build [describe your project]. Please set up the task structure.
```

The operator will:
1. Ask clarifying questions about scope
2. Run `/amauta:new-project` to create `.planning/` structure
3. Break the project into epics → stories → tasks in Amauta
4. Assign tasks to the right specialist agents

### Step 3: Initialize the Project

```
/amauta:new-project
```

This single command runs a complete initialization pipeline:

```
/amauta:new-project
      │
      ├── Deep questioning (what are you building? constraints? tech stack?)
      │
      ├── Optional research (4 parallel researcher agents)
      │     ├── Stack researcher → finds best technologies
      │     ├── Architecture researcher → discovers patterns
      │     ├── Features researcher → maps requirements
      │     └── Pitfalls researcher → finds common failures
      │
      ├── Requirements definition (v1 / v2 / out-of-scope)
      │
      └── Roadmap creation (phases with success criteria)
            │
            Creates:
            ├── .planning/PROJECT.md       ← your vision
            ├── .planning/REQUIREMENTS.md  ← scoped requirements
            ├── .planning/ROADMAP.md       ← phase breakdown
            └── .planning/STATE.md         ← project memory
```

**Best practice:** Answer the questions thoroughly. The quality of your
answers here directly determines the quality of every plan and execution
that follows. Be specific about:
- What "done" looks like (user-observable outcomes)
- What's NOT in scope for v1
- Your tech stack preferences
- Any known constraints or risks

### Step 4: Create Amauta Task Structure

After `/amauta:new-project`, have the operator create the task hierarchy:

```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"

# Create epic (top-level project container)
$CLI add epic "My Project v1.0" --agent operator --priority high

# Create stories (feature areas)
$CLI add story "User Authentication" --parent EP-0001 --agent operator
$CLI add story "Core API" --parent EP-0001 --agent operator
$CLI add story "Frontend Dashboard" --parent EP-0001 --agent operator

# Create tasks (individual units of work)
$CLI add task "Design auth schema" --parent ST-0001 --agent executor-backend --priority critical --importance 5 --urgency 5
$CLI add task "Implement JWT middleware" --parent ST-0001 --agent executor-backend --priority critical --importance 5 --urgency 4
$CLI add task "Create login UI" --parent ST-0003 --agent executor-frontend --priority high --importance 4 --urgency 3

# Set dependencies (TK-0002 requires TK-0001 to finish first)
$CLI link TK-0002 --dep TK-0001
```

**Priority scoring** (Amauta uses `importance×0.4 + urgency×0.3 + dep_pressure×0.3`):
- `--importance 5` = critical to project success
- `--urgency 5` = time-sensitive
- `dep_pressure` is auto-calculated from how many tasks are blocked by this one

### Step 5: View the Board

```bash
$CLI board   # Full kanban view
$CLI stats   # Summary counts by status
```

---

## 4. The RPETD Pipeline — How Every Task Works

**Every single task** goes through exactly 5 phases. No exceptions.
No agent can mark a task done without completing all 5 phases.

```
┌────────────────────────────────────────────────────────────────────┐
│                        RPETD PIPELINE                              │
├──────────┬─────────────────────────────────────────────────────────┤
│  PHASE   │  WHAT HAPPENS                                           │
├──────────┼─────────────────────────────────────────────────────────┤
│ R        │  Research: Query RLM for code context, query memory for  │
│ Research │  past learnings, gather domain knowledge                 │
│          │  Output: understanding of what exists and what's needed  │
├──────────┼─────────────────────────────────────────────────────────┤
│ P        │  Plan: Define exact approach, files to change, risks,    │
│ Plan     │  cross-check against existing patterns via RLM           │
│          │  Output: specific implementation plan with file list     │
├──────────┼─────────────────────────────────────────────────────────┤
│ E        │  Execute: Write/edit code with per-file RLM context,     │
│ Execute  │  commit with task ID in message                          │
│          │  Output: working code committed to git                   │
├──────────┼─────────────────────────────────────────────────────────┤
│ T        │  Test: Run actual tests, capture real output (not        │
│ Test     │  "tests pass" — actual command output required)          │
│          │  Output: evidence that the work functions correctly      │
├──────────┼─────────────────────────────────────────────────────────┤
│ D        │  Document: Summary of what was delivered + mandatory     │
│ Document │  LEARNING block for memory storage                       │
│          │  Output: SUMMARY.md + memory entry for future use        │
└──────────┴─────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Validator reviews (external)
                              │
                    ┌─────────┴─────────┐
                    │                   │
                  PASS               FAIL
                    │                   │
               Task → DONE      Sub-tasks created
                                   │
                              Executor fixes
                                   │
                              Re-validate
```

### How an Executor Runs a Task

```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"

# 1. Claim the task (atomic — prevents duplicate work)
$CLI claim TK-0042 --agent executor-backend

# 2. R phase — research
$RLM query "JWT middleware patterns" --dir src/ --top-k 5 --compact
$MEM search "authentication patterns"
$CLI rpetd TK-0042 --phase R --content "R: Found existing auth pattern in src/middleware/. JWT library is jsonwebtoken v9. Memory: previous project used RS256 signing — avoid HS256 for scalability."

# 3. P phase — plan
$RLM query "how does existing middleware chain work" --dir src/middleware/ --top-k 3
$CLI rpetd TK-0042 --phase P --content "P: Will add src/middleware/auth.ts. Approach: extract Bearer token from Authorization header, verify with RS256 public key, attach decoded user to req.user. Risk: token expiry handling needs edge case test."

# 4. E phase — execute
$RLM query "existing error handling pattern" --path src/middleware/error.ts
# ... write the code using Write/Edit tools ...
git commit -m "TK-0042: implement JWT auth middleware with RS256"
$CLI rpetd TK-0042 --phase E --content "E: Created src/middleware/auth.ts (87 lines). Added to middleware chain in app.ts:45. Handles: valid token, expired token, malformed token, missing header."

# 5. T phase — test (REAL output required)
$CLI rpetd TK-0042 --phase T --content "T: npm test -- --grep auth
PASS src/middleware/auth.test.ts
  ✓ valid token passes (12ms)
  ✓ expired token returns 401 (8ms)
  ✓ malformed token returns 401 (6ms)
  ✓ missing header returns 401 (5ms)
Tests: 4 passed, 4 total"

# 6. D phase — document + LEARNING
$CLI rpetd TK-0042 --phase D --content "D: JWT auth middleware complete. Attaches decoded payload to req.user. LEARNING: RS256 requires public key file — store path in env var, not hardcoded. Add to project template."
$MEM learn "RS256 JWT: store public key path in JWT_PUBLIC_KEY env var. Never hardcode. See TK-0042."

# 7. Set status to validation (signals operator to spawn validator)
$CLI status TK-0042 validation
```

### Gate Rules

- **20-minute minimum** between phases — prevents rushing
- **`--force`** overrides the gate for trivial tasks (config files, docs)
- **Tag `no-gitflow`** to skip the gitflow gate for tasks not in the git workflow
- **No self-validation** — the executor who ran R through D cannot call `validate`

---

## 5. How Research Works

Research happens at two levels: **project research** (GSD layer) and
**task research** (Amauta layer). Both feed into each other.

### Level 1: Project Research (GSD — /amauta:new-project)

When you run `/amauta:new-project`, 4 parallel researcher agents activate:

```
/amauta:new-project
      │
      └── Spawns 4 gsd-researcher agents in PARALLEL:
            │
            ├── Stack researcher
            │     "What are the best technologies for this domain?"
            │     "What's the current ecosystem state?"
            │     → Outputs: framework choices, library recommendations
            │
            ├── Architecture researcher
            │     "How do experts structure this type of system?"
            │     "What are the established patterns?"
            │     → Outputs: folder structure, data flow, layers
            │
            ├── Features researcher
            │     "What features does this type of app need?"
            │     "What requirements are commonly missed?"
            │     → Outputs: requirement checklist, edge cases
            │
            └── Pitfalls researcher
                  "What commonly goes wrong with this type of project?"
                  "What do developers regret not doing early?"
                  → Outputs: anti-patterns, security risks, scaling traps
```

**Research chain (stops at first sufficient answer):**
```
Memory (past learnings)
  → SKB (shared knowledge base)
    → Context7 MCP (project docs)
      → Perplexity API (web search, if PERPLEXITY_API_KEY set)
        → WebFetch (specific URL fallback)
```

### Level 2: Task Research (RPETD R-phase)

Every task's R-phase queries two sources:

**RLM (Retrieval Language Model) — local code context:**
```bash
# What code already exists for this feature area?
node ~/.claude/get-shit-done/bin/gsd-rlm.cjs query "auth middleware" --dir src/ --top-k 5

# What does this specific file do?
node ~/.claude/get-shit-done/bin/gsd-rlm.cjs query "connection pooling" --path src/db/pool.ts

# How are tests structured for this area?
node ~/.claude/get-shit-done/bin/gsd-rlm.cjs query "test setup patterns" --dir tests/ --compact
```

RLM uses **TF-IDF retrieval** (no API key required). It:
- Chunks your code files intelligently (functions, classes, blocks)
- Ranks chunks by relevance to your query
- Returns the most relevant sections with line numbers
- Has LRU caching for performance

**Memory — past learnings:**
```bash
# What did we learn from similar work?
node ~/.claude/get-shit-done/bin/gsd-memory.cjs search "authentication patterns"

# Cross-project search (find learnings from other projects)
node ~/.claude/get-shit-done/bin/gsd-memory.cjs cross-project "JWT security" --tags security,auth
```

### Level 3: Deep Research (gsd-researcher agent)

For complex or unfamiliar domains, spawn the researcher directly:

```bash
# Operator spawns gsd-researcher:
Task(
  subagent_type="gsd-researcher",
  prompt="Research mode: web. Topic: PostgreSQL connection pooling for high-concurrency Node.js apps.
  
  Run research chain: memory → SKB → Perplexity → synthesize.
  Log findings to task TK-0015 R-phase:
  node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0015 --phase R --content 'R: ...'
  Return structured findings."
)
```

Or use the CLI directly:
```bash
node ~/.claude/get-shit-done/bin/gsd-research.cjs search "PostgreSQL connection pooling Node.js best practices"
node ~/.claude/get-shit-done/bin/gsd-research.cjs check-providers  # see what's available
```

### What Perplexity Does

If `PERPLEXITY_API_KEY` is set, every web research query goes through
Perplexity's web search API. This gives you:
- Current information (not Claude's training cutoff)
- Real documentation and library references
- Community best practices from recent sources

Without it, WebFetch is used as fallback (slower, less comprehensive).

### Research Best Practices

| Do | Don't |
|----|-------|
| Let research inform your requirements | Skip research on unfamiliar domains |
| Use `gsd:discuss-phase` to lock in decisions before planning | Jump straight to execute-phase |
| Store research findings in memory (`--source web_search_result`) | Let research findings live only in context |
| Search memory before starting any task R-phase | Reinvent solutions we've solved before |
| Use `--top-k 10` for broad exploration, `--top-k 3` for focused lookup | Use RLM with huge `--top-k` on every query |

---

## 6. How Validation Works (Independent Validator)

**The core rule: no agent validates its own work.**

This is enforced architecturally — the executor cannot call `validate --pass`
on a task it executed. Only the operator, checker, or validator can do this.

### The Validation Flow

```
Executor completes RPETD D-phase
              │
              ▼
$CLI status TK-0042 validation
              │
              ▼
Operator detects task in VALIDATION status
              │
              ▼
Operator spawns gsd-validator (separate fresh context)
              │
      Task(subagent_type="gsd-validator", prompt="...")
              │
              ▼
┌─────────────────────────────────────────────────────┐
│              VALIDATOR CHECKS (4 gates)             │
│                                                     │
│  Gate 1: RPETD Completeness                         │
│    ✓ All 5 phases logged with meaningful content?   │
│    ✗ Empty or placeholder content = auto-fail       │
│                                                     │
│  Gate 2: Test Evidence                              │
│    ✓ T-phase has REAL command output?               │
│    ✗ "Tests pass" without output = fail             │
│                                                     │
│  Gate 3: Learning Captured                          │
│    ✓ D-phase has LEARNING: statement?               │
│    ✗ No learning extracted = fail                   │
│                                                     │
│  Gate 4: Success Criteria Met                       │
│    ✓ Each criterion verified against artifacts?     │
│    ✗ Criterion unverified = fail                    │
└─────────────────────────────────────────────────────┘
              │
    ┌─────────┴─────────┐
    │                   │
  PASS               FAIL
    │                   │
$CLI validate       $CLI validate
  --pass              --fail
                        │
                  --subtasks "Fix A|Add test B"
                        │
                  Sub-tasks created
                        │
                  Executor claims fixes
                        │
                  RPETD again on sub-tasks
                        │
                  Re-validate
```

### How the Validator Spawns

The operator spawns the validator with full task context:

```
Task(
  subagent_type="gsd-validator",
  prompt="You are gsd-validator. Validate task TK-0042.

  Steps:
  1. node ~/.claude/get-shit-done/bin/amauta.cjs show TK-0042
  2. Check all 5 RPETD phases for completeness
  3. Verify success criteria against actual artifacts:
     - Files exist: ls src/middleware/auth.ts
     - Git commits: git log --oneline --grep='TK-0042'
     - Test output in T-phase is real (not placeholder)
     - LEARNING in D-phase is meaningful
  4. If all pass:
     node ~/.claude/get-shit-done/bin/amauta.cjs validate TK-0042 --pass --validator validator --notes 'PASS: all 4 criteria met, tests verified, LEARNING captured'
  5. If any fail:
     node ~/.claude/get-shit-done/bin/amauta.cjs validate TK-0042 --fail --validator validator --notes 'FAIL: T-phase missing actual output' --subtasks 'Add real test output to TK-0042'

  Return the validation result."
)
```

### Overriding Gates

For trivial tasks (documentation, config files, scaffolding):

```bash
# Tag the task to skip gitflow gate
$CLI tag TK-0099 no-gitflow

# Validate with force (skips gate cooldown and PR requirement)
$CLI validate TK-0099 --pass --force --validator operator --notes "PASS: config-only task, no PR needed"
```

**When to use `--force`:**
- Documentation updates
- Config file changes
- Scaffolding and boilerplate
- Any task explicitly tagged `no-gitflow`

**Never use `--force` on:**
- Feature implementation tasks
- Bug fixes with security implications
- Database migrations
- API changes

### What Makes a Good Validation Note

```bash
# BAD — vague, no evidence
$CLI validate TK-0042 --pass --validator validator --notes "looks good"

# GOOD — specific, references evidence
$CLI validate TK-0042 --pass --validator validator --notes "PASS: auth.ts created (87 lines), 4/4 tests pass (output in T-phase), LEARNING captured, git commit TK-0042 present. All 4 success criteria met: bearer extraction ✓, RS256 verify ✓, req.user attachment ✓, error responses ✓"

# GOOD FAIL — specific reason + actionable subtasks
$CLI validate TK-0042 --fail --validator validator \
  --notes "FAIL: T-phase says 'tests pass' but no actual output. P-phase missing risk analysis." \
  --subtasks "Add real npm test output to T-phase|Add risk analysis to P-phase"
```

---

## 7. How Memory Works

Memory is how the system gets smarter over time. Every learning from every
task is stored in PostgreSQL and is searchable by all future tasks.

### Memory Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MEMORY SYSTEM                              │
│                                                                 │
│  Sources (with score bonus):                                    │
│  ┌─────────────────┬──────┬─────────────────────────────────┐  │
│  │ lesson-learned  │  +4  │ Hard-won failures and fixes      │  │
│  │ best-practice   │  +4  │ Established proven patterns      │  │
│  │ auto_learning   │  +3  │ Extracted from D-phase LEARNING  │  │
│  │ web_search_result│ +3  │ Researched and verified findings │  │
│  │ session-learning│  +3  │ Discovered during current work   │  │
│  │ distilled       │  +2  │ Summarized/compressed knowledge  │  │
│  │ rpetd_phase     │  +1  │ Phase logs and documentation     │  │
│  └─────────────────┴──────┴─────────────────────────────────┘  │
│                                                                 │
│  Storage: PostgreSQL with pgvector (1024-dim embeddings)        │
│  Search: TF-IDF text search + cosine similarity semantic search │
│  Providers: Voyage AI (voyage-code-3) or OpenAI fallback        │
└─────────────────────────────────────────────────────────────────┘
```

### How to Store Memories

```bash
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"

# Store a lesson learned (highest value — +4 bonus)
$MEM store --source lesson-learned \
  --text "PostgreSQL connection pool exhaustion: default pool size of 5 is too small for concurrent agents. Set max=20 in production. Symptom: ECONNREFUSED on burst requests."

# Store a best practice (+4 bonus)
$MEM store --source best-practice \
  --text "Always use parameterized queries for SQL. Never string-interpolate user input. Use psycopg2 %s placeholders, not f-strings."

# Store from a session discovery
$MEM store --source session-learning \
  --text "Voyage AI API requires input as a list: ['text'], not a string 'text'. The API silently accepts strings but returns wrong embeddings."

# Quick learn (auto_learning source, +3 bonus)
$MEM learn "RS256 JWT: store public key path in JWT_PUBLIC_KEY env var. Never hardcode."
```

### How to Search Memories

```bash
# Text search (always works, no API key needed)
$MEM search "database connection"
$MEM search "JWT authentication"

# Search with JSON output (for agent consumption)
$MEM search "postgres" --json

# Cross-project search (find lessons from other projects)
$MEM cross-project "deployment failure" --tags docker,postgres

# List recent memories
$MEM list --limit 20

# Count total memories
$MEM count
```

### When Agents Use Memory

Every executor agent queries memory at the start of R-phase:

```bash
# In R-phase of any task:
$MEM search "{task_topic}" 2>/dev/null || true
```

The `|| true` ensures the task continues even if memory/PG is down (graceful degradation).

### Memory Best Practices

| When | What to Store | Source |
|------|---------------|--------|
| Something breaks unexpectedly | Root cause + fix | `lesson-learned` |
| You find the right way to do something | Pattern + rationale | `best-practice` |
| Perplexity/web research finds something good | The key finding | `web_search_result` |
| RPETD D-phase LEARNING | Auto-extracted | `auto_learning` |
| Current session discovery | New insight | `session-learning` |

**Structure your memory entries like this:**
```
SYMPTOM/CONTEXT: [what situation triggers this]
RULE/FINDING: [the actual learning]
EVIDENCE: [why this is true]
HOW TO APPLY: [concrete usage]
```

Example:
```
SYMPTOM: Voyage AI returns wrong embeddings silently
RULE: Always send input as a list: ["text"], never as a string "text"
EVIDENCE: API accepts strings but treats them as character arrays
HOW TO APPLY: pg_store.py embed call: "input": [truncated_text]
```

---

## 8. Agent Roles and When to Use Each

### gsd-operator (Start Here)

**Role:** Master orchestrator. Receives user requests, creates tasks, routes
to specialists, enforces RPETD, auto-spawns validators.

**When to engage:** Every new project or feature request.

**How to engage:**
```
@gsd-operator I want to add user authentication to this app.
```

The operator will:
1. Ask clarifying questions
2. Check the board for related existing tasks
3. Break the work into tasks with correct agents assigned
4. Delegate to executors via Task tool
5. Auto-spawn validators when executors return

### gsd-planner

**Role:** Task breakdown specialist. Takes an epic or story and produces
a structured task list with dependencies, acceptance criteria, and risk analysis.

**When to engage:** Complex features that need careful decomposition.

**Best practice:** Always include your constraints and success criteria:
```
Task(
  subagent_type="gsd-planner",
  prompt="Break down ST-0005 (User Authentication) into tasks.
  
  Constraints: Must use existing PostgreSQL schema. No external auth providers.
  Success: User can register, login, stay logged in, logout, reset password.
  
  Register tasks in Amauta. Return task IDs."
)
```

### gsd-researcher

**Role:** Research specialist. Runs the 4-mode research chain: memory →
SKB → Context7 → Perplexity → WebFetch.

**When to engage:** New technology, unfamiliar domain, need current info.

**4 Research Modes:**
1. **Ecosystem** — new project, evaluating technologies
2. **Phase** — before planning a specific feature
3. **Memory** — looking for past learnings
4. **Web** — need current/external information

### gsd-executor-backend

**Role:** Python, Node.js, APIs, databases, migrations, server-side logic.

**File patterns:** `services/`, `api/`, `models/`, `migrations/`, `*.py`, `*.sql`

### gsd-executor-frontend

**Role:** React, Next.js, CSS, components, pages, accessibility.

**File patterns:** `components/`, `pages/`, `app/`, `styles/`, `*.tsx`, `*.jsx`

### gsd-executor-infra

**Role:** Docker, CI/CD, GitHub Actions, Terraform, Kubernetes, deployment.

**File patterns:** `Dockerfile`, `docker-compose.*`, `.github/workflows/`, `terraform/`

### gsd-executor-general

**Role:** Full-stack fallback. Config files, documentation, scaffolding,
cross-cutting changes. Default when no specialist fits.

### gsd-checker

**Role:** Quality reviewer. Runs before execution (pre-check: is the plan
good?) and after (post-check: does the output match criteria?).

**Pre-check output:** `PRE-CHECK: [PASS|FAIL] — findings`
**Post-check:** Can call `validate --pass/--fail`

### gsd-validator (The Independent Gate)

**Role:** External validation. The only agent that can mark tasks DONE.
Never the same agent that executed the work.

**Critical:** Always spawned by operator AFTER executor returns D-phase.

### gsd-debugger

**Role:** Scientific bug investigation. Uses hypothesis → test → conclude
cycle. Queries memory for past failures first.

**When to engage:** Something is broken and you don't know why.

```
/amauta:debug "login button does nothing on Safari iOS"
```

### gsd-roadmapper

**Role:** Creates ROADMAP.md from requirements. Spawned automatically by
`/amauta:new-project` and `/amauta:new-milestone`.

---

## 9. Best Practices: Getting Better Outputs

### Project Setup

**Do:**
- Run `/amauta:discuss-phase N` before every `/amauta:plan-phase N`
  → Locks in your preferences. Plans built without discussion make assumptions.
- Use `/amauta:list-phase-assumptions N` before committing to a plan
  → See exactly what Claude intends to build before it starts.
- Run `/amauta:map-codebase` before `/amauta:new-project` on existing code
  → Agents understand what exists and don't duplicate or conflict with it.

**Don't:**
- Skip `/amauta:discuss-phase`. Most "the output was wrong" situations come from
  Claude guessing what you want instead of you specifying it.

### Task Quality

**Do:**
- Give tasks specific, testable success criteria
  ```bash
  $CLI note TK-0042 --text "SUCCESS: Given a valid Bearer token, When auth middleware runs, Then req.user has {id, email, role}. Given expired token, Then 401 with {error: 'token_expired'}." --agent planner
  ```
- Keep tasks small — completable in one RPETD cycle (< 1 hour of work)
- Set realistic `--importance` and `--urgency` scores — they drive scheduling
- Use `--dep` to chain tasks correctly — don't let a task claim work it can't do yet

**Don't:**
- Create tasks with vague titles like "Fix auth" — use "Add JWT expiry refresh token support to auth middleware"
- Let a single task span multiple concerns — break it up

### RPETD Quality

**R phase — Be specific in findings:**
```bash
# WEAK
$CLI rpetd TK-0042 --phase R --content "R: checked the code"

# STRONG
$CLI rpetd TK-0042 --phase R --content "R: RLM found auth is handled in src/middleware/auth.ts:45-89. Current pattern: HS256 symmetric signing. Memory: lesson-learned warns HS256 doesn't scale to multi-server. Recommendation: upgrade to RS256. No existing tests for auth middleware found."
```

**T phase — Include real output:**
```bash
# WRONG (will fail validation)
$CLI rpetd TK-0042 --phase T --content "T: all tests pass"

# RIGHT (passes validation)
$CLI rpetd TK-0042 --phase T --content "T: npm test -- src/middleware/auth.test.ts
> my-app@1.0.0 test
> jest src/middleware/auth.test.ts

PASS src/middleware/auth.test.ts
  Auth Middleware
    ✓ valid RS256 token passes (23ms)
    ✓ expired token returns 401 (11ms)
    ✓ invalid signature returns 401 (8ms)
    ✓ missing header returns 401 (6ms)

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Time:        1.234s"
```

**D phase — Make LEARNING extractable:**
```bash
# WEAK
$CLI rpetd TK-0042 --phase D --content "D: Done. Auth works."

# STRONG
$CLI rpetd TK-0042 --phase D --content "D: JWT auth middleware complete with RS256. Handles all 4 token states. Attaches {id, email, role} to req.user. LEARNING: RS256 requires public key as PEM string in env var JWT_PUBLIC_KEY — base64 encode the file for Docker compat. Store this pattern for all future JWT implementations."
```

### Memory Investment

Every session, start by checking memory:
```bash
$MEM search "$(current task topic)"
```

Every task's D-phase, always store:
```bash
$MEM learn "$(key insight from this task)"
```

The ROI compounds: memory from task 1 improves task 10. Memory from project
1 improves project 5.

### Context Management

Claude Code has a finite context window. GSD-Amauta is designed around this:

- **Each agent gets a fresh 200K context** — spawn agents for expensive work
- **Run `/clear` between major phases** — keeps the orchestrator lean
- **Use `/amauta:resume-work` after `/clear`** — restores state from files, not memory
- **RLM replaces file reads** — query for relevant chunks instead of `cat`-ing entire files

```
# EXPENSIVE (burns context)
Read("src/services/auth.ts")   # 500 lines loaded

# EFFICIENT (only relevant chunks)
$RLM query "token validation logic" --path src/services/auth.ts  # 30-50 lines
```

### Model Profile Selection

| Project Phase | Recommended Profile | Why |
|---------------|--------------------|----|
| Initial planning / architecture | `quality` | Architecture decisions are hard to undo |
| Feature implementation | `balanced` | Opus for planning, Sonnet for execution |
| Bug fixes and config | `budget` | Well-scoped tasks don't need Opus |
| Rapid prototyping | `budget` + disable agents | Speed over quality |

```bash
/amauta:set-profile quality     # When it matters
/amauta:set-profile balanced    # Default
/amauta:set-profile budget      # When cost matters
```

### Output Signals

If you're getting poor outputs:

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Plans don't match your vision | Skipped `/amauta:discuss-phase` | Run it, lock in decisions |
| Agents write the wrong code | Task success criteria too vague | Add `SUCCESS: Given/When/Then` note |
| Validation fails repeatedly | Tasks too large | Break into smaller tasks |
| R-phase is shallow | Memory is empty | Start storing learnings now |
| Executors repeat past mistakes | No memory entries | Store lessons after every failure |
| Tests are fabricated | T-phase not enforced | Validator catches this — trust the gate |

---

## 10. Full Command Cheat Sheet

### Session Start

```bash
# Start services
docker start gsd-postgres
python3 ~/gsd-amauta/services/amauta-daemon.py start

# Check health
curl -s http://127.0.0.1:18799/health | python3 -m json.tool

# Open Claude Code
claude --dangerously-skip-permissions

# Restore context
/amauta:resume-work   # or /amauta:progress
```

### Project Setup

```bash
/amauta:new-project                    # Full init: questions → research → roadmap
/amauta:new-project --auto @prd.md     # From existing document
/amauta:map-codebase                   # Analyze existing code first (brownfield)
/amauta:discuss-phase 1                # Lock in your preferences
/amauta:list-phase-assumptions 1       # Preview Claude's intent
/amauta:plan-phase 1                   # Research + plan + verify
/amauta:execute-phase 1                # Run it
/amauta:verify-work 1                  # UAT
```

### Task Management

```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"

$CLI board                          # Kanban view
$CLI stats                          # Summary counts
$CLI list --status pending          # Filter by status
$CLI show TK-0042 --json            # Full task details
$CLI next executor-backend --json   # Next task for agent

$CLI add epic "Title" --agent operator --priority high
$CLI add story "Title" --parent EP-0001 --agent operator
$CLI add task "Title" --parent ST-0001 --agent executor-backend --priority critical --importance 5 --urgency 4
$CLI link TK-0002 --dep TK-0001     # Task 2 requires task 1

$CLI claim TK-0042 --agent executor-backend
$CLI rpetd TK-0042 --phase R --content "R: ..."
$CLI rpetd TK-0042 --phase P --content "P: ..."
$CLI rpetd TK-0042 --phase E --content "E: ..."
$CLI rpetd TK-0042 --phase T --content "T: [actual output]"
$CLI rpetd TK-0042 --phase D --content "D: ... LEARNING: ..."
$CLI status TK-0042 validation

$CLI validate TK-0042 --pass --validator validator --notes "PASS: ..."
$CLI validate TK-0042 --fail --validator validator --notes "FAIL: ..." --subtasks "Fix A|Add B"
$CLI validate TK-0042 --pass --force --validator operator --notes "PASS: trivial task"

$CLI note TK-0042 --text "..." --agent checker
$CLI search "auth middleware"
$CLI score TK-0042
```

### Memory

```bash
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"

$MEM store --source lesson-learned --text "..."
$MEM store --source best-practice --text "..."
$MEM learn "quick insight"
$MEM search "topic"
$MEM search "topic" --json
$MEM cross-project "topic" --tags react,postgres
$MEM list --limit 20
$MEM count
$MEM health
$MEM embedding-stats
```

### Code Context (RLM)

```bash
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"

$RLM query "auth middleware" --dir src/ --top-k 5
$RLM query "database schema" --path migrations/001.sql
$RLM query "test patterns" --dir tests/ --compact
$RLM chunk services/auth.py         # See how file is chunked
$RLM check-config --json            # Check RLM mode
```

### Research

```bash
RES="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

$RES "PostgreSQL connection pooling best practices"
$RES check-providers
```

### Milestones

```bash
/amauta:audit-milestone                # Check all criteria met
/amauta:plan-milestone-gaps            # Create phases for gaps
/amauta:complete-milestone 1.0.0       # Archive, tag, done
/amauta:new-milestone "v2.0 Features"  # Start next cycle
```

### Troubleshooting

```bash
/amauta:health                         # Check .planning/ integrity
/amauta:health --repair                # Auto-fix issues
/amauta:debug "description"            # Debug session
/amauta:progress                       # Where am I?
/amauta:settings                       # Change config
/amauta:set-profile budget             # Reduce cost
```

---

## 11. Example: Complete Project from Scratch

Here is a real project walkthrough — a REST API with authentication.

### Day 1: Project Setup

```bash
# Start services
docker start gsd-postgres
python3 ~/gsd-amauta/services/amauta-daemon.py start

# Open Claude Code
claude --dangerously-skip-permissions
```

In Claude Code:
```
/amauta:new-project
```

Answer the questions:
```
> What are you building?
A REST API for a task management app. Users can register, create tasks,
assign tasks, and track completion.

> Tech stack preferences?
Node.js/Express, PostgreSQL, TypeScript. No ORMs — raw SQL queries.

> What's out of scope for v1?
No file attachments, no real-time updates, no mobile app.

> Known constraints?
Must pass OWASP security checklist. PostgreSQL already provisioned on AWS RDS.

> What does "done" look like?
API returns correct JSON for all CRUD operations. Auth with JWT. All endpoints
have input validation. 80%+ test coverage.
```

GSD creates:
- `.planning/PROJECT.md` with your vision
- `.planning/REQUIREMENTS.md` with scoped v1 requirements
- `.planning/ROADMAP.md` with 4-6 phases
- `.planning/STATE.md` for session memory

```
/clear
```

### Day 1: Phase 1 Planning

```
/amauta:discuss-phase 1
```

Answer:
```
> How should the database schema look?
Users table: id, email, password_hash, created_at.
Tasks table: id, title, description, status, assignee_id, creator_id, due_date.

> Any naming conventions?
snake_case for DB columns, camelCase for API JSON responses.
```

```
/amauta:plan-phase 1
```

GSD creates `.planning/phases/01-foundation/01-01-PLAN.md`.

```
/clear
```

### Day 1: Execute Phase 1

```
/amauta:execute-phase 1
```

Executors run in parallel waves, each following RPETD. You see:
```
Wave 1: [executor-backend] 01-01 database schema
Wave 2: [executor-backend] 01-02 migrations
Wave 3: [executor-backend] 01-03 connection pool
```

Each executor:
1. Claims their task in Amauta
2. Runs R phase (RLM + memory)
3. Plans
4. Executes (writes code, commits)
5. Tests (real output)
6. Documents (with LEARNING)
7. Sets status to validation

After each executor finishes, operator spawns validator:
```
Validator checking TK-0003...
✓ Gate 1: All 5 RPETD phases complete
✓ Gate 2: T-phase has 12 real test results
✓ Gate 3: LEARNING captured: "RDS requires SSL cert in connection string"
✓ Gate 4: All 3 success criteria verified
PASS → TK-0003 DONE
```

### Day 1 End: Check State

```
/amauta:verify-work 1
/amauta:progress
```

### Day 2: Phase 2 — Authentication

```
/amauta:discuss-phase 2
/amauta:plan-phase 2
/clear
/amauta:execute-phase 2
```

At R-phase, executor queries memory:
```bash
$MEM search "JWT authentication"
# Finds: "RS256 JWT: store public key path in JWT_PUBLIC_KEY env var" (from Day 1!)
```

The system already knows the right pattern. R-phase is informed by
what we learned yesterday.

### Day 3: Milestone Complete

```
/amauta:audit-milestone
```

Output:
```
REQUIREMENTS COVERAGE: 12/12 (100%)
PHASES COMPLETE: 4/4
VERIFICATION: Phase 1 ✓, Phase 2 ✓, Phase 3 ✓, Phase 4 ✓
GAPS: None

MILESTONE STATUS: READY FOR COMPLETION
```

```
/amauta:complete-milestone 1.0.0
```

Archived. Tagged. Done.

---

## 12. Troubleshooting the Pipeline

### Daemon Not Responding

```bash
# Check if it's running
curl -s http://127.0.0.1:18799/health

# Restart it
python3 ~/gsd-amauta/services/amauta-daemon.py stop
python3 ~/gsd-amauta/services/amauta-daemon.py start

# Check logs
python3 ~/gsd-amauta/services/amauta-daemon.py run  # foreground mode
```

### PostgreSQL Connection Failed

```bash
docker start gsd-postgres
docker logs gsd-postgres | tail -20

# Verify connection
psql postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta -c "SELECT 1"
```

### Task Stuck in VALIDATION

```bash
# Check what phase it's on
$CLI show TK-0042 --json | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('Status:', d['status']); [print(f'RPETD {p}:', d.get(f'rpetd_{p.lower()}', 'MISSING')) for p in 'RPETD']"

# Force-validate if genuinely complete
$CLI validate TK-0042 --pass --force --validator operator --notes "PASS: manually verified, all criteria met"
```

### RLM Returns No Results

```bash
# Check RLM health
curl -s http://127.0.0.1:18798/health

# Restart RLM
kill $(lsof -ti:18798)
python3 ~/gsd-amauta/services/rlm-service.py &

# Verify your directory path
$RLM query "test" --dir . --top-k 3
```

### Memory Search Returns Nothing

```bash
# Check memory count
$MEM count

# Check daemon
$MEM health

# If empty, start storing
$MEM store --source best-practice --text "Your first memory entry"
```

### Validation Keeps Failing

```bash
# See what the validator is checking
$CLI show TK-0042

# Most common causes:
# 1. T-phase has "tests pass" not actual output → re-run test and log real output
# 2. D-phase missing LEARNING → add "LEARNING: ..." to D-phase content
# 3. Success criteria not met → executor needs to actually implement the missing piece

# Update a phase if needed (add --content to existing)
$CLI rpetd TK-0042 --phase T --content "T: [corrected with real output]"
```

### Plans Don't Match Your Vision

```bash
# BEFORE planning, always discuss
/amauta:discuss-phase N

# See what Claude is about to build
/amauta:list-phase-assumptions N

# If plan already ran wrong — don't re-execute
# Instead: note what's wrong, quick-fix with gsd:quick
/amauta:quick "Fix the auth plan: should use RS256 not HS256"
```

### Context Window Full

```
/clear
/amauta:resume-work   # Restore from STATE.md
```

This is normal and expected. Design for it:
- `/clear` between phases
- Let operators stay lean, spawn agents for heavy work
- STATE.md is your memory across sessions

---

*This playbook covers the complete GSD-Amauta pipeline. For service
installation, see [README.md](../README.md). For configuration reference,
see [USER-GUIDE.md](USER-GUIDE.md).*
