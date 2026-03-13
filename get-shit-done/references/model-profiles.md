# Model Profiles

Model profiles control which Claude model each GSD agent uses. This allows balancing quality vs token spend.

## Profile Definitions

| Agent | `quality` | `balanced` | `budget` |
|-------|-----------|------------|----------|
| gsd-operator | opus | opus | sonnet |
| gsd-planner | opus | opus | sonnet |
| gsd-roadmapper | opus | sonnet | sonnet |
| gsd-researcher | opus | sonnet | haiku |
| gsd-executor-frontend | opus | sonnet | sonnet |
| gsd-executor-backend | opus | sonnet | sonnet |
| gsd-executor-infra | opus | sonnet | sonnet |
| gsd-executor-general | opus | sonnet | sonnet |
| gsd-checker | sonnet | sonnet | haiku |
| gsd-validator | sonnet | sonnet | haiku |
| gsd-debugger | opus | sonnet | sonnet |

## Profile Philosophy

**quality** - Maximum reasoning power
- Opus for all decision-making and execution agents
- Sonnet for quality checking and validation
- Use when: quota available, critical architecture work

**balanced** (default) - Smart allocation
- Opus only for orchestration and planning (where architecture decisions happen)
- Sonnet for execution, research, and validation (follows explicit instructions)
- Use when: normal development, good balance of quality and cost

**budget** - Minimal Opus usage
- Sonnet for anything that writes code
- Haiku for research, checking, and validation
- Use when: conserving quota, high-volume work, less critical phases

## Resolution Logic

Orchestrators resolve model before spawning:

```
1. Read .planning/config.json
2. Check model_overrides for agent-specific override
3. If no override, look up agent in profile table
4. Pass model parameter to Task call
```

## Per-Agent Overrides

Override specific agents without changing the entire profile:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor-frontend": "opus",
    "gsd-planner": "haiku"
  }
}
```

Overrides take precedence over the profile. Valid values: `opus`, `sonnet`, `haiku`.

## Switching Profiles

Runtime: `/amauta:set-profile <profile>`

Per-project default: Set in `.planning/config.json`:
```json
{
  "model_profile": "balanced"
}
```

## Design Rationale

**Why Opus for gsd-operator and gsd-planner?**
Orchestration and planning involve architecture decisions, goal decomposition, and task design. This is where model quality has the highest impact.

**Why Sonnet for executor agents?**
Executors (frontend, backend, infra, general) follow explicit PLAN.md instructions. The plan already contains the reasoning; execution is implementation.

**Why a single gsd-researcher instead of separate research agents?**
The previous split (gsd-phase-researcher, gsd-project-researcher, gsd-research-synthesizer) created unnecessary agent proliferation. A single gsd-researcher handles all research tasks with the same model profile.

**Why Sonnet (not Haiku) for gsd-checker and gsd-validator in balanced?**
Checking and validation require goal-backward reasoning — verifying that code *delivers* what the phase promised, not just pattern matching. Sonnet handles this well; Haiku may miss subtle gaps.

**Why `inherit` instead of passing `opus` directly?**
Claude Code's `"opus"` alias maps to a specific model version. Organizations may block older opus versions while allowing newer ones. GSD returns `"inherit"` for opus-tier agents, causing them to use whatever opus version the user has configured in their session. This avoids version conflicts and silent fallbacks to Sonnet.
