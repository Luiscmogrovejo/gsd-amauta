# GSD-Amauta — Release History

This file contains the milestone-by-milestone feature history of GSD-Amauta.
For current documentation, see [README.md](README.md) and [docs/QUICKSTART.md](docs/QUICKSTART.md).

---

## v3.3 "The Dialect" (2026)

5 phases (54-58), v3.3 milestone: Stability & Hardening, A2A agent-to-agent protocol,
Module Marketplace, and Public Launch. Body metaphor: federation members start speaking
directly to each other, then ship to the world.

## v3.2 "The Federation" (2026-05-14)

6 phases (48-53), 24 plans, ~336 tests, 22 requirements. Modules + party mode +
agent compilation + v3.1 carry-forward polish. Phase 50-51 introduced the party session
blackboard with 5 frozen state transitions and operator-supervised decision records.
Phase 52 shipped the agent compiler (928 lines, 3 IDE target maps).

## v3.1 "The Gathering" (2026-05-13)

7 phases (41-47), 18 plans, ~536 tests, 25 requirements. BMAD-METHOD patterns grafted
onto Amauta's PG/retrieval infrastructure. Phase 41 introduced sharded workflows (foundation);
Phase 43 shipped the skills architecture; Phase 44 added the cross-IDE installer with
7-step init flow; Phase 46 added the standalone MCP server.

## v3.0 "The Birth" (2026-04-14)

10 phases (31-40), 24 plans, 55 requirements, 820 assertions. 17 agents with
standardized format, specialized capabilities, and lifecycle management. Introduced the
blackboard pattern (agent_findings + agent_messages PG tables) and the formal agent
routing system with file-pattern dispatch and performance tiebreaker fallback.

## v2.8 "Metabolism" (2026-04-13)

6 phases (13 plans, ~150 new tests). Five layered optimizations reduce effective
token cost per RPETD cycle by 75-90%: typed RPETDContext compaction, SHA-256 file
staleness detection, pipe-delimited structured file descriptions, cache_breakpoint
prefix caching for all 11 agent files, and pgvector semantic research cache at
cosine >= 0.90. Config-driven model routing added (per-phase model selection).

## v2.7 "Steady Hands" (2026-04-12)

4 phases (8 plans, 47 new tests). Hardening milestone — closes v2.6 dogfood audit
items: milestone-scoped phase directory resolution (ends ghost directory returns from
archived milestones), dual-probe verification file discovery, structured npm failure
parsing for node --test output, audit report schema versioning with tooling_bugs_observed
and sampling_health fields.

## v2.6 "Sight Beyond Sight" (2026-04-10)

46 requirements across 15 phases. Every RPETD phase gained the ability to see what
other phases have already learned. Key additions: per-task files_expected manifest
enforcement via git diff, divergence protocol v1.1.0 (detect → stop → report → orchestrator
decides), three-verdict validator vocabulary (pass/fail/gaps-found), structured D-phase
WHAT/WHY/WHEN/CATEGORY/TAGS learning format, mandatory PRE_EXECUTION_EVIDENCE block,
plan-to-tasks auto-registration with XML story/task blocks.

## v2.5 "Smarter Brain" (2026-04-06)

49 requirements. PG memory with pgvector semantic search, Voyage AI voyage-code-3
embeddings (1024d), BM25 RLM context engine (10-50x context reduction), 11 specialist
agents with file-pattern routing, 5-step research chain (Memory → SKB → Context7 →
Perplexity → WebFetch), auto-distillation with recency decay and tiered retention,
graceful degradation stack (every feature has a fallback path when infrastructure is
unavailable).
