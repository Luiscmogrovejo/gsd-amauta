'use strict';
/**
 * The run's process registry (Phase 89, plan 89-15).
 *
 * Every fixture that starts a daemon or an RLM service records it HERE, in one
 * JSONL file inside the run's temporary directory (`GSD_PROCESS_LEDGER`, set by
 * `scripts/run-tests.cjs`): pid, port, start time, the test file that owns it
 * and the fixture that started it. Three consumers read it back:
 *
 *   - the fixture's own teardown, which reaps the recorded pid AND the process
 *     tree under it, and fails the owning test when something survives;
 *   - the runner's stray-process check, which decides "is this process ours?"
 *     from the registry (pid + start time) and never from a command line;
 *   - the stray report, which names the test file behind every pid.
 *
 * WHY START TIME IS PART OF THE IDENTITY. A pid NUMBER is not a process.
 * Windows hands a freed pid to the next process within seconds, and a run is
 * eleven minutes long: run 43437354734 (`test (windows-latest, node 22)`,
 * 5465 tests, 0 failed) exited 5 on `pid 3296 (daemon, port 64281): NOT
 * signalled: not an amauta daemon/rlm process` — a registry line whose process
 * had died long before and whose NUMBER some other process was holding when
 * the check ran. A registered process was created between the moment its
 * fixture called `spawn` (`spawnedAt`) and the moment the line was written
 * (`at`); whatever holds that pid with a creation time outside that window is
 * a different process, is not a stray, and is never signalled.
 *
 * WHY NOT THE COMMAND LINE. Three occurrences of this defect class came from
 * recognising a process by what it looks like: the `py` launcher (PR #39),
 * an interpreter other than the pinned one (plan 89-07), and a recycled pid.
 * A launcher, a venv shim and a renamed interpreter all carry a different
 * command line and the same registry line. The command line is still READ,
 * for the report a human reads — it is never the reason a process is signalled.
 *
 * THE ONE RULE THAT DOES NOT BEND: nothing in this module signals a process
 * that is not in the registry, or under a registered process that is alive
 * and verified. The operator's machine runs a live daemon and a live RLM
 * service; a process that merely LOOKS like one of ours is reported and left
 * alone (`unregisteredServices`, and the test that pins it).
 *
 * @module tests/support/process-registry
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

/** REPORTING ONLY: what a daemon or RLM command line looks like. Never a reason to signal. */
const SERVICE_RE = /amauta-daemon\.py|rlm-service\.py/;
/** REPORTING ONLY: a command line that RUNS one of them (`… amauta-daemon.py run`). */
const SERVICE_CMD_RE = /(?:amauta-daemon|rlm-service)\.py["']?\s+(?:run|start)\b/;

/** PowerShell executable (Windows branch only); override with GSD_POWERSHELL_EXE. */
const POWERSHELL_EXE = process.env.GSD_POWERSHELL_EXE || 'powershell.exe';
/** Budget for one process-table read (a cold PowerShell start takes seconds on a CI runner). */
const TABLE_TIMEOUT_MS = Number(process.env.GSD_PROCESS_TABLE_TIMEOUT_MS) || 30000;
/** Interval of the diagnostic watcher's process-table polls. */
const WATCH_INTERVAL_MS = Number(process.env.GSD_PROCESS_WATCH_INTERVAL_MS) || 500;

/**
 * How far a creation time read from the OS may sit outside the registry window
 * and still be the registered process.
 *
 * Windows reports creation in 100 ns units off the same clock `Date.now()`
 * reads, so the slack only has to cover clock granularity. POSIX `ps` reports
 * ELAPSED time in whole seconds, so a creation time derived from it is good to
 * about a second either way; pids there are handed out sequentially, so a pid
 * cannot come round again inside this window.
 */
const TOLERANCE_MS = { win32: 500, posix: 2500 };

/**
 * @param {string} [platform=process.platform]
 * @returns {number} the identity tolerance for that platform, in ms
 */
function toleranceFor(platform = process.platform) {
  return platform === 'win32' ? TOLERANCE_MS.win32 : TOLERANCE_MS.posix;
}

/**
 * The test file that owns whatever this process starts.
 *
 * Under `node --test` every test FILE is its own process and its path is
 * `process.argv[1]`, so the owner needs no cooperation from the test.
 * `GSD_TEST_OWNER` overrides it for a helper that starts a fixture on behalf of
 * a test file.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string[]} [argv=process.argv]
 * @returns {string} repo-relative path with forward slashes, or the raw entry script
 * @example
 *   ownerOf() // 'tests/14-plan-to-tasks.integration.test.cjs'
 */
function ownerOf(env = process.env, argv = process.argv) {
  if (env.GSD_TEST_OWNER) return String(env.GSD_TEST_OWNER);
  const entry = argv[1];
  if (!entry) return '(unknown: no entry script)';
  const rel = path.relative(REPO, path.resolve(entry));
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : entry;
  return shown.split(path.sep).join('/');
}

/**
 * Where registry lines go: `GSD_PROCESS_LEDGER` (the run's registry, set by
 * scripts/run-tests.cjs) or, for a standalone run, `process-ledger.jsonl` in
 * the fixture's own data directory.
 *
 * @param {string} [dataDir] the fixture's data directory
 * @returns {string|null} the file, or null when there is neither
 */
function registryPath(dataDir) {
  if (process.env.GSD_PROCESS_LEDGER) return process.env.GSD_PROCESS_LEDGER;
  return dataDir ? path.join(dataDir, 'process-ledger.jsonl') : null;
}

/**
 * Append one JSON line to the registry. Never throws: a registry that cannot
 * be written must not break the test that is starting a service, and it says
 * so on stderr instead of staying silent.
 *
 * @param {string|undefined} dataDir the fixture's data directory (standalone fallback)
 * @param {object} record the line to write
 * @returns {void}
 */
function append(dataDir, record) {
  const file = registryPath(dataDir);
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('process-registry: could not write ' + file + ': ' + e.message);
  }
}

/**
 * Register one process a fixture started.
 *
 * @param {object} f
 * @param {'daemon'|'rlm'} f.kind what the process is
 * @param {number} f.pid the exact pid
 * @param {number} f.spawnedAt `Date.now()` taken BEFORE the fixture's root was spawned
 * @param {string} f.fixture the fixture function, e.g. 'startFixtureDaemon'
 * @param {string} [f.role='spawned'] 'spawned' (the pid node started), 'pidfile'
 *   (the pid the service wrote into the fixture's own data dir) or 'descendant'
 * @param {number|null} [f.port]
 * @param {string|null} [f.dataDir]
 * @param {number} [f.rootPid] the pid the fixture spawned, when this is not it
 * @param {number} [f.createdMs] the exact creation time, when it was read from the process table
 * @returns {object} the entry, to hand back to `close()`
 * @example
 *   const e = register({ kind: 'daemon', pid: proc.pid, spawnedAt, fixture: 'startFixtureDaemon', dataDir });
 */
function register(f) {
  const entry = {
    event: 'started',
    kind: f.kind,
    role: f.role || 'spawned',
    pid: f.pid,
    port: f.port || null,
    dataDir: f.dataDir || null,
    spawnedAt: f.spawnedAt,
    at: Date.now(),
    owner: f.owner || ownerOf(),
    fixture: f.fixture,
  };
  if (f.rootPid && f.rootPid !== f.pid) entry.rootPid = f.rootPid;
  if (Number.isFinite(f.createdMs)) entry.createdMs = f.createdMs;
  append(f.dataDir, entry);
  return entry;
}

/**
 * Write the closing (or the still-open) line for an entry.
 *
 * The line follows the MEASUREMENT, not the intent (plan 88-16's finding):
 * `stopped` and `exited` are written only for a process observed gone; a
 * survivor is written `started` again, so it stays open and the stray check
 * sees it.
 *
 * @param {object} entry what `register()` returned, or a hand-built `{kind, pid, port, dataDir}`
 * @param {'stopped'|'exited'|'started'} event
 * @returns {void}
 */
function close(entry, event) {
  const line = {
    event,
    kind: entry.kind,
    pid: entry.pid,
    port: entry.port || null,
    dataDir: entry.dataDir || null,
    at: Date.now(),
    owner: entry.owner || ownerOf(),
  };
  if (entry.role) line.role = entry.role;
  if (entry.fixture) line.fixture = entry.fixture;
  if (entry.spawnedAt !== undefined) line.spawnedAt = entry.spawnedAt;
  if (entry.rootPid) line.rootPid = entry.rootPid;
  if (Number.isFinite(entry.createdMs)) line.createdMs = entry.createdMs;
  // A survivor keeps the registration time it was first seen at: `at` is the
  // upper bound of its identity window, and moving it would widen the window.
  if (event === 'started' && entry.at !== undefined) line.at = entry.at;
  append(entry.dataDir, line);
}

/**
 * Record what a fixture learned after registering (the daemon's ephemeral
 * port). A separate event so the `started`/`stopped` pair per pid stays a pair.
 *
 * @param {object} entry what `register()` returned (mutated: the fields are merged in)
 * @param {object} fields e.g. `{port: 51234}`
 * @returns {void}
 */
function annotate(entry, fields) {
  Object.assign(entry, fields);
  append(entry.dataDir, { event: 'ready', pid: entry.pid, spawnedAt: entry.spawnedAt, ...fields });
}

/**
 * How long before its registry line a self-registered service may have been
 * created: the time an interpreter takes from process creation to running
 * `sitecustomize`, on a loaded CI runner, with room to spare.
 */
const SELF_REGISTER_SLACK_MS = 60000;

/**
 * Read a registry file into entries.
 *
 * One entry per PROCESS, not per pid number. A pid that two fixtures of one
 * run were given in turn is two entries, and the late `exited` of the first
 * cannot close the second: a closing line names the `spawnedAt` of the entry it
 * closes. A line without `spawnedAt` (written by hand, or by a pre-89-15
 * writer) keys on the pid alone, and a closing line without it closes every
 * entry of that pid — the old semantics, preserved.
 *
 * A `self` line (in `<registry>.self`) is a daemon or RLM service registering
 * ITSELF as it starts (`tests/support/pythonpath/sitecustomize.py`): it holds
 * this run's registry path in its environment, which is the proof that it
 * belongs to this run. When a fixture registered that pid the two are one
 * process and the entry is only marked; otherwise the service was started
 * through a product path, not a fixture, and the `self` line is its whole
 * registration.
 *
 * A missing file is the normal "nothing started" case. A malformed line is
 * skipped with a warning. Never throws.
 *
 * @param {string} file the registry path
 * @returns {{open: object[], closed: object[]}} entries, oldest first
 */
function readEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('live-store-canary: cannot read process ledger ' + file + ': ' + e.message);
    text = ''; // no fixture wrote a line; a service may still have registered itself
  }
  /** @type {{rec: object, open: boolean, closedAt: number|null}[]} */
  const slots = [];
  const keyOf = (rec) => (rec.spawnedAt === undefined ? '' : String(rec.spawnedAt));
  const find = (rec) => slots.filter((s) => s.rec.pid === rec.pid && keyOf(s.rec) === keyOf(rec)).pop();
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
    if (rec.event === 'started') {
      const slot = find(rec);
      // A re-written `started` (a survivor) keeps what the first line knew.
      if (slot) Object.assign(slot, { rec: { ...slot.rec, ...rec }, open: true, closedAt: null });
      else slots.push({ rec, open: true, closedAt: null });
    } else if (rec.event === 'ready') {
      const slot = find(rec);
      if (slot) {
        const { event: _event, ...fields } = rec;
        Object.assign(slot.rec, fields);
      }
    } else if (rec.event === 'stopped' || rec.event === 'exited') {
      const closing = rec.spawnedAt === undefined ? slots.filter((s) => s.rec.pid === rec.pid) : [find(rec)].filter(Boolean);
      for (const slot of closing) Object.assign(slot, { open: false, closedAt: Number.isFinite(rec.at) ? rec.at : Date.now() });
    }
  }
  // The services that registered THEMSELVES. A fixture registers the process it
  // spawns before that process has run a line of Python, so a `self` line that
  // falls inside the lifetime of an entry with the same pid is that same
  // process speaking; one that does not is a service no fixture started.
  for (const self of readSelfLines(file)) {
    const tol = toleranceFor();
    const same = slots.find((s) => s.rec.pid === self.pid && s.rec.role !== 'self' &&
      (!Number.isFinite(s.rec.spawnedAt) || self.at >= s.rec.spawnedAt - tol) &&
      (s.open || self.at <= s.closedAt + tol));
    if (same) {
      same.rec.selfRegistered = true;
      continue;
    }
    slots.push({
      rec: {
        ...self,
        event: 'started',
        role: 'self',
        fixture: null,
        port: null,
        spawnedAt: self.at - SELF_REGISTER_SLACK_MS,
        selfRegistered: true,
      },
      open: true,
      closedAt: null,
    });
  }
  const open = [];
  const closed = [];
  for (const slot of slots) (slot.open ? open : closed).push(slot.rec);
  return { open, closed };
}

/**
 * Where services register themselves: beside the registry, in a file of their
 * own, so the fixtures' `started`/`stopped` pairs stay pairs.
 *
 * @param {string} registryFile the run's registry
 * @returns {string}
 */
function selfRegistryPath(registryFile) {
  return registryFile + '.self';
}

/**
 * The `self` lines of a run (see `readEntries`). Never throws.
 *
 * @param {string} registryFile the run's registry
 * @returns {{pid: number, ppid?: number, kind: string, at: number, owner: string|null, dataDir: string|null}[]}
 */
function readSelfLines(registryFile) {
  let text;
  try {
    text = fs.readFileSync(selfRegistryPath(registryFile), 'utf8');
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.event === 'self' && Number.isInteger(rec.pid) && rec.pid > 0 && Number.isFinite(rec.at)) out.push(rec);
    } catch (_e) {
      /* a line being written right now */
    }
  }
  return out;
}

// ── the process table ────────────────────────────────────────────────────────

/**
 * One PowerShell statement that prints `pid<TAB>ppid<TAB>FILETIME<TAB>command`
 * for a `Win32_Process` object in `$_`. Shared by the one-shot table and the
 * watcher loop, so both produce lines the same parser reads. Single-quoted
 * strings only: the script travels as `-EncodedCommand`, and this keeps it
 * readable in a log as well.
 */
const PS_ROW =
  '$c = 0; if ($_.CreationDate) { $c = $_.CreationDate.ToFileTimeUtc() }; ' +
  '$l = $_.Name; if ($_.CommandLine) { $l = $_.CommandLine -replace \'[\\r\\n\\t]+\', \' \' }; ' +
  '$row = ([string]$_.ProcessId, [string]$_.ParentProcessId, [string]$c, [string]$l) -join [char]9';

const PS_TABLE =
  '$ErrorActionPreference = \'Stop\'; ' +
  'Get-CimInstance Win32_Process | ForEach-Object { ' + PS_ROW + '; [Console]::Out.WriteLine($row) }';

const PS_WATCH =
  '$ErrorActionPreference = \'SilentlyContinue\'; $seen = @{}; ' +
  'while ($true) { ' +
  'Get-CimInstance Win32_Process | ForEach-Object { ' + PS_ROW + '; ' +
  '$k = [string]$_.ProcessId + \':\' + [string]$c; ' +
  'if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; [Console]::Out.WriteLine($row) } }; ' +
  '[Console]::Out.Flush(); Start-Sleep -Milliseconds ' + WATCH_INTERVAL_MS + ' }';

/**
 * The argv that runs a PowerShell script without any quoting between node and
 * PowerShell: the script is passed base64-encoded UTF-16LE.
 *
 * @param {string} script PowerShell source
 * @returns {string[]} argv for `POWERSHELL_EXE`
 */
function powershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** POSIX `ps` columns: pid, parent pid, elapsed time, command line. */
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,etime=,command='];

/**
 * `[[dd-]hh:]mm:ss` (the `etime` column) in seconds.
 * @param {string} s
 * @returns {number} seconds, or NaN when the text is not an elapsed time
 * @example
 *   elapsedSeconds('02-02:13:34') // 180814
 */
function elapsedSeconds(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return NaN;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * Parse the POSIX `ps` output into rows.
 * @param {string} out stdout of `ps -A -o pid=,ppid=,etime=,command=`
 * @param {number} nowMs when `ps` was asked
 * @returns {{pid: number, ppid: number, createdMs: number, command: string}[]}
 */
function parsePosixTable(out, nowMs) {
  const rows = [];
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const secs = elapsedSeconds(m[3]);
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      createdMs: Number.isFinite(secs) ? nowMs - secs * 1000 : 0,
      command: m[4].trim(),
    });
  }
  return rows;
}

/**
 * Parse the PowerShell rows (`pid<TAB>ppid<TAB>FILETIME<TAB>command`).
 *
 * FILETIME is 100 ns ticks since 1601 and does not fit a double, so it is
 * converted through BigInt. A row whose creation date PowerShell could not
 * read carries 0, which every consumer treats as "unknown", never as "old".
 *
 * @param {string} out stdout of the table or the watcher script
 * @returns {{pid: number, ppid: number, createdMs: number, command: string}[]}
 */
function parseWindowsTable(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 4 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) continue;
    const ft = BigInt(parts[2]);
    rows.push({
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      createdMs: ft > 0n ? Number(ft / 10000n - 11644473600000n) : 0,
      command: parts.slice(3).join(' ').trim(),
    });
  }
  return rows;
}

/**
 * @param {{pid: number}[]} rows
 * @param {number} at when the table was read
 * @param {string} platform
 * @returns {{at: number, platform: string, byPid: Map<number, object>}}
 */
function tableOf(rows, at, platform) {
  const byPid = new Map();
  for (const r of rows) byPid.set(r.pid, r);
  return { at, platform, byPid };
}

/**
 * Read the process table, synchronously (the runner is synchronous).
 *
 * @param {string} [platform=process.platform] injectable so both parsers are reachable anywhere
 * @returns {{at: number, platform: string, byPid: Map<number, {pid: number, ppid: number, createdMs: number, command: string}>}|null}
 *   null when the table could not be read; callers then treat every identity as UNVERIFIED
 */
function processTable(platform = process.platform) {
  const at = Date.now();
  try {
    if (platform === 'win32') {
      const out = execFileSync(POWERSHELL_EXE, powershellArgs(PS_TABLE), {
        encoding: 'utf8',
        timeout: TABLE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const rows = parseWindowsTable(out);
      return rows.length ? tableOf(rows, at, platform) : null;
    }
    const out = execFileSync('ps', PS_ARGS, {
      encoding: 'utf8',
      timeout: TABLE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = parsePosixTable(out, at);
    return rows.length ? tableOf(rows, at, platform) : null;
  } catch (e) {
    console.error('process-registry: the process table could not be read: ' + String(e.message).split('\n')[0]);
    return null;
  }
}

/**
 * Read the process table without blocking the event loop (fixture teardown).
 *
 * @param {string} [platform=process.platform]
 * @returns {Promise<ReturnType<typeof processTable>>} the table, or null when it could not be read
 */
function processTableAsync(platform = process.platform) {
  const at = Date.now();
  return new Promise((resolve) => {
    const done = (err, out) => {
      if (err) {
        console.error('process-registry: the process table could not be read: ' + String(err.message).split('\n')[0]);
        return resolve(null);
      }
      const rows = platform === 'win32' ? parseWindowsTable(out) : parsePosixTable(out, at);
      resolve(rows.length ? tableOf(rows, at, platform) : null);
    };
    const opts = { encoding: 'utf8', timeout: TABLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    if (platform === 'win32') execFile(POWERSHELL_EXE, powershellArgs(PS_TABLE), opts, done);
    else execFile('ps', PS_ARGS, { ...opts, env: { ...process.env, LC_ALL: 'C' } }, done);
  });
}

// ── identity ────────────────────────────────────────────────────────────────

/**
 * Decide what the process table says about a registry entry.
 *
 *   gone        nothing holds the pid
 *   ours        the holder was created inside the entry's identity window
 *   recycled    the holder was created outside it: a different process
 *   unverified  the entry carries no window, or the holder's creation time is
 *               unknown — it can be neither claimed nor dismissed
 *
 * The window is `[spawnedAt, at]` widened by the platform tolerance, or — for
 * an entry whose creation time was itself read from a process table —
 * `createdMs` within the tolerance.
 *
 * @param {{pid: number, spawnedAt?: number, at?: number, createdMs?: number}} entry
 * @param {{platform: string, byPid: Map<number, object>}} table
 * @returns {{state: 'gone'|'ours'|'recycled'|'unverified', holder: object|null}}
 */
function classify(entry, table) {
  const holder = table.byPid.get(entry.pid) || null;
  if (!holder) return { state: 'gone', holder: null };
  if (!holder.createdMs) return { state: 'unverified', holder };
  const tol = toleranceFor(table.platform);
  if (Number.isFinite(entry.createdMs)) {
    return { state: Math.abs(holder.createdMs - entry.createdMs) <= tol ? 'ours' : 'recycled', holder };
  }
  if (!Number.isFinite(entry.spawnedAt) || !Number.isFinite(entry.at)) return { state: 'unverified', holder };
  const inside = holder.createdMs >= entry.spawnedAt - tol && holder.createdMs <= entry.at + tol;
  return { state: inside ? 'ours' : 'recycled', holder };
}

/**
 * The processes under a root that is alive and verified, breadth first.
 *
 * A child is followed only when it was created no earlier than its parent,
 * which is what tells a real child from a process whose RECORDED parent pid
 * has since been handed to something else.
 *
 * @param {{platform: string, byPid: Map<number, object>}} table
 * @param {number} rootPid a pid the caller has verified is the registered process
 * @returns {{pid: number, ppid: number, createdMs: number, command: string}[]} descendants, parents before children
 */
function descendants(table, rootPid) {
  const root = table.byPid.get(rootPid);
  if (!root) return [];
  const tol = toleranceFor(table.platform);
  const childrenOf = new Map();
  for (const p of table.byPid.values()) {
    if (p.pid === p.ppid) continue;
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of childrenOf.get(parent.pid) || []) {
      if (seen.has(child.pid)) continue;
      if (!child.createdMs || !parent.createdMs || child.createdMs + tol < parent.createdMs) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Whether a pid answers signal 0 (EPERM counts as alive).
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ── fixture teardown ─────────────────────────────────────────────────────────

/** When this process started: the earliest a process of one of its fixtures can have been created. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const POLL_INTERVAL_MS = 100;

/**
 * The pid written in a pid file, or null when the file is absent or unusable.
 *
 * The files read through this are written BY a fixture's own service INTO the
 * fixture's own temporary data directory. That makes the pid a CANDIDATE, not
 * a target: `reapFixture` signals it only after the process table has shown it
 * was created during the fixture's lifetime.
 *
 * @param {string} file absolute path of the pid file
 * @returns {number|null}
 * @example
 *   readPidFile('/tmp/d/amauta-daemon.pid') // 1076
 */
function readPidFile(file) {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Wait until `pid` stops answering signal 0, or the budget runs out.
 *
 * @param {number} pid the pid to watch
 * @param {number} ms how long to wait in total
 * @returns {Promise<boolean>} true when the process is gone
 */
async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return !pidAlive(pid);
}

/**
 * Kill one exact pid: SIGTERM, bounded wait, SIGKILL, bounded wait.
 *
 * @param {number} pid the exact pid to stop
 * @param {number} graceMs budget for EACH of the two waits
 * @param {boolean} [hard=false] skip the SIGTERM (a simulated crash)
 * @returns {Promise<boolean>} true when the pid has stopped answering
 * @example
 *   await killPid(1076, 5000) // true
 */
async function killPid(pid, graceMs, hard = false) {
  if (!pidAlive(pid)) return true;
  if (!hard) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_e) {
      /* exited between the probe and the signal */
    }
    if (await waitForExit(pid, graceMs)) return true;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_e) {
    /* exited after SIGTERM */
  }
  return waitForExit(pid, graceMs);
}

/**
 * Stop every process of ONE fixture and report what survived.
 *
 * The fixture is the process node spawned (`proc`) plus:
 *   - the processes UNDER it in the process table — on Windows a terminated
 *     parent leaves its children running, and `py.exe` is a launcher whose
 *     child is the real interpreter, so killing `proc` alone is how a daemon
 *     and its RLM child outlived run 43223847244;
 *   - the pids the fixture's own service wrote into the fixture's own data
 *     directory (`pidFiles`), and the ones the fixture registered when it
 *     became ready (`members`).
 *
 * Nothing outside that set is signalled, and a pid-file pid is signalled only
 * when the process table shows its process was created during the fixture's
 * lifetime: a stale file whose number has since been handed to another process
 * names a stranger, and a stranger is left alone.
 *
 * The registry line of every process follows the MEASUREMENT: `stopped` for one
 * observed gone, `started` for a survivor, which therefore stays visible to the
 * runner's stray check, attributed to its owner.
 *
 * @param {object} o
 * @param {import('child_process').ChildProcess} o.proc the process the fixture spawned
 * @param {'daemon'|'rlm'} o.kind
 * @param {string} o.fixture the fixture function's name, for the registry
 * @param {string} o.dataDir the fixture's data directory
 * @param {number|null} [o.port]
 * @param {number} [o.spawnedAt] `Date.now()` before the spawn; this process's own start when absent
 * @param {object} [o.entry] the root's registry entry, when the fixture registered it
 * @param {object[]} [o.members] entries the fixture registered besides the root
 * @param {{file: string, kind: 'daemon'|'rlm', port?: number|null}[]} [o.pidFiles]
 * @param {number} o.graceMs budget for each wait
 * @param {boolean} [o.hard=false] SIGKILL at once (a simulated crash)
 * @param {function(): Promise<object|null>} [o.readTable=processTableAsync] injectable process-table reader
 * @returns {Promise<{rootGone: boolean, survivors: {pid: number, kind: string, role: string}[], allGone: boolean}>}
 */
async function reapFixture(o) {
  const { proc } = o;
  const readTable = o.readTable || processTableAsync;
  const lower = Number.isFinite(o.spawnedAt) ? o.spawnedAt : PROCESS_STARTED_AT;
  const reaped = () => proc.exitCode !== null || proc.signalCode !== null;
  const rootEntry = o.entry || {
    kind: o.kind,
    role: 'spawned',
    pid: proc.pid,
    port: o.port || null,
    dataDir: o.dataDir,
    fixture: o.fixture,
    ...(Number.isFinite(o.spawnedAt) ? { spawnedAt: o.spawnedAt } : {}),
  };
  if (o.port && !rootEntry.port) rootEntry.port = o.port;

  // 1. Who is in this fixture. Pid files are read BEFORE anything is signalled:
  //    a service that exits cleanly unlinks its own.
  /** @type {Map<number, {pid: number, kind: string, role: string, port: number|null, entry: object|null, createdMs: number|null, source: string}>} */
  const members = new Map();
  const candidate = (c) => {
    if (!c.pid || c.pid === proc.pid || c.pid === process.pid || members.has(c.pid)) return;
    members.set(c.pid, { port: null, entry: null, createdMs: null, ...c });
  };
  for (const e of o.members || []) {
    candidate({ pid: e.pid, kind: e.kind, role: e.role || 'pidfile', port: e.port || null, entry: e, source: 'the registry' });
  }
  for (const pf of o.pidFiles || []) {
    candidate({ pid: readPidFile(pf.file), kind: pf.kind, role: 'pidfile', port: pf.port || null, source: pf.file });
  }
  const table = await readTable();
  if (table) {
    const tol = toleranceFor(table.platform);
    for (const m of [...members.values()]) {
      const holder = table.byPid.get(m.pid);
      const ours = holder && (m.entry
        ? classify(m.entry, table).state === 'ours'
        : Boolean(holder.createdMs) && holder.createdMs >= lower - tol && holder.createdMs <= table.at + tol);
      if (ours) {
        m.createdMs = holder.createdMs;
        continue;
      }
      members.delete(m.pid);
      if (m.entry) close(m.entry, 'exited'); // the registered process is gone, whoever holds the number now
      if (holder) {
        console.error(
          'process-registry: pid ' + m.pid + ' named in ' + m.source + ' is not a process of this fixture ' +
            '(created ' + iso(holder.createdMs) + ', fixture started ' + iso(lower) + '): NOT signalled'
        );
      }
    }
    // The tree under every process verified so far (the root while its handle is
    // unreaped, and each verified member): launcher -> interpreter -> children.
    const roots = [...members.keys()];
    if (!reaped() && table.byPid.has(proc.pid)) roots.unshift(proc.pid);
    for (const r of roots) {
      for (const d of descendants(table, r)) {
        if (members.has(d.pid) || d.pid === proc.pid || d.pid === process.pid) continue;
        members.set(d.pid, {
          pid: d.pid,
          kind: /rlm-service\.py/.test(d.command) ? 'rlm' : o.kind,
          role: 'descendant',
          port: null,
          entry: null,
          createdMs: d.createdMs,
          source: 'the process tree under pid ' + r,
        });
      }
    }
  } else {
    // No process table: nothing can be verified and the tree cannot be walked.
    // A pid the fixture REGISTERED while its service was starting is still
    // stopped — it is in the run's registry. A pid known only from a pid file is
    // not: with no creation time to check, it could be anybody's, so it is left
    // alone and said so. If it really is this fixture's, the end-of-run check
    // finds it as a service of this checkout that no registry line accounts for.
    for (const m of [...members.values()]) {
      if (m.entry) continue;
      members.delete(m.pid);
      if (pidAlive(m.pid)) {
        console.error(
          'process-registry: no process table, so pid ' + m.pid + ' named in ' + m.source +
            ' cannot be verified as a process of this fixture: NOT signalled'
        );
      }
    }
  }

  // 2. The root, through its own handle (never by number: the handle IS the process).
  const done = new Promise((resolve) => {
    if (reaped()) return resolve();
    proc.once('exit', () => resolve());
  });
  const bounded = () => {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), o.graceMs);
    });
    return Promise.race([done, timedOut]).finally(() => clearTimeout(timer));
  };
  const signalRoot = (sig) => {
    try {
      proc.kill(sig);
    } catch (_e) {
      /* already gone */
    }
  };
  if (o.hard) {
    signalRoot('SIGKILL');
    await bounded();
  } else {
    signalRoot('SIGTERM');
    if (await bounded() === 'timeout') {
      signalRoot('SIGKILL');
      // Bounded: an `await done` here hangs forever when the child never exits,
      // which is precisely the case this code exists to report.
      await bounded();
    }
  }

  // 3. Everything else, each by exact pid, each bounded.
  const stillAnswering = [];
  for (const m of members.values()) {
    if (!(await killPid(m.pid, o.graceMs, Boolean(o.hard)))) stillAnswering.push(m);
  }

  // 4. What survived. A reaped handle is authoritative for the root: the child
  //    is dead and a pid that still answers is somebody else's (the 88-11 false
  //    alarm). For the others a pid that still answers is checked against the
  //    creation time remembered for it, so a recycled number is not a survivor.
  const rootGone = reaped() || (await waitForExit(proc.pid, o.graceMs));
  let survivors = stillAnswering;
  if (stillAnswering.length > 0) {
    const again = await readTable();
    if (again) {
      const tol = toleranceFor(again.platform);
      survivors = stillAnswering.filter((m) => {
        const holder = again.byPid.get(m.pid);
        if (!holder) return false;
        if (!m.createdMs || !holder.createdMs) return true;
        return Math.abs(holder.createdMs - m.createdMs) <= tol;
      });
    }
  }

  // 5. The registry follows the measurement.
  for (const m of members.values()) {
    const survived = survivors.includes(m);
    const entry = m.entry || {
      kind: m.kind,
      role: m.role,
      pid: m.pid,
      port: m.port || (m.kind === o.kind ? rootEntry.port : null),
      dataDir: o.dataDir,
      fixture: o.fixture,
      rootPid: proc.pid,
      spawnedAt: lower,
      at: Date.now(),
      ...(m.createdMs ? { createdMs: m.createdMs } : {}),
    };
    close(entry, survived ? 'started' : 'stopped');
  }
  close(rootEntry, rootGone ? 'stopped' : 'started');

  const out = survivors.map((m) => ({ pid: m.pid, kind: m.kind, role: m.role }));
  if (!rootGone) out.unshift({ pid: proc.pid, kind: o.kind, role: 'spawned' });
  return { rootGone, survivors: out, allGone: out.length === 0 };
}

/**
 * The error a fixture teardown throws when a process of the fixture survived,
 * so the OWNING test fails — not the whole run, eleven minutes later, with a
 * pid and a port and no name.
 *
 * @param {string} label e.g. 'fixture-daemon'
 * @param {{pid: number, kind: string, role: string}[]} survivors
 * @param {string} dataDir
 * @returns {Error}
 */
function survivorError(label, survivors, dataDir) {
  const err = new Error(
    label + ': ' + survivors.length + ' process(es) of this fixture survived teardown (SIGTERM, then SIGKILL, each ' +
      'with a bounded wait): ' + survivors.map((s) => 'pid ' + s.pid + ' (' + s.kind + ', ' + s.role + ')').join(', ') +
      '. Owner: ' + ownerOf() + '. Data dir kept: ' + dataDir + '. Each is recorded as RUNNING in the run registry.'
  );
  err.code = 'EFIXTURESURVIVOR';
  err.survivors = survivors;
  return err;
}

// ── the diagnostic watcher ───────────────────────────────────────────────────

/**
 * Start the process watcher: a child that appends one line per process it
 * ever sees (`pid<TAB>ppid<TAB>created<TAB>command`) to `outFile`, so the
 * ancestry of a process whose parents have exited can still be read after the
 * run. Diagnostic and opt-in (`GSD_PROCESS_WATCH=1`): it signals nothing.
 *
 * @param {string} outFile where the lines go
 * @param {string} [platform=process.platform]
 * @returns {import('child_process').ChildProcess|null} the watcher, to be killed by its handle; null when it could not start
 */
function startWatcher(outFile, platform = process.platform) {
  try {
    const fd = fs.openSync(outFile, 'a');
    const child = platform === 'win32'
      ? spawn(POWERSHELL_EXE, powershellArgs(PS_WATCH), { stdio: ['ignore', fd, 'ignore'], windowsHide: true })
      : spawn(process.execPath, [__filename, '--watch'], {
        stdio: ['ignore', fd, 'ignore'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    child.on('error', (e) => console.error('process-registry: the watcher could not start: ' + e.message));
    fs.closeSync(fd);
    return child;
  } catch (e) {
    console.error('process-registry: the watcher could not start: ' + e.message);
    return null;
  }
}

/**
 * The POSIX watcher loop (`node process-registry.cjs --watch`): the same lines
 * the Windows PowerShell loop prints, with the creation time already in epoch
 * ms and marked so (`ms:` prefix).
 * @returns {void}
 */
function watchLoop() {
  const seen = new Set();
  const tick = () => {
    const table = processTable();
    if (table) {
      for (const p of table.byPid.values()) {
        // etime has one-second resolution, so the creation time of one process
        // jitters between polls: key on the pid and the creation time to 4 s.
        const key = p.pid + ':' + Math.round(p.createdMs / 4000);
        if (seen.has(key)) continue;
        seen.add(key);
        process.stdout.write([p.pid, p.ppid, 'ms:' + p.createdMs, p.command].join('\t') + '\n');
      }
    }
  };
  tick();
  setInterval(tick, WATCH_INTERVAL_MS);
}

/**
 * Read a watcher log back.
 * @param {string} file
 * @returns {{pid: number, ppid: number, createdMs: number, command: string}[]} every process the watcher saw
 */
function readWatchLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return [];
  }
  const rows = [];
  const windowsLines = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length >= 4 && parts[2].startsWith('ms:')) {
      rows.push({
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        createdMs: Number(parts[2].slice(3)),
        command: parts.slice(3).join(' '),
      });
    } else {
      windowsLines.push(line);
    }
  }
  return rows.concat(parseWindowsTable(windowsLines.join('\n')));
}

/**
 * The chain of ancestors of a process, read from everything the watcher saw —
 * including parents that exited long before the run ended.
 *
 * @param {{pid: number, ppid: number, createdMs: number}} proc the process to explain
 * @param {{pid: number, ppid: number, createdMs: number, command: string}[]} seen `readWatchLog()` output
 * @param {string} [platform=process.platform]
 * @returns {{pid: number, ppid: number, createdMs: number, command: string}[]} parent first, then its parent, …
 */
function ancestry(proc, seen, platform = process.platform) {
  const tol = toleranceFor(platform);
  const chain = [];
  let cur = proc;
  for (let depth = 0; depth < 16 && cur && cur.ppid > 0; depth++) {
    // The parent is the newest process with that pid created no later than the child.
    let parent = null;
    for (const p of seen) {
      if (p.pid !== cur.ppid || !p.createdMs) continue;
      if (cur.createdMs && p.createdMs > cur.createdMs + tol) continue;
      if (!parent || p.createdMs > parent.createdMs) parent = p;
    }
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

// ── the run timeline (which test file was running when) ─────────────────────

/**
 * Read the run timeline written by `tests/support/run-timeline.cjs`.
 * @param {string} file
 * @returns {{file: string, pid: number, start: number, end: number|null}[]} one window per test-file process
 */
function readTimeline(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return [];
  }
  const byPid = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (rec.event === 'file-start') byPid.set(rec.pid + ':' + rec.at, { file: rec.file, pid: rec.pid, start: rec.at, end: null });
    else if (rec.event === 'file-end') {
      for (const w of byPid.values()) if (w.pid === rec.pid && w.end === null) w.end = rec.at;
    }
  }
  return [...byPid.values()];
}

/**
 * The test files that were running at a given moment.
 * @param {ReturnType<typeof readTimeline>} timeline
 * @param {number} atMs
 * @param {number} [slackMs=3000] how far outside a window a moment may fall and still count
 * @returns {string[]} file names, deduplicated
 */
function filesRunningAt(timeline, atMs, slackMs = 3000) {
  const out = new Set();
  for (const w of timeline) {
    if (atMs >= w.start - slackMs && atMs <= (w.end === null ? Infinity : w.end + slackMs)) out.add(w.file);
  }
  return [...out];
}

// ── the audit the runner runs after the tests ───────────────────────────────

/**
 * A shared index of the registries of every run in progress on this machine,
 * so one run does not mistake another run's registered fixture for a process
 * nobody registered (a nested runner inside a test, two runs side by side).
 */
const ACTIVE_DIR = path.join(os.tmpdir(), 'gsd-run-registries');

/**
 * Announce this run's registry to other runs. Never throws.
 * @param {string} registryFile
 * @returns {string|null} the marker file, to hand to `withdraw()`
 */
function announce(registryFile) {
  try {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
    const marker = path.join(ACTIVE_DIR, process.pid + '-' + Date.now() + '.json');
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, registry: registryFile, at: Date.now() }));
    return marker;
  } catch (_e) {
    return null;
  }
}

/**
 * Remove this run's marker. Never throws.
 * @param {string|null} marker
 * @returns {void}
 */
function withdraw(marker) {
  if (!marker) return;
  try {
    fs.rmSync(marker, { force: true });
  } catch (_e) {
    /* best effort */
  }
}

/**
 * Open entries of every OTHER run in progress (markers whose runner is dead
 * are removed on the way).
 * @param {string} ownRegistry
 * @returns {object[]} registry entries
 */
function foreignOpenEntries(ownRegistry) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(ACTIVE_DIR);
  } catch (_e) {
    return out;
  }
  for (const name of names) {
    const marker = path.join(ACTIVE_DIR, name);
    try {
      const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (!pidAlive(m.pid)) {
        fs.rmSync(marker, { force: true });
        continue;
      }
      if (m.registry === ownRegistry) continue;
      out.push(...readEntries(m.registry).open);
    } catch (_e) {
      /* a marker being written or removed right now */
    }
  }
  return out;
}

/**
 * Daemon and RLM processes that ARE NOT in the registry. Reported, never
 * signalled: this is the list the operator's own live daemon would be on.
 *
 * A process is listed when its command line runs `amauta-daemon.py` or
 * `rlm-service.py` and no registry of this or any other run in progress
 * accounts for it. Each carries `preexisting`: whether it was created before
 * this run began.
 *
 * @param {object} o
 * @param {{platform: string, byPid: Map<number, object>}} o.table
 * @param {object[]} o.registered every entry (open and closed) of this run and open ones of other runs
 * @param {number} o.runStartedAt
 * @param {function(number): boolean} [o.isProtectedPid]
 * @param {string} [o.repoRoot] the checkout whose `services/` scripts are labelled as this checkout's
 * @returns {{pid: number, ppid: number, createdMs: number, command: string, inCheckout: boolean, preexisting: boolean}[]}
 */
function unregisteredServices(o) {
  const tol = toleranceFor(o.table.platform);
  const norm = (d) => String(d).split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const roots = [o.repoRoot || REPO].map(norm);
  // Accounted for: every process a registry line identifies, and everything
  // under one (the interpreter behind a registered launcher, a registered
  // daemon's RLM child).
  const known = new Set();
  for (const e of o.registered) {
    if (known.has(e.pid) || classify(e, o.table).state !== 'ours') continue;
    known.add(e.pid);
    for (const d of descendants(o.table, e.pid)) known.add(d.pid);
  }
  const out = [];
  for (const p of o.table.byPid.values()) {
    // A process that merely MENTIONS a script (inline Python source that imports
    // the daemon module, a grep, an editor) is not a service: the script has to
    // be followed by the verb a service is started with.
    if (!SERVICE_CMD_RE.test(p.command)) continue;
    if (!p.createdMs) continue;
    if (o.isProtectedPid && o.isProtectedPid(p.pid)) continue;
    if (known.has(p.pid)) continue;
    const cmd = p.command.split('\\').join('/').toLowerCase();
    out.push({
      ...p,
      inCheckout: roots.some((r) => cmd.includes(r + '/services/')),
      // Created before the run began: it was already there (the operator's live
      // daemon; on a CI runner, the daemon the package's install script starts).
      preexisting: p.createdMs + tol < o.runStartedAt,
    });
  }
  return out;
}

/**
 * Everything the runner needs to know about processes after a run.
 *
 * @param {string} registryFile the run's registry
 * @param {object} [o]
 * @param {function(number): boolean} [o.isProtectedPid] pids that are never claimed (this process, its parent, the live daemon's)
 * @param {number} [o.runStartedAt] when the run began; without it no unregistered census is taken
 * @param {ReturnType<typeof processTable>} [o.table] a table to use instead of reading one
 * @param {string} [o.repoRoot]
 * @returns {{strays: object[], recycled: object[], unclosed: object[], unregistered: object[], preexisting: object[], table: object|null}}
 *   `strays` are registered processes still alive (or alive and unverifiable);
 *   `recycled` are entries whose pid now belongs to another process;
 *   `unclosed` are entries nobody closed whose process is gone;
 *   `unregistered` are service-like processes created during the run that no registry accounts for;
 *   `preexisting` are services of this checkout that were already running when the run began.
 */
function audit(registryFile, o = {}) {
  const isProtected = o.isProtectedPid || (() => false);
  const { open, closed } = readEntries(registryFile);
  const result = { strays: [], recycled: [], unclosed: [], unregistered: [], preexisting: [], table: null };
  const answering = open.filter((e) => pidAlive(e.pid));
  // A fixture owes its line a closing one. A service that registered ITSELF
  // through a product path owes nothing: when it is gone, it is simply gone.
  const owesClosing = (e) => e.role !== 'self';
  for (const e of open) if (!answering.includes(e) && owesClosing(e)) result.unclosed.push(e);
  const needTable = answering.length > 0 || Number.isFinite(o.runStartedAt);
  // One retry: a table that cannot be read leaves every live entry UNVERIFIED,
  // which fails the run, and a cold PowerShell on a loaded runner can time out once.
  const table = needTable ? (o.table !== undefined ? o.table : (processTable() || processTable())) : null;
  result.table = table;
  for (const e of answering) {
    const base = {
      selfRegistered: Boolean(e.selfRegistered),
      ppid: e.ppid,
      pid: e.pid,
      kind: e.kind || 'daemon',
      port: e.port || null,
      dataDir: e.dataDir || null,
      owner: e.owner || null,
      fixture: e.fixture || null,
      role: e.role || null,
      spawnedAt: e.spawnedAt,
      at: e.at,
      createdMs: e.createdMs,
    };
    if (isProtected(e.pid)) {
      result.strays.push({ ...base, identified: false, reason: 'protected pid', holder: null });
      continue;
    }
    const c = table ? classify(e, table) : { state: 'unverified', holder: null };
    if (c.state === 'gone') {
      if (owesClosing(e)) result.unclosed.push(e); // it exited between the probe and the table
    } else if (c.state === 'recycled') {
      result.recycled.push({ ...base, holder: c.holder });
    } else if (c.state === 'ours') {
      let eperm = false;
      try {
        process.kill(e.pid, 0);
      } catch (err) {
        eperm = err.code === 'EPERM';
      }
      result.strays.push(eperm
        ? { ...base, identified: false, reason: 'not ours (EPERM)', holder: c.holder }
        : { ...base, identified: true, reason: 'identified by the run registry (pid and start time)', holder: c.holder });
    } else {
      const why = !table
        ? 'the process table could not be read, so the pid cannot be proven to be the registered process'
        : (!Number.isFinite(e.spawnedAt) && !Number.isFinite(e.createdMs)
          ? 'the registry line carries no start time, so the pid cannot be proven to be the registered process'
          : 'the holder\'s start time is unknown, so the pid cannot be proven to be the registered process');
      result.strays.push({ ...base, identified: false, reason: why, holder: c.holder });
    }
  }
  if (table && Number.isFinite(o.runStartedAt)) {
    const outside = unregisteredServices({
      table,
      registered: [...open, ...closed, ...foreignOpenEntries(registryFile)],
      runStartedAt: o.runStartedAt,
      isProtectedPid: isProtected,
      repoRoot: o.repoRoot,
    });
    result.unregistered = outside.filter((p) => !p.preexisting);
    result.preexisting = outside.filter((p) => p.preexisting && p.inCheckout);
  }
  return result;
}

/**
 * @param {number|undefined} ms
 * @returns {string} ISO time, or '?' when unknown
 */
function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '?';
}

/**
 * One line saying who started a registered process.
 * @param {{owner?: string, fixture?: string, role?: string, spawnedAt?: number, at?: number}} e
 * @returns {string}
 */
function provenance(e) {
  if (e.role === 'self') {
    return 'started by ' + (e.owner || 'an unknown test file') + ' through a PRODUCT path, not a fixture ' +
      '(the service registered itself at ' + iso(e.at) + ')';
  }
  if (!e.owner && !e.fixture) return 'started by: unknown (the registry line names no owner)';
  return 'started by ' + (e.owner || 'unknown') + (e.fixture ? ' through ' + e.fixture : '') +
    (e.role && e.role !== 'spawned' ? ' [' + e.role + ']' : '') +
    ' at ' + iso(Number.isFinite(e.spawnedAt) ? e.spawnedAt : e.at);
}

/**
 * @param {{pid: number, ppid: number, createdMs: number, command: string}|null} h
 * @returns {string}
 */
function holderText(h) {
  if (!h) return 'unknown';
  return 'pid ' + h.pid + ' ppid ' + h.ppid + ' created ' + iso(h.createdMs) + ' cmd=' + String(h.command).slice(0, 300);
}

module.exports = {
  REPO,
  SERVICE_RE,
  SERVICE_CMD_RE,
  TOLERANCE_MS,
  toleranceFor,
  ownerOf,
  registryPath,
  append,
  register,
  close,
  annotate,
  SELF_REGISTER_SLACK_MS,
  selfRegistryPath,
  readSelfLines,
  readEntries,
  elapsedSeconds,
  parsePosixTable,
  parseWindowsTable,
  powershellArgs,
  processTable,
  processTableAsync,
  classify,
  descendants,
  pidAlive,
  PROCESS_STARTED_AT,
  readPidFile,
  waitForExit,
  killPid,
  reapFixture,
  survivorError,
  startWatcher,
  readWatchLog,
  ancestry,
  readTimeline,
  filesRunningAt,
  announce,
  withdraw,
  foreignOpenEntries,
  unregisteredServices,
  audit,
  iso,
  provenance,
  holderText,
};

if (require.main === module && process.argv[2] === '--watch') watchLoop();
