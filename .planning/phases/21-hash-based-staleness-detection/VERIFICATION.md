---
status: passed
phase: 21-hash-based-staleness-detection
date: 2026-04-12
validator: gsd-validator
---

# Phase 21 Verification: Hash-Based Staleness Detection

**Verdict: PASS**

All 4 requirement IDs (STALE-01..04) verified. All 4 ROADMAP.md success criteria met. 20/20 Python tests pass. 10/10 Phase 20 regression tests pass. No new failures.

---

## Requirement Verification

### STALE-01 — compute_file_hash returns SHA-256 hex digest; hashes stored in rpetd_context

**Status: VERIFIED**

Evidence:
- `services/context_validator.py` line 31: `def compute_file_hash(path: str) -> Optional[str]`
- `services/context_validator.py` line 45: `h = hashlib.sha256()` — stdlib SHA-256
- `services/context_validator.py` line 206: `def compute_file_hashes(paths: list[str]) -> dict[str, str]` — batch wrapper
- `services/amauta-daemon.py` line 2169: `ctx_file_hashes = ContextValidator.compute_file_hashes(relevant)` — compact route now populates file_hashes
- `services/amauta-daemon.py` line 2186: `file_hashes=ctx_file_hashes` — passed to rpetd_context_store (no longer empty {})
- No `file_hashes={}` in the compact route (grep returned empty)
- Tests: `test_hash_is_sha256_hex_64_chars`, `test_hash_matches_manual_sha256`, `test_hash_stable_when_file_unchanged`, `test_hash_changes_when_file_modified`, `test_hash_returns_none_for_nonexistent_file`, `test_compute_file_hashes_batch` — all 6 PASS

### STALE-02 — changed_since calls git diff --name-only; zero filesystem reads for unchanged files

**Status: VERIFIED**

Evidence:
- `services/context_validator.py` line 79: `def changed_since(context: dict, project_dir: str = ".") -> list[str]`
- `services/context_validator.py` line 82: docstring states "Uses `git diff --name-only`"
- `services/context_validator.py`: intersection of git diff output with `file_hashes` keys means only git's index is consulted for unchanged files — no `open()` or filesystem read for unchanged paths
- `services/context_validator.py` line 57: `def get_current_commit(project_dir: str = ".") -> Optional[str]`
- Tests: `test_no_commit_ref_returns_all_files`, `test_empty_file_hashes_returns_empty`, `test_git_diff_returns_changed_files` (asserts `--name-only` in subprocess args), `test_git_diff_failure_returns_all` — all 4 PASS

### STALE-03 — selective_refresh regenerates only stale files; 10-file/2-stale test shows exactly 2 refreshed

**Status: VERIFIED**

Evidence:
- `services/context_validator.py` line 132: `def selective_refresh(context: dict, stale_files: list[str], description_fn=None) -> dict`
- Logic: iterates `file_hashes` keys; calls `description_fn` only if `path in stale_set`; unchanged paths retain cached descriptions verbatim
- `services/context_validator.py` line 195: `log.info("[STALE] %d files refreshed, %d cached", refreshed_count, cached_count)`
- Test `test_10_files_2_stale_refreshes_exactly_2`: 10 real tempfiles, 2 marked stale, verifies `call_count["n"] == 2`, `refreshed_count == 2`, `cached_count == 8`, stale files get new descriptions, unchanged files retain originals — PASS
- Test `test_no_stale_files_calls_description_fn_zero_times`: zero calls when no stale files — PASS
- Test `test_stale_log_line_emitted`: `[STALE]` present in `log.info` call args — PASS

### STALE-04 — RPETD orchestrator calls validate_context before phase start; [STALE] log line emitted

**Status: VERIFIED**

Evidence:
- `services/context_validator.py` line 227: `def validate_context(task_id, phase, project_dir, pg_store, description_fn) -> dict` — module-level orchestration function
- Phase order lookup: R has no prior, P looks up R, E looks up P, T looks up E, D looks up T
- `services/amauta-daemon.py` line 2201: `if path == "/api/context/validate":` — POST endpoint
- `services/amauta-daemon.py` line 2216: `from services.context_validator import validate_context`
- `services/amauta-daemon.py` line 2224: `description_fn=None,  # Phase 22 CAVE-01 will wire compressed description_fn`
- `services/amauta-daemon.py` line 2247: `"had_prior_context": result.get("had_prior_context", False)` — full response shape
- `services/context_validator.py` line 195: `[STALE]` log emitted in `selective_refresh`
- `services/context_validator.py` line 308: `[STALE] 0 files refreshed` emitted in no-changes path
- Integration tests:
  - `test_no_pg_store_returns_empty`: had_prior_context=False, changed_files=[] — PASS
  - `test_r_phase_has_no_prior`: R phase triggers no PG lookup — PASS
  - `test_p_phase_looks_up_r_context`: P phase calls rpetd_context_get("TK-001", "R") — PASS
  - `test_with_stored_context_and_no_changes`: git diff empty → cached_count=2, refreshed_count=0 — PASS
  - `test_with_stored_context_and_changes`: 1 changed file → refreshed_count=1, cached_count=1 — PASS
  - `test_10_files_2_changed_end_to_end`: 10 files, 2 changed by mocked git diff → refreshed=2, cached=8, description_fn called exactly 2 times — PASS
  - `test_stale_log_line_in_validate_context`: [STALE] appears in log.info calls — PASS

---

## ROADMAP.md Success Criteria

1. **`compute_file_hash(path)` returns stable SHA-256** — VERIFIED by 6 unit tests including `test_hash_matches_manual_sha256` (compares against `hashlib.sha256(content).hexdigest()` independently) and `test_hash_stable_when_file_unchanged`.

2. **`changed_since(context)` uses git diff with zero filesystem reads for unchanged** — VERIFIED. Code path: subprocess git diff → intersect with file_hashes keys → return list. Unchanged files (not in git diff output) are never opened. Confirmed by `test_git_diff_returns_changed_files` which asserts `--name-only` in the subprocess call args.

3. **10-file/2-stale test shows exactly 2 refreshed** — VERIFIED by two tests:
   - Unit: `test_10_files_2_stale_refreshes_exactly_2` in test_context_validator.py (PASS)
   - Integration: `test_10_files_2_changed_end_to_end` in test_context_validator_integration.py (PASS)
   Both assert `refreshed_count == 2`, `cached_count == 8`, and `description_fn` call count == 2.

4. **[STALE] log line emitted** — VERIFIED at two code paths: `selective_refresh` line 195 (normal refresh) and `validate_context` line 308 (no-changes fast path). Verified by `test_stale_log_line_emitted` and `test_stale_log_line_in_validate_context`.

---

## Test Run Output

```
$ python3 -m pytest tests/test_context_validator.py tests/test_context_validator_integration.py -v --tb=short

============================= test session starts ==============================
platform darwin -- Python 3.14.3, pytest-9.0.2, pluggy-1.6.0
collected 20 items

tests/test_context_validator.py::TestComputeFileHash::test_hash_is_sha256_hex_64_chars PASSED
tests/test_context_validator.py::TestComputeFileHash::test_hash_matches_manual_sha256 PASSED
tests/test_context_validator.py::TestComputeFileHash::test_hash_stable_when_file_unchanged PASSED
tests/test_context_validator.py::TestComputeFileHash::test_hash_changes_when_file_modified PASSED
tests/test_context_validator.py::TestComputeFileHash::test_hash_returns_none_for_nonexistent_file PASSED
tests/test_context_validator.py::TestComputeFileHash::test_compute_file_hashes_batch PASSED
tests/test_context_validator.py::TestChangedSince::test_no_commit_ref_returns_all_files PASSED
tests/test_context_validator.py::TestChangedSince::test_empty_file_hashes_returns_empty PASSED
tests/test_context_validator.py::TestChangedSince::test_git_diff_returns_changed_files PASSED
tests/test_context_validator.py::TestChangedSince::test_git_diff_failure_returns_all PASSED
tests/test_context_validator.py::TestSelectiveRefresh::test_10_files_2_stale_refreshes_exactly_2 PASSED
tests/test_context_validator.py::TestSelectiveRefresh::test_no_stale_files_calls_description_fn_zero_times PASSED
tests/test_context_validator.py::TestSelectiveRefresh::test_stale_log_line_emitted PASSED
tests/test_context_validator_integration.py::TestValidateContext::test_no_pg_store_returns_empty PASSED
tests/test_context_validator_integration.py::TestValidateContext::test_r_phase_has_no_prior PASSED
tests/test_context_validator_integration.py::TestValidateContext::test_p_phase_looks_up_r_context PASSED
tests/test_context_validator_integration.py::TestValidateContext::test_with_stored_context_and_no_changes PASSED
tests/test_context_validator_integration.py::TestValidateContext::test_with_stored_context_and_changes PASSED
tests/test_context_validator_integration.py::TestEndToEndStaleness::test_10_files_2_changed_end_to_end PASSED
tests/test_context_validator_integration.py::TestEndToEndStaleness::test_stale_log_line_in_validate_context PASSED

============================== 20 passed in 0.12s ==============================
```

Phase 20 regression (node --test tests/20-context-handoff.test.cjs): 10 pass, 0 fail.
Phase 20 Python regression (tests/test_rpetd_context.py): 11 pass, 0 fail.

---

## Structural Checks

| Check | Result |
|---|---|
| `services/context_validator.py` exists | PASS |
| `class ContextValidator` present | PASS |
| `def compute_file_hash` present | PASS |
| `def changed_since` present | PASS |
| `def selective_refresh` present | PASS |
| `def validate_context` (module-level) present | PASS |
| `hashlib.sha256` used | PASS |
| `git diff --name-only` used | PASS |
| `[STALE]` log line emitted | PASS (2 code paths) |
| POST `/api/context/validate` in daemon | PASS (line 2201) |
| `compute_file_hashes` in compact route | PASS (line 2169) |
| `file_hashes={}` empty dict removed from compact route | PASS (grep empty) |
| `__commit_ref__` embedded in file_hashes JSONB | PASS |
| Python AST valid (both files) | PASS |
| Git commits present for all tasks | PASS (93e98db..2b5fc97) |

---

## Notes

- No live daemon required for test coverage. All tests use mocked PGStore and mocked subprocess.
- `description_fn=None` in the validate endpoint is an intentional Phase 22 CAVE-01 hook, not a gap.
- `__commit_ref__` embedded as a JSONB key (not a new PG column) is the intended design per 21-02 decisions.
- Phase 21 ROADMAP.md entry is marked `[x] COMPLETE 2026-04-12`.
