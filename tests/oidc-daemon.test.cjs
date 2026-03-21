/**
 * OIDC/SSO Integration Tests — daemon wiring
 *
 * Tests SSO-01 through SSO-05 via the daemon source code:
 *   - oidc_auth.py module exists with OIDCAuth class (SSO-01)
 *   - Daemon imports and initializes OIDC module (SSO-01)
 *   - Health endpoint bypasses OIDC (SSO-03)
 *   - All API endpoints check OIDC when enabled (SSO-03)
 *   - Sub claim available for audit logging (SSO-04)
 *   - Graceful degradation without env vars (SSO-05)
 *   - Configuration via env vars (SSO-02)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVICES = path.join(ROOT, 'services');
const OIDC_MODULE = path.join(SERVICES, 'oidc_auth.py');
const DAEMON_FILE = path.join(SERVICES, 'amauta-daemon.py');

function pyEval(code, env = {}) {
  try {
    const result = execFileSync('python3', ['-c', `
import sys, json, os
sys.path.insert(0, '${SERVICES}')
${code}
`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
      env: { ...process.env, ...env },
    });
    return result.trim();
  } catch (err) {
    return (err.stdout || '').toString().trim() || (err.stderr || '').toString().trim();
  }
}

// Helper: build a fake JWT
function makeJWT(payload) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = (obj) => {
    const json = JSON.stringify(obj);
    return Buffer.from(json).toString('base64url');
  };
  return `${encode(header)}.${encode(payload)}.fakesig`;
}

// ═══════════════════════════════════════════════════════
// Module existence and structure
// ═══════════════════════════════════════════════════════

describe('OIDC module structure (SSO-01)', () => {
  test('oidc_auth.py exists in services/', () => {
    assert.ok(fs.existsSync(OIDC_MODULE), 'services/oidc_auth.py should exist');
  });

  test('oidc_auth.py contains OIDCAuth class', () => {
    const source = fs.readFileSync(OIDC_MODULE, 'utf-8');
    assert.ok(source.includes('class OIDCAuth'), 'Should define OIDCAuth class');
  });

  test('OIDCAuth has is_enabled method', () => {
    const source = fs.readFileSync(OIDC_MODULE, 'utf-8');
    assert.ok(source.includes('def is_enabled'), 'Should have is_enabled method');
  });

  test('OIDCAuth has validate_token method', () => {
    const source = fs.readFileSync(OIDC_MODULE, 'utf-8');
    assert.ok(source.includes('def validate_token'), 'Should have validate_token method');
  });

  test('OIDCAuth has fetch_jwks method', () => {
    const source = fs.readFileSync(OIDC_MODULE, 'utf-8');
    assert.ok(source.includes('def fetch_jwks'), 'Should have fetch_jwks method');
  });

  test('OIDCAuth uses only stdlib imports', () => {
    const source = fs.readFileSync(OIDC_MODULE, 'utf-8');
    // Should NOT import any external packages
    const lines = source.split('\n').filter(l => l.startsWith('import ') || l.startsWith('from '));
    const allowedModules = ['base64', 'json', 'logging', 'os', 'time', 'urllib', 'urllib.request'];
    for (const line of lines) {
      const mod = line.replace(/^(?:from |import )/, '').split(/[ .]/)[0];
      assert.ok(
        allowedModules.some(a => mod === a || a.startsWith(mod)),
        `Unexpected import: ${line} — only stdlib allowed`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════
// Daemon wiring (SSO-03)
// ═══════════════════════════════════════════════════════

describe('Daemon OIDC wiring (SSO-03)', () => {
  let daemonSource;

  test('daemon imports oidc_auth', () => {
    daemonSource = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      daemonSource.includes('from oidc_auth import OIDCAuth'),
      'Daemon should import OIDCAuth'
    );
  });

  test('daemon has _check_oidc function', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      daemonSource.includes('def _check_oidc('),
      'Daemon should have _check_oidc function'
    );
  });

  test('do_GET calls _check_oidc', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    // Find do_GET method and verify it calls _check_oidc
    const doGetIdx = daemonSource.indexOf('def do_GET(self)');
    const doPostIdx = daemonSource.indexOf('def do_POST(self)');
    const doGetBody = daemonSource.slice(doGetIdx, doPostIdx);
    assert.ok(
      doGetBody.includes('_check_oidc'),
      'do_GET should call _check_oidc'
    );
  });

  test('do_POST calls _check_oidc', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    const doPostIdx = daemonSource.indexOf('def do_POST(self)');
    const doPostBody = daemonSource.slice(doPostIdx, doPostIdx + 2000);
    assert.ok(
      doPostBody.includes('_check_oidc'),
      'do_POST should call _check_oidc'
    );
  });

  test('health endpoint bypasses OIDC', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    // _check_oidc should skip /health
    const checkFn = daemonSource.slice(
      daemonSource.indexOf('def _check_oidc('),
      daemonSource.indexOf('# ── Rate Limiting')
    );
    assert.ok(
      checkFn.includes('/health'),
      '_check_oidc should bypass /health'
    );
  });

  test('metrics endpoint bypasses OIDC', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    const checkFn = daemonSource.slice(
      daemonSource.indexOf('def _check_oidc('),
      daemonSource.indexOf('# ── Rate Limiting')
    );
    assert.ok(
      checkFn.includes('/metrics'),
      '_check_oidc should bypass /metrics'
    );
  });

  test('OIDC failure returns 401', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    const doGetIdx = daemonSource.indexOf('def do_GET(self)');
    const doGetSection = daemonSource.slice(doGetIdx, doGetIdx + 1000);
    assert.ok(
      doGetSection.includes('401'),
      'Invalid OIDC token should return 401'
    );
  });

  test('OIDC init in start_server', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      daemonSource.includes('_oidc = OIDCAuth()'),
      'start_server should initialize OIDCAuth'
    );
  });

  test('health endpoint reports OIDC status', () => {
    daemonSource = daemonSource || fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      daemonSource.includes('oidc_enabled'),
      'Health response should include oidc_enabled field'
    );
  });
});

// ═══════════════════════════════════════════════════════
// SSO-02: Configuration via env vars (Python unit)
// ═══════════════════════════════════════════════════════

describe('OIDC configuration via env vars (SSO-02)', () => {
  test('OIDCAuth disabled when no env vars set', () => {
    const r = pyEval(`
os.environ.pop('GSD_OIDC_ISSUER', None)
os.environ.pop('GSD_OIDC_CLIENT_ID', None)
from oidc_auth import OIDCAuth
auth = OIDCAuth()
print(auth.is_enabled())
`, {
      GSD_OIDC_ISSUER: '',
      GSD_OIDC_CLIENT_ID: '',
    });
    assert.strictEqual(r, 'False');
  });

  test('OIDCAuth enabled when both vars set', () => {
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
print(auth.is_enabled())
`);
    assert.strictEqual(r, 'True');
  });

  test('audience defaults to client_id when GSD_OIDC_AUDIENCE not set', () => {
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'my-client-id'
os.environ.pop('GSD_OIDC_AUDIENCE', None)
from oidc_auth import OIDCAuth
auth = OIDCAuth()
print(auth.audience)
`);
    assert.strictEqual(r, 'my-client-id');
  });

  test('GSD_OIDC_AUDIENCE overrides client_id for audience', () => {
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'my-client-id'
os.environ['GSD_OIDC_AUDIENCE'] = 'custom-aud'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
print(auth.audience)
`);
    assert.strictEqual(r, 'custom-aud');
  });
});

// ═══════════════════════════════════════════════════════
// SSO-05: Graceful degradation
// ═══════════════════════════════════════════════════════

describe('Graceful degradation (SSO-05)', () => {
  test('validate_token passes through when disabled', () => {
    const r = pyEval(`
os.environ.pop('GSD_OIDC_ISSUER', None)
os.environ.pop('GSD_OIDC_CLIENT_ID', None)
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('any-token')
print(json.dumps(result))
`, {
      GSD_OIDC_ISSUER: '',
      GSD_OIDC_CLIENT_ID: '',
    });
    const result = JSON.parse(r);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.sub, 'anonymous');
  });

  test('daemon gracefully handles missing oidc_auth module', () => {
    const daemonSource = fs.readFileSync(DAEMON_FILE, 'utf-8');
    // Verify try/except around import
    assert.ok(
      daemonSource.includes('except ImportError:') &&
      daemonSource.includes('_HAS_OIDC_MODULE'),
      'Daemon should catch ImportError for oidc_auth'
    );
  });

  test('_check_oidc returns valid when _oidc is None', () => {
    const daemonSource = fs.readFileSync(DAEMON_FILE, 'utf-8');
    const checkFn = daemonSource.slice(
      daemonSource.indexOf('def _check_oidc('),
      daemonSource.indexOf('# ── Rate Limiting')
    );
    assert.ok(
      checkFn.includes('_oidc is None') || checkFn.includes('not _oidc'),
      '_check_oidc should handle _oidc being None'
    );
  });
});

// ═══════════════════════════════════════════════════════
// SSO-04: Sub claim for audit (Python unit)
// ═══════════════════════════════════════════════════════

describe('Sub claim extraction for audit (SSO-04)', () => {
  test('sub extracted from valid token', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: 'user-42',
      iss: 'https://auth.test.com',
      aud: 'test-client',
      exp: now + 3600,
    };
    const token = makeJWT(payload);
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('${token}')
print(result['sub'])
`);
    assert.strictEqual(r, 'user-42');
  });

  test('email extracted from token', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: 'user-42',
      email: 'admin@example.com',
      iss: 'https://auth.test.com',
      aud: 'test-client',
      exp: now + 3600,
    };
    const token = makeJWT(payload);
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('${token}')
print(result['email'])
`);
    assert.strictEqual(r, 'admin@example.com');
  });

  test('daemon stores oidc_sub on handler instance', () => {
    const daemonSource = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      daemonSource.includes('self._oidc_sub'),
      'Handler should store _oidc_sub for audit logging'
    );
  });
});

// ═══════════════════════════════════════════════════════
// SSO-01: Token validation edge cases (Python unit)
// ═══════════════════════════════════════════════════════

describe('Token validation edge cases (SSO-01)', () => {
  test('expired token rejected', () => {
    const payload = {
      sub: 'user-42',
      iss: 'https://auth.test.com',
      aud: 'test-client',
      exp: Math.floor(Date.now() / 1000) - 60,
    };
    const token = makeJWT(payload);
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('${token}')
print(result['valid'])
`);
    assert.strictEqual(r, 'False');
  });

  test('wrong issuer rejected', () => {
    const payload = {
      sub: 'user-42',
      iss: 'https://evil.com',
      aud: 'test-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = makeJWT(payload);
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('${token}')
print(result['valid'])
`);
    assert.strictEqual(r, 'False');
  });

  test('wrong audience rejected', () => {
    const payload = {
      sub: 'user-42',
      iss: 'https://auth.test.com',
      aud: 'wrong-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = makeJWT(payload);
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('${token}')
print(result['valid'])
`);
    assert.strictEqual(r, 'False');
  });

  test('malformed JWT rejected (2 parts)', () => {
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('header.payload')
print(result['valid'])
`);
    assert.strictEqual(r, 'False');
  });

  test('empty string token rejected when enabled', () => {
    const r = pyEval(`
os.environ['GSD_OIDC_ISSUER'] = 'https://auth.test.com'
os.environ['GSD_OIDC_CLIENT_ID'] = 'test-client'
from oidc_auth import OIDCAuth
auth = OIDCAuth()
result = auth.validate_token('')
print(result['valid'])
`);
    assert.strictEqual(r, 'False');
  });
});
