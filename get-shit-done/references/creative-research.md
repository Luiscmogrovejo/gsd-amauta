# Creative Research Query Techniques

**Purpose:** 5 query transformation techniques for R-phase creative research.
**Usage:** Researcher agent reads at R-phase start via Read tool when `--creative` is active.
**Note:** 8-word max per variant query (enforced by gsd-research.cjs).
**Note:** Creative mode only for research/exploration/architecture-review/pattern-search tasks.

## 1. Techniques

### 1. Inversion (always included)
- **Principle:** "Why does X fail?" reveals failure modes direct search misses.
- **Template:** `"{topic} failures common mistakes"`
- **Good:** `"rate limiting failures common mistakes"` (specific failure mode)
- **Bad:** `"what is rate limiting and how does it fail"` (too long, unfocused)

### 2. Anti-pattern (always included)
- **Principle:** Negative constraints reveal more than positive examples.
- **Template:** `"{topic} anti-patterns worst practices"`
- **Good:** `"connection pooling anti-patterns"` (actionable negatives)
- **Bad:** `"things you should not do with connection pooling because they are bad"` (verbose)

### 3. Lateral Analogy (third slot: architecture/design/frontend/testing domains)
- **Principle:** Solutions from analogous domains spark novel approaches.
- **Template:** `"natural systems analogy {topic}"`
- **Good:** `"TCP congestion control flow throttling"` (cross-domain insight)
- **Bad:** `"how are databases similar to other computer things"` (vague)

### 4. Cross-Domain Transfer (third slot: database/api/backend/caching domains)
- **Principle:** Compare competing solutions in adjacent domains.
- **Template:** `"alternative approaches {topic} tradeoffs"`
- **Good:** `"Kafka vs RabbitMQ message ordering"` (concrete comparison)
- **Bad:** `"how do different message queues compare to each other"` (too broad)

### 5. Constraint Removal (third slot: infrastructure/security/performance/deployment/monitoring/authentication domains)
- **Principle:** Removing constraints reveals ideal-state architecture.
- **Template:** `"unlimited resources approach {topic}"`
- **Good:** `"unlimited compute approach to encryption"` (reveals ideal)
- **Bad:** `"what if we had unlimited everything for security"` (meaningless)

## 2. Per-Domain Examples

### database
- Inversion: `"connection pool exhaustion failures mistakes"`
- Anti-pattern: `"database migration anti-patterns worst practices"`
- Cross-domain: `"Redis vs PostgreSQL caching tradeoffs"`

### api
- Inversion: `"REST API failures versioning mistakes"`
- Anti-pattern: `"GraphQL anti-patterns worst practices"`
- Cross-domain: `"gRPC vs REST streaming tradeoffs"`

### security
- Inversion: `"authentication failures bypass mistakes"`
- Anti-pattern: `"JWT anti-patterns worst practices"`
- Constraint removal: `"unlimited compute approach authentication"`

### frontend
- Inversion: `"React rendering performance failures mistakes"`
- Anti-pattern: `"CSS anti-patterns worst practices"`
- Lateral: `"natural systems analogy component state"`

### backend
- Inversion: `"microservices failures coordination mistakes"`
- Anti-pattern: `"Node.js async anti-patterns worst practices"`
- Cross-domain: `"Elixir vs Node.js concurrency tradeoffs"`

### infrastructure
- Inversion: `"Kubernetes deployment failures mistakes"`
- Anti-pattern: `"Docker anti-patterns worst practices"`
- Constraint removal: `"unlimited bandwidth approach service mesh"`

## 3. Rules

- 8-word max per variant query -- gsd-research.cjs truncates with warning if exceeded
- Always English for Perplexity queries regardless of original language
- 4 total queries when creative is on: 1 original + 3 variants
- Each variant runs reduced cascade independently: memory -> SKB -> Perplexity only
- No-novelty log emitted when all variants > 0.7 Jaccard similar to original results
