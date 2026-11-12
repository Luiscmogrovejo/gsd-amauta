"""Plan 88-12 task 04: the mcp requirement is capped below 2 while the server uses the 1.x API.

``services/amauta-mcp.py`` imports ``mcp.server.Server``, ``mcp.server.stdio.stdio_server`` and
``mcp.server.sse.SseServerTransport``; those are 1.x paths. An unbounded ``mcp>=1.0`` resolves
to 2.x on a fresh install and the server dies at import.
"""
import re
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent

_ONE_X_MARKERS = (
    "from mcp.server import Server",
    "from mcp.server.stdio import stdio_server",
    "from mcp.server.sse import SseServerTransport",
)


def _mcp_line(path):
    """Return the ``mcp`` requirement line of a requirements file (comment stripped)."""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if re.match(r"^mcp\s*([<>=!~\[]|$)", line):
            return line
    raise AssertionError("no mcp requirement in %s" % path)


def _contains(requirement_line, version):
    """True when the requirement's specifier admits `version`.

    Uses packaging when importable; otherwise a documented fallback that only
    understands the operators used in this repository (>=, <, ==, <=, >).
    """
    try:
        from packaging.requirements import Requirement
    except ImportError:  # fallback: compare dotted integers
        def parse(v):
            return tuple(int(x) for x in v.split("."))

        spec = requirement_line[len("mcp"):]
        ok = True
        for op, ver in re.findall(r"(>=|<=|==|<|>)\s*([0-9][0-9.]*)", spec):
            a, b = parse(version), parse(ver)
            ok = ok and {
                ">=": a >= b, "<=": a <= b, "==": a == b, "<": a < b, ">": a > b,
            }[op]
        return ok
    return Requirement(requirement_line).specifier.contains(version)


def test_requirements_cap_matches_the_api_the_server_uses():
    line = _mcp_line(_REPO / "requirements.txt")
    source = (_REPO / "services" / "amauta-mcp.py").read_text(encoding="utf-8")
    if any(marker in source for marker in _ONE_X_MARKERS):
        assert not _contains(line, "2.0.0"), (
            "the cap was removed while services/amauta-mcp.py still imports the 1.x server API "
            "- port the server (Phase 90) or restore `<2` (requirements.txt says %r)" % line
        )


def test_dev_pin_is_inside_the_runtime_range():
    runtime = _mcp_line(_REPO / "requirements.txt")
    dev = _mcp_line(_REPO / "requirements-dev.txt")
    match = re.match(r"^mcp==([0-9][0-9.]*)$", dev)
    assert match, "requirements-dev.txt should pin mcp exactly, got %r" % dev
    assert _contains(runtime, match.group(1)), (
        "CI would test mcp %s, outside the runtime range %r" % (match.group(1), runtime)
    )
