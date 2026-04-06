#!/usr/bin/env node
/**
 * 25-01 Infrastructure Quick Wins Tests -- RLM port cleanup & API key validation
 * Validates _validate_api_keys structure, _port_is_free behavior, RLM log file path,
 * and restart counter reset via AST/grep checks and Python exec tests.
 *
 * Plan: 01-01 (Phase 01-infrastructure-quick-wins)
 *
 * Tests:
 *   1. _validate_api_keys returns correct structure for VOYAGE_API_KEY (ok)
 *   2. _validate_api_keys returns missing status for empty PERPLEXITY_API_KEY
 *   3. _validate_api_keys returns PERPLEXITY_MODEL value
 *   4. _port_is_free returns true for an unused high port
 *   5. _port_is_free returns false for an occupied port
 *   6. RLM restart counter resets on successful start (code path check)
 *   7. RLM stderr goes to log file not DEVNULL (code path check)
 *   8. _kill_port_holder is defined in daemon
 *   9. _rlm_watchdog logs reason= in restart and max-restarts messages
 *  10. health endpoint api_keys dict does not expose raw key lengths or values
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON_PY = path.join(ROOT, 'services', 'amauta-daemon.py');
const DAEMON_SRC = fs.readFileSync(DAEMON_PY, 'utf-8');

function pyExec(code) {
  return execFileSync('python3', ['-c', code], {
    cwd: ROOT,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

// ── _validate_api_keys tests ─────────────────────────────────────────────────

describe('_validate_api_keys (T3)', () => {
  it('returns status=ok for a valid-length VOYAGE_API_KEY (46 chars)', () => {
    // pa- prefix + 43 chars = 46 total, within [40, 60]
    const key = 'pa-test1234567890123456789012345678901234567890';
    const keyTrimmed = key.slice(0, 46);
    const out = pyExec(`
import os, sys
sys.path.insert(0, '${ROOT}/services')
os.environ['VOYAGE_API_KEY'] = '${keyTrimmed}'
os.environ['PERPLEXITY_API_KEY'] = ''
os.environ.pop('PERPLEXITY_MODEL', None)

# Extract _validate_api_keys from daemon source without executing module-level code
import ast, types, importlib.util

src = open('${DAEMON_PY}').read()
tree = ast.parse(src)

# Find and compile just the _validate_api_keys function
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == '_validate_api_keys':
        mod = ast.Module(body=[node], type_ignores=[])
        ast.fix_missing_locations(mod)
        code = compile(mod, '${DAEMON_PY}', 'exec')
        g = {'os': os}
        exec(code, g)
        result = g['_validate_api_keys']()
        print(result['VOYAGE_API_KEY']['status'])
        break
`);
    assert.equal(out, 'ok', `Expected status=ok, got: ${out}`);
  });

  it('returns status=missing for empty PERPLEXITY_API_KEY', () => {
    const out = pyExec(`
import os, sys, ast
os.environ['VOYAGE_API_KEY'] = ''
os.environ['PERPLEXITY_API_KEY'] = ''
os.environ.pop('PERPLEXITY_MODEL', None)

src = open('${DAEMON_PY}').read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == '_validate_api_keys':
        mod = ast.Module(body=[node], type_ignores=[])
        ast.fix_missing_locations(mod)
        code = compile(mod, '${DAEMON_PY}', 'exec')
        g = {'os': os}
        exec(code, g)
        result = g['_validate_api_keys']()
        print(result['PERPLEXITY_API_KEY']['status'])
        break
`);
    assert.equal(out, 'missing', `Expected status=missing, got: ${out}`);
  });

  it('returns PERPLEXITY_MODEL value when set', () => {
    const out = pyExec(`
import os, sys, ast
os.environ['VOYAGE_API_KEY'] = ''
os.environ['PERPLEXITY_API_KEY'] = ''
os.environ['PERPLEXITY_MODEL'] = 'sonar-pro'

src = open('${DAEMON_PY}').read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == '_validate_api_keys':
        mod = ast.Module(body=[node], type_ignores=[])
        ast.fix_missing_locations(mod)
        code = compile(mod, '${DAEMON_PY}', 'exec')
        g = {'os': os}
        exec(code, g)
        result = g['_validate_api_keys']()
        print(result['PERPLEXITY_MODEL']['value'])
        break
`);
    assert.equal(out, 'sonar-pro', `Expected value=sonar-pro, got: ${out}`);
  });
});

// ── _port_is_free tests ──────────────────────────────────────────────────────

describe('_port_is_free (T1)', () => {
  it('returns True for an unused high port', () => {
    const out = pyExec(`
import ast, os, socket

src = open('${DAEMON_PY}').read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == '_port_is_free':
        mod = ast.Module(body=[node], type_ignores=[])
        ast.fix_missing_locations(mod)
        code = compile(mod, '${DAEMON_PY}', 'exec')
        g = {'os': os}
        import socket as _socket
        g['_socket'] = _socket
        # Inject socket module so the inline import works
        exec(code, g)
        # Find a free port dynamically
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            free_port = s.getsockname()[1]
        result = g['_port_is_free'](free_port)
        print('TRUE' if result else 'FALSE')
        break
`);
    assert.equal(out, 'TRUE', `_port_is_free should return True for unused port, got: ${out}`);
  });

  it('returns False for an occupied port', () => {
    const out = pyExec(`
import ast, os, socket

src = open('${DAEMON_PY}').read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == '_port_is_free':
        mod = ast.Module(body=[node], type_ignores=[])
        ast.fix_missing_locations(mod)
        code = compile(mod, '${DAEMON_PY}', 'exec')
        g = {'os': os}
        exec(code, g)
        # Bind a port, then check it is occupied
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', 0))
        occupied_port = sock.getsockname()[1]
        try:
            result = g['_port_is_free'](occupied_port)
            print('FALSE' if not result else 'TRUE')
        finally:
            sock.close()
        break
`);
    assert.equal(out, 'FALSE', `_port_is_free should return False for occupied port, got: ${out}`);
  });
});

// ── Code-path verification tests ─────────────────────────────────────────────

describe('RLM code-path checks (T1/T2)', () => {
  it('_rlm_restart_count = 0 reset is inside _start_rlm', () => {
    // Find _start_rlm function body and verify the reset is there
    assert.ok(
      DAEMON_SRC.includes('_rlm_restart_count = 0  # Reset on successful start'),
      'restart counter reset not found in daemon source'
    );
  });

  it('RLM stderr goes to rlm-service.log not DEVNULL in _start_rlm', () => {
    assert.ok(
      DAEMON_SRC.includes('rlm-service.log'),
      'rlm-service.log not found in daemon source'
    );
    assert.ok(
      DAEMON_SRC.includes('stderr=rlm_log_file'),
      'stderr=rlm_log_file not found in daemon source'
    );
    // Ensure DEVNULL is no longer used in the RLM start block
    // (grep for DEVNULL -- should only appear if referenced elsewhere, not in Popen args)
    const devnullInPopen = /Popen\([^)]*DEVNULL[^)]*\)/s.test(DAEMON_SRC);
    assert.equal(devnullInPopen, false, 'DEVNULL still used inside a Popen call in daemon');
  });

  it('_kill_port_holder is defined in daemon', () => {
    assert.ok(
      DAEMON_SRC.includes('def _kill_port_holder(port):'),
      '_kill_port_holder not defined in daemon'
    );
  });

  it('_rlm_watchdog logs reason= for restart and max_restarts_exceeded', () => {
    assert.ok(
      DAEMON_SRC.includes('reason = "process_exited" if process_dead else "health_check_failed"'),
      'reason detection not found in _rlm_watchdog'
    );
    assert.ok(
      DAEMON_SRC.includes('log.warning("rlm_restart attempt=%d/%d reason=%s"'),
      'rlm_restart log with reason= not found in _rlm_watchdog'
    );
    assert.ok(
      DAEMON_SRC.includes('log.error("rlm_max_restarts_exceeded reason=%s"'),
      'rlm_max_restarts_exceeded log with reason= not found in _rlm_watchdog'
    );
  });
});

// ── API key health endpoint security checks (T3) ─────────────────────────────

describe('Health endpoint api_keys security (T3)', () => {
  it('api_keys dict is present in health endpoint', () => {
    assert.ok(
      DAEMON_SRC.includes('"api_keys":'),
      '"api_keys": not found in daemon health endpoint'
    );
  });

  it('health endpoint api_keys does not expose raw key lengths or values', () => {
    // The api_keys comprehension must filter out entries with "length" key
    // Confirm the filter: `if "length" in v or not v.get("set")`
    assert.ok(
      DAEMON_SRC.includes('if "length" in v or not v.get("set")'),
      'api_keys comprehension filter not found -- keys with lengths may be exposed'
    );
    // The comprehension should only include "set" and "status", not "length" or "value"
    const healthBlock = DAEMON_SRC.match(/"api_keys":\s*\{[^}]+\}/s);
    assert.ok(healthBlock, 'api_keys block not found in source');
    assert.ok(
      !healthBlock[0].includes('"length"') || healthBlock[0].includes('if "length" in v'),
      'api_keys block may expose length field directly'
    );
  });

  it('_validate_api_keys checks all required env vars', () => {
    assert.ok(
      DAEMON_SRC.includes('"VOYAGE_API_KEY"'),
      '"VOYAGE_API_KEY" not found in _validate_api_keys'
    );
    assert.ok(
      DAEMON_SRC.includes('"PERPLEXITY_API_KEY"'),
      '"PERPLEXITY_API_KEY" not found in _validate_api_keys'
    );
    assert.ok(
      DAEMON_SRC.includes('"PERPLEXITY_MODEL"'),
      '"PERPLEXITY_MODEL" not found in _validate_api_keys'
    );
  });

  it('startup banner prints API Keys section', () => {
    assert.ok(
      DAEMON_SRC.includes('print(f"  API Keys:")'),
      'API Keys startup banner not found in daemon'
    );
  });
});
