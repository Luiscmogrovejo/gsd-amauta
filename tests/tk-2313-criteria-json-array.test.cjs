/**
 * TK-2313 — list-valued flags (--criteria, --deliverables, --checklist, --refs)
 * are a JSON array on the wire, never a pipe-split string.
 *
 * At a95f645 amauta.py split these values on "|" (cmd_add :2544/2546/2548/2552,
 * cmd_update :2696/2698/2700), so a criterion that cites `a | grep b` was cut into
 * fragments and the caller saw a green "Created"/"Updated" line. TK-2322 measured
 * 497 of 2440 store items affected. These tests pin the replacement contract:
 *
 *   C1  a criterion containing a literal pipe round-trips whole (add -> show --json)
 *   C2  update replaces with the array and touches only the fields sent; a non-array
 *       value exits non-zero, names the flag, and stores nothing
 *   D1  --<flag>-file siblings; refusals name the first offending character
 *   D2  every caller emits JSON: gsd-tools.cjs plan-to-tasks (source pin) and the
 *       daemon's _build_args hop (executed from source, no server started)
 *   C3  no split("|") site remains in amauta.py
 *   D3  the TK-2322 detector's negative arm: no stored element is a pipe-fragment
 *
 * Provenance: set TK2313_ROOT_UNDER_TEST to a tree holding amauta.py,
 * services/amauta-daemon.py and get-shit-done/bin/gsd-tools.cjs to run the same
 * assertions against another commit (the a95f645 control arm). The md5 of every
 * file read is printed so the run is attributable.
 *
 * Run: node --test tests/tk-2313-criteria-json-array.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = process.env.TK2313_ROOT_UNDER_TEST || path.join(__dirname, '..');
const PY = path.join(ROOT, 'amauta.py');
const DAEMON_PY = path.join(ROOT, 'services', 'amauta-daemon.py');
const TOOLS_CJS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
// A port nothing listens on: the python CLI must never reach a daemon from here.
const PORT = process.env.TK2313_TEST_PORT || '18914';

function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
for (const f of [PY, DAEMON_PY, TOOLS_CJS]) {
  process.stdout.write(`[tk-2313] under test: ${f} md5=${md5(f)}\n`);
}

function withTmp(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tk2313-'));
  try { fn(d); } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

function py(args, dataDir) {
  const r = spawnSync('python3', [PY, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, AMAUTA_DATA_DIR: dataDir, NO_COLOR: '1',
           GSD_AMAUTA_PORT: PORT, GSD_AMAUTA_NO_AUTO_START: '1' },
    cwd: dataDir, timeout: 20000,
  });
  const strip = s => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
  return { code: r.status, out: strip(r.stdout).trim(), err: strip(r.stderr).trim(),
           all: strip(r.stdout) + '\n' + strip(r.stderr) };
}

function idOf(out) { const m = out.match(/TK-\d+/); return m ? m[0] : null; }

function showJson(id, d) {
  const r = py(['show', id, '--json'], d);
  assert.strictEqual(r.code, 0, `show ${id} failed: ${r.all}`);
  return JSON.parse(r.out);
}

function readTasks(d) {
  const p = path.join(d, 'tasks.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : { items: [] };
}

const PIPE_CRITERION = 'run a | grep b exits 0';

describe('TK-2313 C1 — a criterion with a literal pipe round-trips whole', () => {
  test('C1: add --criteria JSON array, show --json reads back exactly the array', () => withTmp(d => {
    const r = py(['add', 'task', 't', '--criteria', JSON.stringify([PIPE_CRITERION, 'second'])], d);
    assert.strictEqual(r.code, 0, r.all);
    const tk = idOf(r.out);
    assert.ok(tk, `no TK id in: ${r.out}`);
    const item = showJson(tk, d);
    assert.deepStrictEqual(item.success_criteria, [PIPE_CRITERION, 'second']);
    assert.strictEqual(item.success_criteria.length, 2);
    assert.ok(item.success_criteria[0].includes('|'), 'first criterion must keep its pipe');
  }));

  test('D3: TK-2322 detector negative arm — no stored element is a pipe-fragment of an authored criterion', () => withTmp(d => {
    const authored = ['`grep "foo\\|bar" src/x.py` exits 0', 'jq \'.a | .b\' out.json prints 1', 'plain'];
    const r = py(['add', 'task', 'detector', '--criteria', JSON.stringify(authored)], d);
    assert.strictEqual(r.code, 0, r.all);
    const stored = showJson(idOf(r.out), d).success_criteria;
    assert.deepStrictEqual(stored, authored);
    for (const a of authored.filter(x => x.includes('|'))) {
      for (const frag of a.split('|').map(s => s.trim())) {
        assert.ok(!stored.includes(frag), `pipe-fragment ${JSON.stringify(frag)} was stored as its own element`);
      }
    }
  }));
});

describe('TK-2313 C2 — update replaces with the array, and only the fields sent', () => {
  function seeded(d) {
    const r = py(['add', 'task', 'seed',
      '--criteria', JSON.stringify(['c1', 'c2 | c3']),
      '--deliverables', JSON.stringify(['d1']),
      '--checklist', JSON.stringify(['k1', 'k2'])], d);
    assert.strictEqual(r.code, 0, r.all);
    return idOf(r.out);
  }

  test('C2: update --criteria replaces success_criteria and touches no other list', () => withTmp(d => {
    const tk = seeded(d);
    const r = py(['update', tk, '--criteria', JSON.stringify(['new | one'])], d);
    assert.strictEqual(r.code, 0, r.all);
    const item = showJson(tk, d);
    assert.deepStrictEqual(item.success_criteria, ['new | one']);
    assert.deepStrictEqual(item.deliverables, ['d1']);
    assert.deepStrictEqual(item.validation_checklist, ['k1', 'k2']);
  }));

  test('C2: update --deliverables replaces deliverables and touches no other list', () => withTmp(d => {
    const tk = seeded(d);
    const r = py(['update', tk, '--deliverables', JSON.stringify(['x | y', 'z'])], d);
    assert.strictEqual(r.code, 0, r.all);
    const item = showJson(tk, d);
    assert.deepStrictEqual(item.deliverables, ['x | y', 'z']);
    assert.deepStrictEqual(item.success_criteria, ['c1', 'c2 | c3']);
    assert.deepStrictEqual(item.validation_checklist, ['k1', 'k2']);
  }));

  test('C2: update --checklist replaces validation_checklist only', () => withTmp(d => {
    const tk = seeded(d);
    const r = py(['update', tk, '--checklist', JSON.stringify(['only | this'])], d);
    assert.strictEqual(r.code, 0, r.all);
    const item = showJson(tk, d);
    assert.deepStrictEqual(item.validation_checklist, ['only | this']);
    assert.deepStrictEqual(item.success_criteria, ['c1', 'c2 | c3']);
    assert.deepStrictEqual(item.deliverables, ['d1']);
  }));

  test('C2: update --criteria "a|b" exits non-zero, names the flag, stores nothing', () => withTmp(d => {
    const tk = seeded(d);
    const before = JSON.stringify(readTasks(d));
    const r = py(['update', tk, '--criteria', 'a|b'], d);
    assert.notStrictEqual(r.code, 0, 'a non-array value must be refused');
    assert.ok(r.all.includes('--criteria'), `refusal must name the flag: ${r.all}`);
    assert.strictEqual(JSON.stringify(readTasks(d)), before, 'store must be byte-identical after a refusal');
    assert.deepStrictEqual(showJson(tk, d).success_criteria, ['c1', 'c2 | c3']);
  }));
});

describe('TK-2313 D1 — the wire format is a JSON array; anything else is refused loudly', () => {
  test('D1: add --criteria "a|b" exits non-zero, names the flag and the first offending character, creates no task', () => withTmp(d => {
    const r = py(['add', 'task', 't', '--criteria', 'a|b'], d);
    assert.notStrictEqual(r.code, 0);
    assert.ok(r.all.includes('--criteria'), r.all);
    assert.ok(/'a'/.test(r.all) && /offset 0/.test(r.all), `must name char and offset: ${r.all}`);
    assert.strictEqual(readTasks(d).items.length, 0, 'no task may be created on refusal');
  }));

  test('D1: JSON that is not an array of strings is refused (object; non-string element; bare string)', () => withTmp(d => {
    for (const bad of ['{"a":1}', '["ok", 2]', '"just a string"', '']) {
      const r = py(['add', 'task', 't', '--deliverables', bad], d);
      assert.notStrictEqual(r.code, 0, `must refuse ${JSON.stringify(bad)}`);
      assert.ok(r.all.includes('--deliverables'), `refusal must name --deliverables for ${JSON.stringify(bad)}: ${r.all}`);
    }
    assert.strictEqual(readTasks(d).items.length, 0);
  }));

  test('D1: --criteria-file reads the array from a file; giving both forms is refused', () => withTmp(d => {
    const f = path.join(d, 'criteria.json');
    fs.writeFileSync(f, JSON.stringify([PIPE_CRITERION, 'from file']));
    const r = py(['add', 'task', 't', '--criteria-file', f], d);
    assert.strictEqual(r.code, 0, r.all);
    assert.deepStrictEqual(showJson(idOf(r.out), d).success_criteria, [PIPE_CRITERION, 'from file']);
    const both = py(['add', 'task', 't2', '--criteria', '["x"]', '--criteria-file', f], d);
    assert.notStrictEqual(both.code, 0, 'both --criteria and --criteria-file must be refused');
    const missing = py(['add', 'task', 't3', '--criteria-file', path.join(d, 'nope.json')], d);
    assert.notStrictEqual(missing.code, 0);
    assert.ok(missing.all.includes('--criteria-file'), missing.all);
  }));

  test('D1: --refs accepts a JSON array and attaches doc_refs with the paths whole', () => withTmp(d => {
    const refs = ['src/a|b.py', 'docs/notes.md'];
    const r = py(['add', 'task', 't', '--refs', JSON.stringify(refs)], d);
    assert.strictEqual(r.code, 0, r.all);
    const item = showJson(idOf(r.out), d);
    assert.deepStrictEqual(item.doc_refs.map(x => x.path), refs);
    const bad = py(['add', 'task', 't2', '--refs', 'r1|r2'], d);
    assert.notStrictEqual(bad.code, 0);
    assert.ok(bad.all.includes('--refs'), bad.all);
  }));

  test('D1: update --criteria-file works and an update with no list flag changes no list', () => withTmp(d => {
    const r = py(['add', 'task', 't', '--criteria', JSON.stringify(['keep | me'])], d);
    const tk = idOf(r.out);
    const f = path.join(d, 'c.json');
    fs.writeFileSync(f, JSON.stringify(['replaced | whole']));
    const u = py(['update', tk, '--criteria-file', f], d);
    assert.strictEqual(u.code, 0, u.all);
    assert.deepStrictEqual(showJson(tk, d).success_criteria, ['replaced | whole']);
    const t = py(['update', tk, '--title', 'renamed'], d);
    assert.strictEqual(t.code, 0, t.all);
    assert.deepStrictEqual(showJson(tk, d).success_criteria, ['replaced | whole']);
  }));
});

describe('TK-2313 C3/D2 — no split path remains and every caller emits JSON', () => {
  test('C3: amauta.py has no split("|") site', () => {
    const src = fs.readFileSync(PY, 'utf-8');
    const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('split("|")') || l.includes("split('|')"));
    assert.deepStrictEqual(hits, [], `pipe-split sites remain: ${JSON.stringify(hits)}`);
  });

  test('D2: gsd-tools.cjs plan-to-tasks passes --criteria a JSON.stringify value and has no pipe join', () => {
    const src = fs.readFileSync(TOOLS_CJS, 'utf-8');
    const lines = src.split('\n');
    const emits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /'--criteria',\s*\w+/.test(l));
    assert.ok(emits.length >= 2, `expected the two plan-to-tasks emit sites, found ${emits.length}`);
    for (const [n, l] of emits) {
      const ident = l.match(/'--criteria',\s*(\w+)/)[1];
      const decl = new RegExp(`const\\s+${ident}\\s*=\\s*JSON\\.stringify\\(`);
      assert.ok(decl.test(src), `line ${n}: ${ident} is not declared as JSON.stringify(...)`);
    }
    const joins = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes("join(' | ')") || l.includes("join('|')"));
    assert.deepStrictEqual(joins, [], `pipe joins remain: ${JSON.stringify(joins)}`);
  });

  test('D2: daemon _build_args forwards a JSON-array criteria string verbatim and serializes a native list', () => {
    const code = [
      'import ast, json, sys, textwrap',
      `src = open(${JSON.stringify(DAEMON_PY)}, encoding="utf-8").read()`,
      'tree = ast.parse(src)',
      "fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == '_build_args')",
      'ns = {"json": json}',
      'exec(textwrap.dedent(ast.get_source_segment(src, fn)), ns)',
      'build = ns["_build_args"]',
      `s = ${JSON.stringify(JSON.stringify([PIPE_CRITERION, 'second']))}`,
      'a1 = build(None, "add", {"type": "task", "title": "t", "criteria": s})',
      `a2 = build(None, "add", {"type": "task", "title": "t", "criteria": ${JSON.stringify([PIPE_CRITERION, 'second'])}})`,
      'a3 = build(None, "update", {"id": "TK-0001", "criteria": s})',
      'print(json.dumps({"a1": a1, "a2": a2, "a3": a3}))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', code], { encoding: 'utf-8', env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' } });
    const { a1, a2, a3 } = JSON.parse(out);
    const expected = JSON.stringify([PIPE_CRITERION, 'second']);
    assert.strictEqual(a1[a1.indexOf('--criteria') + 1], expected, 'string body must pass verbatim');
    assert.strictEqual(a3[a3.indexOf('--criteria') + 1], expected, 'update hop must pass verbatim');
    const fromList = a2[a2.indexOf('--criteria') + 1];
    assert.deepStrictEqual(JSON.parse(fromList), [PIPE_CRITERION, 'second'], `native list must be serialized as JSON, got ${fromList}`);
  });
});
