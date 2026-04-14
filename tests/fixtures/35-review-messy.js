// @testing-only: Phase 35 messy code fixture for gsd-reviewer detection rule testing.
// Contains deliberate violations: long function, missing docs, naming inconsistency.
'use strict';

const os = require('node:os'); // unused import (dead code — info level finding)

const DATA_STATUSES = ['active', 'inactive', 'pending', 'archived', 'deleted'];

// VIOLATION: snake_case function name (naming inconsistency — warning)
// VIOLATION: function body is 57 lines long (long function — warning)
function process_all_records(records, options) {
  if (!Array.isArray(records)) {
    return { error: 'records must be an array', processed: [] };
  }
  const processed = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    if (!record || typeof record !== 'object') {
      errors.push({ index: i, reason: 'record is null or not an object' });
      continue;
    }

    if (!record.id || typeof record.id !== 'string') {
      errors.push({ index: i, reason: 'record.id missing or not a string' });
      continue;
    }

    if (!DATA_STATUSES.includes(record.status)) {
      skipped.push({ id: record.id, reason: `unknown status: ${record.status}` });
      continue;
    }

    if (record.status === 'deleted') {
      skipped.push({ id: record.id, reason: 'record is marked deleted' });
      continue;
    }

    const transformedRecord = {
      id: record.id,
      status: record.status,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      value: typeof record.value === 'number' ? record.value : 0,
      tags: Array.isArray(record.tags) ? record.tags.filter(t => typeof t === 'string') : [],
      processedAt: new Date().toISOString(),
    };

    if (options && options.enrichWithMeta) {
      transformedRecord.meta = {
        originalIndex: i,
        hasName: transformedRecord.name.length > 0,
        hasValue: transformedRecord.value !== 0,
        tagCount: transformedRecord.tags.length,
      };
    }

    if (options && options.filterInactive && record.status === 'inactive') {
      skipped.push({ id: record.id, reason: 'inactive records filtered by option' });
      continue;
    }

    processed.push(transformedRecord);
  }

  return {
    processed,
    skipped,
    errors,
    summary: {
      total: records.length,
      processedCount: processed.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
    },
  };
}

// VIOLATION: public function with NO JSDoc (missing documentation — warning)
function formatOutput(data, includeTimestamp) {
  if (!data || typeof data !== 'object') {
    return '[invalid data]';
  }
  const lines = [];
  if (includeTimestamp) {
    lines.push(`Timestamp: ${new Date().toISOString()}`);
  }
  if (data.summary) {
    lines.push(`Total: ${data.summary.total}`);
    lines.push(`Processed: ${data.summary.processedCount}`);
    lines.push(`Skipped: ${data.summary.skippedCount}`);
    lines.push(`Errors: ${data.summary.errorCount}`);
  }
  return lines.join('\n');
}

/**
 * Calculates metrics from a processing result object.
 * @param {{ summary: { total: number, processedCount: number, skippedCount: number, errorCount: number } }} result - Processing result.
 * @returns {{ successRate: number, errorRate: number, skipRate: number }} Calculated metrics.
 */
function calculateMetrics(result) {
  if (!result || !result.summary || result.summary.total === 0) {
    return { successRate: 0, errorRate: 0, skipRate: 0 };
  }
  const { total, processedCount, skippedCount, errorCount } = result.summary;
  return {
    successRate: Math.round((processedCount / total) * 100),
    errorRate: Math.round((errorCount / total) * 100),
    skipRate: Math.round((skippedCount / total) * 100),
  };
}

module.exports = { process_all_records, formatOutput, calculateMetrics };
