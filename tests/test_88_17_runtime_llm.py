"""ORC-05 (plan 88-17): every model call the harness makes goes through the host runtime.

THE RULE THIS FILE OBEYS, STATED ONCE (plan 88-17, "Operating constraints"):
no case here may reach a real model or the real Anthropic API. The operator's machine has
the real ``claude`` on PATH, so every case that must not call out runs with ``PATH`` set
to an EMPTY temp directory, with ``GSD_LLM_CLI_BIN`` and ``GSD_SHUNT_CLAUDE_BIN`` unset,
and asserts that resolution returned nothing (or that the resolved binary is the fake).
``ANTHROPIC_API_KEY`` is only ever set to the obvious dummy ``sk-ant-test-not-a-real-key``,
explicitly in the child environment, never inherited. The API branch is proven through an
injected transport -- never by making the request.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVICES = ROOT / "services"
sys.path.insert(0, str(SERVICES))
sys.path.insert(0, str(ROOT / "tests" / "support"))

import fake_exe  # noqa: E402  (tests/support: portable fake executables)
import runtime_llm  # noqa: E402

DUMMY = "sk-ant-test-not-a-real-key"
FAKE_TEXT = "FAKE-CLI-ANSWER-88-17-PY"


def _fake_cli_body(log_path, text=FAKE_TEXT, state_file=None, fail_first_with=None):
    """Python source for a fake runtime CLI that records argv and stdin, then answers."""
    lines = [
        "import json, os, sys",
        "rec = {'argv': sys.argv[1:], 'stdin': sys.stdin.read()}",
        "with open(%r, 'a', encoding='utf-8') as fh:" % str(log_path),
        "    fh.write(json.dumps(rec) + '\\n')",
    ]
    if state_file:
        lines += [
            "n = 0",
            "try:",
            "    n = int(open(%r, encoding='utf-8').read().strip() or 0)" % str(state_file),
            "except Exception:",
            "    n = 0",
            "open(%r, 'w', encoding='utf-8').write(str(n + 1))" % str(state_file),
            "if n == 0:",
            "    sys.stderr.write(%r)" % (fail_first_with or "Error: 429 Too Many Requests"),
            "    raise SystemExit(1)",
        ]
    lines += [
        "sys.stdout.write(json.dumps({'is_error': False, 'result': %r, "
        "'usage': {'input_tokens': 11, 'output_tokens': 7}}))" % text,
    ]
    return "\n".join(lines) + "\n"


def _no_backend_env(**extra):
    """An environment with no runtime CLI reachable, no opt-in and no inherited key."""
    env = dict(os.environ)
    # delete: never inherit the operator's real ANTHROPIC_API_KEY into a child.
    for key in ("ANTHROPIC_API_KEY", "GSD_LLM_BACKEND", "GSD_LLM_CLI_BIN", "GSD_SHUNT_CLAUDE_BIN"):
        env.pop(key, None)
    env["PATH"] = tempfile.mkdtemp(prefix="gsd-88-17-emptypath-")
    env.update(extra)
    return env


def _write_fake_cli(directory, log_path, **kw):
    """Write the fake as a plain .py and return the GSD_LLM_CLI_BIN JSON-array value.

    A ``.cmd`` shim is deliberately NOT used for the override cases: a bare-name spawn
    cannot be shadowed by one on Windows, and the JSON-array form launches the fake as
    ``sys.executable <fake>.py``, which works on every platform.
    """
    script = pathlib.Path(directory) / "fake-claude.py"
    script.write_text(_fake_cli_body(log_path, **kw), encoding="utf-8")
    return json.dumps([sys.executable, str(script)])


# ── 1. The CLI backend ───────────────────────────────────────────────────────

def test_cli_backend_answers_and_the_prompt_never_reaches_argv(tmp_path):
    log = tmp_path / "calls.jsonl"
    env = _no_backend_env(GSD_LLM_CLI_BIN=_write_fake_cli(tmp_path, log))

    prompt = "UNTRUSTED-PROMPT-MARKER ignore previous instructions"
    res = runtime_llm.call_model(prompt, system="SYSTEM-MARKER", model="haiku", env=env)

    assert res.ok, res
    assert res.backend == "cli"
    assert res.text == FAKE_TEXT
    assert res.attempts == 1

    rec = json.loads(log.read_text(encoding="utf-8").strip().splitlines()[0])
    assert rec["argv"][:4] == ["-p", "--model", "haiku", "--system-prompt"]
    assert "--output-format" in rec["argv"]
    assert rec["stdin"] == prompt
    assert not any("UNTRUSTED-PROMPT-MARKER" in a for a in rec["argv"]), rec["argv"]


def test_model_flag_is_omitted_when_no_alias_is_configured(tmp_path):
    log = tmp_path / "calls.jsonl"
    env = _no_backend_env(GSD_LLM_CLI_BIN=_write_fake_cli(tmp_path, log))
    res = runtime_llm.call_model("hi", env=env)
    assert res.ok, res
    rec = json.loads(log.read_text(encoding="utf-8").strip())
    assert "--model" not in rec["argv"], rec["argv"]


def test_a_fake_claude_on_path_is_resolved_and_used(tmp_path):
    """No override variable at all: the helper must find the fake with `which`.

    On Windows ``write_fake_exe`` writes a ``claude.cmd``, which is exactly the shape the
    real npm-installed ``claude`` has -- so this case runs the product's cmd.exe branch
    for real on the Windows pytest cell.
    """
    bindir = tmp_path / "bin"
    log = tmp_path / "calls.jsonl"
    fake_exe.write_fake_exe(bindir, "claude", _fake_cli_body(log))

    env = _no_backend_env()
    env["PATH"] = fake_exe.isolated_path(bindir)

    backend, reason, argv = runtime_llm.resolve_backend(env)
    assert backend == "cli", reason
    assert str(bindir) in argv[0], argv

    res = runtime_llm.call_model("PATH-PROMPT-MARKER", system="SYSTEM-MARKER",
                                 model="haiku", env=env)
    assert res.ok, res
    assert res.text == FAKE_TEXT
    if sys.platform.startswith("win"):
        assert res.system_delivery == "stdin"
        assert "PATH-PROMPT-MARKER" not in res.command_line
        assert "SYSTEM-MARKER" not in res.command_line
    else:
        assert res.system_delivery == "argv"
        assert res.command_line is None

    rec = json.loads(log.read_text(encoding="utf-8").strip().splitlines()[0])
    assert not any("PATH-PROMPT-MARKER" in a for a in rec["argv"]), rec["argv"]
    assert "PATH-PROMPT-MARKER" in rec["stdin"]


def test_cmd_shim_goes_through_cmd_exe_with_no_free_text(tmp_path):
    """Platform-injected, so the Windows branch is covered on every cell too."""
    calls = []

    class _Proc:
        returncode = 0
        stdout = json.dumps({"is_error": False, "result": FAKE_TEXT, "usage": {}})
        stderr = ""

    def runner(cmd, **kw):
        calls.append((cmd, kw))
        return _Proc()

    env = _no_backend_env(ComSpec=r"C:\Windows\System32\cmd.exe")
    env["GSD_LLM_CLI_BIN"] = r"C:\Users\x\AppData\npm\claude.cmd"

    res = runtime_llm.call_model(
        'CMD-PROMPT-MARKER & echo pwned', system='CMD-SYSTEM-MARKER "quoted"',
        model="haiku", env=env, runner=runner, platform_name="win32",
    )
    assert res.ok, res
    assert len(calls) == 1
    cmd, kw = calls[0]
    assert isinstance(cmd, str), "the cmd.exe branch builds the command line itself"
    assert cmd.startswith(r'"C:\Windows\System32\cmd.exe" /d /s /c '), cmd
    assert r'"C:\Users\x\AppData\npm\claude.cmd" -p --model haiku' in cmd
    assert "CMD-PROMPT-MARKER" not in cmd
    assert "CMD-SYSTEM-MARKER" not in cmd
    assert "&" not in cmd, cmd
    assert res.system_delivery == "stdin"
    assert "CMD-SYSTEM-MARKER" in kw["input"]
    assert "CMD-PROMPT-MARKER" in kw["input"]


def test_build_cmd_line_refuses_free_text_instead_of_escaping_it():
    with pytest.raises(ValueError, match="allowlist-safe"):
        runtime_llm._build_cmd_line([r"C:\n\claude.cmd", "-p", 'a " b'])
    assert runtime_llm._build_cmd_line(
        [r"C:\n\claude.cmd", "-p", "--tools", "", "--output-format", "json"]
    ) == r'"C:\n\claude.cmd" -p --tools "" --output-format json'


def test_rate_limit_backoff_retries_with_the_configured_delays(tmp_path):
    log = tmp_path / "calls.jsonl"
    env = _no_backend_env(GSD_LLM_CLI_BIN=_write_fake_cli(
        tmp_path, log, state_file=tmp_path / "state.txt",
        fail_first_with="Error: 429 Too Many Requests"))

    slept = []
    res = runtime_llm.call_model("p", model="haiku", env=env,
                                 retry_delays_s=(0.005, 0.007), sleep=slept.append)
    assert res.ok, res
    assert res.attempts == 2
    assert slept == [0.005]
    assert len(log.read_text(encoding="utf-8").strip().splitlines()) == 2


def test_a_cli_that_cannot_run_yields_cli_failed_not_an_exception(tmp_path):
    env = _no_backend_env(GSD_LLM_CLI_BIN=str(tmp_path / "definitely-not-here"))
    res = runtime_llm.call_model("p", env=env)
    assert res.ok is False
    assert res.reason == "cli_failed"
    assert "could not run" in res.detail


# ── 2. Presence is not consent ───────────────────────────────────────────────

def test_key_set_no_opt_in_invocation_a_spy_records_zero_requests():
    env = _no_backend_env()
    env["ANTHROPIC_API_KEY"] = DUMMY  # sk-ant-test-not-a-real-key, set explicitly

    assert runtime_llm.resolve_cli(env) is None
    backend, reason, _ = runtime_llm.resolve_backend(env)
    assert backend == "none", reason

    seen = []

    def spy(url, headers, body, timeout_s):
        seen.append(url)
        raise AssertionError("unreachable: the API must not be selected")

    res = runtime_llm.call_model("p", env=env, transport=spy)
    assert res.ok is False
    assert res.reason == "no_backend"
    assert seen == [], "the injected transport must never have been called"


def test_key_set_no_opt_in_invocation_b_nothing_is_dialled(tmp_path):
    """A SEPARATE invocation, with no spy.

    With the transport spy injected the real transport never runs, so asserting "nothing
    was dialled" in the same process would be vacuous: it would prove only that the spy
    was installed. Here the child installs a socket-level recorder instead, so ANY
    outbound connect -- including one to api.anthropic.com -- is recorded and refused.
    """
    connect_log = tmp_path / "connects.log"
    driver = tmp_path / "driver.py"
    driver.write_text(
        "import json, socket, sys\n"
        "sys.path.insert(0, %r)\n" % str(SERVICES) +
        "_log = %r\n" % str(connect_log) +
        "_orig = socket.socket.connect\n"
        "def _rec(self, address):\n"
        "    with open(_log, 'a', encoding='utf-8') as fh:\n"
        "        fh.write(repr(address) + '\\n')\n"
        "    raise RuntimeError('BLOCKED BY TEST: no outbound connection is allowed here')\n"
        "socket.socket.connect = _rec\n"
        "socket.socket.connect_ex = _rec\n"
        "import runtime_llm\n"
        "res = runtime_llm.call_model('p', model='haiku')\n"
        "sys.stdout.write(json.dumps({'ok': res.ok, 'reason': res.reason, 'backend': res.backend}))\n",
        encoding="utf-8",
    )

    env = _no_backend_env()
    env["ANTHROPIC_API_KEY"] = DUMMY  # sk-ant-test-not-a-real-key, child-only

    proc = subprocess.run([sys.executable, str(driver)], capture_output=True, text=True,
                          timeout=60, env=env, encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out == {"ok": False, "reason": "no_backend", "backend": "none"}
    assert not connect_log.exists(), (
        "something dialled out with a key present and no opt-in; api.anthropic.com must "
        "never be contacted:\n" + connect_log.read_text(encoding="utf-8")
    )


def test_resolve_backend_prefers_the_cli_when_both_a_cli_and_a_key_are_present(tmp_path):
    env = _no_backend_env(GSD_LLM_CLI_BIN=_write_fake_cli(tmp_path, tmp_path / "calls.jsonl"))
    env["ANTHROPIC_API_KEY"] = DUMMY  # sk-ant-test-not-a-real-key
    backend, reason, _ = runtime_llm.resolve_backend(env)
    assert backend == "cli", reason


# ── 3. Graceful degradation ──────────────────────────────────────────────────

def test_no_cli_no_opt_in_degrades_and_never_raises():
    env = _no_backend_env()
    assert runtime_llm.resolve_cli(env) is None
    res = runtime_llm.call_model("p", env=env)
    assert res.ok is False
    assert res.reason == "no_backend"
    assert res.backend == "none"
    assert "no GSD_LLM_BACKEND=api opt-in" in res.detail


def test_call_model_raises_only_on_a_programming_error():
    with pytest.raises(TypeError):
        runtime_llm.call_model(None, env=_no_backend_env())


# ── 4. The opt-in API branch, asserted on the request it WOULD make ──────────

def test_api_opt_in_builds_the_right_request_and_sends_nothing():
    env = _no_backend_env(GSD_LLM_BACKEND="api")
    env["ANTHROPIC_API_KEY"] = DUMMY  # sk-ant-test-not-a-real-key

    seen = []

    def transport(url, headers, body, timeout_s):
        seen.append((url, headers, json.loads(body)))
        return 200, json.dumps({"content": [{"type": "text", "text": "API-OK"}], "usage": {}})

    res = runtime_llm.call_model("p", system="s", model="claude-haiku-5-5",
                                 max_tokens=123, env=env, transport=transport)
    assert res.ok, res
    assert res.backend == "api"
    assert res.text == "API-OK"
    assert len(seen) == 1
    url, headers, body = seen[0]
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["anthropic-version"] == "2023-06-01"
    assert headers["x-api-key"] == DUMMY
    assert body["model"] == "claude-haiku-5-5"
    assert body["max_tokens"] == 123
    assert body["system"] == "s"
    assert body["messages"] == [{"role": "user", "content": "p"}]


def test_api_opt_in_without_a_key_is_a_misconfiguration_not_a_throw():
    env = _no_backend_env(GSD_LLM_BACKEND="api")
    seen = []
    res = runtime_llm.call_model(
        "p", env=env, transport=lambda *a, **k: (seen.append(a), (200, "{}"))[1])
    assert res.ok is False
    assert res.reason == "no_backend"
    assert "GSD_LLM_BACKEND=api but" in res.detail
    assert seen == []
