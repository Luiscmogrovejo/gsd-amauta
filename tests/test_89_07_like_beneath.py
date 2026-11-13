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

from services.rlm_search import like_beneath  # noqa: E402


class TestTheSeparatorIsNotAnEscape:
    """The defect itself, stated as the property that was false on Windows."""

    def test_a_windows_prefix_keeps_its_wildcard(self):
        """The trailing `%` must survive as a WILDCARD, not become a literal."""
        pattern = like_beneath("C:\\a\\b")
        assert pattern.endswith("%"), pattern
        assert not pattern.endswith("\\%"), (
            "the wildcard is escaped, so this pattern matches the literal string "
            "'C:\\a\\b%%' and nothing else -- the Windows defect: %r" % (pattern,)
        )

    def test_every_backslash_in_the_path_is_doubled(self):
        """A backslash must reach LIKE as a LITERAL backslash, not as an escape.

        The separator this function appends is the HOST's, so the tail differs
        by cell; what must hold everywhere is that the backslashes already in
        the caller's path are doubled and the final `%` is live.
        """
        pattern = like_beneath("C:\\a\\b")
        assert pattern.startswith("C:\\\\a\\\\b"), pattern
        assert pattern.endswith("%") and not pattern.endswith("\\%"), pattern
        if os.sep == "\\":
            assert pattern == "C:\\\\a\\\\b\\\\%"
        else:
            assert pattern == "C:\\\\a\\\\b" + os.sep + "%"

    def test_a_posix_prefix_is_unchanged_by_the_fix(self):
        """The behaviour the Linux and macOS cells already had stays identical."""
        assert like_beneath("/a/b") == "/a/b/%"
        assert like_beneath("/a/b/") == "/a/b/%"

    def test_a_trailing_separator_is_not_doubled(self):
        """`/a/b` and `/a/b/` describe the same directory.

        Only the HOST's separator is stripped, deliberately: a POSIX machine has
        no business reading a backslash as a directory separator, and the paths
        this filter sees are the ones `rlm_ingestion` stored on the same host.
        """
        joined = os.path.join("srv", "a", "b")
        assert like_beneath(joined) == like_beneath(joined + os.sep)


class TestTheCallersPathIsEscapedToo:
    """The second half of the same bug, which no platform was immune to."""

    def test_an_underscore_in_a_directory_name_is_escaped(self):
        """`_` is LIKE's single-character wildcard, so `a_b` matched `axb`."""
        pattern = like_beneath("/srv/a_b")
        assert "\\_" in pattern, pattern
        assert "a\\_b" in pattern

    def test_a_per_cent_in_a_directory_name_is_escaped(self):
        """`%` is LIKE's any-string wildcard; only the one we append may be live."""
        pattern = like_beneath("/srv/50%done")
        assert pattern.count("%") == 2, pattern          # the escaped one, and the wildcard
        assert "50\\%done" in pattern
        assert pattern.endswith("/%")

    def test_the_escape_character_itself_is_escaped_before_anything_else(self):
        """Order matters: escaping `%` first would then double its own backslash."""
        pattern = like_beneath("/srv/a\\b%c")
        assert pattern == "/srv/a\\\\b\\%c/%", pattern


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

        assert rlm_ingestion.like_beneath is rlm_search.like_beneath

    def test_the_pattern_is_a_pure_function_of_the_platform_separator(self):
        """The function uses `os.sep`, so it is right on whatever cell runs it."""
        pattern = like_beneath(os.path.join("srv", "a", "b"))
        assert pattern.endswith("%")
        assert not pattern.endswith("\\%")
        expected_sep = "\\\\" if os.sep == "\\" else os.sep
        assert pattern.endswith(expected_sep + "%"), (pattern, os.sep)
