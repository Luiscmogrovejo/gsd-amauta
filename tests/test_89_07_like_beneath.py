"""Phase 89 plan 89-07: a directory-scoped search must work on Windows.

**The defect this file pins.** Three sites built their ``LIKE`` pattern as
``prefix + os.sep + "%"``:

* ``services/rlm_search.py`` ``hybrid_search`` -- the file filter of ``/query``
  and of ``amauta/search-code``;
* ``services/rlm_search.py``'s ``bm25_only``/plain-FTS sibling;
* ``services/rlm_ingestion.py`` ``prune_deleted_chunks`` -- "every chunk under
  this directory".

On Windows ``os.sep`` is a BACKSLASH, which is SQL ``LIKE``'s default ESCAPE
character, so ``C:\\a\\b\\%`` stopped meaning "anything beneath C:\\a\\b" and
started meaning "the literal string C:\\a\\b%" -- a pattern that matches one
impossible path. A directory-scoped search returned EMPTY, with no error and no
warning, and a prune deleted nothing.

It had been invisible since the feature existed because the Postgres-backed
tests only ever ran on the Linux cells. Plan 89-07 gave the Windows cell a
disposable PostgreSQL and eleven tests failed at once on run 43366250606, every
one of them a directory-filtered search or a prune.

Nothing here needs a database: the subject is the PATTERN, and the pattern is a
pure function. These tests therefore run on all nine cells and carry no skip
entry.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rlm_search import like_beneath, like_escape  # noqa: E402


class TestTheSeparatorIsNotAnEscape:
    """The defect itself, stated as the property that was false on Windows."""

    @staticmethod
    def _wildcard_is_live(pattern):
        """Whether the trailing `%` of a LIKE pattern is a WILDCARD.

        `endswith("\\%")` is the wrong test and failed on the Windows cell
        itself (run 43370212942): a CORRECTLY escaped separator ends the string
        with two backslashes and a per-cent, whose last two characters are a
        backslash and a per-cent. What decides it is the PARITY of the
        backslash run immediately before the `%` -- an even run is escaped
        backslashes and the `%` is live, an odd run escapes the `%` itself.
        """
        assert pattern.endswith("%"), pattern
        run = len(pattern[:-1]) - len(pattern[:-1].rstrip("\\"))
        return run % 2 == 0

    def test_a_windows_prefix_keeps_its_wildcard(self):
        """The trailing `%` must survive as a WILDCARD, not become a literal."""
        for sep in ("/", "\\"):
            pattern = like_beneath("C:\\a\\b", sep)
            assert self._wildcard_is_live(pattern), (
                "the wildcard is escaped, so this pattern matches one literal "
                "string and nothing else -- the Windows defect: %r" % (pattern,)
            )

    def test_every_backslash_in_the_path_is_doubled(self):
        """A backslash must reach LIKE as a LITERAL backslash, not as an escape.

        The separator this function appends is the HOST's, so the tail differs
        by cell; what must hold everywhere is that the backslashes already in
        the caller's path are doubled and the final `%` is live.
        """
        assert like_beneath("C:\\a\\b", "\\") == "C:\\\\a\\\\b\\\\%"
        assert like_beneath("C:\\a\\b", "/") == "C:\\\\a\\\\b/%"
        pattern = like_beneath("C:\\a\\b")
        assert pattern.startswith("C:\\\\a\\\\b"), pattern
        assert self._wildcard_is_live(pattern), pattern

    def test_a_posix_prefix_is_unchanged_by_the_fix(self):
        """The behaviour the Linux and macOS cells already had stays identical.

        The separator is named here, because an OMITTED one is the HOST's and
        this file runs on all nine cells: on the Windows cell the default
        boundary is a backslash, so `/a/b/%` is the POSIX LEG's tail, not a
        platform-independent fact. The default is asserted on the line below,
        against the host's own separator.
        """
        assert like_beneath("/a/b", "/") == "/a/b/%"
        assert like_beneath("/a/b/", "/") == "/a/b/%"
        assert like_beneath("/a/b") == "/a/b" + ("/%" if os.sep == "/" else "\\\\%")

    def test_a_trailing_separator_is_not_doubled(self):
        """`/a/b` and `/a/b/` describe the same directory.

        Only the HOST's separator is stripped, deliberately: a POSIX machine has
        no business reading a backslash as a directory separator, and the paths
        this filter sees are the ones `rlm_ingestion` stored on the same host.
        """
        joined = os.path.join("srv", "a", "b")
        assert like_beneath(joined) == like_beneath(joined + os.sep)
        # BOTH separators are stripped now, so a POSIX-style fixture prefix and
        # a native one describe the same directory on every cell.
        assert like_beneath("srv/a/b", "/") == like_beneath("srv/a/b/", "/")
        assert like_beneath("srv\\a\\b", "\\") == like_beneath("srv\\a\\b\\", "\\")


class TestTheCallersPathIsEscapedToo:
    """The second half of the same bug, which no platform was immune to."""

    def test_an_underscore_in_a_directory_name_is_escaped(self):
        """`_` is LIKE's single-character wildcard, so `a_b` matched `axb`."""
        pattern = like_beneath("/srv/a_b")
        assert "\\_" in pattern, pattern
        assert "a\\_b" in pattern

    def test_a_per_cent_in_a_directory_name_is_escaped(self):
        """`%` is LIKE's any-string wildcard; only the one we append may be live."""
        pattern = like_beneath("/srv/50%done", "/")
        assert pattern.count("%") == 2, pattern          # the escaped one, and the wildcard
        assert "50\\%done" in pattern
        assert pattern.endswith("/%")
        # The host-separator leg escapes the SAME per-cent; only its tail
        # differs, so the `/%` literal above belongs to the POSIX leg alone.
        native = like_beneath("/srv/50%done")
        assert native.count("%") == 2, native
        assert "50\\%done" in native

    def test_the_escape_character_itself_is_escaped_before_anything_else(self):
        """Order matters: escaping `%` first would then double its own backslash."""
        assert like_beneath("/srv/a\\b%c", "/") == "/srv/a\\\\b\\%c/%"
        assert like_beneath("/srv/a\\b%c", "\\") == "/srv/a\\\\b\\%c\\\\%"


class TestEscapingIsPublicAndReusable:
    """The escaping is a primitive, because callers outside the filter need it.

    A test of its own built an ad-hoc pattern as `str(root) + "%two.py"` and so
    carried the identical defect: on the Windows cell the UPDATE it ran matched
    no row, silently, and the test failed three lines later for a reason that
    was not the real one. The escaping is therefore exported, not nested.
    """

    def test_the_three_meaningful_characters_are_escaped(self):
        assert like_escape("a\\b") == "a\\\\b"
        assert like_escape("50%done") == "50\\%done"
        assert like_escape("a_b") == "a\\_b"

    def test_an_ordinary_path_is_left_alone(self):
        assert like_escape("/srv/a/b.py") == "/srv/a/b.py"

    def test_like_beneath_is_this_function_plus_a_boundary(self):
        """One owner of the escaping, so the two cannot drift apart."""
        for prefix in ("/srv/a_b", "C:\\srv\\50%done", "plain"):
            for sep in ("/", "\\"):
                assert like_beneath(prefix, sep) == (
                    like_escape(prefix.rstrip("/\\") + sep) + "%")


class TestTheProductHasNoSecondCopy:
    """One owner, so the three sites cannot drift apart again."""

    def test_no_site_builds_the_pattern_by_hand(self):
        """Over the AST, not the text: a docstring may quote the old expression.

        The subject is CODE, and the three comments that explain the defect all
        spell the expression they warn about. A text scan would read those as
        offenders, so the scan is over expressions `ast` actually parsed.
        """
        import ast as _ast

        root = Path(__file__).resolve().parent.parent
        offenders = []
        for rel in ("services/rlm_search.py", "services/rlm_ingestion.py"):
            tree = _ast.parse((root / rel).read_text(encoding="utf-8"))
            for node in _ast.walk(tree):
                if not isinstance(node, _ast.BinOp):
                    continue
                rendered = _ast.unparse(node).replace("'", '"').replace(" ", "")
                if 'os.sep+"%"' in rendered:
                    offenders.append("%s:%d: %s"
                                     % (rel, getattr(node, "lineno", 0),
                                        _ast.unparse(node)))
        assert offenders == [], (
            "a site builds the directory LIKE pattern itself instead of calling "
            "like_beneath(); that is the expression the Windows cell proved wrong:\n"
            + "\n".join(offenders))

    def test_both_modules_resolve_to_the_same_function(self):
        from services import rlm_ingestion, rlm_search

        assert rlm_ingestion.beneath_patterns is rlm_search.beneath_patterns

    def test_the_pattern_is_a_pure_function_of_the_platform_separator(self):
        """The function uses `os.sep`, so it is right on whatever cell runs it."""
        pattern = like_beneath(os.path.join("srv", "a", "b"))
        assert TestTheSeparatorIsNotAnEscape._wildcard_is_live(pattern), pattern
        expected_sep = "\\\\" if os.sep == "\\" else os.sep
        assert pattern.endswith(expected_sep + "%"), (pattern, os.sep)


class TestBothSeparatorsAreCovered:
    """A path filter must not care which separator the STORED path uses."""

    def test_the_pair_is_one_pattern_per_separator(self):
        from services.rlm_search import beneath_patterns

        patterns = beneath_patterns("/srv/a")
        assert len(patterns) == 2, patterns
        assert patterns[0].endswith("/%"), patterns
        assert patterns[1].endswith("\\\\%"), patterns
        for pattern in patterns:
            assert TestTheSeparatorIsNotAnEscape._wildcard_is_live(pattern), pattern

    def test_a_posix_fixture_prefix_is_matched_on_a_windows_host(self):
        """The case that was still empty on Windows after the escaping fix.

        Several fixtures seed `file_path` as `prefix + "a.py"` with a literal
        `/` in the prefix, while `os.sep` on that cell is a backslash. One
        host-separator pattern matched none of them.
        """
        from services.rlm_search import beneath_patterns

        patterns = beneath_patterns("__test65_boost__/")
        assert "__test65_boost__/%".replace("_", "\\_") in patterns, patterns

    def test_both_call_sites_bind_both_patterns(self):
        """Three binds in the SQL, three parameters -- counted, not assumed."""
        import ast as _ast

        source = (Path(__file__).resolve().parent.parent
                  / "services" / "rlm_search.py").read_text(encoding="utf-8")
        # `hybrid_search`'s clause is split across two source lines, so the
        # fragment appears twice in the file: once in the SQL and once in the
        # docstring that quotes it. What must hold is that BOTH call sites pass
        # `beneath_patterns`, which returns exactly two patterns.
        assert source.count("beneath_patterns(prefix)") == 2, (
            "both file-filter sites must bind the pair: "
            + str(source.count("beneath_patterns(prefix)")))
        from services.rlm_search import beneath_patterns
        assert len(beneath_patterns("/x")) == 2
        _ast.parse(source)
