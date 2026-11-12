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
