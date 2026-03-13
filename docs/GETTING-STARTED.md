# Getting Started with Amauta v1
## How to use on Claude Code — new repo or existing repo

---

## What is Amauta?

Amauta v1 is a Claude Code plugin that gives you:
- **11 specialist agents** (operator, planner, researcher, executor × 4, checker, validator, debugger, roadmapper)
- **RPETD pipeline** — every task goes through Research → Plan → Execute → Test → Document
- **Independent validation** — a separate agent verifies work before marking it done
- **PostgreSQL memory** — learnings persist across projects and sessions
- **`amauta` CLI** — task board, RPETD logging, validation, memory search

---

## Part 1: Installation

### Prerequisites

```bash
# Node.js 18+
node --version   # must be >= 18

# Python 3.9+
python3 --version

# Docker (for PostgreSQL)
docker --version

# Claude Code
claude --version
```

### Install the Plugin

```bash
# Clone the repo
git clone https://github.com/robertamauta/gsd-amauta.git ~/gsd-amauta

# Install into Claude Code (global — available in all projects)
cd ~/gsd-amauta
node bin/install.js --claude --global
```

You should see:
```
✓ Installed agents
✓ Installed commands/gsd
✓ Installed get-shit-done workflows
✓ Installed get-shit-done bin
```

### Start the Services

Run these once per machine restart (add to your shell profile to automate):

```bash
# 1. PostgreSQL with pgvector
docker compose -f ~/gsd-amauta/docker/docker-compose.yml up -d

# 2. Amauta daemon (task management HTTP API on :18799)
python3 ~/gsd-amauta/services/amauta-daemon.py start

# 3. RLM service (code context engine on :18798)
python3 ~/gsd-amauta/services/rlm-service.py &
```

### Verify Everything Works

```bash
# Check daemon
curl -s http://127.0.0.1:18799/health | python3 -m json.tool
# Expected: { "status": "ok", "pg_available": true }

# Check CLI
node ~/.claude/get-shit-done/bin/amauta.cjs
# Expected: Amauta v1 banner + command list

# Check RLM
curl -s http://127.0.0.1:18798/health
# Expected: { "status": "ok" }
```

### Optional: Set Environment Variables

```bash
# Add to ~/.zshrc or ~/.bash_profile

# Voyage AI for semantic memory search (recommended)
export VOYAGE_API_KEY="your-key"        # voyage.ai — code-optimized embeddings

# OR OpenAI as fallback
export OPENAI_API_KEY="your-key"        # openai.com

# Perplexity for web research in the research chain
export PERPLEXITY_API_KEY="your-key"    # perplexity.ai

# Optional: custom data directory
export AMAUTA_DATA_DIR="$HOME/gsd-amauta/data"
```

None of these are required — the system works without them (graceful degradation).

---

## Part 2: New Repository

### Step 1: Create the Repo

```bash
mkdir my-project
cd my-project
git init
```

### Step 2: Open Claude Code

```bash
claude --dangerously-skip-permissions
```

The flag lets agents write files, run tests, and commit without asking
confirmation at every step.

### Step 3: Type this in Claude Code

```
@gsd-operator

I want to build [describe your project in 1-3 sentences].
```

The operator will ask you a series of focused questions. Answer them
honestly and specifically — this shapes every plan that follows.

**Example good answers:**
```
> What are you building?
A REST API for a personal finance tracker. Users can log income/expenses,
tag transactions, and see monthly summaries.

> Tech stack?
Node.js + Express + PostgreSQL + TypeScript. No ORMs.

> What's NOT in v1?
No charts/visualizations, no exports, no multi-currency, no sharing.

> What does done look like?
All CRUD endpoints work. Auth with JWT. Input validation. 80%+ test coverage.
```

### Step 4: Project Initialization

After the questions, run:

```
/amauta:new-project
```

This creates your `.planning/` directory with:
```
.planning/
├── PROJECT.md        ← your vision, in writing
├── REQUIREMENTS.md   ← v1 requirements with IDs
├── ROADMAP.md        ← 4-6 phases with success criteria
└── STATE.md          ← session memory
```

### Step 5: Plan Phase 1

```
/clear
/amauta:discuss-phase 1
```

Answer the questions — this locks in your preferences before any code
is written. Then:

```
/amauta:plan-phase 1
```

This spawns researcher agents, creates the plan, and has a checker verify it.

### Step 6: Execute

```
/clear
/amauta:execute-phase 1
```

Executor agents run in parallel waves. Each one:
1. Claims a task in Amauta
2. Runs the full RPETD pipeline
3. Commits code with the task ID
4. Gets independently validated

### Step 7: Verify and Repeat

```
/amauta:verify-work 1    # Manual UAT
/amauta:progress         # See what's next
```

Repeat for each phase. When all phases are done:

```
/amauta:audit-milestone
/amauta:complete-milestone 1.0.0
```

---

## Part 3: Existing Repository

### Step 1: Map the Codebase First

```bash
cd your-existing-project
claude --dangerously-skip-permissions
```

```
/amauta:map-codebase
```

This runs 4 parallel agents that analyze your code and produce:
```
.planning/codebase/
├── STACK.md          ← languages, frameworks, dependencies
├── ARCHITECTURE.md   ← patterns, layers, data flow
├── STRUCTURE.md      ← directory layout, key files
├── CONVENTIONS.md    ← naming, style, existing patterns
├── TESTING.md        ← test setup and patterns
├── INTEGRATIONS.md   ← external services, APIs
└── CONCERNS.md       ← tech debt, known issues
```

**Why this matters:** Without this step, agents guess your conventions
and patterns. With it, they follow them exactly.

### Step 2: Define What You're Adding

```
/amauta:new-project
```

Answer the questions focused on **what you're adding**, not what already
exists. The codebase map gives agents the existing context automatically.

**Example:**
```
> What are you building?
Adding a real-time notification system to our existing Express API.
Users should see notifications in the UI without refreshing.

> What does done look like?
WebSocket connection from browser. Server pushes events for: new message,
task assigned, task completed. Notifications persist to DB. Mark as read.
```

### Step 3: Amauta Task Board

Set up the task structure for what you're adding:

```bash
# Short alias — use this throughout
alias amauta="node ~/.claude/get-shit-done/bin/amauta.cjs"

# Create the work hierarchy
amauta add epic "Notification System" --agent operator --priority high
amauta add story "WebSocket Backend" --parent EP-0001 --agent operator
amauta add story "Notification UI" --parent EP-0001 --agent operator

# Check the board
amauta board
```

### Step 4: Normal Phase Flow

From here it's the same as a new project:

```
/amauta:discuss-phase 1   # lock in how it should work
/amauta:plan-phase 1      # research your codebase + plan
/amauta:execute-phase 1   # run it
/amauta:verify-work 1     # check it works
```

The key difference: at R-phase, agents will query RLM against your existing
codebase to find patterns, conventions, and existing code before writing anything new.

---

## Part 4: The `amauta` CLI — Daily Usage

Set the alias once in your shell profile:

```bash
# ~/.zshrc or ~/.bash_profile
alias amauta="node ~/.claude/get-shit-done/bin/amauta.cjs"
```

Then reload: `source ~/.zshrc`

### View the Board

```bash
amauta board       # full kanban view
amauta stats       # counts by status
amauta list --status pending --agent executor-backend
```

### Create Tasks

```bash
# Epic > Story > Task hierarchy
amauta add epic "Feature Name" --agent operator --priority high
amauta add story "Sub-feature" --parent EP-0001 --agent operator
amauta add task "Implement X" --parent ST-0001 \
  --agent executor-backend \
  --priority critical \
  --importance 5 \
  --urgency 4

# Set dependencies (task 2 can't start until task 1 finishes)
amauta link TK-0002 --dep TK-0001
```

### Run RPETD on a Task

```bash
# Claim it first
amauta claim TK-0042 --agent executor-backend

# Log each phase as you work
amauta rpetd TK-0042 --phase R --content "R: RLM found auth pattern in src/middleware/. Memory: JWT RS256 preferred. Plan: reuse existing pattern."
amauta rpetd TK-0042 --phase P --content "P: Will add src/middleware/auth.ts. Files to change: app.ts:45."
amauta rpetd TK-0042 --phase E --content "E: Created auth.ts 87 lines. Committed: TK-0042: add JWT middleware"
amauta rpetd TK-0042 --phase T --content "T: npm test
PASS src/middleware/auth.test.ts
  ✓ valid token (12ms)
  ✓ expired token returns 401 (8ms)
Tests: 2 passed"
amauta rpetd TK-0042 --phase D --content "D: JWT auth complete. LEARNING: RS256 public key must be base64 in env var for Docker."

# Move to validation queue
amauta status TK-0042 validation
```

### Validate a Task (Always a Different Agent)

```bash
# PASS
amauta validate TK-0042 \
  --pass \
  --validator validator \
  --notes "PASS: all 5 RPETD phases complete, 4 tests pass with real output, LEARNING captured"

# FAIL — creates sub-tasks automatically
amauta validate TK-0042 \
  --fail \
  --validator validator \
  --notes "FAIL: T-phase has no actual test output" \
  --subtasks "Add real npm test output to T-phase"

# Force pass for trivial tasks (docs, config)
amauta tag TK-0099 no-gitflow
amauta validate TK-0099 --pass --force --validator operator --notes "PASS: config-only"
```

### Memory

```bash
# Store a lesson (highest value)
amauta exec memory store "lesson-learned" "RS256 JWT: base64-encode public key for Docker. See TK-0042."

# Or use gsd-memory.cjs directly
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"
$MEM store --source lesson-learned --text "RS256 JWT: base64-encode public key"
$MEM search "JWT"
$MEM learn "quick insight for auto_learning"
```

---

## Part 5: Working with Agents in Claude Code

### Start the Operator

```
@gsd-operator
```

Tell it what you want:
```
I need to add user authentication. JWT, PostgreSQL, no external auth providers.
```

The operator will:
1. Check the board for existing tasks
2. Decompose the work
3. Assign tasks to the right specialists
4. Spawn executors that follow RPETD
5. Auto-spawn validators when executors return

### Use Any Agent Directly

```
@gsd-planner   Plan the authentication feature. Break into tasks under ST-0005.
@gsd-researcher Research JWT best practices for Node.js 2025.
@gsd-debugger  Login button does nothing on Safari iOS.
@gsd-validator Validate task TK-0042.
```

### Spawn Agents from the Operator

The operator uses Claude Code's `Task()` tool to spawn subagents:

```
Task(
  subagent_type="gsd-executor-backend",
  prompt="Claim and complete TK-0042. Follow RPETD. Log each phase with:
  node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0042 --phase X --content '...'
  Do NOT validate your own work. Return when D-phase is logged."
)
```

Each spawned agent gets a **fresh 200K context window** — they don't share
the operator's context. This is by design.

### Session Management

```
/clear                  # Clear context window (do this between phases)
/amauta:resume-work        # Restore context from STATE.md after /clear
/amauta:progress           # See where you are and what's next
/amauta:pause-work         # Save handoff before stopping
```

---

## Part 6: Complete Session Workflow

Here is exactly what a typical work session looks like:

```bash
# ── TERMINAL ────────────────────────────────────────────────────────
# Start services (if not already running)
docker start gsd-postgres
python3 ~/gsd-amauta/services/amauta-daemon.py start

# Open Claude Code in your project directory
cd my-project
claude --dangerously-skip-permissions
```

```
# ── CLAUDE CODE ─────────────────────────────────────────────────────

# Restore context from last session
/amauta:resume-work

# Check the board
# (or type: @gsd-operator check the board and tell me what to do next)

# Work on the next phase
/amauta:discuss-phase 2
/amauta:plan-phase 2
/clear
/amauta:execute-phase 2
/amauta:verify-work 2
/clear

# End of session — save state
/amauta:pause-work
```

```bash
# ── TERMINAL ────────────────────────────────────────────────────────
# Check what got built
amauta board
amauta stats
git log --oneline -10
```

---

## Part 7: Quick Reference

### Agents

| Agent | Type in Claude Code | What it does |
|-------|---------------------|--------------|
| `gsd-operator` | `@gsd-operator` | Orchestrates everything |
| `gsd-planner` | `@gsd-planner` | Breaks work into tasks |
| `gsd-researcher` | `@gsd-researcher` | Research chain |
| `gsd-executor-backend` | `@gsd-executor-backend` | Python/Node/SQL |
| `gsd-executor-frontend` | `@gsd-executor-frontend` | React/CSS/UI |
| `gsd-executor-infra` | `@gsd-executor-infra` | Docker/CI/CD |
| `gsd-executor-general` | `@gsd-executor-general` | Config/docs/misc |
| `gsd-checker` | `@gsd-checker` | Pre/post quality review |
| `gsd-validator` | `@gsd-validator` | Independent validation gate |
| `gsd-debugger` | `@gsd-debugger` | Bug investigation |
| `gsd-roadmapper` | `@gsd-roadmapper` | Phase planning |

### Slash Commands

| Command | What it does |
|---------|--------------|
| `/amauta:new-project` | Full project init |
| `/amauta:map-codebase` | Analyze existing code |
| `/amauta:discuss-phase N` | Lock in your preferences |
| `/amauta:plan-phase N` | Research + plan + verify |
| `/amauta:execute-phase N` | Run all plans in parallel |
| `/amauta:verify-work N` | Manual UAT |
| `/amauta:audit-milestone` | Check all criteria met |
| `/amauta:complete-milestone 1.0.0` | Archive and tag |
| `/amauta:progress` | Where am I? |
| `/amauta:resume-work` | Restore context |
| `/amauta:debug "issue"` | Debug session |
| `/amauta:quick` | Ad-hoc task |
| `/amauta:help` | Full command reference |

### amauta CLI

```bash
alias amauta="node ~/.claude/get-shit-done/bin/amauta.cjs"

amauta board                              # kanban view
amauta stats                              # counts
amauta show TK-0001 --json               # task details
amauta add task "Title" --parent ST-0001 --agent executor-backend
amauta claim TK-0001 --agent executor-backend
amauta rpetd TK-0001 --phase R --content "R: ..."
amauta validate TK-0001 --pass --validator validator --notes "PASS: ..."
amauta search "auth"
amauta daemon status
```

### RPETD in 30 Seconds

```
Every task = R → P → E → T → D → Validate (by someone else)

R  Research  Query RLM for existing code + memory for past learnings
P  Plan      Define approach, files to change, risks
E  Execute   Write code, commit with task ID: "TK-0042: ..."
T  Test      Run tests — include REAL output, not "tests pass"
D  Document  Summary + "LEARNING: [insight]" for future memory
   Validate  Different agent checks all 5 phases + success criteria
```

---

## Common Issues

### "Daemon not running" error

```bash
python3 ~/gsd-amauta/services/amauta-daemon.py start
curl -s http://127.0.0.1:18799/health
```

### "PostgreSQL not available"

```bash
docker start gsd-postgres
docker ps --filter name=gsd-postgres  # check it shows "healthy"
```

### Agents not showing in Claude Code

```bash
# Re-run the installer
cd ~/gsd-amauta
node bin/install.js --claude --global

# Verify
ls ~/.claude/agents/ | grep gsd
```

### `amauta` command not found

```bash
# Add alias to shell profile
echo 'alias amauta="node ~/.claude/get-shit-done/bin/amauta.cjs"' >> ~/.zshrc
source ~/.zshrc
amauta board
```

### Board is empty after project setup

The board starts empty — that's correct. The operator populates it
when you describe work. Either:
```
@gsd-operator  Set up tasks for [project name]. Use /amauta:new-project output.
```
Or create tasks manually:
```bash
amauta add epic "Project Name" --agent operator
```

---

*For deeper documentation: [PLAYBOOK.md](PLAYBOOK.md) | [USER-GUIDE.md](USER-GUIDE.md) | [README.md](../README.md)*
