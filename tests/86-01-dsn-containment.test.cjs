/**
 * DSNSAFE-01 — environmental containment for the shared PostgreSQL.
 *
 * THE INCIDENT THIS PINS (2026-09-07)
 * ───────────────────────────────────
 * `services/pg_store.py` line 114 hardcoded the shared development DSN as the
 * fallback for an unset `GSD_POSTGRES_URL`. A lane unset that variable on
 * purpose, to match CI. Unsetting the override did not disable the database —
 * it silently repointed the process at the shared one, and 8 `party_session`
 * rows were written to it.
 *
 * The reach was three call frames deep and nothing at the top looked like a
 * database call:
 *
 *     gsd-tools.cjs party create      (node)
 *       -> services/party_session_cli.py         (python3, spawned)
 *         -> services/party_session.create()
 *           -> services/pg_store.PGStore()       -> psycopg2 pool -> LIVE DB
 *
 * So this test drives the CLI, not `pg_store`. A test that called `pg_store`
 * directly would have passed on the day of the incident, because the thing
 * that failed was not `pg_store` in isolation — it was that four test files
 * with no database code in them reached it.
 *
 * HOW IT IS MEASURED
 * ──────────────────
 * A `sitecustomize.py` on the child's PYTHONPATH wraps `psycopg2.connect`. The
 * wrapper appends the DSN it was handed to a log file and then RAISES — it
 * never calls through. Two consequences, both deliberate:
 *
 *   1. every connection ATTEMPT is observable, including one made three frames
 *      down by code that no test file mentions; and
 *   2. this test physically cannot connect to the shared database, even if the
 *      containment it is testing has been removed. A regression shows up as a
 *      forbidden host in the log, not as more rows in someone's database.
 *
 * `psycopg2.pool.ThreadedConnectionPool._connect` calls `psycopg2.connect(...)`
 * as a module attribute lookup at call time (psycopg2/pool.py L63), so the
 * wrapper covers the pooled path PGStore actually uses.
 *
 * THE THREE ARMS
 * ──────────────
 *   POSITIVE  an explicitly-configured DSN reaches psycopg2 unchanged, and the
 *             instrument reports non-zero. Without this, the zero in the
 *             negative arm would prove nothing — a probe that reports zero has
 *             to be able to report non-zero.
 *   NEGATIVE  with no DSN configured, the path refuses and connects to NOTHING.
 *   MUTATION  the source pin below turns red if the hardcoded fallback is
 *             restored, so the rule cannot be deleted and still test green.
 *
 * FALSE-POSITIVE DIRECTION, pinned as well: containment must not break
 * legitimate local development. An explicitly-set DSN is the developer saying
 * yes, and it must never produce the refusal.
 *
 * NO SHARED SERVICE IS CONTACTED BY THIS FILE. No Postgres, no Redis, no
 * daemon, no RLM. The only DSNs it ever hands out point at Unix-domain sockets
 * in directories that do not exist.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/** The shared services this repo must never reach from a test. */
const FORBIDDEN = ['5433', '6379', '18799', '18798'];

/**
 * A DSN that is structurally unable to reach a shared host: libpq treats a
 * `host=` beginning with `/` as a Unix-domain socket directory and never falls
 * back to TCP, and this directory does not exist. Must stay byte-identical to
 * `services/pg_dsn.CONTAINMENT_TEST_DSN`; a test below asserts that.
 */
const CONTAINMENT_TEST_DSN =
  'postgresql:///gsd_amauta_test?host=/nonexistent/gsd-amauta-containment';

/** A distinguishable second one, so the positive arm proves the DSN travelled. */
const SENTINEL_DSN =
  'postgresql://sentinel_user@/sentinel_db?host=/nonexistent/dsnsafe-sentinel';

// ─── The instrument ───────────────────────────────────────────────────────────

const SITECUSTOMIZE = `
# Written by tests/86-01-dsn-containment.test.cjs. Records every psycopg2
# connection ATTEMPT and refuses to make any of them.
import os
import sys

_LOG = os.environ.get("DSNSAFE_CONN_LOG")


def _chain():
    # A sitecustomize.py injected via PYTHONPATH SHADOWS the platform's own,
    # because PYTHONPATH precedes every other sys.path entry. Homebrew's
    # CPython ships one whose job is to append its site-packages; shadowing it
    # silently removes psycopg2 (and everything else) from the interpreter, and
    # the containment arm would then pass for entirely the wrong reason. Run the
    # shadowed one first.
    here = os.path.dirname(os.path.abspath(__file__))
    for entry in list(sys.path):
        try:
            if not entry or os.path.abspath(entry) == here:
                continue
            cand = os.path.join(entry, "sitecustomize.py")
            if os.path.isfile(cand):
                with open(cand) as fh:
                    src = fh.read()
                exec(compile(src, cand, "exec"),
                     {"__file__": cand, "__name__": "sitecustomize"})
                break
        except Exception:
            pass


def _install():
    try:
        import psycopg2
    except Exception:
        return
    _real = psycopg2.connect

    import re as _re

    def _redact(text):
        # A DSN with a password in it IS a credential, and this log is read out
        # loud in failure messages, gate logs and reports. The whole point of
        # this file is a DSN, so redact before anything can print it.
        return _re.sub(r"://[^/@\\s]*:[^/@\\s]*@", "://<redacted>@", str(text))

    def _recording_connect(dsn=None, *args, **kwargs):
        target = _redact(dsn if dsn is not None else repr(kwargs))
        if _LOG:
            with open(_LOG, "a") as fh:
                fh.write(str(target) + "\\n")
        raise RuntimeError(
            "DSNSAFE instrument: connection attempt recorded and BLOCKED "
            "(target=%s). No packet was sent." % (target,)
        )

    psycopg2.connect = _recording_connect


_chain()
_install()
`;

/**
 * Prepare a scratch dir holding the instrument.
 * @returns {{dir:string, log:string, pythonpath:string}}
 */
function makeInstrument() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsnsafe-'));
  fs.writeFileSync(path.join(dir, 'sitecustomize.py'), SITECUSTOMIZE);
  return {
    dir,
    log: path.join(dir, 'connections.log'),
    pythonpath: dir,
  };
}

/** @returns {string[]} the DSNs psycopg2 was asked to connect with */
function readLog(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean);
}

/**
 * Run `gsd-tools.cjs party create` through the real three-frame path.
 *
 * @param {object} inst instrument from makeInstrument()
 * @param {object} extraEnv values to add; null deletes the key
 */
function runPartyCreate(inst, extraEnv) {
  const env = { ...process.env };
  // Never inherit a DSN from the ambient shell — the incident shell had a live
  // one exported, and a test that reads it is measuring the shell, not the code.
  delete env.GSD_POSTGRES_URL;
  delete env.DATABASE_URL;
  delete env.AMAUTA_MEMORY_DATABASE_URL;
  env.DSNSAFE_CONN_LOG = inst.log;
  env.PYTHONPATH = [inst.pythonpath, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.GSD_AMAUTA_NO_AUTO_START = '1';
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (v === null) delete env[k]; else env[k] = String(v);
  }
  for (const key of ['GSD_POSTGRES_URL', 'DATABASE_URL']) {
    const v = env[key];
    if (v) {
      assert.ok(
        FORBIDDEN.every((p) => !v.includes(p)),
        `refusing to run: ${key} names a shared service port (${v})`
      );
    }
  }
  return spawnSync(
    process.execPath,
    [TOOLS, 'party', 'create', '--participants', 'gsd-planner,gsd-checker'],
    { encoding: 'utf8', timeout: 60000, cwd: ROOT, env }
  );
}

/**
 * Does the instrument actually arm under the exact conditions the arms use?
 *
 * This asks the stronger question on purpose. Checking only that psycopg2
 * imports would have missed the real failure mode: the injected sitecustomize
 * shadowed Homebrew's, site-packages vanished, psycopg2 became unimportable in
 * the child, and the containment arm would have reported green because nothing
 * could connect for a reason that has nothing to do with containment.
 */
function instrumentArms() {
  const inst = makeInstrument();
  const env = { ...process.env };
  env.PYTHONPATH = [inst.pythonpath, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const r = spawnSync(
    'python3',
    ['-c', 'import psycopg2; print(getattr(psycopg2.connect, "__name__", "?"))'],
    { encoding: 'utf8', timeout: 20000, env }
  );
  return !r.error && r.status === 0 && /_recording_connect/.test(r.stdout || '');
}

const CAN_ARM = instrumentArms();
const SKIP_ARM =
  'the psycopg2.connect instrument did not arm under this python3 (no psycopg2, ' +
  'or sitecustomize did not take effect). A negative arm is unfalsifiable without ' +
  'the positive one beside it, so these are skipped rather than reported green.';

// ─── ARM 1 (positive): the instrument can report non-zero ─────────────────────

test('DSNSAFE-01 positive arm: an explicit DSN travels all three frames to psycopg2', (t) => {
  if (!CAN_ARM) return t.skip(SKIP_ARM);
  const inst = makeInstrument();
  const r = runPartyCreate(inst, { GSD_POSTGRES_URL: SENTINEL_DSN });
  const seen = readLog(inst.log);

  assert.ok(
    seen.length > 0,
    'the explicitly-configured run reached psycopg2 zero times ' +
      `(status=${r.status} stdout=${r.stdout} stderr=${r.stderr}). The instrument ` +
      'cannot detect a connection attempt, so the zero in the negative arm would ' +
      'prove nothing.'
  );
  assert.ok(
    seen.some((d) => d.includes('dsnsafe-sentinel')),
    `the DSN that reached psycopg2 is not the one that was configured: ${JSON.stringify(seen)}`
  );
});

// ─── ARM 2 (negative): unset means refuse, and dial nothing ───────────────────

test('DSNSAFE-01 negative arm: with no DSN the party path refuses and connects to nothing', (t) => {
  if (!CAN_ARM) return t.skip(SKIP_ARM);
  const inst = makeInstrument();
  const r = runPartyCreate(inst, { GSD_POSTGRES_URL: null, DATABASE_URL: null });
  const seen = readLog(inst.log);

  assert.deepStrictEqual(
    seen,
    [],
    'a connection was attempted with GSD_POSTGRES_URL unset. This is the ' +
      `incident: ${JSON.stringify(seen)}`
  );
  for (const port of FORBIDDEN) {
    assert.ok(
      !seen.some((d) => d.includes(port)),
      `the unconfigured path aimed at a shared service port ${port}: ${JSON.stringify(seen)}`
    );
  }
  assert.notStrictEqual(
    r.status, 0,
    `party create exited 0 with no DSN configured — it must fail closed ` +
      `(stdout=${r.stdout} stderr=${r.stderr})`
  );
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /GSD_POSTGRES_URL/,
    'the refusal does not name the variable to set; the next person will guess');
  assert.match(out, /export/,
    'the refusal does not show what to export; frustration is how fallbacks get reintroduced');
  assert.match(out, /nonexistent/,
    'the refusal does not offer the contained DSN for tests and CI');
});

// ─── FALSE-POSITIVE DIRECTION: local development must still work ──────────────

test('DSNSAFE-01 false-positive arm: an explicitly-set DSN is never refused', (t) => {
  if (!CAN_ARM) return t.skip(SKIP_ARM);
  const inst = makeInstrument();
  const r = runPartyCreate(inst, { GSD_POSTGRES_URL: SENTINEL_DSN });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.ok(
    !/refuses to guess/.test(out),
    'containment refused a run the developer explicitly configured. Containment ' +
      `is about the ABSENT case only. Output: ${out}`
  );
  // It failed for the right reason: the instrument blocked it, not the guard.
  assert.match(out, /DSNSAFE instrument|sentinel/,
    `expected the configured DSN to be the thing that failed, got: ${out}`);
});

// ─── ARM 3 support: the source pin the mutation has to kill ───────────────────

const RESOLVERS = [
  'services/pg_store.py',
  'services/complexity_scorer.py',
  'services/skill_invocation_store.py',
  'services/step-orchestrator.py',
  'services/rlm-service.py',
];

/**
 * Everything scanned for a live DSN literal. `pg_dsn.py` is on this list and
 * not on RESOLVERS. Measured 2026-09-07: a mutation that reinstated a hardcoded
 * default INSIDE require_dsn left this pin green — the helper was not being
 * scanned — while the behavioural negative arm caught it. A pin a mutation
 * survives is an inert pin, so the helper is scanned now too.
 */
const SCANNED = ['services/pg_dsn.py', ...RESOLVERS];

test('DSNSAFE-01 mutation pin: no module resolves a DSN to a hardcoded host', () => {
  // A live DSN string literal anywhere on a resolution path is the defect.
  // Comments are exempt so the tombstones may record what used to be there.
  const LIVE_DSN = /["'](?:postgres(?:ql)?|redis):\/\/[^"'\n]*(?::5433|:6379|:5432|:18799|:18798)[^"'\n]*["']/;
  for (const rel of SCANNED) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    const raw = code.match(LIVE_DSN);
    // A DSN with a password in it is a credential, and an assert message ends
    // up in gate logs and reports. Redact before it can be printed.
    const hit = raw === null ? null : [raw[0].replace(/:\/\/[^/@\s]*:[^/@\s]*@/, '://<redacted>@')];
    assert.strictEqual(
      hit, null,
      `${rel} contains a hardcoded shared-service DSN in live code (${hit && hit[0]}). ` +
        'This is exactly the line that wrote 8 rows to the shared database on ' +
        '2026-09-07. There is no default DSN; use pg_dsn.require_dsn().'
    );
  }
});

test('DSNSAFE-01 mutation pin: require_dsn has no fallback branch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services', 'pg_dsn.py'), 'utf-8');
  assert.ok(
    /raise UnconfiguredPostgresDSN/.test(src),
    'pg_dsn no longer raises on an absent DSN — the containment is gone'
  );
  assert.ok(
    src.includes(CONTAINMENT_TEST_DSN),
    'CONTAINMENT_TEST_DSN drifted from the value this test and the refusal ' +
      'message hand to developers; they must stay byte-identical'
  );
  // The safe value must not merely be a different port on a reachable machine.
  assert.match(
    CONTAINMENT_TEST_DSN, /host=\/[^&\s]*/,
    'the contained DSN is no longer a Unix-domain socket. A wrong TCP port is a ' +
      'refused connection to a machine you did reach, not containment.'
  );
  assert.ok(
    FORBIDDEN.every((p) => !CONTAINMENT_TEST_DSN.includes(p)),
    'the contained DSN names a shared service port'
  );
});

test('DSNSAFE-01 mutation pin: every resolver goes through require_dsn', () => {
  for (const rel of RESOLVERS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.match(
      src, /_require_dsn\(/,
      `${rel} no longer routes DSN resolution through pg_dsn.require_dsn(); ` +
        'a second resolution path is how the first one came back'
    );
  }
});
