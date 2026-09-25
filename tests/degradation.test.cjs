/**
 * GSD-Amauta Degradation Tests
 *
 * Tests that CLI tools degrade gracefully when PG/daemon are unavailable.
 * These tests deliberately point to a non-existent daemon port to simulate
 * missing infrastructure.
 *
 * TK-0059
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MEMORY_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

/**
 * Run a CLI tool with the daemon port set to an unused port (59999)
 * to simulate daemon-not-running conditions.
 *
 * TK-2386: these assertions were written when a silent degrade to file mode
 * at exit 0 WAS the intended contract (TK-0059), so every `assert.ok(r.success)`
 * below was pinning what later turned out to be the defect: on 2026-09-13 six
 * learnings were reported "Stored" at exit 0 and none of them was retrievable,
 * because the answer had come from .planning files rather than PG and nothing
 * in the exit code distinguished the two. File mode itself is still a real
 * case for an operator with no daemon, so it survives behind an explicit
 * opt-in — and these tests now take that opt-in deliberately, which is exactly
 * what they were always testing. The DEFAULT (no opt-in) is asserted to refuse
 * at a non-zero exit in tests/86-01-memory-cli-retrievability.test.cjs.
 */
function runNoDaemon(cliPath, args, cwd = process.cwd()) {
  try {
    const result = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GSD_AMAUTA_PORT: '59999',         // Non-existent port → ECONNREFUSED
        GSD_AMAUTA_HOST: '127.0.0.1',
        GSD_AMAUTA_NO_AUTO_START: '1',    // Skip 5s daemon startup wait in tests
        GSD_MEMORY_FILE_MODE: '1',        // TK-2386: opt in to degraded file mode ON PURPOSE
      },
      cwd,
      timeout: 10000,
    });
    return { success: true, output: result.trim(), stderr: '' };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
      code: err.status,
    };
  }
}

function memoryNoDaemon(args, cwd) { return runNoDaemon(MEMORY_CLI, args, cwd); }

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('Degradation: no daemon/PG', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-degrade-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Memory file-based fallback ───────────────────

  describe('gsd-memory.cjs file fallback', () => {
    test('store falls back to file', () => {
      const r = memoryNoDaemon(['store', 'Test file fallback entry', '--source', 'agent'], tmpDir);
      assert.ok(r.success, `store should succeed in file mode: ${r.stderr}`);
      assert.ok(r.output.includes('file mode'), `should indicate file mode: ${r.output}`);

      // Verify file was created
      const memDir = path.join(tmpDir, '.planning', 'memory');
      assert.ok(fs.existsSync(memDir), 'memory dir should exist');
      const files = fs.readdirSync(memDir);
      assert.ok(files.length > 0, 'should have memory file');
      const content = fs.readFileSync(path.join(memDir, files[0]), 'utf-8');
      assert.ok(content.includes('Test file fallback entry'), 'file should contain entry');
    });

    test('search falls back to file', () => {
      // First store something
      memoryNoDaemon(['store', 'PostgreSQL connection pooling works great', '--source', 'agent'], tmpDir);

      const r = memoryNoDaemon(['search', 'PostgreSQL pooling'], tmpDir);
      assert.ok(r.success, `search should succeed in file mode: ${r.stderr}`);
      // Should find the entry via file-based keyword search
      assert.ok(
        r.output.includes('file mode') || r.output.includes('PostgreSQL'),
        `should indicate file mode or find result: ${r.output}`
      );
    });

    test('learn falls back to STATE.md', () => {
      const r = memoryNoDaemon(['learn', 'Important learning about file fallback'], tmpDir);
      assert.ok(r.success, `learn should succeed in file mode: ${r.stderr}`);
      assert.ok(r.output.includes('file mode'), `should indicate file mode: ${r.output}`);

      // Verify STATE.md was created/updated
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      assert.ok(fs.existsSync(statePath), 'STATE.md should exist');
      const content = fs.readFileSync(statePath, 'utf-8');
      assert.ok(content.includes('Important learning about file fallback'), 'STATE.md should contain learning');
      assert.ok(content.includes('Learnings') || content.includes('LEARNINGS'), 'STATE.md should have Learnings section');
    });

    test('list falls back to file', () => {
      // Store a few entries first
      memoryNoDaemon(['store', 'First fallback entry'], tmpDir);
      memoryNoDaemon(['store', 'Second fallback entry'], tmpDir);

      const r = memoryNoDaemon(['list'], tmpDir);
      assert.ok(r.success, `list should succeed in file mode: ${r.stderr}`);
      assert.ok(
        r.output.includes('file mode') || r.output.includes('entries'),
        `should indicate file mode: ${r.output}`
      );
    });

    test('count falls back to file', () => {
      memoryNoDaemon(['store', 'Count test entry'], tmpDir);

      const r = memoryNoDaemon(['count'], tmpDir);
      assert.ok(r.success, `count should succeed in file mode: ${r.stderr}`);
      assert.ok(r.output.includes('file mode'), `should indicate file mode: ${r.output}`);
      assert.ok(r.output.match(/\d+/), 'should contain a number');
    });

    test('search --json returns file mode indicator', () => {
      memoryNoDaemon(['store', 'JSON mode test'], tmpDir);

      const r = memoryNoDaemon(['search', 'JSON mode', '--json'], tmpDir);
      assert.ok(r.success, `search --json should succeed: ${r.stderr}`);
      const json = JSON.parse(r.output);
      assert.strictEqual(json.mode, 'file', 'should indicate file mode in JSON');
    });
  });

  // ─── Tag inference (no daemon needed) ─────────────

  describe('infer-tags (no daemon needed)', () => {
    test('works without daemon', () => {
      // Create a package.json in tmpDir
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        dependencies: { react: '18.0.0', 'react-dom': '18.0.0' },
        devDependencies: { typescript: '5.0.0', vitest: '1.0.0' },
      }));

      const r = memoryNoDaemon(['infer-tags', tmpDir, '--json'], tmpDir);
      assert.ok(r.success, `infer-tags should work without daemon: ${r.stderr}`);
      const json = JSON.parse(r.output);
      assert.ok(json.tags.includes('react'), 'should detect react');
      assert.ok(json.tags.includes('typescript'), 'should detect typescript');
      assert.ok(json.tags.includes('vitest'), 'should detect vitest');
      assert.ok(json.tags.includes('javascript'), 'should detect javascript');
    });

    test('handles empty directory', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-empty-'));
      try {
        const r = memoryNoDaemon(['infer-tags', emptyDir, '--json'], tmpDir);
        assert.ok(r.success, `should succeed on empty dir: ${r.stderr}`);
        const json = JSON.parse(r.output);
        assert.strictEqual(json.tags.length, 0, 'should have no tags for empty dir');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    test('detects Python project', () => {
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\npsycopg2-binary==2.9\npytest==8.0\n');

      const r = memoryNoDaemon(['infer-tags', tmpDir, '--json'], tmpDir);
      assert.ok(r.success);
      const json = JSON.parse(r.output);
      assert.ok(json.tags.includes('python'), 'should detect python');
      assert.ok(json.tags.includes('flask'), 'should detect flask');
      assert.ok(json.tags.includes('postgresql'), 'should detect postgresql from psycopg');
      assert.ok(json.tags.includes('pytest'), 'should detect pytest');
    });

    test('detects Dockerfile base image', () => {
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n');

      const r = memoryNoDaemon(['infer-tags', tmpDir, '--json'], tmpDir);
      assert.ok(r.success);
      const json = JSON.parse(r.output);
      assert.ok(json.tags.includes('docker'), 'should detect docker');
      assert.ok(json.tags.includes('nodejs'), 'should detect nodejs from base image');
    });
  });

  // ─── Health when daemon is down ───────────────────

  describe('health when daemon down', () => {
    test('memory health reports error', () => {
      const r = memoryNoDaemon(['health'], tmpDir);
      // Should fail with error about daemon not running
      assert.ok(!r.success, 'health should fail when daemon not running');
      const combined = r.output + ' ' + r.stderr;
      assert.ok(
        combined.includes('not reachable') || combined.includes('Daemon') || combined.includes('Error'),
        `should indicate daemon unreachable: ${combined.slice(0, 200)}`
      );
    });
  });

  // ─── tryDaemon 500/ECONNREFUSED → file fallback ───

  describe('tryDaemon write fallback on daemon down', () => {
    test('memory store falls back to file mode when daemon unreachable', () => {
      const r = memoryNoDaemon(['store', 'test learning entry', '--source', 'agent'], tmpDir);
      // Should succeed (fall back to file mode) or produce [file mode] indicator
      // ECONNREFUSED → tryDaemon returns null → file fallback
      const combined = r.output + ' ' + r.stderr;
      assert.ok(
        r.success || combined.includes('file mode') || combined.includes('STATE.md'),
        `store should degrade gracefully: ${combined.slice(0, 300)}`
      );
    });

    test('memory store stderr warns when falling back to file mode', () => {
      const r = memoryNoDaemon(['store', 'another test entry', '--source', 'agent'], tmpDir);
      // After our fix, tryDaemon emits a warning to stderr on POST when daemon is down
      // This test verifies the warning is present
      const hasFallback = r.stderr.includes('Daemon unreachable') || r.stderr.includes('file mode') ||
                          r.output.includes('file mode') || r.output.includes('STATE.md');
      assert.ok(hasFallback,
        `store should warn about file mode fallback: stdout=${r.output.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`
      );
    });

    test('memory learn falls back to file mode when daemon unreachable', () => {
      const r = memoryNoDaemon(['learn', 'test auto learning entry'], tmpDir);
      const combined = r.output + ' ' + r.stderr;
      assert.ok(
        r.success || combined.includes('file mode') || combined.includes('STATE.md'),
        `learn should degrade gracefully: ${combined.slice(0, 300)}`
      );
    });

    test('SKB commands fail with clear message when daemon unreachable', () => {
      const r = memoryNoDaemon(['skb-list'], tmpDir);
      assert.ok(!r.success, 'skb-list should fail without daemon');
      const combined = r.output + ' ' + r.stderr;
      assert.ok(
        combined.includes('PostgreSQL') || combined.includes('Daemon') || combined.includes('SKB requires'),
        `should indicate PG required: ${combined.slice(0, 200)}`
      );
    });
  });
});
