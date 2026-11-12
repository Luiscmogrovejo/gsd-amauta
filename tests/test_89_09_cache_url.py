"""Plan 89-09 task 04: services/cache_url.py, the ONE cache-URL resolver.

Every case asserts on the RESOLVED STRING. Nothing here constructs a client or
opens a socket: the local 6379 is the operator's own Redis server, and a resolver
test that dialled it would be the hazard rather than a test for it. The sites that
do construct a client take the URL from here, so the string is the contract.
"""
import logging
import os
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from services import cache_url  # noqa: E402

#: One row per rung of the chain: (environment, expected URL, expected source).
#: This is the SAME table tests/89-09-cache-url.test.cjs feeds the Node half, and
#: that test compares both answers rung by rung.
CHAIN = [
    ({"GSD_REDIS_URL": "redis://a:1/0", "AMAUTA_REDIS_URL": "redis://b:2/0",
      "VALKEY_URL": "redis://c:3/0", "REDIS_URL": "redis://d:4/0",
      "REDIS_HOST": "e", "REDIS_PORT": "5"}, "redis://a:1/0", "GSD_REDIS_URL"),
    ({"AMAUTA_REDIS_URL": "redis://b:2/0", "VALKEY_URL": "redis://c:3/0",
      "REDIS_URL": "redis://d:4/0"}, "redis://b:2/0", "AMAUTA_REDIS_URL"),
    ({"VALKEY_URL": "redis://c:3/0", "REDIS_URL": "redis://d:4/0"}, "redis://c:3/0", "VALKEY_URL"),
    ({"REDIS_URL": "redis://d:4/0"}, "redis://d:4/0", "REDIS_URL"),
    ({"REDIS_HOST": "e", "REDIS_PORT": "5"}, "redis://e:5/0", "REDIS_HOST+REDIS_PORT"),
    ({"REDIS_HOST": "e"}, "redis://e:6379/0", "REDIS_HOST+REDIS_PORT"),
    ({"REDIS_PORT": "5"}, "redis://127.0.0.1:5/0", "REDIS_HOST+REDIS_PORT"),
    ({}, "redis://127.0.0.1:6379/0", "default"),
    ({"GSD_REDIS_PORT": "7001"}, "redis://127.0.0.1:7001/0", "default"),
    ({"GSD_REDIS_URL": "   "}, "redis://127.0.0.1:6379/0", "default"),
    ({"GSD_REDIS_URL": "", "VALKEY_URL": "redis://c:3/0"}, "redis://c:3/0", "VALKEY_URL"),
    ({"REDIS_URL": "redis://u:secret@h:6379/0"}, "redis://u:secret@h:6379/0", "REDIS_URL"),
    ({"GSD_TEST_VALKEY_URL": "redis://z:9/0"}, "redis://127.0.0.1:6379/0", "default"),
    ({"GSD_REDIS_ENABLED": "false"}, "redis://127.0.0.1:6379/0", "default"),
]


@pytest.fixture(autouse=True)
def _forget_warnings():
    """The once-per-process warning set is process-global; forget it per case."""
    cache_url._WARNED.clear()
    yield
    cache_url._WARNED.clear()


@pytest.mark.parametrize("env,url,source", CHAIN)
def test_the_chain_resolves_and_names_its_source(env, url, source):
    """Every rung resolves to the right URL and reports the right name."""
    assert cache_url.redis_url(env) == url
    assert cache_url.redis_url_source(env) == source
    assert cache_url.resolve(env) == (url, source)


def test_the_precedence_order_is_the_declared_one():
    """The chain is read from URL_NAMES, so the order is data, not four ifs."""
    assert cache_url.URL_NAMES == ("GSD_REDIS_URL", "AMAUTA_REDIS_URL", "VALKEY_URL", "REDIS_URL")
    assert cache_url.CANONICAL == "GSD_REDIS_URL"
    # removing a name one at a time walks the chain down, rung by rung
    env = {name: "redis://%d:%d/0" % (i, i) for i, name in enumerate(cache_url.URL_NAMES)}
    for i, name in enumerate(cache_url.URL_NAMES):
        assert cache_url.redis_url_source(env) == name
        del env[name]
    assert cache_url.redis_url_source(env) == "default"


def test_the_test_side_opt_in_is_not_in_the_chain():
    """GSD_TEST_VALKEY_URL is the test-side opt-in and stays out of the chain.

    It is exactly parallel to GSD_TEST_POSTGRES_URL (tests/conftest.py:160): CI
    hands the disposable Valkey over under that name and tests/conftest.py decides
    what to do with it. A resolver that read it would let a test's cache reach the
    product by accident.
    """
    assert "GSD_TEST_VALKEY_URL" not in cache_url.URL_NAMES
    assert "GSD_TEST_VALKEY_URL" not in cache_url.LEGACY_NAMES
    assert cache_url.redis_url_source({"GSD_TEST_VALKEY_URL": "redis://z:9/0"}) == "default"


def test_the_password_is_masked_in_every_reported_form():
    """A cache DSN can carry a password; nothing reports it unmasked."""
    env = {"REDIS_URL": "redis://user:s3cr3t@cache.internal:6379/0"}
    assert "s3cr3t" not in cache_url.masked_redis_url(env)
    assert cache_url.masked_redis_url(env) == "redis://user:***@cache.internal:6379/0"
    report = cache_url.report(env)
    assert "s3cr3t" not in report["cache_url_masked"]
    assert report == {
        "cache_url_source": "REDIS_URL",
        "cache_url_masked": "redis://user:***@cache.internal:6379/0",
        "cache_url_canonical": "GSD_REDIS_URL",
    }


def test_a_legacy_name_warns_exactly_once_per_process(caplog):
    """The deprecation names the legacy variable, the canonical one and the MASKED URL."""
    env = {"VALKEY_URL": "redis://user:s3cr3t@cache.internal:6379/0"}
    with caplog.at_level(logging.WARNING, logger="services.cache_url"):
        cache_url.redis_url(env)
        cache_url.redis_url(env)
        cache_url.redis_url(env)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1, [r.getMessage() for r in warnings]
    message = warnings[0].getMessage()
    assert "VALKEY_URL" in message
    assert "GSD_REDIS_URL" in message
    assert "redis://user:***@cache.internal:6379/0" in message
    assert "s3cr3t" not in message


def test_the_canonical_name_and_the_default_never_warn(caplog):
    """Only a legacy name is deprecated; the canonical name and the default are not."""
    with caplog.at_level(logging.WARNING, logger="services.cache_url"):
        cache_url.redis_url({"GSD_REDIS_URL": "redis://a:1/0"})
        cache_url.redis_url({})
    assert [r for r in caplog.records if r.levelno == logging.WARNING] == []


def test_each_legacy_name_warns_on_its_own(caplog):
    """Four legacy rungs, four distinct warnings — one per name, not one in total."""
    envs = [
        {"AMAUTA_REDIS_URL": "redis://b:2/0"},
        {"VALKEY_URL": "redis://c:3/0"},
        {"REDIS_URL": "redis://d:4/0"},
        {"REDIS_HOST": "e", "REDIS_PORT": "5"},
    ]
    with caplog.at_level(logging.WARNING, logger="services.cache_url"):
        for env in envs:
            cache_url.redis_url(env)
            cache_url.redis_url(env)
    names = sorted(r.args[0] for r in caplog.records if r.levelno == logging.WARNING)
    assert names == ["AMAUTA_REDIS_URL", "REDIS_HOST+REDIS_PORT", "REDIS_URL", "VALKEY_URL"]


def test_the_default_follows_the_host_side_port_variable():
    """The default's port is GSD_REDIS_PORT, as services/infra_detect.py built it.

    docker/docker-compose.yml publishes the container on that variable, so a
    default that ignored it would point infrastructure detection at a port the
    container is not on.
    """
    assert cache_url.default_url({}) == "redis://127.0.0.1:6379/0"
    assert cache_url.default_url({"GSD_REDIS_PORT": "7002"}) == "redis://127.0.0.1:7002/0"


def test_os_environ_is_the_default_source_of_truth(monkeypatch):
    """Called with no argument, the resolver reads os.environ."""
    monkeypatch.setenv("GSD_REDIS_URL", "redis://from-os-environ:1/0")
    assert cache_url.redis_url() == "redis://from-os-environ:1/0"
    assert cache_url.redis_url_source() == "GSD_REDIS_URL"


def test_this_module_opens_no_socket_and_builds_no_client():
    """The resolver's own source carries no connection primitive."""
    source = (_REPO / "services" / "cache_url.py").read_text(encoding="utf-8")
    # code lines only: the docstring says "opens no socket", which is the point
    code = "\n".join(
        line for line in source.splitlines()
        if line.strip() and not line.lstrip().startswith(("#", "*", '"""', ">>>"))
    )
    for forbidden in ("redis.Redis", "from_url(", "import socket", "socket.socket", ".connect("):
        assert forbidden not in code, "services/cache_url.py must resolve strings only: %r" % forbidden


def test_every_converted_consumer_calls_the_resolver():
    """The ten read sites of task 01 now go through the resolver.

    A grep for the resolver's name in each converted file, so a site that is
    quietly reverted to a direct read is caught here as well as by the lint in
    tests/89-09-cache-url.test.cjs.
    """
    expected = {
        "services/amauta-daemon.py": "cache_url.redis_url()",
        "services/doctor.py": "cache_url.redis_url()",
        "services/infra_detect.py": "cache_url.redis_url()",
        "services/rlm_graph.py": "_cache_url.redis_url()",
        "services/rlm_reranker.py": "_cache_url.redis_url()",
        "services/agent_hydrator.py": "_cache_url.redis_url()",
        "services/amauta-mcp.py": "cache_url.redis_url()",
        "scripts/tool-integrity.cjs": "cacheUrl()",
        "get-shit-done/bin/gsd-tools.cjs": "cacheUrl()",
    }
    for rel, call in expected.items():
        source = (_REPO.joinpath(*rel.split("/"))).read_text(encoding="utf-8")
        assert call in source, "%s no longer calls %s" % (rel, call)


def test_the_fixture_rlm_hands_the_valkey_over_canonically():
    """tests/conftest.py's _start_rlm must use GSD_REDIS_URL, not the host/port pair.

    The session fixture exports GSD_REDIS_URL pointing at a free port with nothing
    behind it. Since the chain puts GSD_REDIS_URL FIRST, a REDIS_HOST/REDIS_PORT
    handover is now outranked and silently ignored — the disposable Valkey would
    never reach the RLM service and the RETR-05 graph test would degrade for the
    wrong reason. This is the assertion that keeps the move in place.
    """
    conftest = (_REPO / "tests" / "conftest.py").read_text(encoding="utf-8")
    start = conftest.index("def _start_rlm(")
    end = conftest.index("\ndef ", start + 1)
    body = conftest[start:end]
    assert 'env["GSD_REDIS_URL"] = "redis://%s:%d/0"' in body
    assert 'env["REDIS_HOST"]' not in body, "the host/port handover is outranked; it must be gone"
    assert 'env.pop("REDIS_HOST", None)' in body
    assert 'env.pop("REDIS_PORT", None)' in body
    # and the precedence that makes it necessary, asserted rather than assumed
    assert cache_url.redis_url_source(
        {"GSD_REDIS_URL": "redis://free-port:1/0", "REDIS_HOST": "valkey", "REDIS_PORT": "2"}
    ) == "GSD_REDIS_URL"


def test_both_scrub_lists_carry_all_five_legacy_names_and_not_the_canonical_one():
    """The two runners agree, name for name (plan 89-09 task 06)."""
    runner = (_REPO / "scripts" / "run-tests.cjs").read_text(encoding="utf-8")
    conftest = (_REPO / "tests" / "conftest.py").read_text(encoding="utf-8")
    runner_list = runner.split("const DELETED_KEYS = [")[1].split("]")[0]
    conftest_list = conftest.split("_DELETED_KEYS = (")[1].split(")")[0]
    for name in cache_url.LEGACY_NAMES:
        assert "'%s'" % name in runner_list, "scripts/run-tests.cjs does not scrub %s" % name
        assert '"%s"' % name in conftest_list, "tests/conftest.py does not scrub %s" % name
    # the canonical name is SET by both runners, not scrubbed — one decision, both files
    assert "'%s'" % cache_url.CANONICAL not in runner_list
    assert '"%s"' % cache_url.CANONICAL not in conftest_list
    assert "env.GSD_REDIS_URL = 'redis://127.0.0.1:' + redisPort + '/0'" in runner
    assert 'os.environ["GSD_REDIS_URL"] = "redis://127.0.0.1:%d/0" % redis_port' in conftest


def test_the_mcp_server_still_opens_nothing_when_nothing_is_configured():
    """An unconfigured MCP server must not dial the operator's own 6379.

    Before plan 89-09 ``MCPValkey`` built no client when neither legacy name was
    set. The resolver always RETURNS a URL, so the site asks for the SOURCE and
    treats ``default`` as "not configured" — this is the line that keeps the old
    behaviour, and it is asserted because losing it would point the MCP server at
    the operator's own Redis on every machine with no cache configured.
    """
    source = (_REPO / "services" / "amauta-mcp.py").read_text(encoding="utf-8")
    assert "source == cache_url.DEFAULT_SOURCE" in source
    assert "no cache URL configured" in source
