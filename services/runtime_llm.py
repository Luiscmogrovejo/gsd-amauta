#!/usr/bin/env python3
"""services/runtime_llm.py -- every model call the harness initiates, in one place (ORC-05).

The Python mirror of ``get-shit-done/bin/lib/runtime-llm.cjs``; the two share a contract,
not code. The harness is a plugin of a host runtime and uses that runtime's model.

Backend order:
  1. the host runtime CLI -- ``claude -p`` today; **Phase 94 (OCX-07)** adds an
     ``opencode`` branch to :func:`resolve_backend` and nothing else changes;
  2. a direct HTTP API call ONLY when ``GSD_LLM_BACKEND=api`` is set explicitly;
  3. otherwise a typed, non-fatal "no model backend" result.

**The presence of ANTHROPIC_API_KEY in the environment NEVER selects the API.** A user
who holds a key for some other purpose must not be billed by this harness. The variable is
read in exactly one place in this file -- inside :func:`_call_api`, which is reachable only
through the ``GSD_LLM_BACKEND=api`` opt-in.

:func:`call_model` **never raises for a missing backend**. It returns
``LlmResult(ok=False, reason="no_backend", ...)`` so the calling feature can degrade. That
is the whole point: ``services/memory_classifier.py`` used to raise, which meant the
classifier had never worked for anybody without a paid key.

Security notes that are load-bearing:
  - The prompt is UNTRUSTED input. It goes to the CLI on **stdin** and to the API inside a
    JSON body. It is never interpolated into a shell string or a command line, on any
    platform; ``shell=True`` appears nowhere.
  - On Windows the real ``claude`` is an npm ``claude.cmd`` shim. ``CreateProcess``
    launches a ``.cmd`` by handing it to ``cmd.exe``, with cmd.exe's re-parsing rules --
    the hazard behind CVE-2024-27980 / "BatBadBut". This module therefore builds that
    command line itself, from **fixed literal tokens and allowlisted values only**, and
    moves free text (the system prompt) onto stdin rather than escaping it.
  - The API branch sends the key in a header through ``urllib``. Nothing is written to
    disk and the key never reaches an argument vector.

Importable both as ``from runtime_llm import call_model`` (when ``services/`` is on
``sys.path``, which every entry point arranges first) and as
``from services.runtime_llm import call_model``.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

_SERVICES_DIR = os.path.dirname(os.path.abspath(__file__))
if _SERVICES_DIR not in sys.path:
    sys.path.append(_SERVICES_DIR)
from _platform import which as _which  # noqa: E402

__all__ = ["LlmResult", "resolve_backend", "call_model", "DEFAULT_RETRY_DELAYS_S"]

#: Name of the host runtime CLI looked up on PATH when no override is set.
DEFAULT_CLI_NAME = "claude"

#: Overrides, in precedence order. ``GSD_SHUNT_CLAUDE_BIN`` is kept because the shunt has
#: always honoured it; ``GSD_LLM_CLI_BIN`` is the backend-neutral name and wins.
CLI_OVERRIDE_VARS = ("GSD_LLM_CLI_BIN", "GSD_SHUNT_CLAUDE_BIN")

DEFAULT_TIMEOUT_S = 60.0
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MAX_TOKENS = 1000

#: Rate-limit backoff, the Python mirror of the Node helper's. Only rate-limit-shaped
#: failures retry; every other failure returns at once.
RATE_LIMIT_PATTERN = re.compile(r"too many requests|rate.?limit|429", re.IGNORECASE)
DEFAULT_RETRY_DELAYS_S = (2.0, 8.0)

#: Characters a token may contain before it is allowed onto a ``cmd.exe`` command line.
#: Closed on purpose: no ``"`` (quote breakout), no ``%`` (percent expansion), no
#: ``& | < > ^ ( )``, no whitespace, no newline.
_CMD_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9_.:=+,@/\\-]*$")

#: A model alias or concrete model id: a closed class, safe for a cmd.exe command line.
_MODEL_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


@dataclass
class LlmResult:
    """The typed result of one model call. A missing backend is an ordinary value here.

    Attributes:
        ok: True when ``text`` carries a model response.
        text: the model's text, empty when ``ok`` is False.
        backend: ``"cli"``, ``"api"`` or ``"none"`` -- what was actually used.
        reason: ``""`` when ok; otherwise ``"no_backend"``, ``"cli_failed"`` or
            ``"api_failed"``.
        detail: a one-line, key-free explanation suitable for a diagnostic.
        model: the model alias that was requested, or None for "the runtime's default".
        attempts: how many CLI attempts were made (the rate-limit backoff is observable
            through this field).
        system_delivery: ``"argv"`` or ``"stdin"`` -- where the system prompt travelled.
        command_line: the cmd.exe command line, when that spawn form was used.
    """

    ok: bool
    text: str = ""
    backend: str = "none"
    reason: str = ""
    detail: str = ""
    model: Optional[str] = None
    attempts: int = 0
    system_delivery: str = "argv"
    command_line: Optional[str] = None
    usage: Dict[str, Any] = field(default_factory=dict)


def _env_of(env):
    """Return the environment mapping to read (the process environment by default)."""
    return os.environ if env is None else env


def _parse_override(raw):
    """Split a CLI override into a command and leading arguments.

    Args:
        raw: the raw environment value; a plain path, or a JSON array of strings.

    Returns:
        list[str]: the argv prefix.
    """
    raw = raw.strip()
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and parsed and all(isinstance(x, str) for x in parsed):
                return list(parsed)
        except Exception:
            pass  # a malformed override is treated as a plain path
    return [raw]


def resolve_cli(env=None):
    """Resolve the host runtime CLI without running it.

    Args:
        env: environment mapping to read; None means the process environment.

    Returns:
        tuple[list[str], str] | None: ``(argv_prefix, source)`` or None when nothing
        resolved. ``source`` is the override variable name or ``"PATH"``.

    Example:
        >>> resolve_cli({"GSD_LLM_CLI_BIN": "/bin/echo"})
        (['/bin/echo'], 'GSD_LLM_CLI_BIN')
    """
    environ = _env_of(env)
    for name in CLI_OVERRIDE_VARS:
        raw = str(environ.get(name) or "").strip()
        if raw:
            return _parse_override(raw), name
    found = _which(DEFAULT_CLI_NAME, env=environ)
    return ([found], "PATH") if found else None


def resolve_backend(env=None):
    """Decide which backend a call would use, WITHOUT making a call.

    PHASE 94 / OCX-07 EXTENSION POINT: the ``opencode`` backend is added HERE and nowhere
    else -- another host-runtime candidate ahead of the ``claude`` lookup. The typed
    result, the API opt-in rule and every caller stay untouched.

    Args:
        env: environment mapping to read; None means the process environment.

    Returns:
        tuple[str, str, object]: ``(backend, reason, cli)`` where ``backend`` is
        ``"cli"``, ``"api"`` or ``"none"`` and ``cli`` is the resolved argv prefix or None.

    Example:
        >>> resolve_backend({"GSD_LLM_BACKEND": "api"})[0]
        'api'
    """
    environ = _env_of(env)
    explicit = str(environ.get("GSD_LLM_BACKEND") or "").strip().lower()

    if explicit == "api":
        return "api", "GSD_LLM_BACKEND=api (explicit opt-in)", None

    resolved = resolve_cli(environ)
    if resolved is not None:
        argv, source = resolved
        return "cli", "host runtime CLI via %s" % source, argv
    if explicit == "cli":
        return "none", "GSD_LLM_BACKEND=cli but no host runtime CLI could be resolved", None
    return "none", "no host runtime CLI on PATH and no GSD_LLM_BACKEND=api opt-in", None


def _quote_cmd_path(p):
    """Quote an executable path for a ``cmd.exe /d /s /c`` command line.

    Args:
        p: the resolved path (from ``which`` or an operator override, never user input).

    Returns:
        str: the path wrapped in double quotes.

    Raises:
        ValueError: when the path contains a character that cannot be quoted safely.
    """
    if re.search(r'["%\r\n]', p):
        raise ValueError(
            "runtime_llm: refusing to build a cmd.exe command line for a path containing a quote or %%"
        )
    return '"%s"' % p


def _build_cmd_line(argv):
    """Build the ``cmd.exe /d /s /c`` command line for a ``.cmd``/``.bat`` runtime CLI.

    Every element is either the quoted target path (the first element) or a token that
    matches the closed allowlist. A token that fails raises instead of being escaped:
    escaping for cmd.exe is exactly the mistake CVE-2024-27980 was about, so free text
    travels on stdin instead.

    Args:
        argv: the full argument vector, target first.

    Returns:
        str: the command line handed to cmd.exe.

    Raises:
        ValueError: when a value is not allowlist-safe.

    Example:
        >>> _build_cmd_line([r"C:\\n\\claude.cmd", "-p"])
        '"C:\\\\n\\\\claude.cmd" -p'
    """
    parts = [_quote_cmd_path(argv[0])]
    for a in argv[1:]:
        if a == "":
            parts.append('""')
            continue
        if not _CMD_SAFE_TOKEN.match(a):
            raise ValueError(
                "runtime_llm: refusing to place a value on a cmd.exe command line that is "
                "not allowlist-safe; free text must travel on stdin (CVE-2024-27980)"
            )
        parts.append(a)
    return " ".join(parts)


def _build_cli_args(model, system, system_on_stdin):
    """Build the runtime CLI argument vector (without the executable).

    The argv is ``gsd-shunt.cjs``'s ``callCli``, verbatim, minus ``--model`` when no alias
    is configured -- 88-CONTEXT.md's rule is "the runtime's default model unless a model
    alias is configured".

    Args:
        model: a model alias, or None for the runtime's default.
        system: the system prompt, or None.
        system_on_stdin: True when the system prompt must not reach the command line.

    Returns:
        list[str]: the argument vector.
    """
    args = ["-p"]
    if model:
        args += ["--model", model]
    if system and not system_on_stdin:
        args += ["--system-prompt", system]
    args += [
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format", "json",
    ]
    return args


def _build_stdin(system, prompt, system_on_stdin):
    """Compose the stdin payload, fencing the system prompt when it cannot go in argv.

    Args:
        system: the system prompt, or None.
        prompt: the (untrusted) user prompt.
        system_on_stdin: True when the system prompt must travel on stdin.

    Returns:
        str: the bytes written to the child's stdin.
    """
    if not system_on_stdin or not system:
        return prompt
    return "<system_instructions>\n%s\n</system_instructions>\n\n%s" % (system, prompt)


def _parse_cli_json(stdout, binname):
    """Parse the runtime CLI's ``--output-format json`` envelope.

    Args:
        stdout: raw stdout from the CLI.
        binname: the binary path, for error messages.

    Returns:
        tuple[str, dict]: the text and the usage dict.

    Raises:
        RuntimeError: when the output is not JSON or the CLI reported an error.
    """
    try:
        parsed = json.loads(stdout)
    except Exception:
        raise RuntimeError("%s output not JSON: %s" % (binname, str(stdout)[:200]))
    if parsed.get("is_error"):
        raise RuntimeError("%s reported an error: %s" % (binname, str(parsed.get("result"))[:300]))
    return str(parsed.get("result") or ""), dict(parsed.get("usage") or {})


def _cli_attempt(argv_prefix, prompt, system, model, timeout_s, env, platform_name, runner,
                 diag=None):
    """Make one CLI attempt. Never retries; :func:`call_model` owns the backoff loop.

    Args:
        argv_prefix: resolved executable plus any leading arguments.
        prompt: the untrusted prompt, delivered on stdin.
        system: the system prompt, or None.
        model: a model alias, or None.
        timeout_s: seconds before the child is killed.
        env: the child environment.
        platform_name: ``sys.platform`` or an injected value.
        runner: ``subprocess.run``-compatible callable (injectable for tests).
        diag: optional dict filled in BEFORE the spawn with ``system_delivery`` and
            ``command_line``, so a failure result can report which spawn form was used.

    Returns:
        tuple[str, dict, str, str | None]: text, usage, system delivery, command line.

    Raises:
        RuntimeError: on a spawn failure, a non-zero exit, or unparseable output.
        ValueError: when a value cannot be placed safely on a cmd.exe command line.
    """
    is_win = str(platform_name).startswith("win")
    target = argv_prefix[0]
    is_shim = is_win and target.lower().endswith((".cmd", ".bat"))
    if model is not None and not _MODEL_TOKEN.match(model):
        raise ValueError("runtime_llm: refusing a model alias that is not a plain token: %r" % (model,))

    cli_args = _build_cli_args(model, system, is_shim)
    stdin_payload = _build_stdin(system, prompt, is_shim)
    child_env = dict(env)
    child_env["GSD_SHUNT"] = "off"
    child_env["GSD_SHUNT_WORKER"] = "1"

    diag = {} if diag is None else diag
    command_line = None
    if is_shim:
        command_line = _build_cmd_line(list(argv_prefix) + cli_args)
        comspec = child_env.get("ComSpec") or child_env.get("COMSPEC") or "cmd.exe"
        # ``/s`` tells cmd.exe to strip the FIRST and LAST quote of the string after
        # ``/c`` and run the rest verbatim. Handing it the bare line would strip the
        # opening quote of the target path and the closing quote of ``--tools ""``,
        # mangling both; the documented idiom is to wrap the WHOLE line in one more pair
        # of quotes so the pair cmd.exe removes is the outer one. Nothing
        # user-controlled is in the line (see _build_cmd_line), so the extra quotes
        # cannot be escaped out of.
        cmd = '%s /d /s /c "%s"' % (_quote_cmd_path(comspec), command_line)
        diag["system_delivery"] = "stdin"
        diag["command_line"] = command_line
    else:
        cmd = list(argv_prefix) + cli_args
        diag["system_delivery"] = "argv"
        diag["command_line"] = None

    try:
        proc = runner(
            cmd,
            input=stdin_payload,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=child_env,
        )
    except FileNotFoundError as e:
        raise RuntimeError("could not run %s: %s" % (target, e))
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("%s timed out after %ss: %s" % (target, timeout_s, e))

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[:300]
        raise RuntimeError("%s exited %s: %s" % (target, proc.returncode, tail))
    text, usage = _parse_cli_json(proc.stdout, target)
    return text, usage, ("stdin" if is_shim else "argv"), command_line


def _default_transport(url, headers, body, timeout_s):
    """The default API transport: one ``urllib`` POST. Nothing is written to disk.

    Args:
        url: the endpoint.
        headers: request headers (the key lives here, never in an argv).
        body: the encoded JSON body.
        timeout_s: socket timeout in seconds.

    Returns:
        tuple[int, str]: the HTTP status and the response body.

    Raises:
        urllib.error.URLError: on a transport failure.
    """
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return resp.getcode(), resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _call_api(prompt, system, model, max_tokens, timeout_s, env, transport):
    """The opt-in direct API branch. Reached ONLY when ``GSD_LLM_BACKEND=api``.

    Args:
        prompt: the user prompt.
        system: the system prompt, or None.
        model: a model id or alias.
        max_tokens: output cap.
        timeout_s: socket timeout.
        env: the environment to read the key from.
        transport: ``(url, headers, body, timeout_s) -> (status, text)``, injectable so a
            test can assert on the request WITHOUT making it.

    Returns:
        LlmResult: ok on success, ``api_failed``/``no_backend`` otherwise. Never raises.
    """
    # The ONLY read of ANTHROPIC_API_KEY in the Python product, and it sits inside the
    # explicit GSD_LLM_BACKEND=api opt-in. Presence alone never reaches this line.
    api_key = str(env.get("ANTHROPIC_API_KEY") or "")
    if not api_key:
        return LlmResult(
            ok=False, backend="api", reason="no_backend",
            detail="GSD_LLM_BACKEND=api but ANTHROPIC_API_KEY is empty", model=model, attempts=1,
        )
    payload = {"max_tokens": max_tokens or DEFAULT_MAX_TOKENS,
               "messages": [{"role": "user", "content": prompt}]}
    if model:
        payload["model"] = model
    if system:
        payload["system"] = system
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
    }
    try:
        status, text = transport(API_URL, headers, body, timeout_s)
    except Exception as e:  # transport failures are ordinary, not fatal
        return LlmResult(ok=False, backend="api", reason="api_failed",
                         detail=str(e).splitlines()[0] if str(e) else type(e).__name__,
                         model=model, attempts=1)
    try:
        parsed = json.loads(text)
    except Exception:
        return LlmResult(ok=False, backend="api", reason="api_failed",
                         detail="API response not parseable", model=model, attempts=1)
    if status != 200 or parsed.get("error"):
        msg = (parsed.get("error") or {}).get("message", "")
        return LlmResult(ok=False, backend="api", reason="api_failed",
                         detail=("API %s: %s" % (status, msg)).strip(), model=model, attempts=1)
    # A block with no ``type`` is accepted too, matching the shape the pre-88-17
    # callers read; dropping it would silently turn a working response into "".
    out = "".join(b.get("text", "") for b in parsed.get("content", [])
                  if b.get("type") in (None, "text"))
    return LlmResult(ok=True, text=out, backend="api", model=model, attempts=1,
                     usage=dict(parsed.get("usage") or {}))


def call_model(
    prompt,
    system=None,
    model=None,
    max_tokens=None,
    env=None,
    timeout_s=DEFAULT_TIMEOUT_S,
    retry_delays_s=DEFAULT_RETRY_DELAYS_S,
    sleep=time.sleep,
    runner=subprocess.run,
    transport=_default_transport,
    platform_name=None,
    on_retry=None,
):
    """Make one model call on behalf of the harness.

    **Never raises for a missing backend.** It raises only on a programming error (a
    non-string prompt, or a value that cannot be placed safely on a cmd.exe command line).

    Args:
        prompt: the prompt text; treated as untrusted and delivered on stdin.
        system: an optional system prompt.
        model: a model alias such as ``"haiku"``, or None to let the host runtime pick its
            own default model (88-CONTEXT.md's ORC-05 rule).
        max_tokens: output cap for the API branch; the CLI backend has its own default.
        env: environment mapping; None means the process environment.
        timeout_s: seconds before the CLI child is killed / the socket times out.
        retry_delays_s: rate-limit backoff delays; two entries means at most two retries.
        sleep: injectable sleep so a test does not wait seconds.
        runner: injectable ``subprocess.run``.
        transport: injectable API transport, so a test can assert on the request the
            helper WOULD make rather than making it.
        platform_name: injectable ``sys.platform`` for the Windows branch.
        on_retry: optional callback ``(attempt, delay_s, detail)`` for diagnostics.

    Returns:
        LlmResult: always a value, never an exception, for every backend state.

    Raises:
        TypeError: when ``prompt`` is not a string.

    Example:
        >>> r = call_model("hello", env={})      # no CLI, no opt-in
        >>> r.ok, r.reason
        (False, 'no_backend')
    """
    if not isinstance(prompt, str):
        raise TypeError("runtime_llm: call_model needs a string prompt")
    environ = dict(_env_of(env))
    platform_name = platform_name or sys.platform

    backend, reason, argv_prefix = resolve_backend(environ)

    if backend == "none":
        return LlmResult(ok=False, backend="none", reason="no_backend", detail=reason,
                         model=model, attempts=0)

    if backend == "api":
        return _call_api(prompt, system, model, max_tokens, timeout_s, environ, transport)

    attempts = 0
    detail = ""
    diag = {}
    delays = list(retry_delays_s or ())
    for attempt in range(len(delays) + 1):
        attempts += 1
        try:
            text, usage, delivery, command_line = _cli_attempt(
                argv_prefix, prompt, system, model, timeout_s, environ, platform_name, runner,
                diag=diag,
            )
            return LlmResult(ok=True, text=text, backend="cli", model=model, attempts=attempts,
                             system_delivery=delivery, command_line=command_line, usage=usage)
        except ValueError:
            raise  # a programming error, not a backend state
        except Exception as e:
            detail = (str(e).splitlines() or [type(e).__name__])[0]
            if RATE_LIMIT_PATTERN.search(str(e)) and attempt < len(delays):
                if on_retry:
                    on_retry(attempt + 1, delays[attempt], detail)
                sleep(delays[attempt])
                continue
            break
    # The diagnostics are carried on the FAILURE result too: without them a red Windows
    # cell cannot tell "the cmd.exe branch ran and the shim failed" from "the branch was
    # never taken", which is the first question anyone asks.
    return LlmResult(ok=False, backend="cli", reason="cli_failed", detail=detail,
                     model=model, attempts=attempts,
                     system_delivery=diag.get("system_delivery") or "",
                     command_line=diag.get("command_line"))
