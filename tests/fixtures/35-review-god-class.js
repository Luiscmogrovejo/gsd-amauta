// @testing-only: Phase 35 god class fixture for gsd-reviewer detection rule testing.
// Contains deliberate violations: 500+ lines (god class), 4 unrelated concerns (SOLID).
// SOLID violation: MegaService handles authentication, logging, email, and data processing.
'use strict';

/**
 * MegaService handles authentication, logging, email sending, and data processing.
 * This is a deliberate SOLID violation — 4 unrelated concerns in a single class.
 */
class MegaService {
  constructor(config) {
    this.config = config || {};
    this.logs = [];
    this.emailQueue = [];
    this.sessions = new Map();
    this.dataCache = new Map();
  }

  // ── Authentication concern ──────────────────────────────────────────────────

  login(username, password) {
    if (!username || typeof username !== 'string') {
      throw new Error('Username must be a non-empty string');
    }
    if (!password || typeof password !== 'string') {
      throw new Error('Password must be a non-empty string');
    }
    const hashedPassword = this._hashPassword(password);
    if (hashedPassword !== this.config.users?.[username]) {
      return { success: false, reason: 'Invalid credentials' };
    }
    const token = this._generateToken(username);
    this.sessions.set(token, { username, createdAt: Date.now() });
    this.log('info', `User ${username} logged in`);
    return { success: true, token };
  }

  logout(token) {
    if (!this.sessions.has(token)) {
      return { success: false, reason: 'Session not found' };
    }
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    this.log('info', `User ${session.username} logged out`);
    return { success: true };
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'Token must be a string' };
    }
    const session = this.sessions.get(token);
    if (!session) {
      return { valid: false, reason: 'Token not found' };
    }
    const maxAge = this.config.sessionMaxAge || 3600000;
    if (Date.now() - session.createdAt > maxAge) {
      this.sessions.delete(token);
      return { valid: false, reason: 'Token expired' };
    }
    return { valid: true, username: session.username };
  }

  refreshToken(token) {
    const verification = this.verifyToken(token);
    if (!verification.valid) {
      return { success: false, reason: verification.reason };
    }
    const oldSession = this.sessions.get(token);
    this.sessions.delete(token);
    const newToken = this._generateToken(oldSession.username);
    this.sessions.set(newToken, { username: oldSession.username, createdAt: Date.now() });
    this.log('info', `Token refreshed for user ${oldSession.username}`);
    return { success: true, token: newToken };
  }

  _hashPassword(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
      hash = (hash << 5) - hash + password.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  _generateToken(username) {
    return `${username}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  changePassword(token, oldPassword, newPassword) {
    const verification = this.verifyToken(token);
    if (!verification.valid) {
      return { success: false, reason: 'Invalid or expired token' };
    }
    const { username } = verification;
    const oldHash = this._hashPassword(oldPassword);
    if (oldHash !== this.config.users?.[username]) {
      return { success: false, reason: 'Old password incorrect' };
    }
    if (!this.config.users) this.config.users = {};
    this.config.users[username] = this._hashPassword(newPassword);
    this.log('info', `Password changed for user ${username}`);
    return { success: true };
  }

  listSessions() {
    const result = [];
    for (const [token, session] of this.sessions.entries()) {
      result.push({
        token: token.slice(0, 8) + '...',
        username: session.username,
        age: Math.floor((Date.now() - session.createdAt) / 1000),
      });
    }
    return result;
  }

  // ── Logging concern ─────────────────────────────────────────────────────────

  log(level, message, context) {
    const entry = this._formatLogEntry(level, message, context);
    this.logs.push(entry);
    if (level === 'error') {
      process.stderr.write(JSON.stringify(entry) + '\n');
    } else {
      process.stdout.write(JSON.stringify(entry) + '\n');
    }
    return entry;
  }

  warn(message, context) {
    return this.log('warn', message, context);
  }

  error(message, context) {
    return this.log('error', message, context);
  }

  _formatLogEntry(level, message, context) {
    return {
      timestamp: new Date().toISOString(),
      level,
      service: this.config.serviceName || 'MegaService',
      message,
      context: context || null,
    };
  }

  getLogsByLevel(level) {
    if (!level) return this.logs.slice();
    return this.logs.filter(entry => entry.level === level);
  }

  clearLogs() {
    const count = this.logs.length;
    this.logs = [];
    return { cleared: count };
  }

  rotateLogs(maxEntries) {
    const max = maxEntries || 1000;
    if (this.logs.length > max) {
      const removed = this.logs.length - max;
      this.logs = this.logs.slice(-max);
      return { rotated: true, removed };
    }
    return { rotated: false, removed: 0 };
  }

  exportLogs(format) {
    if (format === 'json') {
      return JSON.stringify(this.logs, null, 2);
    }
    return this.logs.map(e =>
      `[${e.timestamp}] [${e.level.toUpperCase()}] ${e.service}: ${e.message}`
    ).join('\n');
  }

  // ── Email concern ───────────────────────────────────────────────────────────

  sendEmail(to, subject, body, options) {
    if (!to || typeof to !== 'string') {
      this.error('sendEmail: "to" must be a non-empty string', { to });
      return { success: false, reason: '"to" must be a non-empty string' };
    }
    if (!subject || typeof subject !== 'string') {
      this.error('sendEmail: "subject" must be a non-empty string', { subject });
      return { success: false, reason: '"subject" must be a non-empty string' };
    }
    if (!body || typeof body !== 'string') {
      this.error('sendEmail: "body" must be a non-empty string', { body });
      return { success: false, reason: '"body" must be a non-empty string' };
    }
    const message = {
      to,
      subject,
      body: this._formatEmailBody(body, options),
      sentAt: new Date().toISOString(),
      status: 'queued',
    };
    this.emailQueue.push(message);
    this.log('info', `Email queued to ${to}: ${subject}`);
    return { success: true, queued: true };
  }

  queueEmail(to, subject, body) {
    return this.sendEmail(to, subject, body, { queue: true });
  }

  processEmailQueue() {
    const results = [];
    while (this.emailQueue.length > 0) {
      const email = this.emailQueue.shift();
      try {
        email.status = 'sent';
        email.processedAt = new Date().toISOString();
        this.log('info', `Email sent to ${email.to}`);
        results.push({ to: email.to, success: true });
      } catch (err) {
        email.status = 'failed';
        email.error = err.message;
        this.error(`Email failed to ${email.to}`, { error: err.message });
        results.push({ to: email.to, success: false, reason: err.message });
      }
    }
    return results;
  }

  _formatEmailBody(body, options) {
    if (!options || !options.template) return body;
    const template = options.template;
    return template.replace(/\{\{body\}\}/g, body);
  }

  getEmailQueueLength() {
    return this.emailQueue.length;
  }

  flushEmailQueue() {
    const count = this.emailQueue.length;
    this.emailQueue = [];
    return { flushed: count };
  }

  // VIOLATION: method with 7 parameters (too many params — warning)
  sendBulkEmail(toList, subject, body, template, retryCount, delayMs, trackingEnabled) {
    if (!Array.isArray(toList) || toList.length === 0) {
      return { success: false, reason: 'toList must be a non-empty array' };
    }
    const results = [];
    for (const to of toList) {
      const opts = { template, retry: retryCount || 0, delay: delayMs || 0, tracking: trackingEnabled };
      const result = this.sendEmail(to, subject, body, opts);
      results.push({ to, ...result });
    }
    this.log('info', `Bulk email queued to ${toList.length} recipients`);
    return { success: true, results };
  }

  // ── Data Processing concern ─────────────────────────────────────────────────

  processRecords(records, schema) {
    if (!Array.isArray(records)) {
      this.error('processRecords: records must be an array');
      return { success: false, error: 'records must be an array', results: [] };
    }
    const results = [];
    const errors = [];
    for (const record of records) {
      try {
        const validated = this.validateInput(record, schema);
        if (!validated.valid) {
          errors.push({ record, reason: validated.errors.join(', ') });
          continue;
        }
        const transformed = this.transformData(record);
        results.push(transformed);
      } catch (err) {
        this.error('processRecords: error processing record', { error: err.message, record });
        errors.push({ record, reason: err.message });
      }
    }
    const metrics = this.aggregateResults(results);
    this.log('info', `processRecords: ${results.length} processed, ${errors.length} errors`);
    return { success: true, results, errors, metrics };
  }

  transformData(record) {
    if (!record || typeof record !== 'object') return {};
    const transformed = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') {
        transformed[key] = value.trim();
      } else if (typeof value === 'number') {
        transformed[key] = isFinite(value) ? value : 0;
      } else if (Array.isArray(value)) {
        transformed[key] = value.filter(v => v !== null && v !== undefined);
      } else {
        transformed[key] = value;
      }
    }
    transformed._transformedAt = new Date().toISOString();
    return transformed;
  }

  aggregateResults(results) {
    if (!Array.isArray(results) || results.length === 0) {
      return { count: 0, hasData: false };
    }
    const numericFields = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === 'number') {
          if (!numericFields[key]) numericFields[key] = { sum: 0, count: 0 };
          numericFields[key].sum += value;
          numericFields[key].count++;
        }
      }
    }
    const averages = {};
    for (const [key, stats] of Object.entries(numericFields)) {
      averages[key] = stats.count > 0 ? stats.sum / stats.count : 0;
    }
    return { count: results.length, hasData: true, averages };
  }

  validateInput(data, schema) {
    const errors = [];
    if (!schema || typeof schema !== 'object') {
      return { valid: true, errors: [] };
    }
    for (const [field, rules] of Object.entries(schema)) {
      const value = data?.[field];
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`Field "${field}" is required`);
        continue;
      }
      if (value === undefined || value === null) continue;
      if (rules.type && typeof value !== rules.type) {
        errors.push(`Field "${field}" must be of type ${rules.type}, got ${typeof value}`);
      }
      if (rules.minLength && typeof value === 'string' && value.length < rules.minLength) {
        errors.push(`Field "${field}" must be at least ${rules.minLength} characters`);
      }
      if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
        errors.push(`Field "${field}" must be at most ${rules.maxLength} characters`);
      }
      if (rules.min && typeof value === 'number' && value < rules.min) {
        errors.push(`Field "${field}" must be >= ${rules.min}`);
      }
      if (rules.max && typeof value === 'number' && value > rules.max) {
        errors.push(`Field "${field}" must be <= ${rules.max}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  cacheRecord(key, value, ttlMs) {
    const expiry = ttlMs ? Date.now() + ttlMs : null;
    this.dataCache.set(key, { value, expiry, cachedAt: Date.now() });
    return { cached: true, key };
  }

  getCachedRecord(key) {
    const entry = this.dataCache.get(key);
    if (!entry) return { found: false };
    if (entry.expiry && Date.now() > entry.expiry) {
      this.dataCache.delete(key);
      return { found: false, reason: 'expired' };
    }
    return { found: true, value: entry.value, age: Date.now() - entry.cachedAt };
  }

  evictExpiredCache() {
    let evicted = 0;
    for (const [key, entry] of this.dataCache.entries()) {
      if (entry.expiry && Date.now() > entry.expiry) {
        this.dataCache.delete(key);
        evicted++;
      }
    }
    return { evicted };
  }

  // VIOLATION: long method (~55 lines — long function warning)
  bulkProcessAndCache(records, schema, cacheOptions) {
    if (!Array.isArray(records) || records.length === 0) {
      this.warn('bulkProcessAndCache: no records to process');
      return { success: false, reason: 'no records provided', results: [] };
    }
    const ttl = cacheOptions?.ttlMs || 300000;
    const prefix = cacheOptions?.keyPrefix || 'rec';
    const results = [];
    const cached = [];
    const errors = [];
    let cacheHits = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const cacheKey = `${prefix}-${record?.id || i}`;
      const hit = this.getCachedRecord(cacheKey);

      if (hit.found) {
        cacheHits++;
        results.push(hit.value);
        cached.push(cacheKey);
        continue;
      }

      try {
        const validated = this.validateInput(record, schema);
        if (!validated.valid) {
          errors.push({ index: i, id: record?.id, reason: validated.errors.join('; ') });
          this.warn(`bulkProcessAndCache: validation failed for record ${i}`, { errors: validated.errors });
          continue;
        }

        const transformed = this.transformData(record);
        this.cacheRecord(cacheKey, transformed, ttl);
        results.push(transformed);
      } catch (err) {
        errors.push({ index: i, id: record?.id, reason: err.message });
        this.error('bulkProcessAndCache: unexpected error', { index: i, error: err.message });
      }
    }

    const metrics = this.aggregateResults(results);
    this.log('info', `bulkProcessAndCache complete: ${results.length} processed, ${cacheHits} cache hits, ${errors.length} errors`);

    return {
      success: true,
      results,
      errors,
      metrics,
      cacheStats: {
        hits: cacheHits,
        misses: results.length - cacheHits,
        newlyCached: cached.length,
      },
    };
  }

  clearDataCache() {
    const count = this.dataCache.size;
    this.dataCache.clear();
    return { cleared: count };
  }

  getCacheStats() {
    let expired = 0;
    let active = 0;
    for (const entry of this.dataCache.values()) {
      if (entry.expiry && Date.now() > entry.expiry) {
        expired++;
      } else {
        active++;
      }
    }
    return { total: this.dataCache.size, active, expired };
  }

  paginateResults(results, page, pageSize) {
    if (!Array.isArray(results)) return { data: [], total: 0, page: 1, pageSize };
    const size = pageSize || 20;
    const currentPage = page || 1;
    const start = (currentPage - 1) * size;
    const end = start + size;
    return {
      data: results.slice(start, end),
      total: results.length,
      page: currentPage,
      pageSize: size,
      totalPages: Math.ceil(results.length / size),
    };
  }

  sortResults(results, field, direction) {
    if (!Array.isArray(results) || results.length === 0) return [];
    const dir = direction === 'desc' ? -1 : 1;
    return results.slice().sort((a, b) => {
      if (a[field] < b[field]) return -1 * dir;
      if (a[field] > b[field]) return 1 * dir;
      return 0;
    });
  }

  filterResults(results, predicate) {
    if (!Array.isArray(results)) return [];
    if (typeof predicate !== 'function') return results.slice();
    return results.filter(predicate);
  }

  // ── Additional auth helpers ──────────────────────────────────────────────────

  hasPermission(token, permission) {
    const verification = this.verifyToken(token);
    if (!verification.valid) return false;
    const userPerms = this.config.permissions?.[verification.username] || [];
    return userPerms.includes(permission) || userPerms.includes('admin');
  }

  revokeAllSessions(username) {
    let revoked = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === username) {
        this.sessions.delete(token);
        revoked++;
      }
    }
    this.log('info', `Revoked ${revoked} sessions for user ${username}`);
    return { revoked };
  }

  // ── Additional email helpers ─────────────────────────────────────────────────

  getEmailQueueSnapshot() {
    return this.emailQueue.map(email => ({
      to: email.to,
      subject: email.subject,
      status: email.status,
      sentAt: email.sentAt,
    }));
  }

  retryFailedEmails() {
    const failed = this.emailQueue.filter(e => e.status === 'failed');
    for (const email of failed) {
      email.status = 'queued';
      email.retried = true;
    }
    return { retried: failed.length };
  }
}

module.exports = { MegaService };
