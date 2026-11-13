"""Plan 89-09 task 05: the two reporting extension points.

``services/amauta-daemon.py`` and ``services/doctor.py`` would otherwise have been
edited by five and four Phase 89 plans respectively, every one of them only to add
ONE reporting row. One extension point each lets a later plan contribute its row
from its own module (``services/report_hooks.py``'s docstring is the contract).

What is proven here:
  * a registered provider's fragment reaches ``/health`` AND ``doctor``;
  * a provider that RAISES is named and cannot take either down;
  * this plan's own cache row names the supplying variable with the URL MASKED;
  * the pre-existing output did not move: the full ``/health`` key set and the full
    ``doctor`` check list are compared with the sets master ``7c93244`` produced,
    frozen here as data so the comparison needs no git history and no skip.

Nothing here starts a daemon, binds a port or opens a socket.
"""
import ast
import json
import logging
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from services import cache_url, report_hooks  # noqa: E402

# ─── The frozen "before" sets, measured on master 7c93244 ────────────────────

#: Every key the /health body carried before this plan. Measured with the AST
#: census below, on 7c93244, and frozen so this test needs no git history: a
#: `git show`-driven comparison would have to SKIP on a shallow clone, and a skip
#: needs a ledger entry.
HEALTH_KEYS_BEFORE = [
    "amauta_py", "api_keys", "backend", "backend_selection", "cache_metrics",
    "daemon", "data_dir", "degraded", "degraded_counts", "features",
    "features_off", "oidc_enabled", "oidc_issuer", "pg_available",
    "pg_configured", "pg_health", "pg_recovery_available", "pg_recovery_hint",
    "pid", "pipeline_status", "port", "redis_managed", "redis_restarts",
    "redis_running", "redis_url", "rlm_managed", "rlm_port", "rlm_restarts",
    "rlm_restarts_lifetime", "rlm_running", "service_errors", "sqlite_health",
    "status",
]

#: Every check `doctor.main()` called before this plan, in order.
DOCTOR_CHECKS_BEFORE = [
    "check_paths", "check_path_collision", "check_install_drift",
    "check_version_skew", "check_install_stale", "check_github_access",
    "check_daemon", "check_backend", "check_postgres", "check_valkey",
    "check_rlm_index", "check_embeddings", "check_api_keys", "check_migrations",
    "check_agents", "check_skills", "check_mobile",
]


def _health_keys():
    """Every key assigned into the ``/health`` body, by AST census.

    Returns:
        list: sorted, unique key names.
    """
    tree = ast.parse((_REPO / "services" / "amauta-daemon.py").read_text(encoding="utf-8"))
    keys = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "health" and isinstance(node.value, ast.Dict):
                keys.extend(k.value for k in node.value.keys if isinstance(k, ast.Constant))
            if not (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                    and target.value.id == "health"):
                continue
            if isinstance(target.slice, ast.Constant):
                keys.append(target.slice.value)
            elif (isinstance(target.slice, ast.Attribute)
                    and target.slice.attr == "HEALTH_SECTION"):
                # health[report_hooks.HEALTH_SECTION] — the ONE named constant the
                # census resolves, so the daemon keeps a single source of truth
                # for the section name instead of repeating the literal.
                keys.append(report_hooks.HEALTH_SECTION)
            else:
                raise AssertionError(
                    "a /health key is assigned through an expression this census cannot "
                    "resolve (line %d); keep the key a literal or name it here" % target.lineno)
    return sorted(set(keys))


def _doctor_checks():
    """Every ``check_*`` call in ``doctor.main()``, in source order.

    Returns:
        list: function names.
    """
    tree = ast.parse((_REPO / "services" / "doctor.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "main":
            return [
                call.func.id for call in ast.walk(node)
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                and call.func.id.startswith("check_")
            ]
    raise AssertionError("services/doctor.py has no main()")


@pytest.fixture(autouse=True)
def _restore_providers():
    """Every case gets the real provider list back, whatever it did to it."""
    builtin = report_hooks._BUILTIN_PROVIDERS
    modules = report_hooks.PROVIDER_MODULES
    cache_url._WARNED.clear()
    yield
    report_hooks._BUILTIN_PROVIDERS = builtin
    report_hooks.PROVIDER_MODULES = modules
    cache_url._WARNED.clear()


# ═══════════════════════════════════════════════════════════════════════════
# The hooks exist, and a provider reaches both reports
# ═══════════════════════════════════════════════════════════════════════════

def test_a_registered_provider_reaches_health_and_doctor():
    """One provider, two reports, from its own module's two functions."""
    def health_fragment(env=None):
        return {"engine": "fallback", "measured": True}

    def doctor_rows(env=None):
        return [(report_hooks.STATUS_OK, "lexical", "engine=fallback", {"engine": "fallback"})]

    report_hooks._BUILTIN_PROVIDERS = (("lexical", health_fragment, doctor_rows),)
    # Plan 89-10: only the provider this case installs. The module providers
    # (PROVIDER_MODULES) are real reporters with rows of their own -- the
    # key-presence row always has one -- and this case is about the hook.
    report_hooks.PROVIDER_MODULES = ()
    assert report_hooks.extra_health_rows({}) == {"lexical": {"engine": "fallback", "measured": True}}
    assert report_hooks.extra_doctor_rows({}) == [
        (report_hooks.STATUS_OK, "lexical", "engine=fallback", {"engine": "fallback"})
    ]


def test_a_provider_that_raises_is_named_and_breaks_nothing(caplog):
    """A reporter that fails must not take /health or doctor down."""
    def boom(env=None):
        raise RuntimeError("the lexical probe timed out")

    def good(env=None):
        return {"ok": True}

    report_hooks._BUILTIN_PROVIDERS = (("broken", boom, boom), ("fine", good, None))
    # Plan 89-10: only the provider this case installs. The module providers
    # (PROVIDER_MODULES) are real reporters with rows of their own -- the
    # key-presence row always has one -- and this case is about the hook.
    report_hooks.PROVIDER_MODULES = ()
    with caplog.at_level(logging.WARNING, logger="services.report_hooks"):
        section = report_hooks.extra_health_rows({})
        rows = report_hooks.extra_doctor_rows({})
    assert section["fine"] == {"ok": True}, "a good provider still reports"
    assert section[report_hooks.DEGRADED_KEY] == ["broken: the lexical probe timed out"]
    assert "broken" not in section, "a failed provider contributes no fragment"
    assert rows == [(report_hooks.STATUS_WARN, "broken",
                     "reporter failed: the lexical probe timed out", {})]
    assert any("health_provider_failed" in r.getMessage() for r in caplog.records)


def test_a_provider_that_returns_the_wrong_shape_is_a_degraded_entry():
    """A dict is the contract; anything else is named, not merged."""
    report_hooks._BUILTIN_PROVIDERS = (("wrong", lambda env=None: ["not", "a", "dict"], None),)
    # Plan 89-10: only the provider this case installs. The module providers
    # (PROVIDER_MODULES) are real reporters with rows of their own -- the
    # key-presence row always has one -- and this case is about the hook.
    report_hooks.PROVIDER_MODULES = ()
    section = report_hooks.extra_health_rows({})
    assert section[report_hooks.DEGRADED_KEY] == ["wrong: health_fragment must return a dict, got list"]


def test_a_provider_that_returns_none_contributes_nothing_and_is_not_degraded():
    """"Nothing to report" is a legal answer, and is not a failure."""
    report_hooks._BUILTIN_PROVIDERS = (("quiet", lambda env=None: None, lambda env=None: None),)
    # Plan 89-10: only the provider this case installs. The module providers
    # (PROVIDER_MODULES) are real reporters with rows of their own -- the
    # key-presence row always has one -- and this case is about the hook.
    report_hooks.PROVIDER_MODULES = ()
    assert report_hooks.extra_health_rows({}) == {}
    assert report_hooks.extra_doctor_rows({}) == []


def test_an_absent_provider_module_is_not_an_error():
    """doctor must still run on a partial install."""
    report_hooks.PROVIDER_MODULES = ("a_module_this_repo_does_not_have",)
    assert "cache" in report_hooks.extra_health_rows({})
    assert [r[1] for r in report_hooks.extra_doctor_rows({})] == ["cache"]


# ═══════════════════════════════════════════════════════════════════════════
# The first consumer: this plan's own cache-source row
# ═══════════════════════════════════════════════════════════════════════════

def test_the_cache_row_names_the_supplying_variable_with_the_url_masked():
    """A password-bearing legacy URL: the row names VALKEY_URL and masks the password."""
    env = {"VALKEY_URL": "redis://cacheuser:s3cr3t@cache.internal:6379/2"}
    fragment = report_hooks.extra_health_rows(env)["cache"]
    assert fragment == {
        "cache_url_source": "VALKEY_URL",
        "cache_url_masked": "redis://cacheuser:***@cache.internal:6379/2",
        "cache_url_canonical": "GSD_REDIS_URL",
    }
    assert "s3cr3t" not in json.dumps(fragment)

    # Plan 89-10: the cache provider's rows, by category. Other providers
    # (the key-presence row) report beside it and are not this case's subject.
    rows = [r for r in report_hooks.extra_doctor_rows(env) if r[1] == "cache"]
    assert len(rows) == 1
    status, category, detail, data = rows[0]
    assert (status, category) == (report_hooks.STATUS_OK, "cache")
    assert detail == (
        "redis://cacheuser:***@cache.internal:6379/2 from VALKEY_URL "
        "(canonical name is GSD_REDIS_URL)"
    )
    assert "s3cr3t" not in detail
    assert data == fragment


def test_the_cache_row_says_canonical_when_the_canonical_name_supplied_it():
    env = {"GSD_REDIS_URL": "redis://127.0.0.1:6380/0"}
    detail = report_hooks.extra_doctor_rows(env)[0][2]
    assert detail == "redis://127.0.0.1:6380/0 from GSD_REDIS_URL (canonical)"


def test_the_cache_row_is_never_a_warning():
    """Informational, so doctor's exit code does not move for a legacy name.

    The deprecation is warned once per process by the resolver itself; promoting
    it to a doctor WARN would take every install that still exports a legacy name
    from exit 0 to exit 1.
    """
    for env in ({}, {"GSD_REDIS_URL": "redis://a:1/0"}, {"REDIS_URL": "redis://d:4/0"},
                {"REDIS_HOST": "h", "REDIS_PORT": "1"}):
        assert report_hooks.extra_doctor_rows(env)[0][0] == report_hooks.STATUS_OK


# ═══════════════════════════════════════════════════════════════════════════
# Nothing else in either report moved
# ═══════════════════════════════════════════════════════════════════════════

def test_the_health_key_set_gained_exactly_one_key():
    """Every pre-existing /health key is still assigned, and only `extra` is new."""
    after = _health_keys()
    assert sorted(set(after) - set(HEALTH_KEYS_BEFORE)) == [report_hooks.HEALTH_SECTION]
    assert sorted(set(HEALTH_KEYS_BEFORE) - set(after)) == [], "a /health key disappeared"
    assert report_hooks.HEALTH_SECTION == "extra"


def test_the_doctor_check_list_is_unchanged():
    """No built-in check was added, removed or reordered; rows arrive via the hook."""
    assert _doctor_checks() == DOCTOR_CHECKS_BEFORE


def test_the_hook_runs_after_every_built_in_check():
    """The new rows land at the END of the table, so no existing row moves."""
    source = (_REPO / "services" / "doctor.py").read_text(encoding="utf-8")
    assert source.index("check_mobile()\n") < source.index("report_hooks.extra_doctor_rows()")
    assert source.index("report_hooks.extra_doctor_rows()") < source.index("    if opts[\"json\"]:")


def test_the_row_vocabulary_is_doctors_own():
    """report_hooks returns doctor's exact status strings, so the renderer is untouched."""
    doctor_source = (_REPO / "services" / "doctor.py").read_text(encoding="utf-8")
    for name, value in (("OK", report_hooks.STATUS_OK), ("WARN", report_hooks.STATUS_WARN),
                        ("FAIL", report_hooks.STATUS_FAIL)):
        assert '%s = "%s"' % (name, value) in doctor_source, (
            "services/doctor.py no longer declares %s = %r; report_hooks must follow it" % (name, value))


def test_the_contract_for_the_three_later_plans_is_written_down():
    """89-06, 89-08 and 89-10 arrive through the hooks and edit neither file."""
    contract = (_REPO / "services" / "report_hooks.py").read_text(encoding="utf-8")
    for plan in ("89-06", "89-08", "89-10"):
        assert plan in contract, "the contract must name plan %s and its row" % plan
    assert "lexical-engine row" in contract
    assert "embedding-catalogue row" in contract
    assert "key-presence rows" in contract
    assert "do not touch" in contract.lower()


def test_the_live_health_endpoint_still_returns_200_and_carries_the_section(fixture_daemon):
    """End to end, in the REAL daemon process: 200, every old key, and the new one.

    The failing-provider case above is asserted at the function level because
    `extra_health_rows()` is what decides: it catches every provider exception and
    returns a dict, so the handler below cannot be reached with an exception in
    flight. This case proves the positive half in the process that actually serves
    the endpoint — the hook is wired, not merely defined.
    """
    import urllib.request

    with urllib.request.urlopen("http://127.0.0.1:%d/health" % fixture_daemon.port, timeout=10) as response:
        assert response.status == 200
        body = json.loads(response.read().decode("utf-8"))

    assert report_hooks.HEALTH_SECTION in body, sorted(body)
    section = body[report_hooks.HEALTH_SECTION]
    assert report_hooks.DEGRADED_KEY not in section, section
    assert set(section["cache"]) == {"cache_url_source", "cache_url_masked", "cache_url_canonical"}
    assert section["cache"]["cache_url_canonical"] == "GSD_REDIS_URL"
    # every key the body carried before this plan is still there
    missing = [k for k in HEALTH_KEYS_BEFORE if k not in body]
    # the five conditional keys only appear in the state that produces them
    conditional = {"pg_health", "sqlite_health", "degraded_counts",
                   "pg_recovery_available", "pg_recovery_hint"}
    assert [k for k in missing if k not in conditional] == [], missing


def test_neither_report_file_grew_a_second_extension_point():
    """ONE hook each: a second one would re-open the collision this closes."""
    daemon = (_REPO / "services" / "amauta-daemon.py").read_text(encoding="utf-8")
    doctor = (_REPO / "services" / "doctor.py").read_text(encoding="utf-8")
    assert daemon.count("report_hooks.extra_health_rows()") == 1
    assert doctor.count("report_hooks.extra_doctor_rows()") == 1
