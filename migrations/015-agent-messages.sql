-- GSD-Amauta Migration 015: Agent messages blackboard table (COMM-02)
-- Phase 38: Blackboard Communication
-- Creates agent_messages table for structured inter-agent communication.
-- Operator supervision gates ASK_QUESTION and DELEGATE_SUBTASK message types.
-- SHARE_FINDING and REQUEST_REVIEW are auto-approved (informational / advisory).

BEGIN;

-- COMM-02: Agent messages blackboard table.
-- Agents send typed messages to each other via this table.
-- Operator reads pending messages during normal orchestration loop.
CREATE TABLE agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent VARCHAR(64) NOT NULL,
  to_agent VARCHAR(64) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  message_type VARCHAR(32) NOT NULL, -- 'ASK_QUESTION', 'SHARE_FINDING', 'REQUEST_REVIEW', 'DELEGATE_SUBTASK'
  content TEXT NOT NULL,
  response TEXT,
  status VARCHAR(16) DEFAULT 'pending', -- 'pending', 'approved', 'denied', 'responded'
  operator_approved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

-- Primary lookup: retrieve all messages for a task in chronological order.
CREATE INDEX idx_messages_task ON agent_messages(task_id);

-- Inbox lookup: retrieve pending/approved messages for a recipient agent.
CREATE INDEX idx_messages_to ON agent_messages(to_agent, status);

COMMIT;
