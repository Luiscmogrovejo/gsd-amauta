---
plan: 01-01
title: "RLM Service Reliability + Daemon API Key Validation"
status: complete
completed_at: "2026-04-06"
commits:
  - e49596e  # fix(rlm): kill orphaned port holders, log stderr, reset restart counter, add API key validation
  - 0a04042  # test(01-01): add 13 tests for RLM port cleanup and API key validation
---

# SUMMARY: Plan 01-01 — RLM Service Reliability + Daemon API Key Validation

## What was built

### T1: RLM port-squatting fix (services/amauta-daemon.py)

Added two helper functions before `_start_rlm`:

- `_kill_port_holder(port)`: uses `lsof -ti :{port}` to enumerate PIDs holding
  the port, sends SIGTERM then SIGKILL (with 0.5s grace) to each non-self PID.
  Logs `rlm_port_freed` on success, `rlm_port_kill_permission` on EPERM.

- `_port_is_free(port)`: binds a socket to 127.0.0.1:{port} to test availability.
  Returns True if bind succeeds, False on OSError.

`_start_rlm` now has a pre-flight block that calls both helpers before `Popen`.
On startup, RLM stdout/stderr are redirected to `DATA_DIR/rlm-service.log`
(append mode) instead of DEVNULL. `_rlm_restart_count` is reset to 0 after each
successful health check, breaking the permanent failure accumulation.

### T2: Watchdog logging improvement (services/amauta-daemon.py)

Replaced the single combined condition `_rlm_process.poll() is not None or not _check_rlm_health()`
with two separate checks:
- `process_dead = _rlm_process.poll() is not None`
- `health_failed = not process_dead and not _check_rlm_health()`

Both the `rlm_restart` warning and `rlm_max_restarts_exceeded` error logs now
include `reason=process_exited|health_check_failed` for operator observability.

### T3: API key validation (services/amauta-daemon.py)

Added `_validate_api_keys()` function:
- Checks `VOYAGE_API_KEY` (expected 40-60 chars) and `PERPLEXITY_API_KEY` (40-70 chars)
  with length-bound validation producing `ok` or `suspicious_length` status
- Reports `PERPLEXITY_MODEL` presence/value
- Never exposes raw key material

Wired into:
- **Startup banner**: prints `API Keys:` section with each key status before RLM start
- **`/health` endpoint**: adds `api_keys` dict with `set`/`status` fields only
  (filter `if "length" in v or not v.get("set")` ensures lengths are stripped
  from the public endpoint)

### T4: Tests (tests/25-01-infra-quick-wins.test.cjs)

13 tests across 4 describe blocks. All pass in 246ms via `node --test`.
- `_validate_api_keys (T3)`: 3 tests using Python AST extraction + isolated exec
- `_port_is_free (T1)`: 2 tests using real socket bind (no mocks)
- `RLM code-path checks (T1/T2)`: 4 grep/string-match tests
- `Health endpoint api_keys security (T3)`: 4 tests verifying fields and filter

## Acceptance criteria status

- [x] `def _kill_port_holder(port):` in daemon
- [x] `def _port_is_free(port):` in daemon
- [x] `_kill_port_holder(RLM_PORT)` called inside `_start_rlm`
- [x] `_rlm_restart_count = 0  # Reset on successful start` in daemon
- [x] `stderr=subprocess.DEVNULL` absent from `_start_rlm` (DEVNULL count = 0)
- [x] `rlm-service.log` as log file path
- [x] `stderr=rlm_log_file` in Popen call
- [x] `reason = "process_exited" if process_dead else "health_check_failed"` in watchdog
- [x] `log.warning("rlm_restart attempt=%d/%d reason=%s"` in watchdog
- [x] `log.error("rlm_max_restarts_exceeded reason=%s"` in watchdog
- [x] `def _validate_api_keys():` in daemon
- [x] `"VOYAGE_API_KEY"` in `_validate_api_keys`
- [x] `"PERPLEXITY_API_KEY"` in `_validate_api_keys`
- [x] `"PERPLEXITY_MODEL"` in `_validate_api_keys`
- [x] `print(f"  API Keys:")` in startup section
- [x] `"api_keys":` in health endpoint block
- [x] Health endpoint api_keys does not expose length or key values
- [x] `tests/25-01-infra-quick-wins.test.cjs` exists with 13 tests, exits 0

## Key decisions

- `_kill_port_holder` uses `lsof` (macOS/Linux compatible). The `subprocess` import
  is done inline (`import subprocess as _sp`) to avoid name collision with the
  module-level `subprocess` reference.
- Log file opened in append mode and shared for both stdout and stderr — simpler
  than two separate files and avoids interleaved writes from two streams.
- Restart counter reset placed AFTER the health check loop succeeds, not at Popen
  time — ensures only a genuinely healthy start clears the counter.
- Health endpoint filters out `PERPLEXITY_MODEL` (which has a `value` key, not
  `length`) from `api_keys` — only API keys with bound validation are exposed.
