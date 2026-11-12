"""Platform differences in one place (Phase 88, plans 88-13 and 88-15).

Nothing here may change POSIX behaviour. Every function is a no-op on a platform that
already behaves correctly, and the Windows branch is strictly additive.

Importable both as ``from _platform import setup_stdio`` (when ``services/`` is on
``sys.path``, which every entry point arranges first) and as
``from services._platform import setup_stdio``.
"""
import io
import sys

__all__ = ["setup_stdio"]


def _is_utf8(stream) -> bool:
    """Report whether a stream already encodes as UTF-8.

    The encoding name is lower-cased and every ``-`` and ``_`` is removed; after that
    reduction the only string that counts as UTF-8 is ``utf8``. That covers ``utf-8``,
    ``UTF-8``, ``utf_8`` and ``UTF8`` with one comparison.

    Args:
        stream: Any text stream; an object without an ``encoding`` attribute is not UTF-8.

    Returns:
        bool: True when the stream's encoding normalises to ``utf8``.
    """
    name = getattr(stream, "encoding", "") or ""
    return str(name).lower().replace("-", "").replace("_", "") == "utf8"


def _reconfigure(stream, replace_name=None) -> bool:
    """Make one stream UTF-8, never raising.

    Args:
        stream: The stream to convert.
        replace_name: ``"stdout"`` or ``"stderr"`` when the stream is the live ``sys``
            attribute, so the fallback path can rebind it; None otherwise.

    Returns:
        bool: True when the stream was reconfigured or replaced.
    """
    try:
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")
            return True
        buffer = getattr(stream, "buffer", None)
        if buffer is not None and replace_name:
            wrapper = io.TextIOWrapper(
                buffer,
                encoding="utf-8",
                errors="backslashreplace",
                line_buffering=bool(getattr(stream, "line_buffering", False)),
            )
            setattr(sys, replace_name, wrapper)
            return True
    except Exception:  # closed stream, detached buffer, a test double: leave it alone
        return False
    return False


def setup_stdio(streams=None) -> bool:
    """Make stdout and stderr UTF-8 when they are not already.

    Windows uses the ANSI code page (cp1252) for a piped stdout, so printing U+25CB
    raises UnicodeEncodeError. Reconfigure only when the stream's encoding is not
    already a UTF-8 alias: on Linux and macOS it is, so this returns False and not one
    byte of output changes. A character that still cannot be encoded degrades to a
    visible backslash escape instead of killing the process. stdin is never touched.

    Args:
        streams: Iterable of streams to convert. None means ``sys.stdout`` and
            ``sys.stderr``. Tests pass their own wrappers.

    Returns:
        bool: True when at least one stream was reconfigured.

    Example:
        if __name__ == "__main__":
            setup_stdio()
            main()
    """
    changed = False
    try:
        if streams is None:
            targets = [(sys.stdout, "stdout"), (sys.stderr, "stderr")]
        else:
            targets = [(s, None) for s in streams]
        for stream, name in targets:
            if stream is None or _is_utf8(stream):
                continue
            if _reconfigure(stream, name):
                changed = True
    except Exception:
        return changed
    return changed
