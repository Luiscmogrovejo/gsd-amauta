'use strict';
/**
 * @file User validation utilities — Phase 35 clean code fixture.
 * @description Passes all 10 gsd-reviewer detection rules.
 *   - < 500 lines total
 *   - All functions < 50 lines
 *   - <= 5 params per function
 *   - No duplicated blocks > 10 lines
 *   - JSDoc on all public functions
 *   - No unused imports
 *   - No circular dependencies
 *   - Consistent camelCase naming
 *   - Imports grouped correctly
 *   - Single concern (user validation)
 */

// stdlib
const { inspect } = require('node:util');

// internal
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates a user email address.
 * @param {string} email - The email address to validate.
 * @returns {boolean} True if the email is valid.
 */
function validateEmail(email) {
  if (typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Validates a username string.
 * @param {string} username - The username to validate.
 * @returns {{ valid: boolean, reason?: string }} Validation result.
 */
function validateUsername(username) {
  if (typeof username !== 'string') {
    return { valid: false, reason: 'Username must be a string' };
  }
  if (username.length < 3 || username.length > 30) {
    return { valid: false, reason: 'Username must be 3-30 characters' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, reason: 'Username may only contain letters, digits, and underscores' };
  }
  return { valid: true };
}

/**
 * Validates a full user registration payload.
 * @param {{ email: string, username: string, age: number }} payload - Registration data.
 * @returns {{ valid: boolean, errors: string[] }} Aggregated validation result.
 */
function validateRegistration(payload) {
  const errors = [];
  if (!validateEmail(payload.email)) {
    errors.push('Invalid email address');
  }
  const usernameResult = validateUsername(payload.username);
  if (!usernameResult.valid) {
    errors.push(usernameResult.reason);
  }
  if (typeof payload.age !== 'number' || payload.age < 13 || payload.age > 150) {
    errors.push('Age must be a number between 13 and 150');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Returns a debug-friendly string representation of a validation result.
 * @param {{ valid: boolean, errors: string[] }} result - Validation result to inspect.
 * @returns {string} Formatted debug string.
 */
function debugValidationResult(result) {
  return inspect(result, { depth: 2, colors: false });
}

module.exports = { validateEmail, validateUsername, validateRegistration, debugValidationResult };
