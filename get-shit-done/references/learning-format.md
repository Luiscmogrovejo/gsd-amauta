# Structured Learning Format (WHAT/WHY/WHEN/TAGS)

**Purpose:** Human-review and SKB-promotion format for D-phase learnings. NOT a retrieval optimizer — free-text + embeddings still win recall. This structure exists so a reviewer can decide in <10 seconds whether a learning deserves promotion.

**Kill switch:** `GSD_D_STRUCTURED=false` disables the parser — the operator stores LEARNING blocks as free-text and logs a warning. No silent degradation.

---

## WHAT/WHY/WHEN/TAGS Template

Every D-phase LEARNING block MUST follow this shape. The first line IS the WHAT — the one-liner doubles as the structured field, so there is nothing extra to maintain.

```
LEARNING: <action-oriented executable instruction, <=120 chars>
  WHAT: <same as the LEARNING: line, <=120 chars>
  WHY: <the reason it matters, <=200 chars>
  WHEN: <conditional trigger — the situation where this applies, <=80 chars>
  CATEGORY: <one of: workflow|process|delivery|pattern|policy|architecture|convention|pitfall|tool-usage>
  TAGS: <comma-separated, up to 5 tags from curated vocabulary in config/tag-rules.json>
```

### Field Rules (enforced at CLI level)

| Field    | Required | Max length | Rule |
|----------|----------|------------|------|
| WHAT     | YES      | 120 chars  | Action-oriented executable instruction, not problem description |
| WHY      | no       | 200 chars  | Context/reason. Empty is better than vague. |
| WHEN     | no       | 80 chars   | Conditional trigger (situation), NOT the RPETD phase |
| CATEGORY | no       | fixed set  | Defaults to `pattern`. Warning logged when default is used. |
| TAGS     | no       | 5 max      | Auto-trimmed by tier if >5. Banned tags stripped. See tag-rules.json. |

### Length Cap Enforcement

Over-limit learnings are REJECTED at the CLI level with a specific fix message:
- `Rejected: WHAT is 147 chars (max 120). Trim to the executable instruction only.`
- `Rejected: WHY is 243 chars (max 200). Keep to one sentence of context.`
- `Rejected: all tags are generic (best-practice, lesson). Add specific tags like 'postgresql', 'connection-pool'.`

---

## Categories

Fixed set matching SKB categories. Choose the narrowest fit. Default is `pattern` (warning logged).

| Category      | When to use |
|---------------|-------------|
| `workflow`    | Multi-step procedure that must happen in order |
| `process`     | Repeatable protocol (how we run RPETD phases, etc.) |
| `delivery`    | Ship-level concern (rollout, release notes, feature flags) |
| `pattern`     | Reusable code/design pattern (DEFAULT) |
| `policy`      | Hard rule / boundary (always do X, never do Y) |
| `architecture`| System-level decision (boundaries between services) |
| `convention`  | Stylistic rule (naming, import order, file layout) |
| `pitfall`     | Gotcha that previously caused a failure |
| `tool-usage`  | Correct invocation of a specific tool or CLI |

---

## Action-Oriented WHAT (the test)

**GOOD (instruction):**
- `Use connection pooling with min=2, max=10 for PG in Node.js`
- `Cancel pending react-query requests on component unmount`
- `Run pytest with -p no:cacheprovider when fixture changes land`
- `Escape single quotes in PG jsonb ?| queries as %27`

**BAD (problem description — rewrite as instruction):**
- `PG connection pool exhausted` -> Use connection pooling with min=2, max=10 for PG in Node.js
- `Tests flaky on CI` -> Run pytest with -p no:cacheprovider when fixture changes land
- `XSS in product search` -> Escape user-controlled strings via DOMPurify before rendering product titles

---

## Examples by Agent Category

### Example 1 — Executor (backend)

```
D: Implemented PG connection pooling for the audit ingest worker. Verified under 50 concurrent requests with no timeouts.

LEARNING: Use connection pooling with min=2, max=10 for PG in Node.js
  WHAT: Use connection pooling with min=2, max=10 for PG in Node.js
  WHY: Prevents connection exhaustion under concurrent agent load; default pg driver opens 1 conn per query
  WHEN: Working with PG connection pools in Node.js services
  CATEGORY: pattern
  TAGS: postgresql, connection-pool, nodejs, backend
```

### Example 2 — Planner

```
D: Split Phase 14's plan into 3 waves after dependency analysis showed linearization blocked parallelism.

LEARNING: Split planning waves on dependency cuts, not file-count parity
  WHAT: Split planning waves on dependency cuts, not file-count parity
  WHY: Linear waves lose parallelism gains; DAG depth is the true minimum phase duration
  WHEN: Planning phases with 5+ tasks and shared-file concerns
  CATEGORY: process
  TAGS: planning, dependency-graph, parallelism
```

### Example 3 — Researcher / Checker

```
D: Creative variants on code tasks returned 3x rollback rate in JetBrains Junie Oct 2025 data.

LEARNING: Gate creative research variants behind task type, not a global flag
  WHAT: Gate creative research variants behind task type, not a global flag
  WHY: Implementation tasks get higher rollback rates from novel suggestions; research tasks benefit
  WHEN: Integrating Perplexity variant queries into the R-phase cascade
  CATEGORY: policy
  TAGS: research, perplexity, task-gating, pitfall
```

### Example 4 — Validator / Operator

```
D: Gate 2 LEARNING block check passed on 6/7 plans. The failure was a missing `LEARNING:` prefix (operator parser relies on it).

LEARNING: Always split on \nLEARNING: (newline-prefixed) to parse multiple D-phase learnings
  WHAT: Always split on \nLEARNING: (newline-prefixed) to parse multiple D-phase learnings
  WHY: Mid-sentence occurrences of the word LEARNING inside WHAT fields break naive split
  WHEN: Parsing multi-learning D-phase content in the operator
  CATEGORY: pitfall
  TAGS: parser, operator, d-phase, pitfall
```

---

## Tag Governance

Tags are validated against `get-shit-done/config/tag-rules.json` at both CLI and daemon layers (defense in depth).

- **Banned generic tags** are stripped before storage: `best-practice`, `general`, `lesson`, `insight`. A learning with ONLY banned tags is rejected with guidance pointing to the vocabulary.
- **Synonyms** are normalized: `db` -> `database`, `k8s` -> `kubernetes`, `ts` -> `typescript`, `py` -> `python`, etc.
- **Tag cap:** Maximum 5 tags. Over-limit tags are auto-trimmed by tier ranking: `domain > technique > scope > meta`. Learning is never rejected for tag count.
- **Vocabulary** is advisory. Pick from the 12 seed domains when possible, but free-form tags are accepted if not banned.

---

## Storage Layout (reference — implementers only)

Structured fields live in the existing `metadata jsonb` column of `gsd_memory`:
```
metadata = {
  "what": "Use connection pooling with min=2, max=10 for PG in Node.js",
  "why":  "Prevents connection exhaustion under concurrent agent load",
  "when": "Working with PG connection pools in Node.js services",
  "category": "pattern"
}
```

Tags live in the existing `tags jsonb` column (GIN-indexed). The full block remains in the `text` column for free-text + embedding recall.

---

## APPLIED_LEARNING Citations

When an agent applies a prior learning during RPETD, it MUST cite it:
```
APPLIED_LEARNING: mem-<12char-id> — <short reason it was applied>
```

Citations may appear in R, P, E, T, or D phase content. The operator scans all phases and dedupes by (mem_id, task_id) so the same learning cited in R-phase AND E-phase increments `applied_count` ONCE per task.

Once `applied_count > 10`, the learning is surfaced via `gsd-memory skb candidates` with `needs_review: true` — operator must call `gsd-memory skb-promote --reviewed` to clear the flag.
