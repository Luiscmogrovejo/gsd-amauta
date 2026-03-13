-- GSD-Amauta PostgreSQL Schema v1
-- Auto-runs on first docker compose up via /docker-entrypoint-initdb.d/

-- Enable pgvector for future embedding support
CREATE EXTENSION IF NOT EXISTS vector;

-- ═══════════════════════════════════════════════════════
-- gsd_memory — Persistent memory across sessions/projects
-- Source-aware scoring from Amauta implementation:
--   auto_learning +3, lesson-learned +4, best-practice +4,
--   web_search_result +3, session-learning +3,
--   distilled +2, rpetd_phase +1, task_event +0
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gsd_memory (
    id          VARCHAR(64) PRIMARY KEY DEFAULT 'mem-' || substr(md5(random()::text), 1, 12),
    text        TEXT NOT NULL,
    agent_id    VARCHAR(64),
    source      VARCHAR(64) DEFAULT 'agent',
    -- sources: agent, task_event, rpetd_phase, auto_learning,
    --          web_search_result, lesson-learned, best-practice,
    --          session-learning, distilled
    tags        JSONB DEFAULT '[]'::jsonb,
    metadata    JSONB DEFAULT '{}'::jsonb,
    project_id  VARCHAR(128),
    embedding   vector(1024),  -- semantic search via Voyage AI or OpenAI (1024 dims)
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gsd_memory_project ON gsd_memory(project_id);
CREATE INDEX IF NOT EXISTS idx_gsd_memory_source ON gsd_memory(source);
CREATE INDEX IF NOT EXISTS idx_gsd_memory_agent ON gsd_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_gsd_memory_tags ON gsd_memory USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_gsd_memory_created ON gsd_memory(created_at DESC);

-- ═══════════════════════════════════════════════════════
-- gsd_shared_kb — Shared Knowledge Base
-- Validated patterns, best practices, project-agnostic knowledge
-- Promoted from gsd_memory on validation pass
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gsd_shared_kb (
    id          VARCHAR(64) PRIMARY KEY DEFAULT 'skb-' || substr(md5(random()::text), 1, 12),
    title       VARCHAR(512) NOT NULL,
    content     TEXT NOT NULL,
    category    VARCHAR(64),
    -- categories: workflow, process, delivery, pattern, policy,
    --             architecture, convention, pitfall, tool-usage
    agent_id    VARCHAR(64),
    tags        JSONB DEFAULT '[]'::jsonb,
    importance  INTEGER DEFAULT 5 CHECK (importance >= 1 AND importance <= 10),
    source_task VARCHAR(16),  -- TK-XXXX that generated this knowledge
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gsd_skb_category ON gsd_shared_kb(category);
CREATE INDEX IF NOT EXISTS idx_gsd_skb_tags ON gsd_shared_kb USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_gsd_skb_importance ON gsd_shared_kb(importance DESC);

-- ═══════════════════════════════════════════════════════
-- gsd_tasks — Task manager (replaces tasks.json when PG available)
-- Full RPETD inline, priority scoring, hierarchy, evidence
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gsd_tasks (
    id               VARCHAR(16) PRIMARY KEY,   -- TK-0001, BG-0001, EP-0001, ST-0001
    project_id       VARCHAR(128) NOT NULL DEFAULT 'default',
    type             VARCHAR(16) DEFAULT 'task'
                     CHECK (type IN ('epic', 'story', 'task', 'bug')),
    title            VARCHAR(512) NOT NULL,
    description      TEXT,
    details          TEXT,
    status           VARCHAR(32) DEFAULT 'pending'
                     CHECK (status IN ('pending', 'in-progress', 'validation', 'done', 'failed', 'deferred')),
    priority         VARCHAR(16) DEFAULT 'medium'
                     CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    assigned_to      VARCHAR(64) DEFAULT 'unassigned',
    claimed_by       VARCHAR(64),
    claimed_at       TIMESTAMPTZ,

    -- GSD phase/plan tracking
    phase            VARCHAR(16),
    plan             VARCHAR(16),

    -- RPETD inline work log
    rpetd_r          TEXT,  -- Research
    rpetd_p          TEXT,  -- Plan
    rpetd_e          TEXT,  -- Execute
    rpetd_t          TEXT,  -- Test
    rpetd_d          TEXT,  -- Document
    rpetd_complete   BOOLEAN DEFAULT FALSE,

    -- Priority scoring: (importance*0.4) + (urgency*0.3) + (dep_pressure*0.3)
    importance       INTEGER DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
    urgency          INTEGER DEFAULT 3 CHECK (urgency >= 1 AND urgency <= 5),

    -- Acceptance criteria & deliverables
    success_criteria JSONB DEFAULT '[]'::jsonb,
    test_strategy    TEXT,
    deliverables     JSONB DEFAULT '[]'::jsonb,

    -- Validation
    validation_notes TEXT,
    validated_by     VARCHAR(64),

    -- Hierarchy & dependencies
    parent_id        VARCHAR(16),
    dependencies     JSONB DEFAULT '[]'::jsonb,

    -- Evidence & outcomes
    evidence         JSONB DEFAULT '{}'::jsonb,
    outcome          VARCHAR(32),
    lesson           TEXT,

    -- Tags & metadata
    tags             JSONB DEFAULT '[]'::jsonb,
    notes            JSONB DEFAULT '[]'::jsonb,  -- timestamped note array

    -- Timestamps
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gsd_tasks_project ON gsd_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_status ON gsd_tasks(status);
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_assigned ON gsd_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_type ON gsd_tasks(type);
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_parent ON gsd_tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_priority ON gsd_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_tags ON gsd_tasks USING gin(tags);

-- ═══════════════════════════════════════════════════════
-- gsd_task_validations — Validation audit trail
-- Every pass/fail is recorded with evidence
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gsd_task_validations (
    id               SERIAL PRIMARY KEY,
    task_id          VARCHAR(16) NOT NULL REFERENCES gsd_tasks(id) ON DELETE CASCADE,
    validator_id     VARCHAR(64) NOT NULL,
    status           VARCHAR(32) NOT NULL
                     CHECK (status IN ('approved', 'rejected')),
    evidence         JSONB DEFAULT '{}'::jsonb,
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gsd_validations_task ON gsd_task_validations(task_id);
CREATE INDEX IF NOT EXISTS idx_gsd_validations_status ON gsd_task_validations(status);

-- ═══════════════════════════════════════════════════════
-- Updated_at trigger (auto-update on any row change)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_gsd_memory_updated') THEN
        CREATE TRIGGER trg_gsd_memory_updated BEFORE UPDATE ON gsd_memory
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_gsd_skb_updated') THEN
        CREATE TRIGGER trg_gsd_skb_updated BEFORE UPDATE ON gsd_shared_kb
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_gsd_tasks_updated') THEN
        CREATE TRIGGER trg_gsd_tasks_updated BEFORE UPDATE ON gsd_tasks
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END $$;
