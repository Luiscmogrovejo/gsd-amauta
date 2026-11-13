# GSD-Amauta

**A quality-enforced AI development harness for Claude Code and any MCP-compatible agent.**

**Status:** personal project, in daily use on the author's own work. Not published on npm yet; install from a clone (below).

GSD-Amauta gives your team a structured 5-phase development pipeline (RPETD: Research -> Plan -> Execute -> Test -> Deliver), persistent PostgreSQL + pgvector memory so every agent session builds on prior work, 35 specialist agents with file-pattern routing, and a formal protocol that turns plan-vs-reality mismatches into first-class observations instead of silent scope creep. Install once; your AI agents run smarter every phase.

---

## Quick start (30 seconds)

```bash
# Prerequisites: Node.js >= 20, Python 3.11+. Docker is RECOMMENDED (PG + Valkey);
# without it the harness installs and runs on a SQLite fallback — see below.
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git && cd gsd-amauta
npm install
docker compose -f docker/docker-compose.yml up -d   # recommended
node bin/init.cjs            # 7-step setup: detects IDEs, runs migrations, starts daemon
node bin/cli.cjs doctor      # 0 = healthy, 1 = degraded, 2 = failing
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
| Multi-agent orchestration | 35 specialist agents with routing | Single-agent | Single-agent | Wide agent roster, no PG | N/A |
| RPETD pipeline enforcement | Mandatory 5-phase gate | No structure | No structure | Loose phase guidance | N/A |
| Blackboard agent communication | agent_findings + agent_messages, on PostgreSQL **and** SQLite | None | None | None | N/A |
| Install method | `git clone` + `npm install` (not on npm yet) | Built into Claude Code | Built into Cursor | Manual copy | Package manager only |
| Requires Docker | Recommended (PG + Valkey); SQLite fallback otherwise | No | No | No | No |
| Module marketplace | Yes (`gsd-amauta module install`) | No | No | No | No |

GSD-Amauta is the right choice when you want persistent memory, structured multi-agent orchestration, and a reproducible quality gate across your team. The honest tradeoff: two of the features that make it worth installing — semantic memory search and the RLM code index — need PostgreSQL, so in practice you want Docker. The blackboard does not: it runs on both backends.

---

## Prerequisites

- **Node.js >= 20** (LTS recommended)
- **Python 3.11+** — for the daemon and services
- **Docker** (recommended) — runs PostgreSQL 16 + pgvector 0.8.2 + Valkey 8.x.
  Without it the installer completes on a SQLite fallback and prints a DEGRADED
  banner naming what is off (see [SQLite fallback](#sqlite-fallback-what-actually-works)).
- **Claude Code** (recommended) or any MCP-compatible AI coding agent

Optional but recommended:
- **Voyage AI API key** — enables semantic memory embeddings (`VOYAGE_API_KEY`)
- **Perplexity API key** — enables the 5-step research chain (`PERPLEXITY_API_KEY`)

---

## Installation

The package is not on npm yet, so install from a clone:

```bash
# 1. Clone and install dependencies
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git
cd gsd-amauta
npm install

# 2. Start infrastructure (PG + Valkey)
docker compose -f docker/docker-compose.yml up -d

# 3. Run the interactive setup
node bin/init.cjs

# 4. Verify everything is healthy
node bin/cli.cjs doctor
```

Optional: `npm link` from the clone puts `gsd-amauta` (and `amauta`) on your PATH, after which `gsd-amauta init` and `gsd-amauta doctor` are the same commands. The CLI reference below assumes that link.

For upgrade and uninstall:
```bash
git pull && node bin/init.cjs --upgrade          # re-installs files + applies new migrations
node bin/init.cjs --upgrade --dry-run --json     # preview first
node bin/init.cjs --uninstall --dry-run          # preview (project + global install)
node bin/init.cjs --uninstall --yes              # also removes the GLOBAL install
```

Never hand-copy files into `~/.claude/`: the installer rewrites config-dir paths
inside the files it installs and regenerates `gsd-file-manifest.json`, which
`doctor` uses to detect drift. A raw copy breaks both.

---

## SQLite fallback: what actually works

When PostgreSQL is not available, init completes on SQLite and says so in a
DEGRADED banner instead of reporting a clean install.

**Works on SQLite:** memory store/search (keyword/FTS), tasks and the RPETD
pipeline, SKB, validation records, audit log, agents, skills, commands, hooks,
**and the blackboard** (`agent_findings` / `agent_messages`) — the agent-to-agent
channel works on both backends and is tested on both.

**Off on SQLite:**
- vector / semantic memory search (pgvector)
- the RLM code index (`rlm_chunks`)
- the semantic cache

**How to check:** `gsd-amauta doctor` prints a `backend` row — `OK` on
PostgreSQL, `WARN  DEGRADED: running on sqlite fallback — OFF: ...` otherwise,
and `FAIL` when PostgreSQL is configured but not answering. The exit code is
0 healthy / 1 degraded / 2 failing; `--strict` makes warnings exit 2, and
`--json` emits the same rows as a document.

On SQLite, `--upgrade` applies no SQL migrations **and records none as
applied**, so a later switch to PostgreSQL runs the full migration set.

---

## Core concepts

**RPETD pipeline** — Every task runs through 5 mandatory phases: Research (prior art + codebase context), Plan (decompose into tasks with acceptance criteria), Execute (implement with divergence protocol enforcement), Test (validate against criteria), Deliver (commit + learn). Agents cannot skip phases.

**Persistent memory** — Every completed task, validated pattern, and agent learning is stored in PostgreSQL with pgvector embeddings. Future agents query this memory before starting work, so the system improves with every phase shipped.

**Specialist agents** — 35 agents with file-pattern routing: planner, executor-backend, executor-frontend, executor-infra, executor-mobile-android, executor-mobile-ios, executor-mobile-cross (Flutter/React Native), executor-wearables (watchOS/Wear OS), executor-ai (LLM apps, prompts, MCP servers, evals), reviewer, security, architect, tester, and more. The orchestrator routes tasks to the right agent based on file types and complexity.

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

## Agent-to-agent communication: the blackboard

**The bespoke A2A request/response protocol was removed in v3.7 (Phase 89,
2026-11-12).** The client, the per-agent-pair circuit breaker, the capability
registry, the `gsd-amauta a2a` and `gsd-tools a2a` verbs, the
`GET /a2a/exchanges` exchange log and its `a2a_messages` table are all gone,
because no production code path ever used them: nothing in the RPETD pipeline
sent an A2A message and the circuit breaker was never armed.

**The blackboard inbox is the single agent-to-agent channel**, and it works on
PostgreSQL **and** on SQLite:

| Verb | What it does |
|---|---|
| `POST /api/findings` | publish something other agents should know |
| `GET /api/findings/:task` | everything filed against one task |
| `GET /api/findings?status=open` | the cross-task audit sweep |
| `PATCH /api/findings/:id` | transition a finding (`ticketed`, `fixed`, …) |
| `POST /api/messages` | send a typed message to one agent |
| `GET /api/messages/:agent` | that agent's inbox (`pending`, `approved`) |
| `GET /api/messages/:agent?status=responded` | read the answers |
| `PATCH /api/messages/:id` | approve, deny or answer a message |

`tests/test_89_05_inbox_round_trip.py` drives post → read → answer → read-the-
answer over HTTP against both backends and compares the two field by field, so
"works on both" is a measurement rather than a claim.

What was lost with the protocol, and what replaces it:

| Gone | Replacement |
|---|---|
| capability negotiation between agents | none. Capabilities are declared in each `AGENT.yaml` and read by `services/capability_access.py`; there is no runtime negotiation and nothing asked for one |
| the per-agent-pair circuit breaker | none, and nothing was protected by it: no Redis client was ever injected, so it never opened |
| the request/response client with threading and retry | the blackboard's typed messages. There is no correlation-id thread and no automatic retry — a caller that needs one asks again |
| the `GET /a2a/exchanges` audit endpoint | `GET /api/findings` and `GET /api/messages/:agent`, both of which the audit log already covers |

**A party session keeps only recorded decisions** (v3.7, Phase 89, ORC-02). It
is a container row plus the decisions agents post into it — `propose`, `agree`,
`dissent`, `block` — which are posted, listed and summarised, attributable to
the agent that posted them and returned in the order they were made. It is no
longer a lifecycle: the four-state transition machine, `party pause`,
`party resume` (with its finding replay) and `party kill` were removed. A
session's `status` is a label that gates nothing, and a removed verb answers
with what replaced it instead of failing silently.

A party session is **not a second agent channel**. Its decisions are rows on
the blackboard (`agent_findings` with a `session_id`), so the blackboard inbox
above stays the single agent-to-agent channel. Party sessions need PostgreSQL;
on the SQLite fallback the verbs answer a typed `requires_postgres`.

```bash
gsd-amauta party create --participants a,b   # open a container
gsd-amauta party start <session_id>          # label it active (never refused)
gsd-amauta party status                      # every session with its decision counts
gsd-amauta party inspect <session_id>        # the ordered, attributed decision trail
gsd-amauta party get <session_id> --with-findings
gsd-amauta party terminate <session_id>      # close it; its decisions stay readable
```

Decisions are recorded from Python with `services/party_session.py`
`post_decision()` and read back with `list_decisions()` and
`summarize_decisions()`; there is no CLI verb that posts one.

---

## CLI reference

```
gsd-amauta init [--upgrade | --uninstall] [--yes] [--verbose] [--dry-run]
gsd-amauta doctor [--json] [--strict] [--config-dir <path>]
gsd-amauta module search <query>
gsd-amauta module install <name>
gsd-amauta party status | inspect <session_id>   # recorded decisions
amauta board
amauta show <task-id>
```

`doctor` exits 0 (healthy), 1 (degraded — warnings) or 2 (failures), so it can
gate a script. It checks paths, PATH collisions, install drift against the
install manifest, version skew, the daemon, the backend and the features a
SQLite fallback turns off, PostgreSQL, Valkey, the RLM index, embedding
coverage, API keys, migrations, agents, skills and the mobile toolchain.

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
