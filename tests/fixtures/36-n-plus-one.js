'use strict';
// @testing-only: Phase 36 N+1 query pattern fixture for gsd-executor-data testing.
// Contains deliberate anti-patterns: N+1 query, SELECT * without WHERE, missing JOIN.

const db = { query: async (sql, params) => ({ rows: [] }) }; // mock

/**
 * BAD: N+1 query pattern -- executes one query per tag inside a loop.
 * gsd-executor-data should flag this and suggest batch query with ANY/&&.
 * @param {string[]} tags - Tags to search for.
 * @returns {Promise<object[]>} Matching memory entries.
 */
async function searchByTagsNPlusOne(tags) {
  const results = [];
  for (const tag of tags) {
    // N+1: query inside loop -- each iteration hits the database
    const { rows } = await db.query(
      'SELECT * FROM gsd_memory WHERE tags @> $1',
      [JSON.stringify([tag])]
    );
    results.push(...rows);
  }
  return results;
}

/**
 * BAD: SELECT * without WHERE on a known-large table.
 * gsd-executor-data should flag sequential scan risk.
 * @returns {Promise<object[]>} All memory entries (unbounded).
 */
async function getAllMemories() {
  const { rows } = await db.query('SELECT * FROM gsd_memory');
  return rows;
}

/**
 * BAD: Missing JOIN condition -- cartesian product risk.
 * @returns {Promise<object[]>} Tasks with validations (missing ON clause).
 */
async function getTaskValidations() {
  const { rows } = await db.query(
    'SELECT * FROM gsd_tasks, gsd_task_validations'
  );
  return rows;
}

/**
 * GOOD: Proper batch query with parameterized IN clause.
 * This is what executor-data should SUGGEST as the fix for N+1.
 * @param {string[]} tags - Tags to search for.
 * @returns {Promise<object[]>} Matching memory entries.
 */
async function searchByTagsBatch(tags) {
  const { rows } = await db.query(
    'SELECT * FROM gsd_memory WHERE tags && $1::jsonb',
    [JSON.stringify(tags)]
  );
  return rows;
}

module.exports = {
  searchByTagsNPlusOne,
  getAllMemories,
  getTaskValidations,
  searchByTagsBatch,
};
