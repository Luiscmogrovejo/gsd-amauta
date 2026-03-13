# Agentic AI Design Patterns — GSD-Amauta Agent Mapping

**Version:** 1.0
**Source:** "The Ultimate Agentic AI Design Patterns Reference Guide" (20 patterns)
**Purpose:** Map each of the 20 agentic AI design patterns to the GSD-Amauta agent roster,
documenting which agents implement which patterns and when they trigger.

---

## Pattern Catalog

### Part I: Core Orchestration Patterns

#### P1 — Prompt Chaining
**Definition:** Decompose complex tasks into sequential steps where each step processes the output of the previous one.
**Agents:** `operator`, `planner`
**Trigger:** When operator decomposes user requests into epic → story → task hierarchy, or when planner creates multi-step plans with sequential dependencies.
**GSD-Amauta Implementation:** RPETD pipeline itself is a 5-step prompt chain (R→P→E→T→D). Each phase's output feeds the next.

#### P2 — Routing
**Definition:** Classify input and direct it to a specialized handler based on intent, complexity, or domain.
**Agents:** `operator`
**Trigger:** Every task assignment — operator routes tasks to executors by file pattern and domain expertise.
**GSD-Amauta Implementation:** Operator routing table in `gsd-operator.md`: `.tsx`→frontend, `.py`→backend, `Dockerfile`→infra, etc.

#### P3 — Parallelization
**Definition:** Execute multiple independent tasks simultaneously, then aggregate results.
**Agents:** `operator`
**Trigger:** When execute-phase identifies independent plans in a wave, spawns multiple executor agents in parallel.
**GSD-Amauta Implementation:** Wave-based execution in `execute-phase.md` — plans within a wave run in parallel Task() calls.

#### P4 — Tool Use (Function Calling)
**Definition:** LLMs interact with external systems via structured function calls.
**Agents:** ALL (10 agents)
**Trigger:** Every agent uses CLI tools: `gsd-amauta.cjs`, `gsd-rlm.cjs`, `gsd-memory.cjs`, `gsd-research.cjs`, `gsd-tools.cjs`.
**GSD-Amauta Implementation:** All agents invoke Node.js CLI tools via Bash. RLM queries, memory search, task management, research chain.

#### P5 — Reflection (The Critic)
**Definition:** Evaluate, critique, and improve outputs through iterative self-assessment.
**Agents:** `validator`, `checker`
**Trigger:** Validator reviews executor work post-RPETD. Checker runs pre/post verification on code quality.
**GSD-Amauta Implementation:** External validation — no agent marks its own work done. Validator uses `gsd-validator.md` protocol with 4 quality gates.

#### P6 — Planning / Orchestration
**Definition:** Central LLM dynamically breaks down tasks, delegates to workers, and synthesizes results.
**Agents:** `operator`, `planner`
**Trigger:** User requests → operator decomposes into epics/stories/tasks via amauta. Planner creates detailed execution plans with Given/When/Then acceptance criteria.
**GSD-Amauta Implementation:** Hierarchical planning: epic → story → task in amauta task manager. Priority scoring: `importance×0.4 + urgency×0.3 + dep_pressure×0.3`.

---

### Part II: Tool & Retrieval Patterns

#### P7 — RAG (Retrieval Augmented Generation)
**Definition:** Retrieve relevant context before generating responses to ground outputs in facts.
**Agents:** `researcher`, all executors
**Trigger:** Every R-phase in RPETD triggers RLM queries. Researcher uses full research chain.
**GSD-Amauta Implementation:** RLM service (`rlm-service.py`) provides code-aware chunking with TF-IDF relevance scoring. Memory search adds past experience context. Research chain: memory → SKB → Context7 → Perplexity → WebFetch.

#### P8 — Resource-Aware Model Routing
**Definition:** Route queries to different model tiers based on complexity and cost.
**Agents:** `operator`
**Trigger:** Operator decides executor vs researcher vs debugger based on task nature. Config supports `executor_model` and `verifier_model` tiers.
**GSD-Amauta Implementation:** `config.json` model settings per role. Simple tasks → general executor, complex → specialist executor.

---

### Part III: Multi-Agent & Memory Patterns

#### P9 — Multi-Agent Collaboration
**Definition:** Multiple specialized agents working together on complex tasks.
**Agents:** ALL (10 agents forming the collaboration)
**Trigger:** Every project execution — operator orchestrates specialists who each handle their domain.
**GSD-Amauta Implementation:** 10-agent roster: operator, 4 executors (frontend/backend/infra/general), planner, researcher, checker, validator, debugger. Coordinated via amauta task manager.

#### P10 — Inter-Agent Communication Protocols
**Definition:** Standardized message formats and handoff procedures between agents.
**Agents:** ALL
**Trigger:** Every Task() spawn includes structured context. RPETD phases serve as the communication protocol.
**GSD-Amauta Implementation:** Amauta task records are the shared communication medium. RPETD phases, notes, and validation results. CLI tools provide the API. Task() spawn prompts include structured context blocks.

#### P11 — Memory Management
**Definition:** Persistent storage and retrieval of information across sessions.
**Agents:** ALL (via `gsd-memory.cjs`)
**Trigger:** Every D-phase stores learning to memory. Every R-phase queries memory for past experience.
**GSD-Amauta Implementation:** PostgreSQL `gsd_memory` table with source-aware scoring: auto_learning +3, lesson-learned +4, web_search_result +3, session-learning +3, distilled +2, rpetd_phase +1. File-based fallback when PG unavailable.

---

### Part IV: Learning & Reasoning Patterns

#### P12 — Learning & Feedback
**Definition:** Capture insights from task execution to improve future performance.
**Agents:** ALL executors, `operator`, `validator`
**Trigger:** Every D-phase must include a `LEARNING:` block. SKB promotion on validation pass. Memory auto-store on Perplexity results.
**GSD-Amauta Implementation:** Three learning paths: (1) RPETD D-phase LEARNING extraction → SKB promotion, (2) Auto-learning from Perplexity results → memory with web_search_result source, (3) `gsd-memory.cjs learn` explicit learning capture.

#### P13 — Reasoning Strategies (CoT / ToT / GoT)
**Definition:** Structured reasoning approaches for complex problem-solving.
**Agents:** `debugger`, `planner`, `researcher`
**Trigger:** Debugger uses scientific method (hypothesis → test → observe → conclude). Planner uses Given/When/Then for acceptance criteria. Researcher uses structured research modes.
**GSD-Amauta Implementation:** Debugger follows scientific method in `gsd-debugger.md`. Planner creates structured plans. RPETD itself enforces step-by-step reasoning.

---

### Part V: Monitoring & Safety Patterns

#### P14 — Goal Setting & Monitoring
**Definition:** Define measurable objectives and track progress toward them.
**Agents:** `operator`, `planner`
**Trigger:** Task creation with success criteria, deliverables, and validation checklist. Amauta board tracks status.
**GSD-Amauta Implementation:** Every task has `success_criteria[]`, `deliverables[]`, `validation_checklist[]`. Amauta `board` and `stats` commands provide monitoring. Priority scoring enables progress tracking.

#### P15 — Exception Handling
**Definition:** Detect, handle, and recover from errors gracefully.
**Agents:** `debugger`, `operator`
**Trigger:** Validation failures create sub-tasks via `--subtasks`. Debugger spawned for technical failures. Graceful degradation throughout.
**GSD-Amauta Implementation:** Validation fail → atomize into sub-tasks. Debugger uses memory-backed failure analysis. All services have fallback: PG→file memory, RLM→file references, daemon→direct CLI, Perplexity→WebFetch.

#### P16 — Evaluation & Monitoring (Evals)
**Definition:** Systematic assessment of agent output quality.
**Agents:** `validator`, `checker`
**Trigger:** Every task passes through 3 validation gates (branch evidence, LEARNING block, test evidence). Checker runs pre/post quality checks.
**GSD-Amauta Implementation:** `checkValidationGates()` in `gsd-amauta.cjs` enforces 3 gates. Validator protocol with 4 quality gates in `gsd-validator.md`. `gsd-checker.md` runs pre/post verification.

#### P17 — Guardrails & Safety
**Definition:** Constraints and boundaries to prevent harmful or incorrect agent behavior.
**Agents:** `operator`, `validator`
**Trigger:** Gitflow gates block validation without PR evidence. Gate cooldown prevents rushing. Non-code types exempt from code gates.
**GSD-Amauta Implementation:** Gitflow gates in `amauta.py`. RPETD completeness enforcement. No self-validation rule. `--force` override for legitimate exceptions only.

---

### Part VI: Human-Centric & Discovery Patterns

#### P18 — Human-in-the-Loop (HITL)
**Definition:** Strategic points where human input is required before proceeding.
**Agents:** `operator`
**Trigger:** Checkpoint plans in execute-phase require user approval. `human-verify`, `decision`, and `human-action` checkpoint types.
**GSD-Amauta Implementation:** Execute-phase checkpoint handling (3 types). UAT via verify-work workflow. User confirms validation results. Auto-advance optional but defaults off.

#### P19 — Prioritization
**Definition:** Rank and order tasks based on importance, urgency, and dependencies.
**Agents:** `operator`
**Trigger:** Every `next` command returns the highest-scored pending task. Score = `importance×0.4 + urgency×0.3 + dep_pressure×0.3`.
**GSD-Amauta Implementation:** Amauta priority scoring in `amauta.py`. `gsd-amauta.cjs next <agent>` returns best task. Dependency pressure calculation includes blocked-by analysis.

#### P20 — Exploration / Discovery
**Definition:** Proactive investigation and discovery of information, patterns, and solutions.
**Agents:** `researcher`
**Trigger:** R-phase of RPETD. Research chain activation. Perplexity-first external research. 4 research modes in `gsd-researcher.md`.
**GSD-Amauta Implementation:** `gsd-research.cjs` provider chain: memory → SKB → Context7 → Perplexity → WebFetch. Researcher has 4 modes: quick-check, deep-dive, architecture-review, pattern-search.

---

## Agent-to-Pattern Matrix

| Agent | Primary Patterns | Secondary Patterns |
|-------|-----------------|-------------------|
| **operator** | P2, P3, P6, P14, P19 | P1, P8, P9, P15, P17, P18 |
| **validator** | P5, P16 | P10, P17 |
| **researcher** | P7, P20 | P4, P13 |
| **planner** | P1, P6, P14 | P13 |
| **checker** | P5, P16 | P10 |
| **executor-frontend** | P4, P12 | P7, P11 |
| **executor-backend** | P4, P12 | P7, P11 |
| **executor-infra** | P4, P12 | P7, P11 |
| **executor-general** | P4, P12 | P7, P11 |
| **debugger** | P13, P15 | P4, P7, P11 |

## Coverage Summary

All 20 patterns are implemented across the 10-agent roster:
- **100% coverage** — every pattern has at least one implementing agent
- **operator** is the most pattern-rich agent (11 patterns)
- **P4 (Tool Use)** and **P9 (Multi-Agent)** span all agents
- **P11 (Memory)** and **P12 (Learning)** are the backbone patterns — used by all executors + operator + debugger
