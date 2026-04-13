// @testing-only: deliberate SQL injection fixture for Phase 34 security tests
// This file is intentionally vulnerable — DO NOT use this pattern in production code.
// Semgrep rule gsd-raw-sql-injection and OWASP SQL injection rules should detect these patterns.

'use strict';

/**
 * VULNERABLE: Raw string interpolation in SQL query.
 * Semgrep rule gsd-raw-sql-injection should detect this.
 * @param {string} userId - untrusted user input
 */
function getUserById(userId) {
  // VULNERABLE: direct string interpolation — detectable by semgrep
  const query = `SELECT * FROM users WHERE id = '${userId}'`;
  return db.query(query);
}

/**
 * VULNERABLE: String concatenation in SQL.
 * @param {string} searchTerm - untrusted user input
 */
function searchUsers(searchTerm) {
  // VULNERABLE: concatenation — detectable by semgrep
  const query = "SELECT * FROM users WHERE name LIKE '%" + searchTerm + "%'";
  return db.query(query);
}

/**
 * VULNERABLE: Format-string SQL construction.
 * @param {string} tableName - untrusted user input
 * @param {string} columnValue - untrusted user input
 */
function findByColumn(tableName, columnValue) {
  // VULNERABLE: format-style construction — additional SQL injection vector
  const query = 'SELECT * FROM ' + tableName + ' WHERE value = \'' + columnValue + '\'';
  return db.query(query);
}

module.exports = { getUserById, searchUsers, findByColumn };
