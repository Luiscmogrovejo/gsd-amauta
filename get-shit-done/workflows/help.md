<purpose>
Display the complete GSD command reference. Output ONLY the reference content. Do NOT add project-specific analysis, git status, next-step suggestions, or any commentary beyond the reference.
</purpose>

<reference>
# GSD-Amauta Command Reference

**GSD-Amauta** combines spec-driven development (GSD) with a multi-agent task management system (Amauta). Every task follows the RPETD pipeline (Research → Plan → Execute → Test → Document) enforced by 11 specialist agents.

## Quick Start — Amauta (Task Management)

```bash
# Start services (daemon + PostgreSQL)
docker start gsd-postgres
python3 ~/gsd-amauta/services/amauta-daemon.py start

# Core task workflow
node ~/.claude/get-shit-done/bin/amauta.cjs add epic "My Project"
node ~/.claude/get-shit-done/bin/amauta.cjs add story "Feature A" --parent EP-0001
node ~/.claude/get-shit-done/bin/amauta.cjs add task "Implement API" --parent ST-0001 --agent executor-backend
node ~/.claude/get-shit-done/bin/amauta.cjs claim TK-0001 --agent executor-backend
node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0001 --phase R --content "R: research findings..."
node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0001 --phase P --content "P: plan..."
node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0001 --phase E --content "E: implemented..."
node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0001 --phase T --content "T: tests pass..."
node ~/.claude/get-shit-done/bin/amauta.cjs rpetd TK-0001 --phase D --content "D: done. LEARNING: ..."
node ~/.claude/get-shit-done/bin/amauta.cjs validate TK-0001 --pass --validator validator --notes "PASS"
```

## Quick Start — GSD (Phase Planning)

1. `/amauta:new-project` - Initialize project (includes research, requirements, roadmap)
2. `/amauta:plan-phase 1` - Create detailed plan for first phase
3. `/amauta:execute-phase 1` - Execute the phase

## Staying Updated

GSD evolves fast. Update periodically:

```bash
npx get-shit-done-cc@latest
```

## Core Workflow

```
/amauta:new-project → /amauta:plan-phase → /amauta:execute-phase → repeat
```

### Project Initialization

**`/amauta:new-project`**
Initialize new project through unified flow.

One command takes you from idea to ready-for-planning:
- Deep questioning to understand what you're building
- Optional domain research (spawns 4 parallel researcher agents)
- Requirements definition with v1/v2/out-of-scope scoping
- Roadmap creation with phase breakdown and success criteria

Creates all `.planning/` artifacts:
- `PROJECT.md` — vision and requirements
- `config.json` — workflow mode (interactive/yolo)
- `research/` — domain research (if selected)
- `REQUIREMENTS.md` — scoped requirements with REQ-IDs
- `ROADMAP.md` — phases mapped to requirements
- `STATE.md` — project memory

Usage: `/amauta:new-project`

**`/amauta:map-codebase`**
Map an existing codebase for brownfield projects.

- Analyzes codebase with parallel Explore agents
- Creates `.planning/codebase/` with 7 focused documents
- Covers stack, architecture, structure, conventions, testing, integrations, concerns
- Use before `/amauta:new-project` on existing codebases

Usage: `/amauta:map-codebase`

### Phase Planning

**`/amauta:discuss-phase <number>`**
Help articulate your vision for a phase before planning.

- Captures how you imagine this phase working
- Creates CONTEXT.md with your vision, essentials, and boundaries
- Use when you have ideas about how something should look/feel
- Optional `--batch` asks 2-5 related questions at a time instead of one-by-one

Usage: `/amauta:discuss-phase 2`
Usage: `/amauta:discuss-phase 2 --batch`
Usage: `/amauta:discuss-phase 2 --batch=3`

**`/amauta:research-phase <number>`**
Comprehensive ecosystem research for niche/complex domains.

- Discovers standard stack, architecture patterns, pitfalls
- Creates RESEARCH.md with "how experts build this" knowledge
- Use for 3D, games, audio, shaders, ML, and other specialized domains
- Goes beyond "which library" to ecosystem knowledge

Usage: `/amauta:research-phase 3`

**`/amauta:list-phase-assumptions <number>`**
See what Claude is planning to do before it starts.

- Shows Claude's intended approach for a phase
- Lets you course-correct if Claude misunderstood your vision
- No files created - conversational output only

Usage: `/amauta:list-phase-assumptions 3`

**`/amauta:plan-phase <number>`**
Create detailed execution plan for a specific phase.

- Generates `.planning/phases/XX-phase-name/XX-YY-PLAN.md`
- Breaks phase into concrete, actionable tasks
- Includes verification criteria and success measures
- Multiple plans per phase supported (XX-01, XX-02, etc.)

Usage: `/amauta:plan-phase 1`
Result: Creates `.planning/phases/01-foundation/01-01-PLAN.md`

**PRD Express Path:** Pass `--prd path/to/requirements.md` to skip discuss-phase entirely. Your PRD becomes locked decisions in CONTEXT.md. Useful when you already have clear acceptance criteria.

### Execution

**`/amauta:execute-phase <phase-number>`**
Execute all plans in a phase.

- Groups plans by wave (from frontmatter), executes waves sequentially
- Plans within each wave run in parallel via Task tool
- Verifies phase goal after all plans complete
- Updates REQUIREMENTS.md, ROADMAP.md, STATE.md

Usage: `/amauta:execute-phase 5`

### Quick Mode

**`/amauta:quick`**
Execute small, ad-hoc tasks with GSD guarantees but skip optional agents.

Quick mode uses the same system with a shorter path:
- Spawns planner + executor (skips researcher, checker, verifier)
- Quick tasks live in `.planning/quick/` separate from planned phases
- Updates STATE.md tracking (not ROADMAP.md)

Use when you know exactly what to do and the task is small enough to not need research or verification.

Usage: `/amauta:quick`
Result: Creates `.planning/quick/NNN-slug/PLAN.md`, `.planning/quick/NNN-slug/SUMMARY.md`

### Roadmap Management

**`/amauta:add-phase <description>`**
Add new phase to end of current milestone.

- Appends to ROADMAP.md
- Uses next sequential number
- Updates phase directory structure

Usage: `/amauta:add-phase "Add admin dashboard"`

**`/amauta:insert-phase <after> <description>`**
Insert urgent work as decimal phase between existing phases.

- Creates intermediate phase (e.g., 7.1 between 7 and 8)
- Useful for discovered work that must happen mid-milestone
- Maintains phase ordering

Usage: `/amauta:insert-phase 7 "Fix critical auth bug"`
Result: Creates Phase 7.1

**`/amauta:remove-phase <number>`**
Remove a future phase and renumber subsequent phases.

- Deletes phase directory and all references
- Renumbers all subsequent phases to close the gap
- Only works on future (unstarted) phases
- Git commit preserves historical record

Usage: `/amauta:remove-phase 17`
Result: Phase 17 deleted, phases 18-20 become 17-19

### Milestone Management

**`/amauta:new-milestone <name>`**
Start a new milestone through unified flow.

- Deep questioning to understand what you're building next
- Optional domain research (spawns 4 parallel researcher agents)
- Requirements definition with scoping
- Roadmap creation with phase breakdown

Mirrors `/amauta:new-project` flow for brownfield projects (existing PROJECT.md).

Usage: `/amauta:new-milestone "v2.0 Features"`

**`/amauta:complete-milestone <version>`**
Archive completed milestone and prepare for next version.

- Creates MILESTONES.md entry with stats
- Archives full details to milestones/ directory
- Creates git tag for the release
- Prepares workspace for next version

Usage: `/amauta:complete-milestone 1.0.0`

### Progress Tracking

**`/amauta:progress`**
Check project status and intelligently route to next action.

- Shows visual progress bar and completion percentage
- Summarizes recent work from SUMMARY files
- Displays current position and what's next
- Lists key decisions and open issues
- Offers to execute next plan or create it if missing
- Detects 100% milestone completion

Usage: `/amauta:progress`

### Session Management

**`/amauta:resume-work`**
Resume work from previous session with full context restoration.

- Reads STATE.md for project context
- Shows current position and recent progress
- Offers next actions based on project state

Usage: `/amauta:resume-work`

**`/amauta:pause-work`**
Create context handoff when pausing work mid-phase.

- Creates .continue-here file with current state
- Updates STATE.md session continuity section
- Captures in-progress work context

Usage: `/amauta:pause-work`

### Debugging

**`/amauta:debug [issue description]`**
Systematic debugging with persistent state across context resets.

- Gathers symptoms through adaptive questioning
- Creates `.planning/debug/[slug].md` to track investigation
- Investigates using scientific method (evidence → hypothesis → test)
- Survives `/clear` — run `/amauta:debug` with no args to resume
- Archives resolved issues to `.planning/debug/resolved/`

Usage: `/amauta:debug "login button doesn't work"`
Usage: `/amauta:debug` (resume active session)

### Todo Management

**`/amauta:add-todo [description]`**
Capture idea or task as todo from current conversation.

- Extracts context from conversation (or uses provided description)
- Creates structured todo file in `.planning/todos/pending/`
- Infers area from file paths for grouping
- Checks for duplicates before creating
- Updates STATE.md todo count

Usage: `/amauta:add-todo` (infers from conversation)
Usage: `/amauta:add-todo Add auth token refresh`

**`/amauta:check-todos [area]`**
List pending todos and select one to work on.

- Lists all pending todos with title, area, age
- Optional area filter (e.g., `/amauta:check-todos api`)
- Loads full context for selected todo
- Routes to appropriate action (work now, add to phase, brainstorm)
- Moves todo to done/ when work begins

Usage: `/amauta:check-todos`
Usage: `/amauta:check-todos api`

### User Acceptance Testing

**`/amauta:verify-work [phase]`**
Validate built features through conversational UAT.

- Extracts testable deliverables from SUMMARY.md files
- Presents tests one at a time (yes/no responses)
- Automatically diagnoses failures and creates fix plans
- Ready for re-execution if issues found

Usage: `/amauta:verify-work 3`

### Milestone Auditing

**`/amauta:audit-milestone [version]`**
Audit milestone completion against original intent.

- Reads all phase VERIFICATION.md files
- Checks requirements coverage
- Spawns integration checker for cross-phase wiring
- Creates MILESTONE-AUDIT.md with gaps and tech debt

Usage: `/amauta:audit-milestone`

**`/amauta:plan-milestone-gaps`**
Create phases to close gaps identified by audit.

- Reads MILESTONE-AUDIT.md and groups gaps into phases
- Prioritizes by requirement priority (must/should/nice)
- Adds gap closure phases to ROADMAP.md
- Ready for `/amauta:plan-phase` on new phases

Usage: `/amauta:plan-milestone-gaps`

### Configuration

**`/amauta:settings`**
Configure workflow toggles and model profile interactively.

- Toggle researcher, plan checker, verifier agents
- Select model profile (quality/balanced/budget)
- Updates `.planning/config.json`

Usage: `/amauta:settings`

**`/amauta:set-profile <profile>`**
Quick switch model profile for GSD agents.

- `quality` — Opus everywhere except verification
- `balanced` — Opus for planning, Sonnet for execution (default)
- `budget` — Sonnet for writing, Haiku for research/verification

Usage: `/amauta:set-profile budget`

### Utility Commands

**`/amauta:cleanup`**
Archive accumulated phase directories from completed milestones.

- Identifies phases from completed milestones still in `.planning/phases/`
- Shows dry-run summary before moving anything
- Moves phase dirs to `.planning/milestones/v{X.Y}-phases/`
- Use after multiple milestones to reduce `.planning/phases/` clutter

Usage: `/amauta:cleanup`

**`/amauta:help`**
Show this command reference.

**`/amauta:update`**
Update GSD to latest version with changelog preview.

- Shows installed vs latest version comparison
- Displays changelog entries for versions you've missed
- Highlights breaking changes
- Confirms before running install
- Better than raw `npx get-shit-done-cc`

Usage: `/amauta:update`

**`/amauta:join-discord`**
Join the GSD Discord community.

- Get help, share what you're building, stay updated
- Connect with other GSD users

Usage: `/amauta:join-discord`

## Amauta Task Management CLI

All task state lives in PostgreSQL via the Amauta daemon on `:18799`.

### Task Hierarchy

```
Epic (EP-XXXX)
  └── Story (ST-XXXX)
        └── Task (TK-XXXX)
```

### amauta Commands  (Amauta v1)

```bash
CLI="node ~/.claude/get-shit-done/bin/amauta.cjs"

# Board & stats
$CLI board                              # Kanban view of all tasks
$CLI stats                              # Task statistics
$CLI list [--type task] [--status pending] [--agent executor-backend]

# Create items
$CLI add epic "Title"
$CLI add story "Title" --parent EP-0001 --agent operator
$CLI add task "Title" --parent ST-0001 --agent executor-backend --priority high --importance 5 --urgency 4

# Task lifecycle
$CLI show TK-0001 [--json]             # Full details
$CLI next executor-backend [--json]    # Next task for agent
$CLI claim TK-0001 --agent executor-backend
$CLI status TK-0001 validation         # Change status
$CLI assign TK-0001 --agent executor-general
$CLI link TK-0002 --dep TK-0001        # Add dependency
$CLI note TK-0001 --text "..." --agent checker

# RPETD pipeline
$CLI rpetd TK-0001 --phase R --content "R: research findings..."
$CLI rpetd TK-0001 --phase P --content "P: approach..."
$CLI rpetd TK-0001 --phase E --content "E: implemented X, Y, Z"
$CLI rpetd TK-0001 --phase T --content "T: npm test output..."
$CLI rpetd TK-0001 --phase D --content "D: delivered. LEARNING: ..."

# Validation (never self-validate — always a different agent)
$CLI validate TK-0001 --pass --validator validator --notes "PASS: evidence"
$CLI validate TK-0001 --fail --validator validator --notes "FAIL: reason" --subtasks "Fix A|Add test B"
$CLI validate TK-0001 --pass --force --validator operator --notes "PASS: trivial task"

# Search & score
$CLI search "auth middleware"
$CLI score TK-0001                      # Priority score breakdown
```

### gsd-memory.cjs Commands

```bash
MEM="node ~/.claude/get-shit-done/bin/gsd-memory.cjs"

$MEM store --source lesson-learned --text "Always run migrations before deploy"
$MEM store --source best-practice --text "Use connection pooling for PG"
$MEM search "deployment failure"
$MEM search "postgres" --json
$MEM learn "key insight"               # Stores as auto_learning
$MEM list [--limit 20]
$MEM count
$MEM health                            # Check daemon + PG status
$MEM embedding-stats                   # Embedding provider info
$MEM backfill-embeddings              # Re-embed memories after migration
$MEM cross-project "react patterns" --tags react,typescript
```

### gsd-rlm.cjs Commands (Code Context)

```bash
RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"

$RLM query "how does auth work" --dir src/ --top-k 5
$RLM query "database schema" --path migrations/001.sql
$RLM chunk services/daemon.py          # See how file is chunked
$RLM check-config --json               # Check RLM mode (rlm vs file-references)
```

### gsd-research.cjs Commands (Research Chain)

```bash
RES="node ~/.claude/get-shit-done/bin/gsd-research.cjs"

$RES "PostgreSQL connection pooling best practices"
$RES check-providers                   # Show available research providers
```

### Source-Aware Memory Scoring

| Source | Bonus | Use For |
|--------|-------|---------|
| `lesson-learned` | +4 | Hard-won failures and fixes |
| `best-practice` | +4 | Established patterns |
| `auto_learning` | +3 | Agent-extracted insights |
| `web_search_result` | +3 | Researched findings |
| `session-learning` | +3 | Current session discoveries |
| `distilled` | +2 | Summarized knowledge |
| `rpetd_phase` | +1 | Phase documentation |

### 11 Specialist Agents

| Agent | Role | Spawned By |
|-------|------|-----------|
| `gsd-operator` | Master orchestrator, task routing | User directly |
| `gsd-planner` | Task breakdown, dependency mapping | Operator |
| `gsd-researcher` | 4-mode research chain | Operator |
| `gsd-executor-frontend` | React/CSS/UI | Operator |
| `gsd-executor-backend` | APIs/DB/Python/Node | Operator |
| `gsd-executor-infra` | Docker/CI/CD/Terraform | Operator |
| `gsd-executor-general` | Config/docs/scaffolding | Operator |
| `gsd-checker` | Pre/post plan review | Operator |
| `gsd-validator` | External validation gate | Operator (auto) |
| `gsd-debugger` | Scientific bug investigation | /amauta:debug |
| `gsd-roadmapper` | Phase/roadmap creation | /amauta:new-project |

### RPETD Pipeline

Every task goes through 5 mandatory phases:

```
R (Research)  → Query RLM + memory for context
P (Plan)      → Define approach, files, risks
E (Execute)   → Write code, commit with task ID
T (Test)      → Run tests, include actual output
D (Document)  → Summary with LEARNING block
              ↓
Validator (external) → --pass or --fail + subtasks
```

Gate rules:
- 20-minute minimum between phases (prevents rushing)
- No self-validation (executor ≠ validator)
- Use `--force` to override for trivial tasks tagged `no-gitflow`

### Service Health

```bash
# Check all services
curl -s http://127.0.0.1:18799/health | python3 -m json.tool  # Amauta daemon
curl -s http://127.0.0.1:18798/health | python3 -m json.tool  # RLM service
docker ps --filter name=gsd-postgres                           # PostgreSQL

# Start services
docker start gsd-postgres
python3 ~/gsd-amauta/services/amauta-daemon.py start
python3 ~/gsd-amauta/services/rlm-service.py &
```

## Files & Structure

### Amauta Plugin Structure

```
~/gsd-amauta/
├── agents/               # 11 specialist agent definitions
├── commands/gsd/         # Slash commands (source of truth)
├── get-shit-done/
│   ├── bin/              # CLI tools (amauta.cjs, gsd-memory.cjs, etc.)
│   └── workflows/        # Workflow step files (installed copy)
├── services/
│   ├── amauta-daemon.py  # HTTP daemon :18799
│   ├── pg_store.py       # PostgreSQL + embedding store
│   └── rlm-service.py    # RLM context engine :18798
├── migrations/           # DB migrations (001-003)
├── docker/               # Docker Compose for PostgreSQL
├── data/                 # Task data (fallback JSON)
└── amauta.py             # Core task manager (3920 lines)
```

### GSD Project Structure

```
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Current phase breakdown
├── STATE.md              # Project memory & context
├── RETROSPECTIVE.md      # Living retrospective (updated per milestone)
├── config.json           # Workflow mode & gates
├── todos/                # Captured ideas and tasks
│   ├── pending/          # Todos waiting to be worked on
│   └── done/             # Completed todos
├── debug/                # Active debug sessions
│   └── resolved/         # Archived resolved issues
├── milestones/
│   ├── v1.0-ROADMAP.md       # Archived roadmap snapshot
│   ├── v1.0-REQUIREMENTS.md  # Archived requirements
│   └── v1.0-phases/          # Archived phase dirs (via /amauta:cleanup or --archive-phases)
│       ├── 01-foundation/
│       └── 02-core-features/
├── codebase/             # Codebase map (brownfield projects)
│   ├── STACK.md          # Languages, frameworks, dependencies
│   ├── ARCHITECTURE.md   # Patterns, layers, data flow
│   ├── STRUCTURE.md      # Directory layout, key files
│   ├── CONVENTIONS.md    # Coding standards, naming
│   ├── TESTING.md        # Test setup, patterns
│   ├── INTEGRATIONS.md   # External services, APIs
│   └── CONCERNS.md       # Tech debt, known issues
└── phases/
    ├── 01-foundation/
    │   ├── 01-01-PLAN.md
    │   └── 01-01-SUMMARY.md
    └── 02-core-features/
        ├── 02-01-PLAN.md
        └── 02-01-SUMMARY.md
```

## Workflow Modes

Set during `/amauta:new-project`:

**Interactive Mode**

- Confirms each major decision
- Pauses at checkpoints for approval
- More guidance throughout

**YOLO Mode**

- Auto-approves most decisions
- Executes plans without confirmation
- Only stops for critical checkpoints

Change anytime by editing `.planning/config.json`

## Planning Configuration

Configure how planning artifacts are managed in `.planning/config.json`:

**`planning.commit_docs`** (default: `true`)
- `true`: Planning artifacts committed to git (standard workflow)
- `false`: Planning artifacts kept local-only, not committed

When `commit_docs: false`:
- Add `.planning/` to your `.gitignore`
- Useful for OSS contributions, client projects, or keeping planning private
- All planning files still work normally, just not tracked in git

**`planning.search_gitignored`** (default: `false`)
- `true`: Add `--no-ignore` to broad ripgrep searches
- Only needed when `.planning/` is gitignored and you want project-wide searches to include it

Example config:
```json
{
  "planning": {
    "commit_docs": false,
    "search_gitignored": true
  }
}
```

## Common Workflows

**Starting a new project:**

```
/amauta:new-project        # Unified flow: questioning → research → requirements → roadmap
/clear
/amauta:plan-phase 1       # Create plans for first phase
/clear
/amauta:execute-phase 1    # Execute all plans in phase
```

**Resuming work after a break:**

```
/amauta:progress  # See where you left off and continue
```

**Adding urgent mid-milestone work:**

```
/amauta:insert-phase 5 "Critical security fix"
/amauta:plan-phase 5.1
/amauta:execute-phase 5.1
```

**Completing a milestone:**

```
/amauta:complete-milestone 1.0.0
/clear
/amauta:new-milestone  # Start next milestone (questioning → research → requirements → roadmap)
```

**Capturing ideas during work:**

```
/amauta:add-todo                    # Capture from conversation context
/amauta:add-todo Fix modal z-index  # Capture with explicit description
/amauta:check-todos                 # Review and work on todos
/amauta:check-todos api             # Filter by area
```

**Debugging an issue:**

```
/amauta:debug "form submission fails silently"  # Start debug session
# ... investigation happens, context fills up ...
/clear
/amauta:debug                                    # Resume from where you left off
```

## Getting Help

- Read `.planning/PROJECT.md` for project vision
- Read `.planning/STATE.md` for current context
- Check `.planning/ROADMAP.md` for phase status
- Run `/amauta:progress` to check where you're up to
</reference>
