"""The ``.env`` loader the four entry points carry (Phase 88, plan 88-11 task 04).

This file is in two halves.

**Characterisation** — what the loader does OUTSIDE test mode, pinned before
anything was changed. The live daemon runs under launchd with no test-mode
variable in its environment and depends on this behaviour: the repository root
``.env`` is read, a variable that is already set always wins, comments and blank
lines are skipped, and one layer of quotes comes off. Each of these ran green on
946c5c3 (origin/master) before the guard below existed, and runs green after.

**The guard** — what the loader does INSIDE a test session: nothing. Four
entry points call ``_load_dotenv()`` at import time, so on the operator's
machine (the only checkout with a repository-root ``.env``) importing any of
them re-injected the live DSN, the live daemon and RLM ports and the API keys
into an environment ``tests/conftest.py`` had just scrubbed, which is how
``tests/test_88_hermetic_guard.py``, ``tests/test_88_pgsql_import_hermetic.py``
and ``tests/test_88_rlm_port_safety.py`` came to fail there and nowhere else.

Every case drives the REAL source of each entry point, copied into a temporary
tree with its own sentinel ``.env`` (see ``tests/support/dotenv_probe.py``).
The repository's own ``.env`` is never read, written or copied.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "support"))

import dotenv_probe  # noqa: E402
from dotenv_probe import ENTRY_POINTS  # noqa: E402


def _keys_env(keys):
    """A child environment with every name in ``keys`` removed.

    Args:
        keys: names the case asserts on, so a value can only come from a
            ``.env`` the probe wrote.

    Returns:
        dict: the child's environment.
    """
    return dotenv_probe.child_env(**{key: None for key in keys})


# ═══════════════════════════════════════════════════════════════════════════
# Characterisation: the behaviour outside test mode, unchanged by this plan
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_outside_test_mode_the_repo_root_env_is_read(tmp_path, rel):
    """Every entry point reads the ``.env`` beside the repository root."""
    target = dotenv_probe.build_tree(tmp_path, rel)
    got = dotenv_probe.probe(target)
    assert got == {
        "GSD_DOTENV_SENTINEL": "leaked-from-dotenv",
        "GSD_POSTGRES_URL": "postgresql://sentinel@127.0.0.1:1/none",
        "VOYAGE_API_KEY": "sentinel-not-a-real-key",
    }


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_outside_test_mode_an_already_set_variable_wins(tmp_path, rel):
    """A name already in the environment is never overridden by the file."""
    target = dotenv_probe.build_tree(tmp_path, rel)
    env = dotenv_probe.child_env(GSD_DOTENV_SENTINEL="from-the-environment")
    got = dotenv_probe.probe(target, env=env)
    assert got["GSD_DOTENV_SENTINEL"] == "from-the-environment"
    # and the names that were NOT already set still come from the file
    assert got["VOYAGE_API_KEY"] == "sentinel-not-a-real-key"


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_outside_test_mode_comments_blanks_and_bare_lines_are_skipped(tmp_path, rel):
    """A comment, a blank line and a line without ``=`` are each skipped.

    They are skipped individually — not treated as the end of the file — so a
    key below them still loads.
    """
    keys = ("GSD_DOTENV_IN_COMMENT", "GSD_DOTENV_BARE_LINE", "GSD_DOTENV_SENTINEL")
    target = dotenv_probe.build_tree(
        tmp_path,
        rel,
        env_text=(
            "# GSD_DOTENV_IN_COMMENT=commented-out\n"
            "   # an indented comment\n"
            "\n"
            "   \n"
            "GSD_DOTENV_BARE_LINE\n"
            "GSD_DOTENV_SENTINEL=below-the-junk\n"
        ),
    )
    got = dotenv_probe.probe(target, keys=keys, env=_keys_env(keys))
    assert got == {
        "GSD_DOTENV_IN_COMMENT": None,
        "GSD_DOTENV_BARE_LINE": None,
        "GSD_DOTENV_SENTINEL": "below-the-junk",
    }


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_outside_test_mode_quoting_and_whitespace_rules(tmp_path, rel):
    """One layer of quotes comes off; the parser's exact rules, pinned.

    The quote stripping is ``strip("'\\"")`` applied after ``strip()``, which
    is why a value quoted on one side only loses that one character, why inner
    whitespace inside quotes survives, and why an empty value becomes an empty
    string rather than being skipped. None of that is obviously right — it is
    simply what the live daemon has been running, so it is what gets pinned.
    """
    keys = (
        "GSD_DOTENV_DQ",
        "GSD_DOTENV_SQ",
        "GSD_DOTENV_PADDED",
        "GSD_DOTENV_INNER_EQUALS",
        "GSD_DOTENV_INNER_SPACES",
        "GSD_DOTENV_HALF_QUOTED",
        "GSD_DOTENV_PADDED_KEY",
        "GSD_DOTENV_EMPTY",
    )
    target = dotenv_probe.build_tree(
        tmp_path,
        rel,
        env_text=(
            'GSD_DOTENV_DQ="double"\n'
            "GSD_DOTENV_SQ='single'\n"
            "GSD_DOTENV_PADDED=   padded   \n"
            "GSD_DOTENV_INNER_EQUALS=a=b=c\n"
            'GSD_DOTENV_INNER_SPACES="  kept  "\n'
            "GSD_DOTENV_HALF_QUOTED=\"mixed'\n"
            "GSD_DOTENV_PADDED_KEY  =  value\n"
            "GSD_DOTENV_EMPTY=\n"
        ),
    )
    got = dotenv_probe.probe(target, keys=keys, env=_keys_env(keys))
    assert got == {
        "GSD_DOTENV_DQ": "double",
        "GSD_DOTENV_SQ": "single",
        "GSD_DOTENV_PADDED": "padded",
        "GSD_DOTENV_INNER_EQUALS": "a=b=c",
        "GSD_DOTENV_INNER_SPACES": "  kept  ",
        "GSD_DOTENV_HALF_QUOTED": "mixed",
        "GSD_DOTENV_PADDED_KEY": "value",
        "GSD_DOTENV_EMPTY": "",
    }


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_outside_test_mode_a_tree_without_an_env_file_injects_nothing(tmp_path, rel):
    """No ``.env`` beside the root means nothing is injected.

    Only the sentinel-only name is asserted: the loader's second candidate is
    ``/srv/amauta/.env``, the deployment's own file, and a machine that has one
    may legitimately set ``GSD_POSTGRES_URL`` from it. Nothing anywhere sets
    ``GSD_DOTENV_SENTINEL`` but this test's own fixtures.
    """
    target = dotenv_probe.build_tree(tmp_path, rel, env_text=None)
    assert not (tmp_path / ".env").exists()
    got = dotenv_probe.probe(target, keys=("GSD_DOTENV_SENTINEL",))
    assert got == {"GSD_DOTENV_SENTINEL": None}


def test_the_probe_itself_would_notice_a_module_that_died_early(tmp_path):
    """The probe fails loudly when the child never reaches the loader.

    Without this, every "nothing was injected" assertion above could pass
    because the child crashed on line one. The probe asserts the report was
    printed; this drives a file that cannot possibly print one.
    """
    broken = tmp_path / "broken.py"
    # os._exit takes the interpreter down past every handler, so no report can
    # be printed. A plain `raise` would not: the child reports whatever the
    # environment held when the module stopped, which is the whole point.
    broken.write_text("import os\nos._exit(3)\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="printed no report"):
        dotenv_probe.probe(broken, keys=("GSD_DOTENV_SENTINEL",))


def test_the_probe_stops_at_the_first_foreign_import(tmp_path):
    """The stop cannot be swallowed by the product's optional-import guards."""
    target = tmp_path / "swallows.py"
    target.write_text(
        "import os\n"
        "os.environ['GSD_DOTENV_SENTINEL'] = 'set-before-the-import'\n"
        "try:\n"
        "    import a_module_that_does_not_exist\n"
        "except ImportError:\n"
        "    os.environ['GSD_DOTENV_SENTINEL'] = 'the-stop-was-swallowed'\n"
        "except Exception:\n"
        "    os.environ['GSD_DOTENV_SENTINEL'] = 'the-stop-was-swallowed'\n",
        encoding="utf-8",
    )
    got = dotenv_probe.probe(target, keys=("GSD_DOTENV_SENTINEL",))
    assert got == {"GSD_DOTENV_SENTINEL": "set-before-the-import"}


def test_no_case_here_builds_a_path_to_the_repository_env():
    """A guard on the test files themselves, not on the product.

    The operator's ``.env`` holds live credentials and the live service ports.
    These tests work from sentinel files in temporary trees, and this asserts
    neither of them can quietly grow a case that points at the real one.
    """
    # Composed rather than written out, so this test does not match itself.
    root = "REPO"
    forbidden = [
        root + ' / ".env"',
        root + " / '.env'",
        root + ', ".env"',
        root + '.joinpath(".env")',
    ]
    for source_file in (Path(__file__), Path(dotenv_probe.__file__)):
        source = source_file.read_text(encoding="utf-8")
        for token in forbidden:
            assert token not in source, "%s builds a path to the real .env: %s" % (
                source_file.name,
                token,
            )


# ═══════════════════════════════════════════════════════════════════════════
# The guard: inside a test session the loader reads nothing
# ═══════════════════════════════════════════════════════════════════════════

#: Truthy spellings of ``GSD_TEST_MODE``. The same set
#: ``get-shit-done/bin/gsd-amauta.cjs`` has always accepted (``/^(1|true|yes|on)$/i``).
TEST_MODE_ON = ("1", "true", "TRUE", "yes", "on")

#: Spellings that are NOT test mode. A loader that treated these as "on" would
#: stop reading .env for a user who set ``GSD_TEST_MODE=0``.
TEST_MODE_OFF = ("0", "false", "off", "")


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_in_test_mode_nothing_is_read(tmp_path, rel):
    """THE DEFECT. In test mode the loader reads no ``.env`` at all.

    Red on 946c5c3 for all four entry points: each returned the sentinel DSN,
    the sentinel key and the sentinel marker, which on the operator's machine
    were the live DSN, a live API key and the live ports.
    """
    target = dotenv_probe.build_tree(tmp_path, rel)
    assert (tmp_path / ".env").is_file(), "the sentinel file must exist, or this proves nothing"
    got = dotenv_probe.probe(target, env=dotenv_probe.child_env(GSD_TEST_MODE="1"))
    assert got == {"GSD_DOTENV_SENTINEL": None, "GSD_POSTGRES_URL": None, "VOYAGE_API_KEY": None}


@pytest.mark.parametrize("spelling", TEST_MODE_ON)
def test_every_truthy_spelling_of_test_mode_suppresses_the_read(tmp_path, spelling):
    """``1``, ``true``, ``TRUE``, ``yes`` and ``on`` all mean test mode."""
    target = dotenv_probe.build_tree(tmp_path, "services/amauta-daemon.py")
    got = dotenv_probe.probe(target, env=dotenv_probe.child_env(GSD_TEST_MODE=spelling))
    assert got["GSD_DOTENV_SENTINEL"] is None, "GSD_TEST_MODE=%r did not suppress" % spelling


@pytest.mark.parametrize("spelling", TEST_MODE_OFF)
def test_a_falsy_spelling_of_test_mode_is_not_test_mode(tmp_path, spelling):
    """``0``, ``false``, ``off`` and empty are not test mode: the file is read.

    The guard must not become a second way to switch the loader off for a user
    who writes ``GSD_TEST_MODE=0`` in their shell profile.
    """
    target = dotenv_probe.build_tree(tmp_path, "services/amauta-daemon.py")
    got = dotenv_probe.probe(target, env=dotenv_probe.child_env(GSD_TEST_MODE=spelling))
    assert got["GSD_DOTENV_SENTINEL"] == "leaked-from-dotenv"


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_pytest_alone_suppresses_the_read(tmp_path, rel):
    """``PYTEST_CURRENT_TEST`` suppresses it even with no ``GSD_TEST_MODE``.

    This is not belt-and-braces: ``tests/test_88_rlm_port_safety.py`` DELETES
    ``GSD_TEST_MODE`` before importing the daemon (the incident it covers is a
    daemon on a non-default port), so that one test would have gone on reading
    the operator's file if test mode were the only marker. pytest sets this
    name for the duration of every test item, and nothing but pytest sets it.
    """
    target = dotenv_probe.build_tree(tmp_path, rel)
    env = dotenv_probe.child_env(PYTEST_CURRENT_TEST="tests/test_x.py::test_y (call)")
    got = dotenv_probe.probe(target, env=env)
    assert got == {"GSD_DOTENV_SENTINEL": None, "GSD_POSTGRES_URL": None, "VOYAGE_API_KEY": None}


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_an_explicit_file_is_the_one_opt_in(tmp_path, rel):
    """``GSD_DOTENV_PATH`` names one file, and it is the only file read.

    The opt-in exists so the loader's own tests can drive the parser in test
    mode. It does not re-open the ambient candidates: the tree's ``.env`` is
    still ignored.
    """
    target = dotenv_probe.build_tree(tmp_path, rel)
    # Plan 89-10: the named file is the managed keys file, so it is written
    # owner-only -- a group- or world-accessible one is refused.
    explicit = dotenv_probe.write_owner_only(
        tmp_path / "explicit.env", "GSD_DOTENV_EXPLICIT=from-the-explicit-file\n")
    env = dotenv_probe.child_env(GSD_TEST_MODE="1", GSD_DOTENV_PATH=str(explicit))
    env.pop("GSD_DOTENV_EXPLICIT", None)
    got = dotenv_probe.probe(
        target, keys=("GSD_DOTENV_EXPLICIT", "GSD_DOTENV_SENTINEL"), env=env
    )
    assert got == {
        "GSD_DOTENV_EXPLICIT": "from-the-explicit-file",
        "GSD_DOTENV_SENTINEL": None,
    }


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_an_explicit_file_that_does_not_exist_is_not_an_error(tmp_path, rel):
    """A missing ``GSD_DOTENV_PATH`` loads nothing and raises nothing."""
    target = dotenv_probe.build_tree(tmp_path, rel)
    env = dotenv_probe.child_env(
        GSD_TEST_MODE="1", GSD_DOTENV_PATH=str(tmp_path / "no-such-file.env")
    )
    got = dotenv_probe.probe(target, env=env)
    assert got == {"GSD_DOTENV_SENTINEL": None, "GSD_POSTGRES_URL": None, "VOYAGE_API_KEY": None}


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_the_explicit_file_wins_outside_test_mode_too(tmp_path, rel):
    """Outside test mode ``GSD_DOTENV_PATH`` is read FIRST, and wins.

    PLAN 89-10 CHANGED THIS ON PURPOSE. Until then this case was
    ``test_the_opt_in_is_ignored_outside_test_mode`` and asserted the opposite:
    the variable was a test hook only. The launchd daemon is now given its keys
    by naming one owner-only file in ``GSD_DOTENV_PATH``, so the variable has to
    work in production -- "an explicit path always wins".

    What did NOT change, and is still asserted: the legacy candidate is read
    exactly as the characterisation half pinned it. The explicit file is a layer
    in front of ``<root>/.env``, so a name only the tree's ``.env`` defines still
    arrives, and a name both define comes from the explicit file.
    """
    target = dotenv_probe.build_tree(tmp_path, rel)
    explicit = dotenv_probe.write_owner_only(
        tmp_path / "explicit.env",
        "GSD_DOTENV_EXPLICIT=from-the-explicit-file\n"
        "VOYAGE_API_KEY=explicit-not-a-real-key\n",
    )
    env = dotenv_probe.child_env(GSD_DOTENV_PATH=str(explicit))
    env.pop("GSD_DOTENV_EXPLICIT", None)
    got = dotenv_probe.probe(
        target, keys=("GSD_DOTENV_EXPLICIT", "GSD_DOTENV_SENTINEL", "VOYAGE_API_KEY"), env=env
    )
    assert got == {
        "GSD_DOTENV_EXPLICIT": "from-the-explicit-file",
        "GSD_DOTENV_SENTINEL": "leaked-from-dotenv",
        "VOYAGE_API_KEY": "explicit-not-a-real-key",
    }


# ═══════════════════════════════════════════════════════════════════════════
# The harness: test mode is on BEFORE any product import or spawn
# ═══════════════════════════════════════════════════════════════════════════

#: Recorded while this module is being IMPORTED, which pytest does during
#: collection — before the session fixture in tests/conftest.py runs. A product
#: module imported at the top of a test file (several are) loads at exactly
#: this moment, so the guard is only reachable if conftest has already set the
#: name by then.
_TEST_MODE_AT_COLLECTION = os.environ.get("GSD_TEST_MODE")


def test_conftest_sets_test_mode_before_collection():
    """``GSD_TEST_MODE`` is set at conftest IMPORT, not only in the fixture.

    The session fixture sets it too, but fixtures run after collection, and
    collection is when a test module's own top-level ``import`` of a product
    entry point fires.
    """
    assert _TEST_MODE_AT_COLLECTION == "1", (
        "GSD_TEST_MODE was %r while this module was being collected; a product "
        "module imported at collection time would have read the operator's .env"
        % (_TEST_MODE_AT_COLLECTION,)
    )


def test_sitecustomize_sets_test_mode_for_a_child_that_lacks_it():
    """A Python child on the support PYTHONPATH gets test mode, even if the
    parent's environment somehow lost it.

    ``tests/support/pythonpath/sitecustomize.py`` is on PYTHONPATH for every
    Python child the Node suite spawns. It already arms the socket guard there;
    arming test mode in the same place closes the same hole for the loader.
    """
    import subprocess

    env = dotenv_probe.child_env()
    env.pop("GSD_TEST_MODE", None)
    support = dotenv_probe.REPO / "tests" / "support" / "pythonpath"
    env["PYTHONPATH"] = str(support) + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-c", "import os;print(os.environ.get('GSD_TEST_MODE'))"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        env=env,
    )
    assert proc.stdout.strip() == "1", (
        "a child on the support PYTHONPATH reported GSD_TEST_MODE=%r\n--- stderr ---\n%s"
        % (proc.stdout.strip(), proc.stderr)
    )


# ═══════════════════════════════════════════════════════════════════════════
# The four copies, and the two other places a .env is read
# ═══════════════════════════════════════════════════════════════════════════

#: First line of the part that must be identical in all four entry points. Plan
#: 89-09 task 03 moved the loader itself into services/_dotenv.py; what is still
#: copied four times is the six-line PRELUDE that loads it by path, and that is
#: what must not drift now.
_BLOCK_START = "_dotenv_spec = importlib.util.spec_from_file_location("

#: The call that ends it, at column 0.
_BLOCK_END = "\n_dotenv.load_dotenv(_DOTENV_ROOT, _DOTENV_EXTRA_SKIP)"

#: The ONE module that defines the loader.
_LOADER_REL = "services/_dotenv.py"

#: The loader's function names, as they are defined in :data:`_LOADER_REL`.
_LOADER_DEFS = ("def dotenv_suppressed(", "def load_dotenv(")


def _canonical_block(rel):
    """The shared loader PRELUDE out of one entry point.

    Args:
        rel: one of :data:`ENTRY_POINTS`.

    Returns:
        str: everything from the ``spec_from_file_location`` call to the
        module-level ``_dotenv.load_dotenv(...)`` call, inclusive.

    Raises:
        AssertionError: when the markers are missing or appear twice, which
            means the extraction is no longer reading the whole prelude.
    """
    source = (dotenv_probe.REPO.joinpath(*rel.split("/"))).read_text(encoding="utf-8")
    assert source.count(_BLOCK_START) == 1, "%s: %d copies of %r" % (
        rel, source.count(_BLOCK_START), _BLOCK_START)
    assert source.count(_BLOCK_END) == 1, "%s: %d copies of the module-level call" % (
        rel, source.count(_BLOCK_END))
    start = source.index(_BLOCK_START)
    end = source.index(_BLOCK_END, start) + len(_BLOCK_END)
    return source[start:end]


def test_services_dotenv_is_the_only_definition_of_the_loader():
    """ONE definition, in services/_dotenv.py (plan 89-09 task 03).

    Until then the loader was four byte-identical forty-line copies and this
    file compared them, so the drift it prevented (three of four updated) was
    DETECTED rather than impossible. It is impossible now: the functions exist
    in one file and the entry points load that file. Two of the four are
    byte-pinned by the canaries, so this is also what makes a later change to
    the loader cost zero re-baselines instead of up to four.
    """
    loader = (dotenv_probe.REPO / _LOADER_REL).read_text(encoding="utf-8")
    for definition in _LOADER_DEFS:
        assert loader.count(definition) == 1, "%s defines %r %d times" % (
            _LOADER_REL, definition, loader.count(definition))
    for rel in ENTRY_POINTS:
        source = (dotenv_probe.REPO.joinpath(*rel.split("/"))).read_text(encoding="utf-8")
        for definition in _LOADER_DEFS:
            assert definition not in source, (
                "%s defines %r itself; the loader has ONE definition, in %s"
                % (rel, definition, _LOADER_REL))
        # the pre-89-09 private names are gone from the entry points entirely
        assert "def _dotenv_suppressed(" not in source, rel
        assert "def _load_dotenv(" not in source, rel


def test_the_four_preludes_that_load_it_are_byte_identical():
    """Each entry point loads the module by PATH, and the six lines that do it
    may not drift.

    The loader cannot be a plain ``import``: services/amauta-daemon.py,
    services/rlm-service.py and services/amauta-mcp.py all run it BEFORE their
    own imports are resolved, and amauta.py is at the repository root while the
    module is in services/. A ``spec_from_file_location`` load needs no
    ``sys.path`` manipulation and behaves identically from either directory.
    Everything that differs per file lives in the two constants above the
    prelude (``_DOTENV_ROOT``, ``_DOTENV_EXTRA_SKIP``).
    """
    blocks = {rel: _canonical_block(rel) for rel in ENTRY_POINTS}
    reference = blocks[ENTRY_POINTS[0]]
    for rel, block in blocks.items():
        if block != reference:
            import difflib

            diff = "".join(
                difflib.unified_diff(
                    reference.splitlines(keepends=True),
                    block.splitlines(keepends=True),
                    fromfile=ENTRY_POINTS[0],
                    tofile=rel,
                )
            )
            raise AssertionError("the loader preludes have drifted:\n" + diff)
    # and the block really is the prelude, not an empty match
    assert "gsd_dotenv" in reference
    assert "services" in reference and "_dotenv.py" in reference
    assert "exec_module" in reference
    assert "_dotenv.load_dotenv(_DOTENV_ROOT, _DOTENV_EXTRA_SKIP)" in reference
    # no sys.path manipulation was smuggled in
    assert "sys.path" not in reference


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_the_prelude_is_load_bearing_without_the_module_nothing_is_read(tmp_path, rel):
    """A tree WITHOUT services/_dotenv.py reads no .env — the mutation proof.

    Without this case the four preludes could be dead code and every
    characterisation case above would still pass for the wrong reason.
    """
    target = dotenv_probe.build_tree(tmp_path, rel, loader=False)
    report = dotenv_probe.probe(target, env=_keys_env(dotenv_probe.SENTINEL_KEYS))
    assert report["GSD_DOTENV_SENTINEL"] is None, (
        "the entry point read a .env with no loader module present, so the prelude "
        "is not what reads it"
    )


@pytest.mark.parametrize("rel", ENTRY_POINTS)
def test_each_copy_declares_the_two_per_file_names(rel):
    """Each entry point declares its own root and its own extra skip names."""
    source = (dotenv_probe.REPO.joinpath(*rel.split("/"))).read_text(encoding="utf-8")
    assert source.count("_DOTENV_ROOT = ") == 1, rel
    assert source.count("_DOTENV_EXTRA_SKIP = ") == 1, rel
    # amauta.py keeps the extra name it has always had; the services have none.
    expected = '("GSD_AMAUTA_NO_AUTO_START",)' if rel == "amauta.py" else "()"
    assert "_DOTENV_EXTRA_SKIP = " + expected in source, rel


def _load_amauta():
    """Import ``amauta.py`` in-process under a unique module name.

    Returns:
        module: the freshly executed module.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "amauta_88_11_dotenv", str(dotenv_probe.REPO / "amauta.py")
    )
    mod = importlib.util.module_from_spec(spec)
    services = str(dotenv_probe.REPO / "services")
    sys.path.insert(0, services)
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(services)
    return mod


def test_the_memory_dsn_does_not_fall_back_to_a_deployment_env_in_test_mode(
    monkeypatch, tmp_path
):
    """``amauta.py`` reads ``/srv/amauta/.env`` for the memory DSN too.

    That is a second ``.env`` reader in the same file, reached at call time
    rather than import time, and it must answer a test session the same way:
    the environment, or nothing.
    """
    deployment = tmp_path / "deployment.env"
    deployment.write_text(
        "AMAUTA_MEMORY_DATABASE_URL=postgresql://sentinel@127.0.0.1:1/none\n"
        "GSD_POSTGRES_URL=postgresql://sentinel@127.0.0.1:1/none\n",
        encoding="utf-8",
    )
    mod = _load_amauta()
    monkeypatch.setattr(mod, "_MEM_ENV_FILE", str(deployment))
    monkeypatch.delenv("AMAUTA_MEMORY_DATABASE_URL", raising=False)
    monkeypatch.delenv("GSD_POSTGRES_URL", raising=False)
    monkeypatch.delenv("AMAUTA_MEMORY_BACKEND", raising=False)

    monkeypatch.setenv("GSD_TEST_MODE", "1")
    assert mod._mem_db_url() == ""
    assert mod._mem_backend() == ""
    assert mod._mem_pg_available() is False

    # The control: with every test marker gone the fallback still works, so
    # the assertions above are about the guard and not about a missing file.
    monkeypatch.delenv("GSD_TEST_MODE", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("GSD_AMAUTA_NO_AUTO_START", raising=False)
    assert mod._mem_db_url() == "postgresql://sentinel@127.0.0.1:1/none"
    assert mod._mem_backend() == "postgres"


def test_the_backfill_script_does_not_read_the_repo_env_in_test_mode(monkeypatch, tmp_path):
    """``scripts/backfill-project-id.py`` resolves its DSN from a .env as well."""
    import importlib.util

    (tmp_path / ".env").write_text(
        "GSD_POSTGRES_URL=postgresql://sentinel@127.0.0.1:1/none\n", encoding="utf-8"
    )
    spec = importlib.util.spec_from_file_location(
        "backfill_88_11_dotenv", str(dotenv_probe.REPO / "scripts" / "backfill-project-id.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    for name in ("GSD_POSTGRES_URL", "AMAUTA_MEMORY_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setenv("GSD_TEST_MODE", "1")
    assert mod._pg_url() is None

    monkeypatch.delenv("GSD_TEST_MODE", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    assert mod._pg_url() == "postgresql://sentinel@127.0.0.1:1/none"
