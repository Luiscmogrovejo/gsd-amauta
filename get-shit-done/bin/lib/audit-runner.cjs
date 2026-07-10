'use strict';

// ============================================================================
// audit-runner.cjs — the shared, read-only, daemon-optional detect engine
// (Phase 83 / plan 83-01 / task 83-01-01, LOOP-01 core).
//
// This is the runnable encoding of the 9 domain auditors' documented, headline,
// statically-decidable Detect expressions — lifted VERBATIM from the Phase-81/82
// behavioral tests (tests/81-01-domain-auditors-w1.test.cjs +
// tests/82-01-domain-auditors-w2.test.cjs), where each was already proven sound
// on a seeded/real violation and a clean control. The auditors themselves are
// read-only agent-prompts; this module is the primitive their three entry points
// reuse:
//   • LOOP-01  the `/amauta:audit` verb (gsd-tools) drives runAudit(domain, …)
//   • LOOP-02  the on-phase-close hook drives runAudit(null, {files: blastRadius})
//   • LOOP-03  the audit-close-loop narrow re-audit drives reauditFile(rule, file)
//
// HARD BOUNDARY — READ-ONLY. This engine only READS files (fs.readFileSync) and
// POSTs findings over HTTP (POST /api/findings, finding_type='audit'). It NEVER
// writes/patches code, never spawns a Write-bearing agent, and never shells out
// (no child_process). A rule that cannot be decided statically emits a
// `warning`-severity finding with evidence '[UNVERIFIABLE — manual review]' —
// never a silent pass, never a fix.
//
// ZERO npm deps — Node stdlib only (fs, path, http): the exact idiom
// findings-to-plan / audit-close-loop already use.
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');

// Audit root — the repo UNDER AUDIT, not this module's install tree.
// This module lives at get-shit-done/bin/lib/audit-runner.cjs, so three levels
// up is the MODULE's root — correct only when the engine runs from a checkout
// of the repo being audited. When it runs from the installed copy
// (~/.claude/get-shit-done/bin/lib/) that resolves to ~/.claude, so the
// repo-scope detects (AGEN-04/AGEN-06) audited the INSTALL tree instead of the
// repo under audit (live symptom: AGEN-06 reported "0 eval sets" when the
// audited repo has 3). defaultRoot() therefore resolves from process.cwd()
// whenever cwd looks like a repo (has .planning/ or package.json), falling back
// to the module-relative root only for odd cwds (e.g. unit tests run from /).
// Computed at CALL time (not load time) so callers/tests may chdir first; an
// explicit opts.root / ctx.root always wins over the default.
const MODULE_ROOT = path.resolve(__dirname, '..', '..', '..');
function defaultRoot() {
  const cwd = process.cwd();
  try {
    if (fs.existsSync(path.join(cwd, '.planning')) || fs.existsSync(path.join(cwd, 'package.json'))) {
      return cwd;
    }
  } catch (_) { /* unreadable cwd → module-relative fallback */ }
  return MODULE_ROOT;
}

// ───────────────────────────────────────────────────────────────────────────
// Detector implementations — mirror each rule's documented Detect VERBATIM from
// the Phase-81/82 tests. Pure functions, no side effects, no network.
// ───────────────────────────────────────────────────────────────────────────

// FRONT-01: onClick on a bare <div>/<span> with no `role` attribute.
function detectOnClickBareDiv(jsxSrc) {
  const hits = [];
  const lines = jsxSrc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/<(div|span)\b([^>]*)/);
    if (!m) continue;
    const attrs = m[2];
    if (/\bonClick\b/.test(attrs) && !/\brole\s*=/.test(attrs)) hits.push(i + 1);
  }
  return hits;
}

// FRONT-05: a client-src env reference that is neither NEXT_PUBLIC_ / VITE_
// prefixed nor otherwise public — a *_SECRET / private key leaked into the bundle.
function detectClientSecretEnv(src) {
  const hits = [];
  const re = /process\.env\.([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (name.startsWith('NEXT_PUBLIC_') || name.startsWith('VITE_')) continue; // public → OK
    if (/SECRET|PRIVATE|_KEY|TOKEN|PASSWORD/.test(name)) hits.push(name);
  }
  return hits;
}

// APIC-01: an outbound fetch() call with no timeout / AbortSignal option.
function detectFetchWithoutTimeout(src) {
  const hits = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bfetch\s*\(/.test(line)) continue;
    if (/AbortSignal|timeout|signal\s*:/.test(line)) continue; // bounded → OK
    hits.push(i + 1);
  }
  return hits;
}

// APIC-04: a mutating POST/PUT request-config block with no idempotency key.
function detectPostWithoutIdempotencyKey(configSrc) {
  const isMutating = /method\s*:\s*['"](POST|PUT)['"]/i.test(configSrc)
    || /\.(post|put)\s*\(/.test(configSrc)
    || /-X\s*(POST|PUT)/i.test(configSrc);
  if (!isMutating) return false;
  const hasKey = /idempotency[-_]?key/i.test(configSrc);
  return !hasKey; // mutating without an idempotency key → finding
}

// AGEN-04: a token/cost budget-ceiling ENFORCEMENT anywhere in the given dirs.
// The finding is the ABSENCE — an empty result set means no hard ceiling exists.
//
// Built from fragments so THIS detector's own source does not contain the literal
// ceiling identifiers it searches for (auditor self-exclusion). Were the pattern
// written as a literal, audit-runner.cjs — living under get-shit-done/bin/ — would
// itself satisfy the ceiling-presence grep and mask the genuine absence (and break
// the Phase-82 AGEN-04 real-tree assertion).
const _CEIL = '_' + 'ceiling';
const CEILING_RE = new RegExp(
  ['budget', 'token', 'cost'].map((s) => s + _CEIL).join('|') + '|max' + '_tokens_' + 'budget'
);
function detectCeilingEnforcement(dirs) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(py|cjs|js|mjs|ts)$/.test(e.name)) continue;
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (CEILING_RE.test(txt)) hits.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

// AGEN-06: agent eval-set count (tests/evals/*.json sans grader-schemas.json).
function countAgentEvalSets(evalsDir) {
  let entries;
  try { entries = fs.readdirSync(evalsDir); } catch (_) { return 0; }
  return entries.filter((f) => f.endsWith('.json') && f !== 'grader-schemas.json').length;
}

// AGEN-06 (denominator): the gsd-* source-agent roster.
function countAgentRoster(sourceDir) {
  let entries;
  try { entries = fs.readdirSync(sourceDir, { withFileTypes: true }); } catch (_) { return 0; }
  return entries.filter((e) => e.isDirectory() && /^gsd-/.test(e.name)).length;
}

// MOBL-A1: a manifest <uses-permission> with no matching code usage (dangling).
function detectDanglingPermissions(manifestSrc, usedPermissions) {
  const used = new Set(usedPermissions);
  const hits = [];
  const re = /<uses-permission\s+android:name="([^"]+)"/g;
  let m;
  while ((m = re.exec(manifestSrc)) !== null) {
    if (!used.has(m[1])) hits.push(m[1]);
  }
  return hits;
}

// MOBL-A4: an inline high-entropy API key in a strings.xml <string> resource.
const BUNDLE_KEY_RE = /\b(AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,}|sk-[0-9A-Za-z]{20,})\b/;
function detectStringsXmlSecret(stringsXmlSrc) {
  const hits = [];
  const re = /<string\s+name="([^"]+)"\s*>([^<]*)<\/string>/g;
  let m;
  while ((m = re.exec(stringsXmlSrc)) !== null) {
    if (BUNDLE_KEY_RE.test(m[2])) hits.push(m[1]);
  }
  return hits;
}

// GEN-06: a doc-referenced path that does not resolve on disk (doc drift).
function detectDocDrift(docSrc, baseDir) {
  const hits = [];
  const re = /`([\w./-]+\.(?:md|cjs|js|py|json|ts))`/g;
  let m;
  while ((m = re.exec(docSrc)) !== null) {
    const ref = m[1];
    if (!fs.existsSync(path.resolve(baseDir, ref))) hits.push(ref);
  }
  return hits;
}

// GEN-08: a debug artifact left in source (`debugger`, `.only`, `fdescribe`).
function detectDebugArtifact(src) {
  const hits = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/\bdebugger\b|\.only\s*\(|\bfdescribe\s*\(|\bfit\s*\(/.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}

// GEN-04: a module unreferenced by any import/require across the given file set.
function detectUnreferencedInSet(files, target) {
  const stem = path.basename(target).replace(/\.[^.]+$/, '');
  for (const f of files) {
    if (path.resolve(f) === path.resolve(target)) continue;
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    if (new RegExp(`(require|import)[^\\n]*['"\`][^'"\`]*${stem}`).test(txt)) return false; // referenced
  }
  return true; // unreferenced → dead file
}

// BACK-05: a migrations/NNN-*.sql UP must have a non-empty NNN-*-DOWN.sql sibling.
function detectMissingDown(upFile) {
  const base = path.basename(upFile);
  if (!/^\d.*\.sql$/.test(base) || /-DOWN\.sql$/.test(base)) return false;
  const down = upFile.replace(/\.sql$/, '-DOWN.sql');
  const ok = fs.existsSync(down) && fs.readFileSync(down, 'utf8').trim().length > 0;
  return !ok; // missing / empty DOWN → finding
}

// BACK-06: a DB call (.query(/.execute() lexically inside a for/forEach/map loop.
function detectDbCallInLoop(src) {
  const lines = src.split('\n');
  let depth = 0;
  const loopDepths = [];
  let loopPending = false;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bfor\s*\(|\.forEach\s*\(|\.map\s*\(/.test(line)) loopPending = true;
    if (loopDepths.length > 0 && /\.(query|execute)\s*\(/.test(line)) hits.push(i + 1);
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        if (loopPending) { loopDepths.push(depth); loopPending = false; }
      } else if (ch === '}') {
        if (loopDepths.length && loopDepths[loopDepths.length - 1] === depth) loopDepths.pop();
        depth--;
      }
    }
  }
  return hits;
}

// INFRA-01: a compose `image:` value that is :latest, a bare tag, or latest-* —
// NOT pinned by an exact version or @sha256 digest.
function detectUnpinnedImages(composeSrc) {
  const hits = [];
  for (const line of composeSrc.split('\n')) {
    const m = line.match(/^\s*image:\s*(\S+)/);
    if (!m) continue;
    const ref = m[1].replace(/['"]/g, '');
    if (ref.includes('@sha256:')) continue;            // digest-pinned → OK
    const afterSlash = ref.substring(ref.lastIndexOf('/') + 1);
    const tag = afterSlash.includes(':') ? afterSlash.split(':')[1] : null;
    if (!tag) { hits.push(ref); continue; }            // bare tag → unpinned
    if (/latest/.test(tag)) hits.push(ref);            // :latest / latest-* → unpinned
  }
  return hits;
}

// INFRA-03: a compose service with no `healthcheck:` key.
function detectServicesWithoutHealthcheck(composeSrc) {
  const lines = composeSrc.split('\n');
  let inServices = false;
  let current = null;
  const services = {};
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim()) { inServices = false; current = null; continue; }
    const svc = line.match(/^ {2}([\w-]+):\s*$/);
    if (svc) { current = svc[1]; services[current] = []; continue; }
    if (current) services[current].push(line);
  }
  return Object.keys(services).filter((s) => !services[s].some((l) => /healthcheck:/.test(l)));
}

// MODL-01/06: an inline claude-<tier>-<date> literal (a pinned model id).
const MODEL_ID_RE = /claude-[a-z]+-[0-9]/;
// The sanctioned single source of truth for model ids (the registry module) and
// its last-known-good fallbacks are NOT violations — every OTHER caller must
// resolve through the registry instead of holding an inline literal.
const MODEL_REGISTRY_FILES = /(?:^|[/\\])(?:model-registry\.(?:json|cjs)|model_registry\.py)$/;
const SANCTIONED_FALLBACK_MARKER = /last-known-good|model[-_ ]registry fallback|registry fallback/i;
function detectInlineModelId(src, filePath) {
  // The registry file itself legitimately holds the canonical ids.
  if (filePath && MODEL_REGISTRY_FILES.test(filePath)) return false;
  if (!MODEL_ID_RE.test(src)) return false;
  // Ignore ids on lines explicitly annotated as the sanctioned degradation-path
  // fallback (a literal is unavoidable there — it fires WHEN the registry can't load).
  const offending = src.split('\n').filter(
    (line) => MODEL_ID_RE.test(line) && !SANCTIONED_FALLBACK_MARKER.test(line)
  );
  return offending.length > 0;
}

// HARN-02: validator == claimer per task (a JSON task ledger — {tasks:[…]}).
function detectValidatorEqualsClaimer(ledger) {
  return (ledger.tasks || [])
    .filter((t) => t.claim && t.validation && t.claim.agent && t.claim.agent === t.validation.agent)
    .map((t) => t.id);
}

// ───────────────────────────────────────────────────────────────────────────
// DETECT REGISTRY — per-domain runnable detects. Each descriptor is one of:
//   • per-file : test(content, filePath) → boolean | string(evidence) | array
//   • fileset  : { fileset:true, scan(files) → [{ file_path, evidence }] }
//   • repo     : { scope:'repo', scan(ctx{ root }) → [{ file_path, evidence }] }
// Every rule_id / domain corresponds to a real shipped auditor rule.
// ───────────────────────────────────────────────────────────────────────────

const DETECT_REGISTRY = {
  frontend: [
    {
      rule_id: 'FRONT-01', domain: 'frontend', severity: 'warning',
      suggested_fix: 'Use a semantic <button>, or add role + keyboard handlers to the interactive element.',
      test(content) {
        const hits = detectOnClickBareDiv(content);
        return hits.length ? `onClick on a bare <div>/<span> lacking role (line ${hits.join(', ')})` : false;
      },
    },
    {
      rule_id: 'FRONT-05', domain: 'frontend', severity: 'error',
      suggested_fix: 'Move the secret server-side; only NEXT_PUBLIC_/VITE_ prefixed values may reach client source.',
      test(content) {
        const hits = detectClientSecretEnv(content);
        return hits.length ? `non-public secret env ref in client source: ${hits.join(', ')}` : false;
      },
    },
  ],
  'api-connections': [
    {
      rule_id: 'APIC-01', domain: 'api-connections', severity: 'warning',
      suggested_fix: 'Pass an AbortSignal.timeout(ms) / timeout option to every outbound call.',
      test(content) {
        const hits = detectFetchWithoutTimeout(content);
        return hits.length ? `fetch() with no timeout/AbortSignal (line ${hits.join(', ')})` : false;
      },
    },
    {
      rule_id: 'APIC-04', domain: 'api-connections', severity: 'warning',
      suggested_fix: 'Add an Idempotency-Key header (or server-side dedup) to mutating POST/PUT calls.',
      test(content) {
        return detectPostWithoutIdempotencyKey(content)
          ? 'mutating POST/PUT with no idempotency key / dedup'
          : false;
      },
    },
  ],
  'agentic-flow': [
    {
      rule_id: 'AGEN-04', domain: 'agentic-flow', severity: 'warning', scope: 'repo',
      suggested_fix: 'Add a hard token/cost budget ceiling enforcement identifier (a budget/token/cost ceiling constant) in services/ or the harness bin.',
      scan(ctx) {
        const root = (ctx && ctx.root) || defaultRoot();
        const dirs = [path.join(root, 'services'), path.join(root, 'get-shit-done', 'bin')];
        const ceilingHits = detectCeilingEnforcement(dirs);
        if (ceilingHits.length > 0) return []; // a ceiling IS enforced → clean
        return [{
          file_path: 'services/,get-shit-done/bin/',
          evidence: 'no token/cost budget-ceiling enforcement found across services/ + get-shit-done/bin/ (ceiling absence)',
        }];
      },
    },
    {
      rule_id: 'AGEN-06', domain: 'agentic-flow', severity: 'warning', scope: 'repo',
      suggested_fix: 'Grow agent eval coverage (tests/evals/*.json) toward the gsd-* agent roster.',
      scan(ctx) {
        const root = (ctx && ctx.root) || defaultRoot();
        const evalSets = countAgentEvalSets(path.join(root, 'tests', 'evals'));
        const roster = countAgentRoster(path.join(root, 'get-shit-done', 'agents'));
        if (roster === 0 || evalSets >= roster) return []; // parity → clean
        return [{
          file_path: 'tests/evals/',
          evidence: `eval coverage gap: ${evalSets} agent eval set(s) vs a ${roster}-agent roster`,
        }];
      },
    },
  ],
  mobile: [
    {
      rule_id: 'MOBL-A1', domain: 'mobile', severity: 'warning', fileset: true,
      suggested_fix: 'Remove the unused <uses-permission>, or add the code that justifies it.',
      // Dangling = declared in a manifest file but its short name appears in no
      // code file in the scanned set. Cross-file: read declarations + usages
      // from the provided file set (matches the 82-01 detectDanglingPermissions).
      scan(files) {
        const manifests = [];
        const usedTokens = new Set();
        for (const f of files) {
          let txt;
          try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
          if (/<uses-permission\s+android:name=/.test(txt)) {
            manifests.push({ file_path: f, src: txt });
          } else {
            // any non-manifest file contributes usage tokens (short perm names).
            const um = txt.match(/[A-Z_]{3,}/g) || [];
            for (const t of um) usedTokens.add(t);
          }
        }
        const out = [];
        for (const man of manifests) {
          const perms = detectDanglingPermissions(man.src, []); // all declared perms
          for (const perm of perms) {
            const short = perm.split('.').pop();
            if (!usedTokens.has(short)) {
              out.push({ file_path: man.file_path, evidence: `dangling <uses-permission> ${perm} (no code usage)` });
            }
          }
        }
        return out;
      },
    },
    {
      rule_id: 'MOBL-A4', domain: 'mobile', severity: 'error',
      suggested_fix: 'Move the key out of strings.xml/Info.plist into a secure secret store; never bundle it.',
      test(content) {
        const hits = detectStringsXmlSecret(content);
        return hits.length ? `inline bundle secret in string resource(s): ${hits.join(', ')}` : false;
      },
    },
  ],
  general: [
    {
      rule_id: 'GEN-04', domain: 'general', severity: 'warning', fileset: true,
      suggested_fix: 'Delete the dead module, or wire it into the import graph.',
      scan(files) {
        const out = [];
        for (const f of files) {
          if (!/\.(cjs|js|mjs|ts)$/.test(f)) continue;
          let ok = true;
          try { ok = fs.statSync(f).isFile(); } catch (_) { ok = false; }
          if (!ok) continue;
          if (detectUnreferencedInSet(files, f)) {
            out.push({ file_path: f, evidence: 'module unreferenced by any import/require in the scanned set (dead file)' });
          }
        }
        return out;
      },
    },
    {
      rule_id: 'GEN-06', domain: 'general', severity: 'warning',
      suggested_fix: 'Update the doc to a path that resolves, or restore the referenced file.',
      test(content, filePath) {
        const baseDir = filePath ? path.dirname(filePath) : defaultRoot();
        const hits = detectDocDrift(content, baseDir);
        return hits.length ? `doc references unresolved path(s): ${hits.join(', ')}` : false;
      },
    },
    {
      rule_id: 'GEN-08', domain: 'general', severity: 'warning',
      suggested_fix: 'Remove the debug artifact (debugger / .only / fdescribe / fit) before merge.',
      test(content) {
        const hits = detectDebugArtifact(content);
        return hits.length ? `debug artifact left in source (line ${hits.join(', ')})` : false;
      },
    },
  ],
  backend: [
    {
      rule_id: 'BACK-05', domain: 'backend', severity: 'warning', fileset: true,
      suggested_fix: 'Add a non-empty NNN-*-DOWN.sql sibling with the reversing migration.',
      scan(files) {
        const out = [];
        for (const f of files) {
          if (detectMissingDown(f)) {
            out.push({ file_path: f, evidence: 'migration UP has no non-empty -DOWN.sql sibling' });
          }
        }
        return out;
      },
    },
    {
      rule_id: 'BACK-06', domain: 'backend', severity: 'warning',
      suggested_fix: 'Hoist the DB call out of the loop (batch / single query) to avoid N+1.',
      test(content) {
        const hits = detectDbCallInLoop(content);
        return hits.length ? `DB call inside a loop — potential N+1 (line ${hits.join(', ')})` : false;
      },
    },
  ],
  infra: [
    {
      rule_id: 'INFRA-01', domain: 'infra', severity: 'warning',
      suggested_fix: 'Pin the image to an exact version or @sha256 digest (never :latest / bare tag).',
      test(content) {
        const hits = detectUnpinnedImages(content);
        return hits.length ? `unpinned image reference(s): ${hits.join(', ')}` : false;
      },
    },
    {
      rule_id: 'INFRA-03', domain: 'infra', severity: 'warning',
      suggested_fix: 'Add a healthcheck: block to each long-running service.',
      test(content) {
        const missing = detectServicesWithoutHealthcheck(content);
        return missing.length ? `compose service(s) with no healthcheck: ${missing.join(', ')}` : false;
      },
    },
  ],
  models: [
    {
      rule_id: 'MODL-01', domain: 'models', severity: 'warning',
      suggested_fix: 'Resolve model ids through get-shit-done/bin/lib/model-registry.json (model-registry.cjs / services/model_registry.py); do not add inline literals. Keep the registry ids on the latest GA tier.',
      test(content, filePath) {
        return detectInlineModelId(content, filePath)
          ? `inline claude-<tier>-<date> model id literal (${(content.match(MODEL_ID_RE) || [''])[0]}) outside the model registry`
          : false;
      },
    },
  ],
  'harness-self': [
    {
      rule_id: 'HARN-02', domain: 'harness-self', severity: 'error',
      suggested_fix: 'Route validation to an agent other than the claimer (no self-validation).',
      // Operates on a JSON task ledger ({tasks:[{claim,validation}]}). A file
      // that is not a parseable ledger is a no-op (never a false positive).
      test(content) {
        let ledger;
        try { ledger = JSON.parse(content); } catch (_) { return false; }
        if (!ledger || !Array.isArray(ledger.tasks)) return false;
        const fired = detectValidatorEqualsClaimer(ledger);
        return fired.length ? `validator == claimer on task(s): ${fired.join(', ')}` : false;
      },
    },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Finding construction — the exact audit-emission shape the Phase-78 substrate
// accepts (required: agent_name/finding_type/content; optional: severity/
// rule_id/domain/file_path/evidence/suggested_fix). finding_type is always
// 'audit'; the server computes dedup_key = rule_id:sha1(file_path).
// ───────────────────────────────────────────────────────────────────────────

function makeFinding(desc, hit) {
  const evidence = hit.evidence || '[UNVERIFIABLE — manual review]';
  return {
    agent_name: `gsd-auditor-${desc.domain}`,
    finding_type: 'audit',
    severity: desc.severity || 'warning',
    rule_id: desc.rule_id,
    domain: desc.domain,
    file_path: hit.file_path,
    evidence,
    suggested_fix: desc.suggested_fix || '',
    content: `[${desc.rule_id}] ${evidence}`,
  };
}

// Resolve the descriptor list for a domain (or ALL domains when falsy/'all').
function resolveDomains(domain) {
  if (!domain || domain === 'all') return Object.keys(DETECT_REGISTRY);
  return DETECT_REGISTRY[domain] ? [domain] : [];
}

// ───────────────────────────────────────────────────────────────────────────
// (b) detect(domain, files, opts) → findings[]  — PURE, no network.
//   • per-file detects: read each file (read-only) and run test(content, path)
//   • fileset detects : scan(files)
//   • repo detects    : scan({ root }) — inspects the tree, not `files`
// ───────────────────────────────────────────────────────────────────────────

function detect(domain, files, opts) {
  const options = opts || {};
  const fileList = Array.isArray(files) ? files : (files ? [files] : []);
  const findings = [];
  for (const d of resolveDomains(domain)) {
    for (const desc of DETECT_REGISTRY[d]) {
      if (desc.scope === 'repo') {
        for (const hit of desc.scan({ root: options.root })) findings.push(makeFinding(desc, hit));
        continue;
      }
      if (desc.fileset) {
        for (const hit of desc.scan(fileList)) findings.push(makeFinding(desc, hit));
        continue;
      }
      // per-file
      for (const fp of fileList) {
        let content;
        try { content = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
        const res = desc.test(content, fp);
        if (res) {
          const evidence = typeof res === 'string' ? res : undefined;
          findings.push(makeFinding(desc, { file_path: fp, evidence }));
        }
      }
    }
  }
  return findings;
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP POST helper — mirrors the findings-to-plan / audit-close-loop idiom.
// Best-effort: a down daemon resolves to { ok:false, daemon:false }, never throws.
// ───────────────────────────────────────────────────────────────────────────

function postFinding(finding, port) {
  return new Promise((resolve) => {
    const body = JSON.stringify(finding);
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/api/findings', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* non-JSON */ }
        resolve({ ok: res.statusCode < 400, daemon: true, status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ ok: false, daemon: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, daemon: false }); });
    req.write(body); req.end();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// (c) runAudit(domain, { scope, files, post, port, cwd, root }) → { findings, posted }
//   detect + (optionally) POST each finding to the Phase-78 substrate. Best-effort:
//   daemon down ⇒ posted:0, findings still returned. Copies the http idiom + the
//   AMAUTA_PORT || 18799 convention from findings-to-plan / audit-close-loop.
// ───────────────────────────────────────────────────────────────────────────

async function runAudit(domain, opts) {
  const options = opts || {};
  // `scope` may be a comma-separated string of files (the verb's --scope form)
  // or an array; `files` is the array form (the LOOP-02 blast-radius list).
  let fileList = options.files;
  if (!fileList && options.scope) {
    fileList = Array.isArray(options.scope) ? options.scope : String(options.scope).split(',').filter(Boolean);
  }
  const findings = detect(domain, fileList || [], { root: options.root });
  let posted = 0;
  if (options.post) {
    const port = parseInt(options.port || process.env.AMAUTA_PORT || '18799', 10);
    for (const f of findings) {
      const res = await postFinding(f, port);
      if (res.ok) posted += 1;
    }
  }
  return { findings, posted };
}

// ───────────────────────────────────────────────────────────────────────────
// (d) reauditFile(ruleId, filePath) → findings[]  — the narrow single-rule
//   re-run the close-loop needs. Runs ONLY the detect(s) whose rule_id === ruleId
//   on filePath and returns the (possibly empty) hits. PURE, no network. A
//   missing/clean file yields []. Used by audit-close-loop's real re-audit fallback.
// ───────────────────────────────────────────────────────────────────────────

function reauditFile(ruleId, filePath) {
  const findings = [];
  for (const d of Object.keys(DETECT_REGISTRY)) {
    for (const desc of DETECT_REGISTRY[d]) {
      if (desc.rule_id !== ruleId) continue;
      if (desc.scope === 'repo') {
        for (const hit of desc.scan({ root: undefined })) findings.push(makeFinding(desc, hit));
        continue;
      }
      if (desc.fileset) {
        for (const hit of desc.scan([filePath])) findings.push(makeFinding(desc, hit));
        continue;
      }
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }
      const res = desc.test(content, filePath);
      if (res) {
        const evidence = typeof res === 'string' ? res : undefined;
        findings.push(makeFinding(desc, { file_path: filePath, evidence }));
      }
    }
  }
  return findings;
}

module.exports = { detect, runAudit, reauditFile, defaultRoot, DETECT_REGISTRY };
