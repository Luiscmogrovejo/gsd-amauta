# Migration Guide: Vanilla GSD to GSD-Amauta

## Overview

GSD-Amauta is a superset of vanilla GSD. Your existing `.planning/` directory, slash commands, and workflows continue to work. The migration adds PostgreSQL memory, task management, and enhanced agents.

## Prerequisites

Before migrating:
- Docker installed and running
- Python 3.9+ with pip
- Node.js 18+
- Existing GSD project (optional — works for new projects too)

## Step 1: Backup

```bash
# Backup your existing GSD installation
cp -r ~/.claude/get-shit-done ~/.claude/get-shit-done-backup

# Backup any project's .planning/ directory
cp -r .planning .planning-backup
```

## Step 2: Install GSD-Amauta

```bash
# Replace GSD with GSD-Amauta
cd ~/.claude
mv get-shit-done get-shit-done-vanilla  # keep vanilla as reference
git clone <repo-url> gsd-amauta

# Run installer
cd gsd-amauta
npm install
```

The installer will:
1. Install standard GSD agents, workflows, commands, and hooks
2. Start PostgreSQL (Docker) on port 5433
3. Install psycopg2-binary
4. Start the Amauta daemon on port 18799
5. Start the RLM service on port 18798

## Step 3: Configure Environment

Add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
# Required for PG memory
export GSD_POSTGRES_URL="postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta"

# Optional: Perplexity research
export PERPLEXITY_API_KEY="your-key-here"

# Optional: Semantic search — choose one (Voyage AI recommended)
export VOYAGE_API_KEY="your-key-here"     # Recommended (Anthropic partner, voyage-code-3)
# OR
export OPENAI_API_KEY="your-key-here"     # Alternative (text-embedding-3-small)

# Optional: Force a specific embedding provider
# export GSD_EMBEDDING_PROVIDER=voyage    # or "openai"
```

**Embedding provider selection**: The system auto-detects which provider to use:
1. If `VOYAGE_API_KEY` is set → uses **Voyage AI `voyage-code-3`** (optimized for code retrieval, Anthropic-recommended)
2. If only `OPENAI_API_KEY` is set → uses **OpenAI `text-embedding-3-small`**
3. If neither is set → falls back to PostgreSQL full-text search (keyword-based, still functional)

Override auto-detection with `GSD_EMBEDDING_PROVIDER=voyage|openai`. Both providers produce 1024-dimension vectors.

## Step 4: Verify Installation

```bash
# Check all services
curl -s http://127.0.0.1:18799/health | python3 -m json.tool  # daemon
curl -s http://127.0.0.1:18798/health | python3 -m json.tool  # RLM
docker ps --filter name=gsd-postgres                            # PG

# Check CLI tools
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-amauta.cjs stats
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-memory.cjs health
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-rlm.cjs health
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-research.cjs check-providers

# Run tests
cd ~/.claude/gsd-amauta && npm test
```

Expected: all health checks return `"status": "ok"`, 583 tests pass.

## Step 5: Apply Database Migrations

If upgrading from an earlier version:

```bash
# Migration 002: HNSW index for semantic search
psql "$GSD_POSTGRES_URL" -f ~/.claude/gsd-amauta/migrations/002-embedding-index.sql

# Migration 003: Standardize embeddings to 1024 dimensions (Voyage AI + OpenAI)
# WARNING: Clears existing embeddings — re-run backfill after
psql "$GSD_POSTGRES_URL" -f ~/.claude/gsd-amauta/migrations/003-embedding-1024.sql
```

## Step 6: Backfill Embeddings (Optional)

If you have existing memories and want semantic search:

```bash
# Check current embedding coverage and active provider
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-memory.cjs embedding-stats

# Backfill all memories without embeddings (requires VOYAGE_API_KEY or OPENAI_API_KEY)
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-memory.cjs backfill-embeddings

# Test semantic search
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-memory.cjs semantic-search "how to handle auth errors"
```

## Step 7: Migrate Existing Projects

For existing projects with `.planning/` directories:

1. **No migration needed** — GSD-Amauta reads the same `.planning/` structure
2. **Optional**: Import learnings from STATE.md into PG memory:

```bash
# From your project directory, import existing learnings
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-memory.cjs learn "$(cat .planning/STATE.md)"
```

3. **Optional**: Create a task board for your project:

```bash
export AMAUTA_DATA_DIR=$(pwd)/data
mkdir -p data
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-amauta.cjs exec add epic "My Project" --agent operator
```

## Verification Checklist

After migration, verify:

- [ ] `docker ps` shows `gsd-postgres` container running
- [ ] Daemon health returns `"status": "ok"` with `"pg_available": true`
- [ ] RLM health returns `"status": "ok"`
- [ ] `gsd-memory.cjs count` returns a number (0 is fine for new install)
- [ ] `/amauta:new-project` slash command works in Claude Code
- [ ] Existing `.planning/` files are readable
- [ ] `npm test` passes all tests

## Rollback Procedure

If you need to revert to vanilla GSD:

```bash
# Stop GSD-Amauta services
docker compose -f ~/.claude/gsd-amauta/docker/docker-compose.yml down
python3 ~/.claude/gsd-amauta/services/amauta-daemon.py stop
python3 ~/.claude/gsd-amauta/services/rlm-service.py stop

# Restore vanilla GSD
cd ~/.claude
rm -rf gsd-amauta
mv get-shit-done-vanilla get-shit-done  # or restore from backup

# Remove env vars from shell profile
# (remove GSD_POSTGRES_URL, PERPLEXITY_API_KEY lines)
```

Your `.planning/` directories are untouched — vanilla GSD will work with them immediately.

## FAQ

### Can I use GSD-Amauta without Docker/PostgreSQL?

Yes. GSD-Amauta degrades gracefully to vanilla GSD behavior. Without PG:
- Memory uses `.planning/memory/*.md` files and `STATE.md`
- Task management uses `data/tasks.json` (file-based)
- All slash commands and workflows work normally

### Do I need to change my Claude Code configuration?

No. GSD-Amauta installs to the same `~/.claude/` locations. Claude Code picks it up automatically.

### What about my existing agents/hooks/commands?

They continue to work. GSD-Amauta adds new agents (10 total) but does not remove your custom additions.

### Will Perplexity cost money?

Yes, Perplexity API calls cost money. Without `PERPLEXITY_API_KEY`, the research chain skips Perplexity and uses other providers (memory, SKB, Context7).

### How much disk space does PostgreSQL use?

The Docker volume starts at ~100MB. Memory entries are small (text + metadata). Even with thousands of entries, expect under 500MB.

### Can I run GSD-Amauta alongside vanilla GSD?

Not recommended — they share the same `~/.claude/` agent paths. Use one or the other.
