'use strict';
/**
 * Live-store canary (Phase 88, plan 88-01).
 *
 * A socket guard alone is not enough: during the 2026-11-11 research runs the live
 * data/tasks.json received notes while the Node socket guard logged no connection
 * to 18799. This module is the independent file-level alarm. The runner takes a
 * snapshot before the tests and another after; any difference in a watched target
 * means the run modified the operator's live store.
 *
 * It always watches the LIVE checkout (GSD_LIVE_CHECKOUT, default
 * ~/Code/gsd-amauta), never the worktree the run happens to start from: the
 * pollution this exists to catch lands in the live checkout's data/tasks.json.
 *
 * Watched targets:
 *   <LIVE>/data/tasks.json
 *   <LIVE>/data/                       listing of names, non-recursive
 *   ~/.amauta/data/tasks.json
 *   ~/.amauta/backups/                 listing of names, minus operator-side backup artefacts
 *   <LIVE>/services/amauta-daemon.pid  the live daemon's pid file
 *   <LIVE>/services/rlm-service.pid    the live RLM's pid file
 *   <this repo>/data/tasks.json        when this repo is not the live checkout
 *
 * It also reports processes: the fixture daemon writes a pid ledger
 * (GSD_PROCESS_LEDGER) and strayProcesses() lists what a run left alive, so a daemon
 * that outlives its test becomes a red run instead of an invisible neighbour.
 *
 * Directory listings hash NAMES only (mtimes and sizes are recorded for diagnosis).
 * The live daemon appends to its own logs all day, so hashing mtimes would raise a
 * false finding on every run; a created or deleted file is the signal.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OWN_REPO = path.resolve(__dirname, '..', '..');

/** Backup-dir entries that operator-side tasks write on purpose. */
const BACKUP_IGNORE = [/\.bundle$/, /^ruleset-.*\.json$/, /^install_record-.*\.json$/, /-2026-11-11$/];

let liveOverride = null;
let targetsOverride = null;

/**
 * Point the canary at a temporary tree (unit tests only).
 * @param {string|null} dir live-checkout stand-in, or null to reset
 * @returns {void}
 */
function _setLiveCheckoutForTest(dir) {
  liveOverride = dir;
}

/**
 * Replace the target list with explicit paths (unit tests only). A path ending in
 * '/' is treated as a directory listing.
 * @param {string[]|null} paths or null to reset
 * @returns {void}
 */
function _setTargetsForTest(paths) {
  targetsOverride = paths;
}

/**
 * Resolve the live checkout directory.
 * @returns {string}
 */
function liveCheckout() {
  return liveOverride || process.env.GSD_LIVE_CHECKOUT || path.join(os.homedir(), 'Code', 'gsd-amauta');
}

/**
 * Build the list of watched targets.
 * @returns {{path: string, kind: 'file'|'dir', ignore?: RegExp[]}[]}
 */
function targets() {
  if (targetsOverride) {
    return targetsOverride.map((p) => ({ path: p.replace(/[\\/]+$/, ''), kind: /[\\/]$/.test(p) ? 'dir' : 'file' }));
  }
  const live = liveCheckout();
  const home = os.homedir();
  const list = [
    { path: path.join(live, 'data', 'tasks.json'), kind: 'file' },
    { path: path.join(live, 'data'), kind: 'dir' },
    { path: path.join(home, '.amauta', 'data', 'tasks.json'), kind: 'file' },
    { path: path.join(home, '.amauta', 'backups'), kind: 'dir', ignore: BACKUP_IGNORE },
    { path: path.join(live, 'services', 'amauta-daemon.pid'), kind: 'file' },
    { path: path.join(live, 'services', 'rlm-service.pid'), kind: 'file' },
  ];
  let sameRepo = false;
  try {
    sameRepo = fs.realpathSync(OWN_REPO) === fs.realpathSync(live);
  } catch (_e) {
    sameRepo = OWN_REPO === live;
  }
  if (!sameRepo) list.push({ path: path.join(OWN_REPO, 'data', 'tasks.json'), kind: 'file' });
  return list;
}

/**
 * Describe one target, or null when it does not exist.
 * @param {{path: string, kind: string, ignore?: RegExp[]}} t
 * @returns {{exists: boolean, mtimeMs: number, sha256: string, size: number}|null}
 */
function describe(t) {
  let st;
  try {
    st = fs.statSync(t.path);
  } catch (_e) {
    return null;
  }
  if (t.kind === 'dir') {
    if (!st.isDirectory()) return null;
    const ignore = t.ignore || [];
    const names = fs
      .readdirSync(t.path)
      .filter((n) => !ignore.some((re) => re.test(n)))
      .sort();
    return {
      exists: true,
      mtimeMs: st.mtimeMs,
      sha256: crypto.createHash('sha256').update(names.join('\n')).digest('hex'),
      size: names.length,
    };
  }
  if (!st.isFile()) return null;
  return {
    exists: true,
    mtimeMs: st.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(t.path)).digest('hex'),
    size: st.size,
  };
}

/**
 * Snapshot every watched target that exists.
 * @returns {{paths: Object<string, {exists: boolean, mtimeMs: number, sha256: string, size: number}>}}
 */
function snapshot() {
  const paths = {};
  for (const t of targets()) {
    const d = describe(t);
    if (d) paths[t.path] = d;
  }
  return { paths };
}

/**
 * Compare two snapshots. Changes in exists, sha256 or size are findings; mtime-only
 * changes are ignored. A target present before and absent after is 'deleted';
 * absent before and present after is 'created'.
 *
 * @param {{paths: object}} before
 * @param {{paths: object}} after
 * @returns {{path: string, reason: string}[]}
 */
function diff(before, after) {
  const findings = [];
  const keys = new Set([...Object.keys(before.paths || {}), ...Object.keys(after.paths || {})]);
  for (const k of [...keys].sort()) {
    const b = (before.paths || {})[k];
    const a = (after.paths || {})[k];
    const bExists = Boolean(b && b.exists !== false);
    const aExists = Boolean(a && a.exists !== false);
    if (bExists && !aExists) findings.push({ path: k, reason: 'deleted' });
    else if (!bExists && aExists) findings.push({ path: k, reason: 'created' });
    else if (bExists && aExists) {
      if (b.sha256 !== a.sha256) findings.push({ path: k, reason: 'content changed' });
      else if (b.size !== a.size) findings.push({ path: k, reason: 'size changed' });
    }
  }
  return findings;
}

/**
 * Render findings for stderr.
 * @param {{path: string, reason: string}[]} findings
 * @returns {string}
 */
function format(findings) {
  return (
    "LIVE STORE CANARY: the test run modified the operator's live store\n" +
    findings.map((f) => '  ' + f.path + ': ' + f.reason).join('\n')
  );
}

const DAEMON_RE = /amauta-daemon\.py|rlm-service\.py/;

/**
 * Pids that are never reportable as killable, whatever the ledger says: this
 * process, its parent, and the pids in the live daemon's own pid files.
 * @returns {Set<number>}
 */
function protectedPids() {
  const set = new Set([process.pid, process.ppid]);
  const live = liveCheckout();
  for (const f of ['amauta-daemon.pid', 'rlm-service.pid']) {
    try {
      const n = parseInt(fs.readFileSync(path.join(live, 'services', f), 'utf8').trim(), 10);
      if (n > 0) set.add(n);
    } catch (_e) {
      /* no such pid file */
    }
  }
  return set;
}

/**
 * Whether a pid is one this harness must never signal.
 * @param {number} pid
 * @returns {boolean}
 */
function isProtectedPid(pid) {
  return protectedPids().has(Number(pid));
}

/**
 * Whether a pid answers signal 0. EPERM means alive but not ours.
 * @param {number} pid
 * @returns {'alive'|'dead'|'eperm'}
 */
function livenessOf(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    return e.code === 'EPERM' ? 'eperm' : 'dead';
  }
}

/**
 * `ps -o command= -p <pid>` through execFileSync (never a shell).
 * @param {number} pid
 * @returns {string} the command line, or '' when unavailable
 */
function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (_e) {
    return '';
  }
}

/**
 * TCP ports the pid is listening on (empty when lsof is missing or finds none).
 * @param {number} pid
 * @returns {number[]}
 */
function listeningPorts(pid) {
  try {
    const out = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...out.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1]));
  } catch (_e) {
    return [];
  }
}

/**
 * Decide whether a live ledger entry is this harness's own daemon or RLM. All of:
 * not a protected pid; the command line names amauta-daemon.py or rlm-service.py;
 * and the command line contains the ledger's dataDir or the process listens on
 * the ledger's port (a recycled pid will match neither).
 *
 * @param {{pid: number, kind?: string, port?: number|null, dataDir?: string}} entry
 * @returns {{identified: boolean, reason: string}}
 */
function identify(entry) {
  if (isProtectedPid(entry.pid)) return { identified: false, reason: 'protected pid' };
  const cmd = commandOf(entry.pid);
  if (!DAEMON_RE.test(cmd)) return { identified: false, reason: 'not an amauta daemon/rlm process' };
  const byDir = entry.dataDir && cmd.includes(entry.dataDir);
  const byPort = entry.port && listeningPorts(entry.pid).includes(Number(entry.port));
  if (!byDir && !byPort) return { identified: false, reason: 'ledger mismatch' };
  return { identified: true, reason: 'identified' };
}

/**
 * Daemons and RLM services the ledger says were started and never stopped, that
 * are still alive. Signals nothing; identification is advisory input for the
 * runner's kill pass. A missing ledger is the normal "nothing started" case; a
 * malformed line is skipped with a warning. Never throws.
 *
 * @param {string} ledgerPath path of the JSONL ledger
 * @returns {{pid: number, kind: string, port: number|null, dataDir: string|null, identified: boolean, reason: string}[]}
 */
function strayProcesses(ledgerPath) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('live-store-canary: cannot read process ledger ' + ledgerPath + ': ' + e.message);
    return [];
  }
  const latest = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_e) {
      console.error('live-store-canary: skipping malformed process-ledger line: ' + line.slice(0, 120));
      continue;
    }
    if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) continue;
    if (rec.event === 'started') latest.set(rec.pid, rec);
    else if (rec.event === 'stopped') latest.set(rec.pid, null);
  }
  const strays = [];
  for (const [pid, rec] of latest) {
    if (!rec) continue;
    const alive = livenessOf(pid);
    if (alive === 'dead') continue;
    const entry = { pid, kind: rec.kind || 'daemon', port: rec.port || null, dataDir: rec.dataDir || null };
    const id = alive === 'eperm' ? { identified: false, reason: 'not ours (EPERM)' } : identify(entry);
    strays.push({ ...entry, ...id });
  }
  return strays;
}

/**
 * Render strays for stderr.
 * @param {ReturnType<typeof strayProcesses>} strays
 * @returns {string}
 */
function formatStrays(strays) {
  return (
    'STRAY PROCESS: the test run left a daemon or RLM service alive\n' +
    strays
      .map(
        (s) =>
          '  pid ' + s.pid + ' (' + s.kind + (s.port ? ', port ' + s.port : '') + '): ' +
          (s.identified ? 'identified, will be stopped by pid' : 'NOT signalled: ' + s.reason)
      )
      .join('\n')
  );
}

module.exports = {
  snapshot,
  diff,
  format,
  strayProcesses,
  formatStrays,
  identify,
  isProtectedPid,
  _setLiveCheckoutForTest,
  _setTargetsForTest,
};
