# GSD-Amauta

**A quality-enforced AI development harness for Claude Code and any MCP-compatible agent.**

GSD-Amauta gives your team a structured 5-phase development pipeline (RPETD: Research -> Plan -> Execute -> Test -> Deliver), persistent PostgreSQL + pgvector memory so every agent session builds on prior work, 17 specialist agents with file-pattern routing, and a formal protocol that turns plan-vs-reality mismatches into first-class observations instead of silent scope creep. Install once; your AI agents run smarter every phase.

---

## Quick start (30 seconds)

```bash
# Prerequisites: Node.js >= 20, Docker (for PG + Valkey)
npm install -g gsd-amauta
npx gsd-amauta init          # 7-step setup: detects IDEs, runs migrations, starts daemon
```

Then in Claude Code (or any MCP client):
```
/amauta:plan-phase 1         # Plan your first feature phase
/amauta:execute-phase 1      # Execute it with full agent orchestration
```

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the full end-to-end walkthrough.

---

## How it differs

| Feature | GSD-Amauta | Claude Code (built-in) | Cursor | BMAD-METHOD | npm |
|---------|-----------|------------------------|--------|-------------|-----|
| Persistent memory across sessions | PostgreSQL + pgvector | None (stateless) | None | None | N/A |
| Multi-agent orchestration | 17 specialist agents with routing | Single-agent | Single-agent | Wide agent roster, no PG | N/A |
| RPETD pipeline enforcement | Mandatory 5-phase gate | No structure | No structure | Loose phase guidance | N/A |
| Blackboard agent communication | agent_findings + agent_messages PG tables | None | None | None | N/A |
| Install method | `npm install -g gsd-amauta` | Built into Claude Code | Built into Cursor | Manual copy | Package manager only |
| Requires Docker | Yes (PG + Valkey) | No | No | No | No |
| A2A agent-to-agent protocol | Yes (v3.3) | No | No | No | No |
| Module marketplace | Yes (`gsd-amauta module install`) | No | No | No | No |

GSD-Amauta is the right choice when you want persistent memory, structured multi-agent orchestration, and a reproducible quality gate across your team. The honest tradeoff: it requires Docker for PostgreSQL and Valkey.

---

## Prerequisites

- **Node.js >= 20** (LTS recommended)
- **Docker** — runs PostgreSQL 16 + pgvector 0.8.2 + Valkey 8.x
- **Python 3.11+** — for the daemon and services
- **Claude Code** (recommended) or any MCP-compatible AI coding agent

Optional but recommended:
- **Voyage AI API key** — enables semantic memory embeddings (`VOYAGE_API_KEY`)
- **Perplexity API key** — enables the 5-step research chain (`PERPLEXITY_API_KEY`)

---

## Installation

```bash
# 1. Install the CLI globally
npm install -g gsd-amauta

# 2. Start infrastructure (PG + Valkey)
docker compose -f $(npm root -g)/gsd-amauta/docker/docker-compose.yml up -d

# 3. Run the interactive setup
npx gsd-amauta init

# 4. Verify everything is healthy
gsd-amauta doctor
```

For upgrade and uninstall:
```bash
npx gsd-amauta init --upgrade
npx gsd-amauta init --uninstall
```

---

## Core concepts

**RPETD pipeline** — Every task runs through 5 mandatory phases: Research (prior art + codebase context), Plan (decompose into tasks with acceptance criteria), Execute (implement with divergence protocol enforcement), Test (validate against criteria), Deliver (commit + learn). Agents cannot skip phases.

**Persistent memory** — Every completed task, validated pattern, and agent learning is stored in PostgreSQL with pgvector embeddings. Future agents query this memory before starting work, so the system improves with every phase shipped.

**Specialist agents** — 17 agents with file-pattern routing: planner, executor-backend, executor-frontend, executor-infra, reviewer, security, architect, tester, and more. The orchestrator routes tasks to the right agent based on file types and complexity.

**Divergence protocol** — When an executor discovers a plan-vs-reality mismatch, it surfaces it as a first-class observation (not a silent fix). The orchestrator decides: absorb, escalate, or replan.

**Module marketplace** — Install community modules: `gsd-amauta module search payments` / `gsd-amauta module install registry:stripe-integration@1.0.0`.

---

## Module marketplace

```bash
gsd-amauta module search <query>             # Search the registry
gsd-amauta module install <name@version>     # Install from registry
gsd-amauta module install https://...        # Install from URL
gsd-amauta module install github:owner/repo@tag
```

---

## A2A Agent-to-Agent protocol (v3.3)

Agents can now communicate directly via a structured A2A protocol with capability negotiation, timeout/retry, circuit breakers per agent-pair, and conversation threading — all audit-logged.

```bash
gsd-amauta a2a tail                          # Stream live A2A exchanges
```

---

## CLI reference

```
gsd-amauta init [--upgrade | --uninstall] [--verbose] [--dry-run]
gsd-amauta doctor
gsd-amauta module search <query>
gsd-amauta module install <name>
gsd-amauta a2a tail
amauta board
amauta show <task-id>
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for PR workflow, commit conventions, and test policy.

## Security

See [SECURITY.md](SECURITY.md) for responsible disclosure and supported version matrix.

## License

[MIT](LICENSE) — Copyright (c) 2026 Luis Carlos Mogrovejo de Piérola

---

## Release history

<details>
<summary>Prior milestone history (v2.5 through v3.2)</summary>

See [HISTORY.md](HISTORY.md) for the full milestone-by-milestone feature log.

</details>
