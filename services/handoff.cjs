'use strict';
/**
 * Handoff utility — structured handoff JSON generation with 800-token budget enforcement.
 *
 * Phase 38: Blackboard Communication (COMM-04)
 * Produces handoff JSON matching the canonical schema. Enforces the 800-token
 * soft limit at the sender by truncating findings to the 5 highest-confidence
 * items and shortening the summary to 200 chars when the budget is exceeded.
 *
 * @example
 *   const { createHandoff } = require('./services/handoff.cjs');
 *   const h = createHandoff({
 *     task_id: 'TK-001',
 *     from_agent: 'executor-backend',
 *     handoff_type: 'phase_complete',
 *     summary: 'Migration 014 created and committed.',
 *     key_findings: [{ text: 'Index idx_findings_task present.', confidence: 0.95 }],
 *   });
 */

const TOKEN_BUDGET = 800;
const MAX_KEY_FINDINGS = 5;
const MAX_SUMMARY_CHARS = 200;
const MAX_FINDING_TEXT_CHARS = 100;
const MAX_DECISIONS = 3;
const MAX_QUESTIONS = 3;

const VALID_HANDOFF_TYPES = ['phase_complete', 'subtask_complete', 'escalation'];

/**
 * Estimate token count for a string using whitespace-split heuristic.
 * Accurate enough for budget enforcement without an external tokenizer.
 *
 * @param {string} text - Input text to estimate.
 * @returns {number} Estimated token count.
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Whitespace-split: each whitespace-delimited chunk ~ 1 token.
  // Adds 15% overhead to account for punctuation splitting.
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.ceil(words.length * 1.15);
}

/**
 * Sort findings by confidence descending and keep the top maxCount.
 *
 * @param {Array<{text: string, confidence?: number}>} findings - Findings to truncate.
 * @param {number} maxCount - Maximum number of findings to keep.
 * @returns {Array<{text: string, confidence: number}>} Truncated findings sorted by confidence.
 */
function truncateFindings(findings, maxCount) {
  if (!Array.isArray(findings)) return [];
  const normalized = findings.map((f) => ({
    text: typeof f === 'string' ? f : (f.text || ''),
    confidence: typeof f === 'object' && f !== null ? (f.confidence != null ? f.confidence : 0.8) : 0.8,
  }));
  const sorted = normalized.slice().sort((a, b) => b.confidence - a.confidence);
  return sorted.slice(0, maxCount);
}

/**
 * Build a structured handoff JSON object enforcing the 800-token budget.
 *
 * When estimated tokens exceed TOKEN_BUDGET, the function:
 *   1. Truncates key_findings to the 5 highest-confidence items.
 *   2. Clips summary to MAX_SUMMARY_CHARS characters.
 *   3. Sets full_context_ref if a PG record ID is provided, so receivers
 *      can retrieve the full context from the database.
 *
 * @param {object} options - Handoff parameters.
 * @param {string} options.task_id - The task being handed off.
 * @param {string} options.from_agent - Name of the sending agent.
 * @param {'phase_complete'|'subtask_complete'|'escalation'} options.handoff_type - Handoff category.
 * @param {string} [options.summary=''] - Short summary of work done (<=200 chars after truncation).
 * @param {Array<{text: string, confidence?: number}|string>} [options.key_findings=[]] - Findings to share.
 * @param {string[]} [options.decisions_made=[]] - Key decisions made (<=3 items).
 * @param {string[]} [options.open_questions=[]] - Open questions for next agent (<=3 items).
 * @param {string[]} [options.artifacts=[]] - File paths produced.
 * @param {number} [options.confidence=0.8] - Overall handoff confidence (0.0-1.0).
 * @param {string} [options.full_context_ref=''] - PG record ID for full context retrieval.
 * @returns {{ handoff: object, truncated: boolean, estimated_tokens: number }} Result object.
 * @throws {Error} When required fields are missing or handoff_type is invalid.
 */
function createHandoff(options) {
  const {
    task_id,
    from_agent,
    handoff_type,
    summary = '',
    key_findings = [],
    decisions_made = [],
    open_questions = [],
    artifacts = [],
    confidence = 0.8,
    full_context_ref = '',
  } = options || {};

  // Required field validation
  if (!task_id) throw new Error('task_id is required');
  if (!from_agent) throw new Error('from_agent is required');
  if (!handoff_type) throw new Error('handoff_type is required');
  if (!VALID_HANDOFF_TYPES.includes(handoff_type)) {
    throw new Error(`handoff_type must be one of: ${VALID_HANDOFF_TYPES.join(', ')}`);
  }

  // Normalize findings to {text, confidence} objects
  let normalizedFindings = truncateFindings(key_findings, key_findings.length);
  // Clip individual finding texts to MAX_FINDING_TEXT_CHARS
  normalizedFindings = normalizedFindings.map((f) => ({
    ...f,
    text: f.text.slice(0, MAX_FINDING_TEXT_CHARS),
  }));

  // Cap list sizes per schema
  const cappedDecisions = (Array.isArray(decisions_made) ? decisions_made : []).slice(0, MAX_DECISIONS);
  const cappedQuestions = (Array.isArray(open_questions) ? open_questions : []).slice(0, MAX_QUESTIONS);

  // Build candidate JSON for token estimation
  let candidateSummary = String(summary || '').slice(0, MAX_SUMMARY_CHARS);
  let candidateFindings = normalizedFindings.slice(0, MAX_KEY_FINDINGS);

  const candidateHandoff = {
    task_id: String(task_id),
    from_agent: String(from_agent),
    handoff_type,
    summary: candidateSummary,
    key_findings: candidateFindings.map((f) => f.text),
    decisions_made: cappedDecisions,
    open_questions: cappedQuestions,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    confidence: Math.max(0.0, Math.min(1.0, Number(confidence) || 0.8)),
    full_context_ref: String(full_context_ref || ''),
  };

  const candidateJson = JSON.stringify(candidateHandoff);
  const estimatedTokens = estimateTokens(candidateJson);
  let truncated = false;

  // Enforce 800-token budget
  if (estimatedTokens > TOKEN_BUDGET) {
    truncated = true;
    // Keep top-5 highest-confidence findings only
    candidateFindings = truncateFindings(normalizedFindings, MAX_KEY_FINDINGS);
    // Clip summary to 200 chars
    candidateSummary = candidateSummary.slice(0, MAX_SUMMARY_CHARS);
    candidateHandoff.key_findings = candidateFindings.map((f) => f.text);
    candidateHandoff.summary = candidateSummary;
  }

  return {
    handoff: candidateHandoff,
    truncated,
    estimated_tokens: estimatedTokens,
  };
}

module.exports = { createHandoff, estimateTokens };
