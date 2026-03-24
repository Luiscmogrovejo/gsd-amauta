/**
 * Python Unit Tests — amauta.py internal functions
 *
 * Tests Python functions via inline Python3 invocation:
 *   - _score() — priority scoring algorithm
 *   - _deps_met() — dependency resolution
 *   - _dedup_check() — duplicate detection
 *   - _extract_pr_url() — PR URL extraction
 *   - _extract_branch_name() — branch name extraction
 *   - _extract_pr_number() — PR number parsing
 *   - _extract_commit_sha() — commit SHA extraction
 *   - _needs_gitflow_gate() — gitflow gate determination (via _infer_lane)
 *   - _is_infra_host_only() — infra task detection
 *   - _has_no_pr_needed_marker() — PR needed marker
 *   - _has_merge_evidence() — merge evidence detection
 *   - _has_learning_written() — learning write detection
 *   - _has_explicit_learning_written() — explicit learning check
 *   - _has_branch_evidence() — branch evidence regex
 *   - _has_test_evidence() — test evidence regex
 *   - _task_hygiene_gaps() — hygiene gap detection
 *   - _infer_lane() — code vs non-code classification
 *   - _infer_domain_tags() — domain tag inference
 *   - _normalize_tags() — tag normalization
 *   - _gate_fail_age_seconds() / _in_gate_cooldown()
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function pyEval(code) {
  try {
    const result = execFileSync('python3', ['-c', `
import sys, json; sys.path.insert(0, '${ROOT}')
${code}
`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 });
    return result.trim();
  } catch (err) {
    return (err.stdout || '').toString().trim() || (err.stderr || '').toString().trim();
  }
}

// ═══════════════════════════════════════════════════════
// _score() — priority scoring
// ═══════════════════════════════════════════════════════

describe('_score() — priority scoring algorithm', () => {
  test('high importance+urgency scores higher than low', () => {
    const result = pyEval(`
from amauta import _score
high = {"id": "TK-1", "importance": 5, "urgency": 5, "priority": "high", "dependencies": []}
low  = {"id": "TK-2", "importance": 1, "urgency": 1, "priority": "low", "dependencies": []}
print(json.dumps({"high": _score(high, [high, low]), "low": _score(low, [high, low])}))
`);
    const scores = JSON.parse(result);
    assert.ok(scores.high > scores.low, `high ${scores.high} should be > low ${scores.low}`);
  });

  test('critical priority gets +1 importance boost', () => {
    const result = pyEval(`
from amauta import _score
crit   = {"id": "TK-1", "importance": 3, "urgency": 3, "priority": "critical", "dependencies": []}
normal = {"id": "TK-2", "importance": 3, "urgency": 3, "priority": "medium", "dependencies": []}
print(json.dumps({"crit": _score(crit, [crit, normal]), "normal": _score(normal, [crit, normal])}))
`);
    const scores = JSON.parse(result);
    assert.ok(scores.crit > scores.normal, 'critical should score higher');
  });

  test('task blocking others gets dep_pressure boost', () => {
    const result = pyEval(`
from amauta import _score
blocker = {"id": "TK-1", "importance": 3, "urgency": 3, "priority": "medium", "dependencies": []}
blocked = {"id": "TK-2", "importance": 3, "urgency": 3, "priority": "medium", "dependencies": ["TK-1"]}
orphan  = {"id": "TK-3", "importance": 3, "urgency": 3, "priority": "medium", "dependencies": []}
items = [blocker, blocked, orphan]
print(json.dumps({"blocker": _score(blocker, items), "orphan": _score(orphan, items)}))
`);
    const scores = JSON.parse(result);
    assert.ok(scores.blocker > scores.orphan, 'blocker should score higher due to dep_pressure');
  });

  test('dep_pressure capped at 5', () => {
    const result = pyEval(`
from amauta import _score
target = {"id": "TK-0", "importance": 3, "urgency": 3, "priority": "medium", "dependencies": []}
items = [target] + [{"id": f"TK-{i}", "importance": 3, "urgency": 3, "dependencies": ["TK-0"]} for i in range(1, 8)]
s1 = _score(target, items)
# Max dep_pressure = 5, so score = (3*0.4)+(3*0.3)+(5*0.3)=1.2+0.9+1.5=3.6
print(s1)
`);
    assert.strictEqual(parseFloat(result), 3.6);
  });

  test('importance clamped to 1-5', () => {
    const result = pyEval(`
from amauta import _score
item = {"id": "TK-1", "importance": 99, "urgency": 1, "priority": "low", "dependencies": []}
print(_score(item, [item]))
`);
    // importance clamped to 5: (5*0.4)+(1*0.3)+(0*0.3)=2.0+0.3+0.0=2.3
    assert.strictEqual(parseFloat(result), 2.3);
  });

  test('zero importance treated as 1', () => {
    const result = pyEval(`
from amauta import _score
item = {"id": "TK-1", "importance": 0, "urgency": 1, "priority": "low", "dependencies": []}
print(_score(item, [item]))
`);
    // importance clamped to 1: (1*0.4)+(1*0.3)+(0*0.3)=0.4+0.3+0.0=0.7
    assert.strictEqual(parseFloat(result), 0.7);
  });

  test('due_date in past sets urgency to 5', () => {
    const result = pyEval(`
from amauta import _score
from datetime import datetime, timedelta
past = (datetime.now() - timedelta(days=2)).isoformat()
item = {"id": "TK-1", "importance": 3, "urgency": 1, "priority": "medium", "dependencies": [], "due_date": past}
print(_score(item, [item]))
`);
    // due overdue: urgency=5, (3*0.4)+(5*0.3)+(0*0.3)=1.2+1.5+0.0=2.7
    assert.strictEqual(parseFloat(result), 2.7);
  });

  test('due_date tomorrow gets urgency boost', () => {
    const result = pyEval(`
from amauta import _score
from datetime import datetime, timedelta
tomorrow = (datetime.now() + timedelta(hours=20)).isoformat()
item = {"id": "TK-1", "importance": 3, "urgency": 1, "priority": "medium", "dependencies": [], "due_date": tomorrow}
no_due = {"id": "TK-2", "importance": 3, "urgency": 1, "priority": "medium", "dependencies": []}
print(json.dumps({"with_due": _score(item, [item, no_due]), "no_due": _score(no_due, [item, no_due])}))
`);
    const scores = JSON.parse(result);
    assert.ok(scores.with_due > scores.no_due, 'Due date tomorrow should boost urgency');
  });
});

// ═══════════════════════════════════════════════════════
// _deps_met()
// ═══════════════════════════════════════════════════════

describe('_deps_met() — dependency resolution', () => {
  test('no dependencies returns true', () => {
    const r = pyEval(`
from amauta import _deps_met
print(_deps_met({"id": "TK-1", "dependencies": []}, []))
`);
    assert.strictEqual(r, 'True');
  });

  test('single dependency done returns true', () => {
    const r = pyEval(`
from amauta import _deps_met
dep = {"id": "TK-1", "status": "done"}
item = {"id": "TK-2", "dependencies": ["TK-1"]}
print(_deps_met(item, [dep, item]))
`);
    assert.strictEqual(r, 'True');
  });

  test('single dependency pending returns false', () => {
    const r = pyEval(`
from amauta import _deps_met
dep = {"id": "TK-1", "status": "pending"}
item = {"id": "TK-2", "dependencies": ["TK-1"]}
print(_deps_met(item, [dep, item]))
`);
    assert.strictEqual(r, 'False');
  });

  test('multiple deps all done returns true', () => {
    const r = pyEval(`
from amauta import _deps_met
d1 = {"id": "TK-1", "status": "done"}
d2 = {"id": "TK-2", "status": "done"}
item = {"id": "TK-3", "dependencies": ["TK-1", "TK-2"]}
print(_deps_met(item, [d1, d2, item]))
`);
    assert.strictEqual(r, 'True');
  });

  test('one of multiple deps not done returns false', () => {
    const r = pyEval(`
from amauta import _deps_met
d1 = {"id": "TK-1", "status": "done"}
d2 = {"id": "TK-2", "status": "in-progress"}
item = {"id": "TK-3", "dependencies": ["TK-1", "TK-2"]}
print(_deps_met(item, [d1, d2, item]))
`);
    assert.strictEqual(r, 'False');
  });

  test('missing dependency ID returns true (not found = not blocking)', () => {
    const r = pyEval(`
from amauta import _deps_met
item = {"id": "TK-2", "dependencies": ["TK-999"]}
print(_deps_met(item, [item]))
`);
    assert.strictEqual(r, 'True');
  });
});

// ═══════════════════════════════════════════════════════
// _dedup_check()
// ═══════════════════════════════════════════════════════

describe('_dedup_check() — duplicate detection', () => {
  test('identical title and agent returns duplicate ID', () => {
    const r = pyEval(`
from amauta import _dedup_check
items = [{"id": "TK-1", "title": "Fix login button", "status": "pending", "assigned_to": "gsd-executor-frontend"}]
result = _dedup_check(items, "Fix login button", "gsd-executor-frontend")
print(result)
`);
    assert.strictEqual(r, 'TK-1');
  });

  test('different agent same title returns None', () => {
    const r = pyEval(`
from amauta import _dedup_check
items = [{"id": "TK-1", "title": "Fix login button", "status": "pending", "assigned_to": "gsd-executor-frontend"}]
result = _dedup_check(items, "Fix login button", "gsd-executor-backend")
print(result)
`);
    assert.strictEqual(r, 'None');
  });

  test('fuzzy match above 70% threshold detects duplicate', () => {
    const r = pyEval(`
from amauta import _dedup_check
items = [{"id": "TK-1", "title": "Fix the login button styling", "status": "in-progress", "assigned_to": "gsd-executor-frontend"}]
result = _dedup_check(items, "Fix the login button style", "gsd-executor-frontend")
print(result)
`);
    assert.strictEqual(r, 'TK-1');
  });

  test('word overlap above 60% detects duplicate', () => {
    const r = pyEval(`
from amauta import _dedup_check
items = [{"id": "TK-1", "title": "Implement user registration form validation", "status": "pending", "assigned_to": "gsd-executor-frontend"}]
result = _dedup_check(items, "User registration form validation implementation", "gsd-executor-frontend")
print(result)
`);
    assert.strictEqual(r, 'TK-1');
  });

  test('empty items list returns None', () => {
    const r = pyEval(`
from amauta import _dedup_check
print(_dedup_check([], "Something", "gsd-executor-general"))
`);
    assert.strictEqual(r, 'None');
  });

  test('done task is ignored by dedup', () => {
    const r = pyEval(`
from amauta import _dedup_check
items = [{"id": "TK-1", "title": "Fix login button", "status": "done", "assigned_to": "gsd-executor-frontend"}]
result = _dedup_check(items, "Fix login button", "gsd-executor-frontend")
print(result)
`);
    assert.strictEqual(r, 'None');
  });

  test('agent=None matches all agents', () => {
    const r = pyEval(`
from amauta import _dedup_check
items = [{"id": "TK-1", "title": "Fix login button", "status": "pending", "assigned_to": "gsd-executor-frontend"}]
result = _dedup_check(items, "Fix login button", None)
print(result)
`);
    // With agent=None, it skips the agent check, so it should match
    assert.strictEqual(r, 'TK-1');
  });
});

// ═══════════════════════════════════════════════════════
// _extract_pr_url()
// ═══════════════════════════════════════════════════════

describe('_extract_pr_url() — PR URL extraction', () => {
  test('extracts PR URL from D-phase', () => {
    const r = pyEval(`
from amauta import _extract_pr_url
item = {"rpetd_phases": {"D": "Merged https://github.com/org/repo/pull/42 to main"}, "notes": []}
print(_extract_pr_url(item))
`);
    assert.strictEqual(r, 'https://github.com/org/repo/pull/42');
  });

  test('extracts PR URL from notes when not in D-phase', () => {
    const r = pyEval(`
from amauta import _extract_pr_url
item = {"rpetd_phases": {"D": "done"}, "notes": [{"text": "PR: https://github.com/org/repo/pull/7"}]}
print(_extract_pr_url(item))
`);
    assert.strictEqual(r, 'https://github.com/org/repo/pull/7');
  });

  test('returns empty when no PR URL', () => {
    const r = pyEval(`
from amauta import _extract_pr_url
item = {"rpetd_phases": {"D": "done"}, "notes": []}
print(repr(_extract_pr_url(item)))
`);
    assert.strictEqual(r, "''");
  });

  test('handles missing rpetd_phases gracefully', () => {
    const r = pyEval(`
from amauta import _extract_pr_url
print(repr(_extract_pr_url({"notes": []})))
`);
    assert.strictEqual(r, "''");
  });
});

// ═══════════════════════════════════════════════════════
// _extract_branch_name()
// ═══════════════════════════════════════════════════════

describe('_extract_branch_name() — branch name extraction', () => {
  test('extracts feat/ branch from checkout command', () => {
    const r = pyEval(`
from amauta import _extract_branch_name
print(_extract_branch_name("git checkout -b feat/TK-1234-login-fix"))
`);
    assert.strictEqual(r, 'feat/TK-1234-login-fix');
  });

  test('extracts fix/ branch from branch= notation', () => {
    const r = pyEval(`
from amauta import _extract_branch_name
print(_extract_branch_name("branch=fix/BG-0042-null-pointer"))
`);
    assert.strictEqual(r, 'fix/BG-0042-null-pointer');
  });

  test('extracts bare feat/ branch reference', () => {
    const r = pyEval(`
from amauta import _extract_branch_name
print(_extract_branch_name("Working on feat/TK-9999-new-feature branch"))
`);
    assert.strictEqual(r, 'feat/TK-9999-new-feature');
  });

  test('returns empty for text with no branch', () => {
    const r = pyEval(`
from amauta import _extract_branch_name
print(repr(_extract_branch_name("just some regular text")))
`);
    assert.strictEqual(r, "''");
  });

  test('extracts refactor/ branch', () => {
    const r = pyEval(`
from amauta import _extract_branch_name
print(_extract_branch_name("refactor/cleanup-auth-module"))
`);
    assert.strictEqual(r, 'refactor/cleanup-auth-module');
  });
});

// ═══════════════════════════════════════════════════════
// _extract_pr_number() and _extract_commit_sha()
// ═══════════════════════════════════════════════════════

describe('_extract_pr_number() — PR number parsing', () => {
  test('extracts number from full PR URL', () => {
    const r = pyEval(`
from amauta import _extract_pr_number
print(_extract_pr_number("https://github.com/org/repo/pull/42"))
`);
    assert.strictEqual(r, '42');
  });

  test('returns 0 for non-PR URL', () => {
    const r = pyEval(`
from amauta import _extract_pr_number
print(_extract_pr_number("https://github.com/org/repo"))
`);
    assert.strictEqual(r, '0');
  });

  test('returns 0 for empty string', () => {
    const r = pyEval(`
from amauta import _extract_pr_number
print(_extract_pr_number(""))
`);
    assert.strictEqual(r, '0');
  });
});

describe('_extract_commit_sha() — commit SHA extraction', () => {
  test('extracts 7-char SHA', () => {
    const r = pyEval(`
from amauta import _extract_commit_sha
print(_extract_commit_sha("commit abc1234 merged"))
`);
    assert.strictEqual(r, 'abc1234');
  });

  test('extracts 40-char full SHA', () => {
    const r = pyEval(`
from amauta import _extract_commit_sha
sha = "abcdef1234567890abcdef1234567890abcdef12"
print(_extract_commit_sha(f"commit {sha}"))
`);
    assert.strictEqual(r, 'abcdef1234567890abcdef1234567890abcdef12');
  });

  test('returns empty for no SHA', () => {
    const r = pyEval(`
from amauta import _extract_commit_sha
print(repr(_extract_commit_sha("no commit here")))
`);
    assert.strictEqual(r, "''");
  });
});

// ═══════════════════════════════════════════════════════
// _has_branch_evidence()
// ═══════════════════════════════════════════════════════

describe('_has_branch_evidence() — branch evidence regex', () => {
  test('git checkout -b detected', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence("git checkout -b feat/TK-1"))
`);
    assert.strictEqual(r, 'True');
  });

  test('branch= detected', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence("branch=feat/new"))
`);
    assert.strictEqual(r, 'True');
  });

  test('branch: detected', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence("branch: fix/bug-123"))
`);
    assert.strictEqual(r, 'True');
  });

  test('feat/ standalone detected', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence("working on feat/something"))
`);
    assert.strictEqual(r, 'True');
  });

  test('fix/ standalone detected', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence("created fix/bug-42"))
`);
    assert.strictEqual(r, 'True');
  });

  test('no branch reference returns false', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence("just regular code text"))
`);
    assert.strictEqual(r, 'False');
  });

  test('None input returns false', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence(None))
`);
    assert.strictEqual(r, 'False');
  });

  test('empty string returns false', () => {
    const r = pyEval(`
from amauta import _has_branch_evidence
print(_has_branch_evidence(""))
`);
    assert.strictEqual(r, 'False');
  });
});

// ═══════════════════════════════════════════════════════
// _has_test_evidence()
// ═══════════════════════════════════════════════════════

describe('_has_test_evidence() — test output regex', () => {
  test('exit 0 detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("Tests ran. exit 0"))
`);
    assert.strictEqual(r, 'True');
  });

  test('exit code 0 detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("exit code 0"))
`);
    assert.strictEqual(r, 'True');
  });

  test('N tests passed detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("42 tests passed, 0 failed"))
`);
    assert.strictEqual(r, 'True');
  });

  test('all tests passed detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("all tests passed"))
`);
    assert.strictEqual(r, 'True');
  });

  test('build pass detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("build pass"))
`);
    assert.strictEqual(r, 'True');
  });

  test('build successful detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("build successful"))
`);
    assert.strictEqual(r, 'True');
  });

  test('go test ok detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("go test ./... ok"))
`);
    assert.strictEqual(r, 'True');
  });

  test('cargo test ok detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("cargo test ok"))
`);
    assert.strictEqual(r, 'True');
  });

  test('tsc --noEmit no longer accepted (loose pattern removed in Phase 13)', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("tsc --noEmit"))
`);
    assert.strictEqual(r, 'False');
  });

  test('checks green detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("All checks green"))
`);
    assert.strictEqual(r, 'True');
  });

  test('ENOENT blocker returns false', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("ENOENT npm not found"))
`);
    assert.strictEqual(r, 'False');
  });

  test('permission denied blocker returns false', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("permission denied accessing /usr/local/bin"))
`);
    assert.strictEqual(r, 'False');
  });

  test('substantial content >100 chars with no signal returns false (proxy removed in Phase 13)', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("x" * 101))
`);
    assert.strictEqual(r, 'False');
  });

  test('short content <100 chars with no signal returns false', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("ran stuff"))
`);
    assert.strictEqual(r, 'False');
  });

  test('None input returns false', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence(None))
`);
    assert.strictEqual(r, 'False');
  });

  test('[COMPLETED] marker detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("[COMPLETED] lint-staged"))
`);
    assert.strictEqual(r, 'True');
  });

  test('criteria met no longer accepted (loose pattern removed in Phase 13)', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("All criteria appear met"))
`);
    assert.strictEqual(r, 'False');
  });

  test('eslint --fix no longer accepted (loose pattern removed in Phase 13)', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("eslint --fix src/"))
`);
    assert.strictEqual(r, 'False');
  });

  test('ci checks success detected', () => {
    const r = pyEval(`
from amauta import _has_test_evidence
print(_has_test_evidence("CI checks: success"))
`);
    assert.strictEqual(r, 'True');
  });
});

// ═══════════════════════════════════════════════════════
// _is_infra_host_only()
// ═══════════════════════════════════════════════════════

describe('_is_infra_host_only() — infra task detection', () => {
  test('lane:infra tag returns true', () => {
    const r = pyEval(`
from amauta import _is_infra_host_only
print(_is_infra_host_only({"tags": ["lane:infra"]}))
`);
    assert.strictEqual(r, 'True');
  });

  test('no-gitflow tag returns true', () => {
    const r = pyEval(`
from amauta import _is_infra_host_only
print(_is_infra_host_only({"tags": ["no-gitflow"]}))
`);
    assert.strictEqual(r, 'True');
  });

  test('docker in title returns true', () => {
    const r = pyEval(`
from amauta import _is_infra_host_only
print(_is_infra_host_only({"tags": [], "title": "Set up Docker compose for dev"}))
`);
    assert.strictEqual(r, 'True');
  });

  test('systemd in description returns true', () => {
    const r = pyEval(`
from amauta import _is_infra_host_only
print(_is_infra_host_only({"tags": [], "title": "task", "description": "Configure systemd service"}))
`);
    assert.strictEqual(r, 'True');
  });

  test('regular task returns false', () => {
    const r = pyEval(`
from amauta import _is_infra_host_only
print(_is_infra_host_only({"tags": [], "title": "Add login page", "description": "Create login form"}))
`);
    assert.strictEqual(r, 'False');
  });

  test('nginx in details returns true', () => {
    const r = pyEval(`
from amauta import _is_infra_host_only
print(_is_infra_host_only({"tags": [], "title": "task", "description": "", "details": "Configure nginx reverse proxy"}))
`);
    assert.strictEqual(r, 'True');
  });
});

// ═══════════════════════════════════════════════════════
// _has_no_pr_needed_marker()
// ═══════════════════════════════════════════════════════

describe('_has_no_pr_needed_marker() — PR needed marker', () => {
  test('PR_URL: no-pr-needed in D-phase returns true', () => {
    const r = pyEval(`
from amauta import _has_no_pr_needed_marker
item = {"rpetd_phases": {"D": "PR_URL: no-pr-needed", "T": ""}, "notes": []}
print(_has_no_pr_needed_marker(item))
`);
    assert.strictEqual(r, 'True');
  });

  test('no-pr-needed in notes returns true', () => {
    const r = pyEval(`
from amauta import _has_no_pr_needed_marker
item = {"rpetd_phases": {"D": "", "T": ""}, "notes": [{"text": "no-pr-needed"}]}
print(_has_no_pr_needed_marker(item))
`);
    assert.strictEqual(r, 'True');
  });

  test('PR_URL: N/A returns true', () => {
    const r = pyEval(`
from amauta import _has_no_pr_needed_marker
item = {"rpetd_phases": {"D": "PR_URL: N/A", "T": ""}, "notes": []}
print(_has_no_pr_needed_marker(item))
`);
    assert.strictEqual(r, 'True');
  });

  test('normal PR URL present returns false', () => {
    const r = pyEval(`
from amauta import _has_no_pr_needed_marker
item = {"rpetd_phases": {"D": "https://github.com/org/repo/pull/42", "T": ""}, "notes": []}
print(_has_no_pr_needed_marker(item))
`);
    assert.strictEqual(r, 'False');
  });
});

// ═══════════════════════════════════════════════════════
// _infer_lane()
// ═══════════════════════════════════════════════════════

describe('_infer_lane() — code vs non-code classification', () => {
  test('executor-backend is code lane', () => {
    const r = pyEval(`
from amauta import _infer_lane
print(_infer_lane({"assigned_to": "gsd-executor-backend"}))
`);
    assert.strictEqual(r, 'code');
  });

  test('researcher is non-code lane', () => {
    const r = pyEval(`
from amauta import _infer_lane
print(_infer_lane({"assigned_to": "gsd-researcher"}))
`);
    assert.strictEqual(r, 'non-code');
  });

  test('planner is non-code lane', () => {
    const r = pyEval(`
from amauta import _infer_lane
print(_infer_lane({"assigned_to": "gsd-planner"}))
`);
    assert.strictEqual(r, 'non-code');
  });

  test('unknown agent defaults to code', () => {
    const r = pyEval(`
import sys; sys.stderr = open('/dev/null', 'w')
from amauta import _infer_lane
print(_infer_lane({"assigned_to": "gsd-unknown-agent"}))
`);
    assert.strictEqual(r, 'code');
  });

  test('no agent with research keyword is non-code', () => {
    const r = pyEval(`
from amauta import _infer_lane
print(_infer_lane({"title": "Research authentication best practices"}))
`);
    assert.strictEqual(r, 'non-code');
  });

  test('no agent with spec keyword is non-code', () => {
    const r = pyEval(`
from amauta import _infer_lane
print(_infer_lane({"title": "Write spec for user management"}))
`);
    assert.strictEqual(r, 'non-code');
  });

  test('no agent with generic title is code', () => {
    const r = pyEval(`
from amauta import _infer_lane
print(_infer_lane({"title": "Implement API endpoint"}))
`);
    assert.strictEqual(r, 'code');
  });
});

// ═══════════════════════════════════════════════════════
// _infer_domain_tags()
// ═══════════════════════════════════════════════════════

describe('_infer_domain_tags() — domain tag inference', () => {
  test('react in title gets frontend tag', () => {
    const r = pyEval(`
from amauta import _infer_domain_tags
tags = _infer_domain_tags({"title": "Add React component for dashboard"})
print("frontend" in tags)
`);
    assert.strictEqual(r, 'True');
  });

  test('postgres in description gets database tag', () => {
    const r = pyEval(`
from amauta import _infer_domain_tags
tags = _infer_domain_tags({"title": "task", "description": "Set up PostgreSQL connection pool"})
print("database" in tags)
`);
    assert.strictEqual(r, 'True');
  });

  test('generic task gets no domain tags', () => {
    const r = pyEval(`
from amauta import _infer_domain_tags
tags = _infer_domain_tags({"title": "Update readme"})
print(len(tags))
`);
    assert.strictEqual(r, '0');
  });
});

// ═══════════════════════════════════════════════════════
// _normalize_tags()
// ═══════════════════════════════════════════════════════

describe('_normalize_tags() — tag normalization', () => {
  test('deduplicates tags', () => {
    const r = pyEval(`
from amauta import _normalize_tags
print(len(_normalize_tags(["foo", "bar", "foo", "baz", "bar"])))
`);
    assert.strictEqual(r, '3');
  });

  test('lowercases tags', () => {
    const r = pyEval(`
from amauta import _normalize_tags
result = _normalize_tags(["FOO", "Bar"])
print(json.dumps(result))
`);
    const tags = JSON.parse(r);
    assert.ok(tags.every(t => t === t.toLowerCase()));
  });

  test('strips whitespace', () => {
    const r = pyEval(`
from amauta import _normalize_tags
result = _normalize_tags(["  foo  ", "bar  "])
print(json.dumps(result))
`);
    const tags = JSON.parse(r);
    assert.ok(tags.every(t => t === t.trim()));
  });

  test('removes empty strings', () => {
    const r = pyEval(`
from amauta import _normalize_tags
result = _normalize_tags(["foo", "", "  ", "bar"])
print(len(result))
`);
    assert.strictEqual(r, '2');
  });
});

// ═══════════════════════════════════════════════════════
// _task_hygiene_gaps()
// ═══════════════════════════════════════════════════════

describe('_task_hygiene_gaps() — missing field detection', () => {
  test('task missing description returns gap', () => {
    const r = pyEval(`
from amauta import _task_hygiene_gaps
gaps = _task_hygiene_gaps({"description": "", "success_criteria": ["done"], "test_strategy": "unit"})
print("description" in str(gaps).lower())
`);
    assert.strictEqual(r, 'True');
  });

  test('task missing success_criteria returns gap', () => {
    const r = pyEval(`
from amauta import _task_hygiene_gaps
gaps = _task_hygiene_gaps({"description": "ok", "success_criteria": [], "test_strategy": "unit"})
print("success" in str(gaps).lower() or "criteria" in str(gaps).lower())
`);
    assert.strictEqual(r, 'True');
  });

  test('complete task returns no gaps', () => {
    const r = pyEval(`
from amauta import _task_hygiene_gaps
gaps = _task_hygiene_gaps({"description": "desc", "details": "details", "success_criteria": ["done"], "test_strategy": "unit", "doc_refs": ["ref"]})
print(len(gaps))
`);
    assert.strictEqual(r, '0');
  });
});

// ═══════════════════════════════════════════════════════
// _has_learning_written() and _has_explicit_learning_written()
// ═══════════════════════════════════════════════════════

describe('_has_learning_written() — learning detection', () => {
  test('LEARNING: in D-phase returns true', () => {
    const r = pyEval(`
from amauta import _has_learning_written
item = {"rpetd_phases": {"D": "LEARNING: always test first"}, "notes": []}
print(_has_learning_written(item))
`);
    assert.strictEqual(r, 'True');
  });

  test('LEARNING: in notes returns true', () => {
    const r = pyEval(`
from amauta import _has_learning_written
item = {"rpetd_phases": {}, "notes": [{"text": "LEARNING: cache invalidation matters"}]}
print(_has_learning_written(item))
`);
    assert.strictEqual(r, 'True');
  });

  test('no LEARNING returns false', () => {
    const r = pyEval(`
from amauta import _has_learning_written
item = {"rpetd_phases": {"D": "all done"}, "notes": [{"text": "complete"}]}
print(_has_learning_written(item))
`);
    assert.strictEqual(r, 'False');
  });
});

describe('_has_explicit_learning_written() — strict learning check', () => {
  test('LEARNING: in R-phase returns true', () => {
    const r = pyEval(`
from amauta import _has_explicit_learning_written
item = {"rpetd_phases": {"R": "LEARNING: found pattern"}, "notes": []}
print(_has_explicit_learning_written(item))
`);
    assert.strictEqual(r, 'True');
  });

  test('empty phases and notes returns false', () => {
    const r = pyEval(`
from amauta import _has_explicit_learning_written
item = {"rpetd_phases": {}, "notes": []}
print(_has_explicit_learning_written(item))
`);
    assert.strictEqual(r, 'False');
  });
});
