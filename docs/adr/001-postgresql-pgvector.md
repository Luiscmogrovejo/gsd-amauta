# ADR-001: Use PostgreSQL with pgvector for Memory Storage

## Status

accepted

## Context

GSD-Amauta v2.0 required persistent storage for four categories of data:

1. **Agent memory** — text blobs and vector embeddings produced by the memory pipeline
2. **Task state** — RPETD phase logs, task lifecycle records, audit trail
3. **Shared knowledge** — SKB entries, learning records, cross-session context
4. **Blackboard** — shared communication channel between agents (Phase 38)

The storage solution must support:
- Semantic vector similarity search (embedding lookup by cosine distance)
- Full-text search over memory and SKB records
- Standard relational queries (task history, phase joins, audit logs)
- Docker Compose deployment without external cloud services
- SQL migrations as the schema change mechanism

GSD-Amauta is a single-developer project. Operational simplicity (one database to manage, back up, and monitor) outweighs raw throughput in this context. At v2.0 scale, the expected data volume is < 100K vectors.

## Decision

Use **PostgreSQL** with the **pgvector** extension for all persistent storage in GSD-Amauta.

Specific implementation details:
- Vector embeddings stored as `vector(1024)` columns (dimension standardized in migration 003)
- HNSW indexes on embedding columns for approximate nearest-neighbor (ANN) search
- GIN indexes for full-text search (BM25 scoring via ParadeDB planned for v2.9)
- Single PostgreSQL instance via Docker Compose (`postgres:16-alpine` image)
- Schema changes managed via numbered SQL migration files in `migrations/`
- pgvector installed via `CREATE EXTENSION IF NOT EXISTS vector` in migration 001

All relational data (tasks, phases, memory records, learnings) co-locate in the same database as the vector data. No separate service is required for search.

## Consequences

**Positive:**
- Single database to manage, back up, and monitor — reduces operational surface area
- pgvector HNSW indexes deliver fast ANN search sufficient for < 1M vectors
- No network hop between relational and vector queries — joins across embeddings and metadata are native SQL
- PostgreSQL is battle-tested; migrations are standard SQL understood by all contributors
- ParadeDB BM25 extension can be layered on top of the same instance for full-text search (v2.9 plan)
- Docker Compose deployment is fully self-contained — no cloud account required

**Negative:**
- pgvector has lower throughput than dedicated vector databases (Pinecone, Weaviate) at very large scale (> 10M vectors)
- Embedding dimension is locked at 1024 after migration 003 — changing it requires a full table migration
- Single-node PostgreSQL is not horizontally scalable; vertical scaling only
- HNSW index build time grows with dataset size — may require maintenance windows at scale

## Alternatives considered

- **Alternative 1: Separate vector database (Pinecone or Weaviate)**
  - Pros: Higher throughput and recall at large scale; purpose-built for vector workloads
  - Cons: Adds a second service to the Docker Compose stack; introduces network latency for every embedding lookup; requires separate backup and monitoring; incurs cloud cost (Pinecone) or additional setup (Weaviate self-hosted). Overkill for < 100K vectors in a single-developer project.

- **Alternative 2: SQLite with sqlite-vss**
  - Pros: Embedded database, zero operational overhead, no separate process
  - Cons: No concurrent write support (WAL mode only partially addresses this); limited extension ecosystem makes adding BM25 search difficult; would require migration to PostgreSQL eventually as the agent ecosystem grows. Technical debt front-loaded rather than deferred.

- **Alternative 3: ChromaDB**
  - Pros: Purpose-built for embeddings, simple Python API, local deployment available
  - Cons: Additional service to deploy alongside the main database; weak relational capabilities for task state and audit logs; smaller ecosystem; the agent blackboard (Phase 38) requires relational joins that ChromaDB cannot serve. Would still need a separate relational database, eliminating the single-database advantage.
