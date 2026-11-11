#!/usr/bin/env node
/**
 * TK-2229: project scoping — registration stamps a real project_id, and
 * --project filters the reads.
 *
 * The counter-proof (tests 1–4) fails on any tree without the fix: before
 * TK-2229 every task was written with project_id = "default", `list` had no
 * --project flag at all (argparse exits 2 on an unrecognised argument), and
 * there was therefore no read that could return one project and not another.
 *
 * Tests:
 *   1. two tasks registered from two different repositories get two different
 *      project_ids (NOT "default")
 *   2. COUNTER-PROOF: `list --project <A>` returns A's task and NOT B's
 *   3. COUNTER-PROOF: `list --project <B>` returns B's task and NOT A's
 *   4. `stats --project <A>` counts only A
 *   5. `board --project <A>` shows only A
 *   6. .planning/config.json "project_id" beats the directory name
 *   7. explicit --project beats every inference
 *   8. --project-dir carries the CALLER's directory (the daemon runs amauta.py
 *      with its own cwd, so inference from os.getcwd() would be wrong)
 *   9. a directory that is not in a git tree falls back to its own basename
 *  10. AMAUTA_PROJECT_ID env override
 *  11. an unknown project filters to nothing rather than to everything
 *  12. tasks written before TK-2229 (no project_id key) read as "default"
 *  13. under the daemon marker with no --project-dir, inference is REFUSED
 *      ("default"), never the daemon's own directory
 *  14. daemon _build_args emits --project for exactly the five subcommands that
 *      declare it, --project-dir for `add`, and NOTHING for `claim` (which has
 *      always sent body.project_dir and would die on an unknown argument)
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const AMAUTA_PY = path.join(ROOT, 'amauta.py');

const TMP = path.join(os.tmpdir(), `amauta-tk2229-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TMP, 'data');
const REPO_A = path.join(TMP, 'proj-alpha');
const REPO_B = path.join(TMP, 'proj-beta');
const REPO_C = path.join(TMP, 'proj-gamma-dir');   // config renames this one
const LOOSE = path.join(TMP, 'loose-directory');   // no .git anywhere

// Titles must be mutually dissimilar: amauta.py's _dedup_check refuses a new
// task whose title is ~60% similar to an existing one, and would return exit 0
// having written nothing.
const TITLE_A = 'Alpha repository ingest worker for queue draining';
const TITLE_B = 'Beta storefront checkout coupon validation endpoint';
const TITLE_C = 'Gamma telemetry sampler histogram bucket widths';
const TITLE_LOOSE = 'Loose scratch note about weekly rota spreadsheets';
const TITLE_EXPLICIT = 'Explicit override for nightly compaction scheduling';
const TITLE_ENV = 'Environment driven pipeline for photo thumbnail resizing';
const TITLE_PROJECT_DIR = 'Caller directory forwarded across the daemon boundary';
const TITLE_DAEMON = 'Untold origin task arriving through an exec passthrough';

/**
 * Run amauta.py and return {stdout, status}. Never throws on a non-zero exit —
 * the counter-proof needs to observe the failure, not be aborted by it.
 * @param {string[]} args - amauta.py arguments.
 * @param {object} [opts] - {cwd, env}
 * @returns {{stdout: string, stderr: string, status: number}}
 */
function amauta(args, opts = {}) {
  try {
    const stdout = execFileSync('python3', [AMAUTA_PY, ...args], {
      cwd: opts.cwd || ROOT,
      env: {
        ...process.env,
        GSD_AMAUTA_NO_AUTO_START: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        NO_COLOR: '1',
        AMAUTA_DATA_DIR: DATA_DIR,
        // Keep the test off every shared service: no PG mirror, no RLM, no Redis.
        AMAUTA_MEMORY_BACKEND: '',
        AMAUTA_MEMORY_DATABASE_URL: '',
        GSD_POSTGRES_URL: '',
        GSD_RLM_ENABLED: 'false',
        GSD_REDIS_ENABLED: 'false',
        ...(opts.env || {}),
      },
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || String(err.message || ''),
      status: err.status === undefined ? 1 : err.status,
    };
  }
}

/** @returns {object[]} the raw items array from the test tasks.json */
function items() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf-8')).items;
}

/**
 * @param {string} title - Task title to look up.
 * @returns {object} the stored item
 */
function itemByTitle(title) {
  const found = items().find((i) => i.title === title);
  assert.ok(found, `task ${JSON.stringify(title)} was never registered`);
  return found;
}

/** Make a directory look like a git working tree. */
function fakeRepo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  [REPO_A, REPO_B, REPO_C].forEach(fakeRepo);
  fs.mkdirSync(LOOSE, { recursive: true });
  fs.mkdirSync(path.join(REPO_C, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_C, '.planning', 'config.json'),
    JSON.stringify({ project_id: 'renamed-by-config', commit_docs: true }, null, 2)
  );

  // Register each task FROM ITS OWN REPOSITORY, using no new flag at all: this
  // invocation is valid on a tree without the fix too, so tests 1-5 fail on the
  // unfixed tree for the reason under test (no project was recorded, no
  // --project filter exists) rather than dying on an unparsable argument.
  const a = amauta(['add', 'task', TITLE_A], { cwd: REPO_A });
  assert.equal(a.status, 0, `add A failed: ${a.stderr || a.stdout}`);
  const b = amauta(['add', 'task', TITLE_B], { cwd: REPO_B });
  assert.equal(b.status, 0, `add B failed: ${b.stderr || b.stdout}`);
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('TK-2229 registration stamps a real project_id', () => {
  it('1. two repositories produce two different, non-default project_ids', () => {
    const a = itemByTitle(TITLE_A);
    const b = itemByTitle(TITLE_B);
    assert.equal(a.project_id, 'proj-alpha');
    assert.equal(b.project_id, 'proj-beta');
    assert.notEqual(a.project_id, 'default');
    assert.notEqual(b.project_id, 'default');
    assert.notEqual(a.project_id, b.project_id);
  });
});

describe('TK-2229 COUNTER-PROOF: a --project read returns one and not the other', () => {
  it('2. list --project proj-alpha returns A and NOT B', () => {
    const a = itemByTitle(TITLE_A);
    const b = itemByTitle(TITLE_B);
    const res = amauta(['list', '--project', 'proj-alpha']);
    assert.equal(res.status, 0, `list --project failed: ${res.stderr}`);
    assert.ok(res.stdout.includes(a.id), `alpha's ${a.id} missing from --project proj-alpha`);
    assert.ok(!res.stdout.includes(b.id), `beta's ${b.id} leaked into --project proj-alpha`);
  });

  it('3. list --project proj-beta returns B and NOT A', () => {
    const a = itemByTitle(TITLE_A);
    const b = itemByTitle(TITLE_B);
    const res = amauta(['list', '--project', 'proj-beta']);
    assert.equal(res.status, 0, `list --project failed: ${res.stderr}`);
    assert.ok(res.stdout.includes(b.id), `beta's ${b.id} missing from --project proj-beta`);
    assert.ok(!res.stdout.includes(a.id), `alpha's ${a.id} leaked into --project proj-beta`);
  });

  it('4. stats --project counts only that project', () => {
    const res = amauta(['stats', '--project', 'proj-alpha']);
    assert.equal(res.status, 0, `stats --project failed: ${res.stderr}`);
    assert.match(res.stdout, /1 items/, `stats did not scope to one item:\n${res.stdout}`);
    assert.ok(!res.stdout.includes('proj-beta'), 'stats leaked proj-beta');
  });

  it('5. board --project shows only that project', () => {
    const a = itemByTitle(TITLE_A);
    const b = itemByTitle(TITLE_B);
    const res = amauta(['board', '--project', 'proj-alpha']);
    assert.equal(res.status, 0, `board --project failed: ${res.stderr}`);
    assert.ok(res.stdout.includes(a.id), `alpha's ${a.id} missing from board --project`);
    assert.ok(!res.stdout.includes(b.id), `beta's ${b.id} leaked into board --project`);
  });
});

describe('TK-2229 resolution precedence', () => {
  it('6. .planning/config.json "project_id" beats the directory name', () => {
    const res = amauta(['add', 'task', TITLE_C], { cwd: REPO_C });
    assert.equal(res.status, 0, `add C failed: ${res.stderr || res.stdout}`);
    assert.equal(itemByTitle(TITLE_C).project_id, 'renamed-by-config');
  });

  it('7. explicit --project beats every inference', () => {
    const res = amauta(['add', 'task', TITLE_EXPLICIT,
                        '--project', 'chosen-by-hand'], { cwd: REPO_A });
    assert.equal(res.status, 0, `add explicit failed: ${res.stderr || res.stdout}`);
    assert.equal(itemByTitle(TITLE_EXPLICIT).project_id, 'chosen-by-hand');
  });

  it('8. --project-dir, not the process cwd, decides the project', () => {
    // The daemon runs amauta.py as a subprocess with the DAEMON's cwd, so
    // inference from os.getcwd() would stamp every task with the daemon's own
    // project. Run from ROOT (standing in for the daemon) and point
    // --project-dir at the caller's repository instead.
    const res = amauta(['add', 'task', TITLE_PROJECT_DIR,
                        '--project-dir', REPO_B], { cwd: ROOT });
    assert.equal(res.status, 0, `add --project-dir failed: ${res.stderr || res.stdout}`);
    const stamped = itemByTitle(TITLE_PROJECT_DIR).project_id;
    assert.equal(stamped, 'proj-beta');
    assert.notEqual(stamped, path.basename(ROOT));
  });

  it('9. a directory outside any git tree falls back to its own basename', () => {
    const res = amauta(['add', 'task', TITLE_LOOSE], { cwd: LOOSE });
    assert.equal(res.status, 0, `add loose failed: ${res.stderr || res.stdout}`);
    assert.equal(itemByTitle(TITLE_LOOSE).project_id, 'loose-directory');
  });

  it('10. AMAUTA_PROJECT_ID overrides inference', () => {
    const res = amauta(['add', 'task', TITLE_ENV],
                       { cwd: REPO_B, env: { AMAUTA_PROJECT_ID: 'from-the-environment' } });
    assert.equal(res.status, 0, `add env failed: ${res.stderr || res.stdout}`);
    assert.equal(itemByTitle(TITLE_ENV).project_id, 'from-the-environment');
  });
});

describe('TK-2229 daemon seam', () => {
  it('13. daemon-launched add with no --project-dir refuses to infer from cwd', () => {
    // Standing in for an /api/exec passthrough: the daemon marker is set, the
    // cwd is the daemon's own repository, and nobody forwarded the caller's
    // directory. Stamping the daemon's project here would be confidently wrong.
    const res = amauta(['add', 'task', TITLE_DAEMON],
                       { cwd: REPO_A, env: { AMAUTA_INVOKED_BY_DAEMON: '1' } });
    assert.equal(res.status, 0, `add failed: ${res.stderr || res.stdout}`);
    assert.equal(itemByTitle(TITLE_DAEMON).project_id, 'default');
  });

  it('13b. the marker does not override an explicit --project-dir', () => {
    const res = amauta(['list', '--project', 'proj-alpha'],
                       { env: { AMAUTA_INVOKED_BY_DAEMON: '1' } });
    assert.equal(res.status, 0, `list failed: ${res.stderr}`);
    assert.ok(res.stdout.includes(itemByTitle(TITLE_A).id));
  });
});

describe('TK-2229 daemon arg building', () => {
  it('14. _build_args scopes the new flags to the subcommands that declare them', () => {
    // Import amauta-daemon.py without starting a server (start_server only runs
    // under __main__) and call the seam directly, rather than grepping source.
    const probe = [
      'import importlib.util, json, os',
      'os.environ["GSD_AMAUTA_NO_AUTO_START"]="1"',
      's=importlib.util.spec_from_file_location("d", "services/amauta-daemon.py")',
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'b=m.AmautaHandler._build_args',
      'class F: pass',
      'f=F()',
      'out={',
      '  "add_dir": b(f,"add",{"type":"task","title":"T","project_dir":"/x/repo-a"}),',
      '  "add_proj": b(f,"add",{"type":"task","title":"T","project":"repo-b"}),',
      '  "list": b(f,"list",{"project":"repo-c"}),',
      '  "board": b(f,"board",{"project":"repo-c"}),',
      '  "stats": b(f,"stats",{"project":"repo-c"}),',
      '  "reconcile": b(f,"reconcile",{"project":"repo-c"}),',
      '  "claim": b(f,"claim",{"id":"TK-1","agent":"a","project_dir":"/x/repo-a"}),',
      '}',
      'print(json.dumps(out))',
    ].join('\n');
    let raw;
    try {
      raw = execFileSync('python3', ['-c', probe], {
        cwd: ROOT, encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (err) {
      assert.fail(`daemon probe failed: ${err.stderr || err.message}`);
    }
    const out = JSON.parse(raw.trim().split('\n').pop());
    assert.deepEqual(out.add_dir, ['add', 'task', 'T', '--project-dir', '/x/repo-a']);
    assert.deepEqual(out.add_proj, ['add', 'task', 'T', '--project', 'repo-b']);
    for (const cmd of ['list', 'board', 'stats', 'reconcile']) {
      assert.deepEqual(out[cmd], [cmd, '--project', 'repo-c'], `${cmd} must forward --project`);
    }
    // The regression that matters: claim has always sent body.project_dir. A
    // blanket flag_map entry would hand argparse an unrecognised argument and
    // break every claim in the fleet.
    assert.deepEqual(out.claim, ['claim', 'TK-1', '--agent', 'a']);
  });
});

describe('TK-2229 filter semantics', () => {
  it('11. an unknown project matches nothing (not everything)', () => {
    const res = amauta(['list', '--project', 'no-such-project-anywhere']);
    assert.equal(res.status, 0, `list failed: ${res.stderr}`);
    assert.match(res.stdout, /No items match/);
  });

  it('12. a pre-TK-2229 item with no project_id key reads as "default"', () => {
    const file = path.join(DATA_DIR, 'tasks.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const legacy = JSON.parse(JSON.stringify(data.items[0]));
    legacy.id = 'TK-9001';
    legacy.title = 'Legacy row predating the project column entirely';
    delete legacy.project_id;
    data.items.push(legacy);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));

    const res = amauta(['list', '--project', 'default']);
    assert.equal(res.status, 0, `list --project default failed: ${res.stderr}`);
    assert.ok(res.stdout.includes('TK-9001'),
      'an item with no project_id key must answer to --project default');
  });
});
