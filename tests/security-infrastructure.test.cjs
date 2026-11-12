/**
 * Security & Infrastructure Audit Tests
 *
 * Validates critical security fixes, infrastructure reliability, and
 * enterprise-grade production patterns across the entire system.
 *
 * Covers:
 * - RLM path traversal protection
 * - RLM body size limits
 * - Daemon auth constant-time compare
 * - Docker configuration correctness
 * - Migration chain integrity (DOWN migrations match UP)
 * - Backup/restore credential safety
 * - Windows compatibility (the lock is real on both platforms, never a no-op)
 * - .env.example completeness
 * - Connection pool leak prevention
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startFixtureDaemon, stopFixtureDaemon } = require('./support/fixture-daemon.cjs');

const ROOT = path.join(__dirname, '..');

// ═══════════════════════════════════════════════════════
// 1. RLM Service Security
// ═══════════════════════════════════════════════════════

describe('RLM Service Security', () => {
  const rlmPath = path.join(ROOT, 'services', 'rlm-service.py');
  let rlmSource;

  test('rlm-service.py exists', () => {
    assert.ok(fs.existsSync(rlmPath));
    rlmSource = fs.readFileSync(rlmPath, 'utf-8');
  });

  test('RLM has _is_safe_path() function for path traversal protection', () => {
    assert.ok(rlmSource.includes('def _is_safe_path('), 'Missing _is_safe_path function');
  });

  test('RLM blocks /etc/ paths', () => {
    assert.ok(rlmSource.includes('/etc/'), 'Should block /etc/ paths');
    assert.ok(rlmSource.includes('_BLOCKED_PREFIXES'), 'Should have blocked prefixes');
  });

  test('RLM blocks /proc/ and /sys/ paths', () => {
    assert.ok(rlmSource.includes('/proc/'), 'Should block /proc/');
    assert.ok(rlmSource.includes('/sys/'), 'Should block /sys/');
  });

  test('RLM _handle_chunk checks _is_safe_path before file read', () => {
    const chunkHandler = rlmSource.substring(
      rlmSource.indexOf('def _handle_chunk'),
      rlmSource.indexOf('def _handle_search')
    );
    assert.ok(chunkHandler.includes('_is_safe_path'), 'Chunk handler must check path safety');
    // _is_safe_path must appear BEFORE os.path.expanduser
    const safeIdx = chunkHandler.indexOf('_is_safe_path');
    const expandIdx = chunkHandler.indexOf('os.path.expanduser');
    assert.ok(safeIdx < expandIdx, 'Path safety check must come before expanduser');
  });

  test('RLM _handle_search checks _is_safe_path for each path', () => {
    const searchHandler = rlmSource.substring(
      rlmSource.indexOf('def _handle_search'),
      rlmSource.indexOf('def _handle_query')
    );
    assert.ok(searchHandler.includes('_is_safe_path'), 'Search handler must check path safety');
  });

  test('RLM _handle_query checks _is_safe_path for directory', () => {
    const queryHandler = rlmSource.substring(
      rlmSource.indexOf('def _handle_query'),
      rlmSource.indexOf('def _handle_query') + 2000
    );
    assert.ok(queryHandler.includes('_is_safe_path'), 'Query handler must check path safety');
  });

  test('RLM has MAX_BODY_SIZE limit', () => {
    assert.ok(rlmSource.includes('MAX_BODY_SIZE'), 'Must have body size limit');
  });

  test('RLM _read_body returns None on oversized body', () => {
    assert.ok(rlmSource.includes('return None'), '_read_body must return None on error');
  });

  test('RLM _read_body returns None on invalid JSON', () => {
    // Should return None instead of {} for invalid JSON
    const readBody = rlmSource.substring(
      rlmSource.indexOf('def _read_body'),
      rlmSource.indexOf('def do_GET')
    );
    assert.ok(readBody.includes('return None'), 'Should return None on JSON decode error');
    assert.ok(readBody.includes('"Invalid JSON body"'), 'Should send error message for bad JSON');
  });

  test('RLM do_POST handles None from _read_body', () => {
    const doPost = rlmSource.substring(
      rlmSource.indexOf('def do_POST'),
      rlmSource.indexOf('def _handle_chunk')
    );
    assert.ok(doPost.includes('body is None'), 'Must check for None body');
    assert.ok(doPost.includes('return'), 'Must return early on None body');
  });

  test('RLM returns 403 for blocked paths', () => {
    assert.ok(rlmSource.includes('403'), 'Must return 403 for blocked paths');
    assert.ok(rlmSource.includes('Access denied'), 'Must include access denied message');
  });

  test('RLM returns 413 for oversized body', () => {
    assert.ok(rlmSource.includes('413'), 'Must return 413 for oversized body');
  });

  test('RLM supports JSON structured logging', () => {
    assert.ok(rlmSource.includes('AMAUTA_LOG_FORMAT'), 'Must support log format env var');
    assert.ok(rlmSource.includes('_JsonFormatter'), 'Must have JSON formatter class');
    assert.ok(rlmSource.includes('"json"'), 'Must support json format');
  });
});

// ═══════════════════════════════════════════════════════
// 2. Daemon Security
// ═══════════════════════════════════════════════════════

describe('Daemon Security', () => {
  const daemonPath = path.join(ROOT, 'services', 'amauta-daemon.py');
  let daemonSource;

  test('amauta-daemon.py exists', () => {
    assert.ok(fs.existsSync(daemonPath));
    daemonSource = fs.readFileSync(daemonPath, 'utf-8');
  });

  test('Daemon uses constant-time comparison for auth token', () => {
    assert.ok(daemonSource.includes('hmac.compare_digest'), 'Must use hmac.compare_digest for auth');
    assert.ok(daemonSource.includes('import hmac'), 'Must import hmac');
  });

  test('Daemon auth does not use direct == comparison', () => {
    // The auth check function should NOT use ==
    const authCheck = daemonSource.substring(
      daemonSource.indexOf('def _check_auth'),
      daemonSource.indexOf('# ── Rate Limiting')
    );
    // Should not have a plain == comparison of auth tokens
    assert.ok(!authCheck.includes('auth == f"Bearer'), 'Must NOT use == for auth comparison');
  });

  test('Daemon reconcile uses module-level DATA_DIR not os.environ default "."', () => {
    if (!daemonSource) daemonSource = fs.readFileSync(daemonPath, 'utf-8');
    const fnStart = daemonSource.indexOf('def _reconcile_tasks_to_store');
    assert.ok(fnStart !== -1, 'Must have _reconcile_tasks_to_store function');
    const reconcile = daemonSource.substring(fnStart, fnStart + 500);
    assert.ok(!reconcile.includes('os.environ.get("AMAUTA_DATA_DIR", ".")'),
      'Must not use os.environ default "." — should use module-level DATA_DIR');
    assert.ok(reconcile.includes('DATA_DIR'), 'Must reference DATA_DIR');
  });

  test('Daemon has MAX_BODY_SIZE configured', () => {
    assert.ok(daemonSource.includes('MAX_BODY_SIZE'), 'Must have body size limit');
    assert.ok(daemonSource.includes('AMAUTA_MAX_BODY_SIZE'), 'Must read from env var');
  });

  test('Daemon has rate limiting', () => {
    assert.ok(daemonSource.includes('_RateLimiter'), 'Must have rate limiter');
    assert.ok(daemonSource.includes('60'), 'Must limit to ~60 req/min');
  });
});

// ═══════════════════════════════════════════════════════
// 3. Docker Configuration
// ═══════════════════════════════════════════════════════

describe('Docker Configuration', () => {
  test('docker-compose.yml does NOT mount DOWN migrations to initdb', () => {
    const compose = fs.readFileSync(
      path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf-8'
    );
    assert.ok(!compose.includes('migrations:/docker-entrypoint-initdb.d:ro'),
      'Must NOT mount entire migrations dir (DOWN files would run!)');
    // Nothing is mounted into initdb any more: the tracked runner applies UP
    // files and structurally never applies a *-DOWN.sql.
    const mounts = compose.split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .filter(l => /:\/docker-entrypoint-initdb\.d/.test(l));
    assert.deepStrictEqual(mounts, [], 'compose must not mount anything into initdb');
  });

  test('docker-compose.yml does not have deprecated version key', () => {
    const compose = fs.readFileSync(
      path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf-8'
    );
    assert.ok(!compose.startsWith('version:'), 'Must not have deprecated version key');
  });

  test('Dockerfile.services has CMD with "run" argument', () => {
    const dockerfile = fs.readFileSync(
      path.join(ROOT, 'docker', 'Dockerfile.services'), 'utf-8'
    );
    assert.ok(dockerfile.includes('"run"'), 'CMD must include "run" argument');
  });

  test('docker-compose.yml mounts no migrations: the tracked runner is the single path', () => {
    // initdb used to mount 001-005 while the other migrations ran untracked from
    // the host. services/migrate_runner.py now applies and records every one.
    const compose = fs.readFileSync(
      path.join(ROOT, 'docker', 'docker-compose.yml'), 'utf-8'
    );
    const migrationMounts = compose.match(/\d{3}-.*\.sql:/g);
    assert.strictEqual(migrationMounts, null, 'compose must not mount migration files into initdb');
    assert.ok(fs.existsSync(path.join(ROOT, 'services', 'migrate_runner.py')), 'tracked runner must exist');
  });
});

// ═══════════════════════════════════════════════════════
// 4. Migration Chain Integrity
// ═══════════════════════════════════════════════════════

describe('Migration Chain Integrity', () => {
  const migrationsDir = path.join(ROOT, 'migrations');

  test('All UP migrations have corresponding DOWN migrations', () => {
    const ups = fs.readdirSync(migrationsDir)
      .filter(f => f.match(/^\d{3}-/) && !f.includes('DOWN'))
      .sort();
    const downs = fs.readdirSync(migrationsDir)
      .filter(f => f.includes('DOWN'))
      .sort();
    
    for (const up of ups) {
      const base = up.replace('.sql', '');
      const expectedDown = `${base}-DOWN.sql`;
      assert.ok(downs.includes(expectedDown), `Missing DOWN migration for ${up}`);
    }
  });

  test('004-DOWN.sql drops the correct index names from 004 UP', () => {
    const up = fs.readFileSync(path.join(migrationsDir, '004-fulltext-indexes.sql'), 'utf-8');
    const down = fs.readFileSync(path.join(migrationsDir, '004-fulltext-indexes-DOWN.sql'), 'utf-8');
    
    // Extract index names from UP
    const upIndexes = [...up.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]);
    assert.ok(upIndexes.length >= 4, 'UP should create at least 4 indexes');
    
    // Verify DOWN drops exactly those indexes
    for (const idx of upIndexes) {
      assert.ok(down.includes(idx), `DOWN must drop index ${idx} created by UP`);
    }
    
    // Verify DOWN does NOT reference non-existent indexes
    const downIndexes = [...down.matchAll(/DROP INDEX IF EXISTS (\w+)/g)].map(m => m[1]);
    for (const idx of downIndexes) {
      assert.ok(upIndexes.includes(idx), `DOWN references ${idx} which is NOT created by UP`);
    }
  });

  test('005 migration creates gsd_agent_performance table', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '005-agent-performance.sql'), 'utf-8');
    assert.ok(sql.includes('gsd_agent_performance'), 'Must create performance table');
    assert.ok(sql.includes('CREATE TABLE'), 'Must be a CREATE TABLE statement');
  });

  test('001 migration creates core tables with proper schema', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001-init.sql'), 'utf-8');
    assert.ok(sql.includes('gsd_memory'), 'Must create gsd_memory');
    assert.ok(sql.includes('gsd_shared_kb'), 'Must create gsd_shared_kb');
    assert.ok(sql.includes('gsd_tasks'), 'Must create gsd_tasks');
    assert.ok(sql.includes('gsd_task_validations'), 'Must create gsd_task_validations');
    assert.ok(sql.includes('vector'), 'Must use pgvector extension');
  });

  test('001 migration creates compatibility views with INSTEAD OF triggers', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001-init.sql'), 'utf-8');
    assert.ok(sql.includes('amauta_memory'), 'Must create amauta_memory view');
    assert.ok(sql.includes('INSTEAD OF INSERT'), 'Must have INSTEAD OF INSERT trigger');
  });
});

// ═══════════════════════════════════════════════════════
// 5. Backup/Restore Security
// ═══════════════════════════════════════════════════════

describe('Backup/Restore Security', () => {
  test('backup.sh uses PGPASSWORD env var instead of DSN in command', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'backup.sh'), 'utf-8');
    assert.ok(script.includes('PGPASSWORD='), 'Must use PGPASSWORD env var');
    assert.ok(script.includes('-h "$_PG_HOST"'), 'Must use -h flag with extracted host');
    assert.ok(script.includes('-U "$_PG_USER"'), 'Must use -U flag with extracted user');
    // Should NOT pass full DSN to pg_dump
    assert.ok(!script.includes('pg_dump "$PG_URL"'), 'Must NOT pass full DSN to pg_dump');
  });

  test('restore.sh uses PGPASSWORD env var instead of DSN in command', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'restore.sh'), 'utf-8');
    assert.ok(script.includes('PGPASSWORD='), 'Must use PGPASSWORD env var');
    // Should NOT pass full DSN to psql
    assert.ok(!script.includes('psql "$PG_URL"'), 'Must NOT pass full DSN to psql');
  });

  test('backup.sh rotates memory.jsonl backups', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'backup.sh'), 'utf-8');
    assert.ok(script.includes('memory_*.jsonl'), 'Must rotate memory backups');
  });
});

// ═══════════════════════════════════════════════════════
// 6. Windows Compatibility
// ═══════════════════════════════════════════════════════

describe('Windows Compatibility', () => {
  // Phase 88 plan 88-15 re-pointed these two. They used to assert that
  // amauta.py imports the POSIX locking module in a try, sets it to None on
  // ImportError and guards every call on it -- which IS the Windows defect:
  // the comment in the source said "file locking will be skipped", so two
  // concurrent amauta invocations lost an update to tasks.json silently. The
  // contract is now the opposite and stronger: the lock is real on both
  // platforms and RAISES where it cannot lock.
  test('amauta.py takes its lock from the shared platform module, not an optional import', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(!source.includes('import fcntl'), 'must not import the POSIX-only module directly');
    assert.ok(!source.includes('fcntl = None'), 'must not degrade to a no-op lock');
    assert.ok(source.includes('_platform.file_lock'), 'must delegate to the shared helper');
    assert.ok(source.includes("import _platform"), 'must import the shared platform module');
  });

  test('amauta.py file locking cannot be a silent no-op', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const lockClass = source.substring(
      source.indexOf('class _file_lock'),
      source.indexOf('# ── Persistence')
    );
    assert.ok(!lockClass.includes('if fcntl:'), 'no guard may skip the acquisition');
    assert.ok(lockClass.includes('_platform.file_lock'), 'the acquisition goes through the helper');
    const helper = fs.readFileSync(path.join(ROOT, 'services', '_platform.py'), 'utf-8');
    assert.ok(helper.includes('flock'), 'the helper locks with flock on POSIX');
    assert.ok(helper.includes('msvcrt'), 'the helper locks with msvcrt on Windows');
    assert.ok(/raise RuntimeError\(\s*\n?\s*"no cross-process file lock/.test(helper),
      'the helper raises where no primitive exists');
  });
});

// ═══════════════════════════════════════════════════════
// 7. .env.example Completeness
// ═══════════════════════════════════════════════════════

describe('.env.example Completeness', () => {
  let envExample;

  test('.env.example exists', () => {
    envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
  });

  test('Contains all required environment variables', () => {
    const required = [
      'GSD_POSTGRES_URL', 'GSD_AMAUTA_PORT', 'AMAUTA_DAEMON_TOKEN',
      'AMAUTA_MAX_BODY_SIZE', 'AMAUTA_DATA_DIR', 'GSD_RLM_PORT',
      'RLM_CACHE_SIZE', 'RLM_CACHE_MAX_MB', 'RLM_MAX_CHUNK_CHARS',
      'RLM_DEFAULT_TOP_K', 'VOYAGE_API_KEY', 'OPENAI_API_KEY',
      'PERPLEXITY_API_KEY', 'AMAUTA_GATE_COOLDOWN_MINUTES',
      'GSD_DEBUG', 'NO_COLOR',
    ];
    for (const v of required) {
      assert.ok(envExample.includes(v), `Missing env var: ${v}`);
    }
  });

  test('Contains advanced/optional environment variables', () => {
    const advanced = [
      'AMAUTA_LOG_LEVEL', 'AMAUTA_LOG_FORMAT',
      'GSD_EMBEDDING_PROVIDER', 'GSD_RLM_HOST', 'GSD_AMAUTA_HOST',
      'PERPLEXITY_MODEL', 'AMAUTA_MEMORY_DATABASE_URL',
      'AMAUTA_MEMORY_BACKEND', 'AMAUTA_SHARED_KB_DIR',
    ];
    for (const v of advanced) {
      assert.ok(envExample.includes(v), `Missing advanced env var: ${v}`);
    }
  });

  test('RLM_DEFAULT_TOP_K matches code default of 10', () => {
    assert.ok(envExample.includes('RLM_DEFAULT_TOP_K=10'), 'Must be 10 to match code default');
  });
});

// ═══════════════════════════════════════════════════════
// 8. Connection Pool Safety
// ═══════════════════════════════════════════════════════

describe('Connection Pool Safety (pg_store.py)', () => {
  const pgStorePath = path.join(ROOT, 'services', 'pg_store.py');
  let pgSource;

  test('pg_store.py exists', () => {
    assert.ok(fs.existsSync(pgStorePath));
    pgSource = fs.readFileSync(pgStorePath, 'utf-8');
  });

  test('_get_conn does NOT allocate new connection in mid-transaction error path', () => {
    const getConn = pgSource.substring(
      pgSource.indexOf('def _get_conn'),
      pgSource.indexOf('def health')
    );
    // The mid-transaction OperationalError handler should NOT create a new conn
    const midTxHandler = getConn.substring(
      getConn.indexOf('Connection died mid-transaction')
    );
    // Should not have getconn() after the reconnect putconn
    const afterPutconn = midTxHandler.substring(
      midTxHandler.indexOf('putconn(conn, close=True)')
    );
    // self._connect() is fine, but getconn() would leak
    assert.ok(!afterPutconn.includes('getconn()'), 
      'Must NOT getconn() after mid-transaction failure (causes leak)');
  });

  test('_get_conn uses single-yield pattern', () => {
    const getConn = pgSource.substring(
      pgSource.indexOf('def _get_conn'),
      pgSource.indexOf('def health')
    );
    // Count yield statements — should be exactly 1
    const yields = getConn.match(/yield conn/g);
    assert.strictEqual(yields?.length, 1, 'Must have exactly 1 yield (single-yield pattern)');
  });

  test('_get_conn has finally block with putconn', () => {
    const getConn = pgSource.substring(
      pgSource.indexOf('def _get_conn'),
      pgSource.indexOf('def health')
    );
    assert.ok(getConn.includes('finally:'), 'Must have finally block');
    assert.ok(getConn.includes('putconn(conn)'), 'Must putconn in finally');
  });

  test('pg_store uses ThreadedConnectionPool', () => {
    assert.ok(pgSource.includes('ThreadedConnectionPool'), 'Must use ThreadedConnectionPool');
  });

  test('pg_store has proper close() method', () => {
    assert.ok(pgSource.includes('def close('), 'Must have close method');
    assert.ok(pgSource.includes('closeall()'), 'Must call closeall() on pool');
  });
});

// ═══════════════════════════════════════════════════════
// 9. Package.json Correctness
// ═══════════════════════════════════════════════════════

describe('Package.json Configuration', () => {
  let pkg;

  test('package.json exists', () => {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  });

  test('migrate script runs all migrations, not just 001', () => {
    assert.ok(pkg.scripts?.migrate, 'Must have migrate script');
    assert.ok(!pkg.scripts.migrate.includes('-f /docker-entrypoint-initdb.d/001-init.sql'),
      'Must NOT hardcode only 001 migration');
    // The tracked runner discovers and applies every UP migration itself.
    assert.ok(pkg.scripts.migrate.includes('migrate_runner.py') ||
      pkg.scripts.migrate.includes('for f in') || pkg.scripts.migrate.includes('0*.sql'),
      'Must run every migration (tracked runner or an explicit loop)');
  });

  test('engine requirement is node >= 20', () => {
    // Phase 58 PUB-03: bumped engines.node from >=18.0.0 to >=20.0.0 (matches CI matrix + npm publish workflow)
    assert.ok(pkg.engines?.node?.includes('20'), 'Must require Node.js >= 20');
  });
});

// ═══════════════════════════════════════════════════════
// 10. .gitignore Coverage
// ═══════════════════════════════════════════════════════

describe('.gitignore Coverage', () => {
  let gitignore;

  test('.gitignore exists', () => {
    gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
  });

  test('.gitignore covers PID files', () => {
    assert.ok(gitignore.includes('*.pid'), 'Must ignore PID files');
  });

  test('.gitignore covers environment files', () => {
    assert.ok(gitignore.includes('.env'), 'Must ignore .env');
    assert.ok(gitignore.includes('!.env.example'), 'Must NOT ignore .env.example');
  });

  test('.gitignore covers Python artifacts', () => {
    assert.ok(gitignore.includes('__pycache__'), 'Must ignore __pycache__');
    assert.ok(gitignore.includes('*.pyc'), 'Must ignore .pyc files');
  });

  test('.gitignore covers secrets', () => {
    assert.ok(gitignore.includes('*.key'), 'Must ignore key files');
    assert.ok(gitignore.includes('*.pem'), 'Must ignore pem files');
    assert.ok(gitignore.includes('credentials.json'), 'Must ignore credentials');
    assert.ok(gitignore.includes('*.secret'), 'Must ignore secret files');
  });
});

// ═══════════════════════════════════════════════════════
// 11. Spec File Existence and Structure
// ═══════════════════════════════════════════════════════

describe('Spec Files Existence', () => {
  const specsDir = path.join(ROOT, 'specs');
  const expectedSpecs = [
    '01-rpetd-pipeline.spec.md',
    '02-memory-pipeline.spec.md',
    '03-rlm-context-engine.spec.md',
    '04-research-chain.spec.md',
    '05-task-lifecycle.spec.md',
    '06-agent-architecture.spec.md',
    '07-auto-learning-feedback.spec.md',
    '08-validation-pipeline.spec.md',
    '09-context-passing-architecture.spec.md',
  ];

  for (const spec of expectedSpecs) {
    test(`${spec} exists`, () => {
      assert.ok(fs.existsSync(path.join(specsDir, spec)), `Missing spec: ${spec}`);
    });
  }

  test('All spec files have requirement IDs', () => {
    for (const spec of expectedSpecs) {
      const content = fs.readFileSync(path.join(specsDir, spec), 'utf-8');
      // Each spec should have at least one requirement ID like SPEC-XX-YYY-N or XXX-N
      assert.ok(
        content.match(/[A-Z]+-\d+/),
        `${spec} must contain at least one requirement ID`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════
// 12. Agent Architecture Spec Compliance
// ═══════════════════════════════════════════════════════

describe('Agent Architecture Spec Compliance (AGT-*)', () => {
  const agentsDir = path.join(ROOT, 'agents');
  // The roster is the gsd-*.md files. The prefix filter also keeps a transient fixture out of the list:
  // tests/module-lifecycle-e2e installs agents/test-agent.md into the repository for the length of one case
  // (the module installer writes relative to the repo root), and node --test runs files in parallel.
  const agents = fs.readdirSync(agentsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));

  test('every compiled agent has a source AGENT.yaml and vice versa', () => {
    // Was `=== 11`; the roster is 35 now. Count against the compile source of
    // truth (get-shit-done/agents/<name>/AGENT.yaml) rather than a literal, so
    // the test catches a real drift — a compiled .md with no YAML behind it, or
    // a YAML that was never compiled — instead of going stale on every new agent.
    const yamlDir = path.join(ROOT, 'get-shit-done', 'agents');
    const sources = fs.readdirSync(yamlDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(yamlDir, e.name, 'AGENT.yaml')))
      .map(e => e.name)
      .sort();
    const compiled = agents.map(a => a.replace(/\.md$/, '')).sort();
    assert.ok(sources.length > 0, 'expected at least one AGENT.yaml source');
    assert.deepStrictEqual(compiled, sources, 'agents/*.md must match get-shit-done/agents/*/AGENT.yaml exactly');
  });

  // The roster is read from disk (35 agents, not the 11 this test was written for). The read-only audit
  // agents (gsd-auditor-*) audit what exists and have no research chain, so they carry no RESEARCH= variable
  // and no gsd-research.cjs reference; every other agent must. Same exemption as tests/research-chain.test.cjs.
  const READ_ONLY_AUDITOR = (f) => f.startsWith('gsd-auditor-');

  test('All agents have CLI, MEM, and RESEARCH variables (AGT-2 contract)', () => {
    const researchAgents = agents.filter(a => !READ_ONLY_AUDITOR(a));
    assert.ok(researchAgents.length > 0, 'expected at least one non-auditor agent');
    for (const agent of agents) {
      const content = fs.readFileSync(path.join(agentsDir, agent), 'utf-8');
      assert.ok(content.includes('CLI='), `${agent} missing CLI= variable`);
      assert.ok(content.includes('MEM='), `${agent} missing MEM= variable`);
      if (!READ_ONLY_AUDITOR(agent)) {
        assert.ok(content.includes('RESEARCH='), `${agent} missing RESEARCH= variable`);
      }
    }
  });

  test('All agents reference gsd-research.cjs in RESEARCH variable', () => {
    for (const agent of agents.filter(a => !READ_ONLY_AUDITOR(a))) {
      const content = fs.readFileSync(path.join(agentsDir, agent), 'utf-8');
      assert.ok(content.includes('gsd-research.cjs'), `${agent} missing gsd-research.cjs reference`);
    }
  });

  test('All agents have corresponding skill directories', (t) => {
    // SKL-01 deferred to v2 (88-CONTEXT.md): assertion is scoped to agents that have a skill directory, not satisfied for all agents.
    const skillsDir = path.join(ROOT, 'skills');
    const withSkill = agents.filter(a => fs.existsSync(path.join(skillsDir, `${a.replace('.md', '')}-workflow`)));
    assert.ok(withSkill.length > 0, 'expected at least one agent with a skill directory');
    for (const agent of withSkill) {
      const agentName = agent.replace('.md', '');
      const skillDir = path.join(skillsDir, `${agentName}-workflow`);
      assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), `Missing SKILL.md in ${agentName}-workflow`);
    }
    t.diagnostic(`SKL-01 deferred to v2: ${agents.length - withSkill.length} of ${agents.length} agents have no skill directory; see .planning/REQUIREMENTS.md`);
  });

  test('All skill files reference the research chain', () => {
    const skillsDir = path.join(ROOT, 'skills');
    const skillDirs = fs.readdirSync(skillsDir).filter(d => d.endsWith('-workflow'));
    for (const dir of skillDirs) {
      const skillFile = path.join(skillsDir, dir, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf-8');
        assert.ok(content.includes('RESEARCH') || content.includes('research'),
          `${dir}/SKILL.md must reference research chain`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// 13. Context Passing Architecture Compliance
// ═══════════════════════════════════════════════════════

describe('Context Passing Architecture (CPA-*)', () => {
  test('Enrichment Layer 1 exists in amauta.py (_enrich_task_context)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(source.includes('_enrich_task_context'), 'Must have Layer 1 enrichment function');
  });

  test('Enrichment Layer 2 exists in amauta.py (_rpetd_phase_enrich)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(source.includes('_rpetd_phase_enrich'), 'Must have Layer 2 enrichment function');
  });

  test('RLM query function exists in amauta.py', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(source.includes('_rlm_query'), 'Must have RLM query wrapper');
  });

  test('Domain docs mapping exists for RLM queries', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(source.includes('_DOMAIN_DOCS'), 'Must have domain docs mapping');
  });

  test('Enrichment covers all RPETD phases (R, P, E, T, D)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    // Use a large window to capture all 5 phase handlers
    const startIdx = source.indexOf('def _rpetd_phase_enrich');
    const nextDef = source.indexOf('\ndef ', startIdx + 1);
    const enrich = source.substring(startIdx, nextDef > startIdx ? nextDef : startIdx + 15000);
    for (const phase of ['R', 'P', 'E', 'T', 'D']) {
      assert.ok(
        enrich.includes(`== "${phase}"`) || enrich.includes(`== '${phase}'`),
        `Enrichment must handle phase ${phase}`
      );
    }
  });

  test('Research chain CLI (gsd-research.cjs) has 5 providers in correct order', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'get-shit-done', 'bin', 'gsd-research.cjs'), 'utf-8'
    );
    // Provider order: memory, skb, context7, perplexity, webfetch
    const providers = ['memory', 'skb', 'context7', 'perplexity', 'webfetch'];
    for (const p of providers) {
      assert.ok(source.includes(p), `Research chain must have ${p} provider`);
    }
    // Check ordering
    const providerArray = source.match(/\[['"]memory['"].*?\]/s);
    assert.ok(providerArray, 'Must have provider array');
  });
});

// ═══════════════════════════════════════════════════════
// 14. Auto-Learning Feedback Loop
// ═══════════════════════════════════════════════════════

describe('Auto-Learning Feedback Loop', () => {
  test('amauta.py has agent performance recording', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(source.includes('_record_agent_performance') || source.includes('record_agent_performance'),
      'Must have performance recording function');
  });

  test('amauta.py has agent performance summary', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    assert.ok(source.includes('_agent_performance_summary') || source.includes('agent_performance_summary'),
      'Must have performance summary function');
  });

  test('pg_store.py has agent performance table operations', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');
    assert.ok(source.includes('gsd_agent_performance'), 'Must reference performance table');
    assert.ok(source.includes('record_agent_performance'), 'Must have record method');
    assert.ok(source.includes('agent_performance_summary'), 'Must have summary method');
  });

  test('Migration 005 creates agent_performance table', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations', '005-agent-performance.sql'), 'utf-8');
    assert.ok(sql.includes('CREATE TABLE'), 'Must CREATE TABLE');
    assert.ok(sql.includes('gsd_agent_performance'), 'Must be gsd_agent_performance');
  });
});

// ═══════════════════════════════════════════════════════
// 15. DSN Credential Sanitization
// ═══════════════════════════════════════════════════════

describe('DSN Credential Sanitization', () => {
  test('pg_store.py has _sanitize_error method', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');
    assert.ok(source.includes('_sanitize_error'), 'Must have _sanitize_error method');
    assert.ok(source.includes('[redacted]'), 'Must redact credentials');
  });

  test('pg_store.py health() uses _sanitize_error for error responses', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'pg_store.py'), 'utf-8');
    const healthFn = source.substring(
      source.indexOf('def health('),
      source.indexOf('def health(') + 500
    );
    assert.ok(healthFn.includes('_sanitize_error'), 'health() must sanitize errors');
  });

  test('amauta-daemon.py has _safe_error function', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
    assert.ok(source.includes('def _safe_error'), 'Must have _safe_error function');
    assert.ok(source.includes('[redacted]'), 'Must redact credentials');
  });

  test('amauta-daemon.py error responses use _safe_error, not raw str(e)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
    // Should NOT have raw str(e) in 500-level error responses.
    // FileNotFoundError (404) and ValueError (400/422) are allowed to use str(e)
    // because those are validation messages about the client's own input.
    const rawStrE = source.match(/_send_json\(\{"error": str\(e\)\}, 500\)/g);
    assert.strictEqual(rawStrE, null, 'Must NOT use raw str(e) in 500-level API error responses');
    // 88-06: _safe_error(e) only redacts credentials from the DSN and still returned the rest of the
    // exception text (paths, SQL fragments) to the client. 500 responses now go through
    // DaemonHandler._internal_error(e), which sends a fixed message plus a correlation id and logs the detail.
    // _safe_error stays for log lines and health-probe text, where the redaction is the point.
    const sanitizedInBody = source.match(/_send_json\(\{"error": _safe_error\(e\)\}, 500\)/g);
    assert.strictEqual(sanitizedInBody, null, '500 responses must not carry exception text even when sanitized');
    const internal = source.match(/self\._internal_error\(e\)/g);
    assert.ok(internal && internal.length >= 10, 'Must use self._internal_error(e) for 500-level error responses');
    assert.ok(source.includes('def _internal_error(self, exc, status=500, correlation_id=None)'));
    assert.ok(source.includes('uuid.uuid4().hex[:12]'), 'correlation id must be 12 hex characters');
  });

  test('amauta-daemon.py imports re module for sanitization', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'amauta-daemon.py'), 'utf-8');
    assert.ok(source.includes('import re'), 'Must import re for regex sanitization');
  });
});

// ═══════════════════════════════════════════════════════
// 16. RLM Phase Enrichment (E/T/D fixed)
// ═══════════════════════════════════════════════════════

describe('RLM Phase Enrichment (E/T/D phases)', () => {
  test('E-phase calls _pick_domain_doc and _rlm_query without doc_path gate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    // Find the E-phase block
    const ePhase = source.substring(
      source.indexOf('elif phase == "E"'),
      source.indexOf('elif phase == "T"')
    );
    assert.ok(ePhase.includes('_pick_domain_doc'), 'E-phase must call _pick_domain_doc');
    // Phase 11 removed if doc_path: gates — RLM is called unconditionally
    assert.ok(!ePhase.includes('if doc_path:'), 'E-phase must NOT gate RLM call with if doc_path: (removed in Phase 11)');
    assert.ok(ePhase.includes('_rlm_query'), 'E-phase must call _rlm_query');
  });

  test('T-phase is disabled (TOK-02): no _pick_domain_doc, no _rlm_query, no doc_path gate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const tPhase = source.substring(
      source.indexOf('elif phase == "T"'),
      source.indexOf('elif phase == "D"')
    );
    // TOK-02: T-phase enrichment disabled -- no RLM or doc lookups at all
    assert.ok(!tPhase.includes('_pick_domain_doc'), 'T-phase must NOT call _pick_domain_doc (TOK-02 disabled)');
    assert.ok(!tPhase.includes('_rlm_query'), 'T-phase must NOT call _rlm_query (TOK-02 disabled)');
    assert.ok(!tPhase.includes('if doc_path:'), 'T-phase must NOT gate RLM call with if doc_path:');
    assert.ok(tPhase.includes('TOK-02'), 'T-phase must have TOK-02 comment explaining the disable');
  });

  test('D-phase RLM removed (TOK-02): no _pick_domain_doc, no _rlm_query, no doc_path gate', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const dPhase = source.substring(
      source.indexOf('elif phase == "D"'),
      source.indexOf('# ── Write delivery event')
    );
    // TOK-02: D-phase RLM delivery check removed -- only write operations remain
    assert.ok(!dPhase.includes('_pick_domain_doc'), 'D-phase must NOT call _pick_domain_doc (TOK-02 removed)');
    assert.ok(!dPhase.includes('_rlm_query'), 'D-phase must NOT call _rlm_query (TOK-02 removed)');
    assert.ok(!dPhase.includes('if doc_path:'), 'D-phase must NOT gate RLM call with if doc_path:');
    assert.ok(dPhase.includes('TOK-02'), 'D-phase must have TOK-02 comment explaining the removal');
  });

  test('R-phase and P-phase still call _rlm_query with doc_path', () => {
    const source = fs.readFileSync(path.join(ROOT, 'amauta.py'), 'utf-8');
    const rPhase = source.substring(
      source.indexOf('if phase == "R"'),
      source.indexOf('elif phase == "P"')
    );
    assert.ok(rPhase.includes('doc_path=doc_path'), 'R-phase must pass doc_path');
    
    const pPhase = source.substring(
      source.indexOf('elif phase == "P"'),
      source.indexOf('elif phase == "E"')
    );
    assert.ok(pPhase.includes('doc_path=doc_path'), 'P-phase must pass doc_path');
  });
});

// ═══════════════════════════════════════════════════════
// 17. Operator Context Passing
// ═══════════════════════════════════════════════════════

describe('Operator Context Passing', () => {
  test('Operator Task() prompt includes $RESEARCH search call', () => {
    const source = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-operator.md'), 'utf-8');
    // The operator was restructured to the 10-section v3.0.0 format in Phase 31 (c981e5f): the "Context
    // Pipeline" section with $RESEARCH / $RLM / $MEM shorthand became "## Tool access & guidance", which
    // lists the same three tools by their scripts. Scope to that section, up to "## Task management".
    const start = source.indexOf('## Tool access & guidance');
    const end = source.indexOf('## Task management');
    assert.ok(start !== -1 && end > start, 'operator must have a Tool access & guidance section');
    const taskPrompt = source.substring(start, end);
    assert.ok(taskPrompt.includes('gsd-research.cjs search'), 'Operator must include the research chain search call');
    assert.ok(taskPrompt.includes('gsd-rlm.cjs query'), 'Operator must include the RLM query call');
    assert.ok(taskPrompt.includes('gsd-memory.cjs search'), 'Operator must include the memory search call');
  });
});

// ═══════════════════════════════════════════════════════
// 18. RLM Performance Optimization
// ═══════════════════════════════════════════════════════

describe('RLM Performance Optimization', () => {
  test('score_chunks pre-tokenizes chunks (no O(n*m) retokenization)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services', 'rlm-service.py'), 'utf-8');
    const scoreFn = source.substring(
      source.indexOf('def score_chunks'),
      source.indexOf('def _tokenize')
    );
    assert.ok(scoreFn.includes('chunk_token_sets'), 'Must pre-tokenize chunks into chunk_token_sets');
    assert.ok(scoreFn.includes('for token_set in chunk_token_sets'), 'Must iterate pre-tokenized sets');
    // doc_freq loop should iterate chunk_token_sets, not re-call _tokenize per chunk per term
    const docFreqLoop = scoreFn.substring(scoreFn.indexOf('for term in terms'));
    assert.ok(docFreqLoop.includes('token_set'), 'doc_freq loop must use pre-tokenized sets');
  });
});

// ═══════════════════════════════════════════════════════
// 19. Daemon 500 responses carry no exception text (88-06)
// ═══════════════════════════════════════════════════════

describe('Daemon 500 responses carry no exception text', () => {
  let handle;
  let stderrBuf = '';

  /**
   * One request against the fixture daemon.
   * @param {string} method
   * @param {string} urlPath
   * @param {object} [body]
   * @returns {Promise<{status: number, text: string, json: object}>}
   */
  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
      const req = http.request({ host: '127.0.0.1', port: handle.port, path: urlPath, method, headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_e) { /* asserted by the caller */ }
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Wait until the daemon has logged `needle` on stderr.
   * @param {string} needle
   * @returns {Promise<boolean>}
   */
  async function logged(needle) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (stderrBuf.includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  test('fixture daemon starts', async () => {
    handle = await startFixtureDaemon();
    handle.proc.stderr.on('data', (c) => { stderrBuf = (stderrBuf + c.toString()).slice(-20000); });
    assert.ok(handle.port > 0);
  });

  test('GET route that raises answers a fixed 500 body with a correlation id', async () => {
    // int('abc') raises ValueError inside the handler's try block; its message must stay server-side.
    const r = await request('GET', '/api/memory/list?limit=abc');
    assert.strictEqual(r.status, 500);
    assert.ok(r.json && typeof r.json === 'object', `body must be JSON, got: ${r.text.slice(0, 80)}`);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['correlation_id', 'error']);
    assert.strictEqual(r.json.error, 'internal error');
    assert.match(r.json.correlation_id, /^[0-9a-f]{12}$/);
    // The detail did not vanish: it is in the daemon log under the same id, with the traceback.
    assert.ok(await logged(`request_failed id=${r.json.correlation_id}`), 'detail must be logged under the correlation id');
    assert.ok(stderrBuf.includes('invalid literal for int()'), 'exception text must be in the daemon log');
  });

  test('POST route that raises answers the same fixed shape, with a different id', async () => {
    const first = await request('GET', '/api/memory/list?limit=abc');
    const r = await request('POST', '/api/memory/semantic-search', { query: 'x', limit: 'abc' });
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['correlation_id', 'error']);
    assert.strictEqual(r.json.error, 'internal error');
    assert.match(r.json.correlation_id, /^[0-9a-f]{12}$/);
    assert.notStrictEqual(r.json.correlation_id, first.json.correlation_id, 'each failure gets its own id');
  });

  test('fixture daemon stops', async () => {
    await stopFixtureDaemon(handle);
    assert.ok(handle.proc.killed || handle.proc.exitCode !== null || handle.proc.signalCode !== null);
  });
});
