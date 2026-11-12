"""Portable newline-delimited JSON-RPC reader for a child process's stdout.

Phase 88, plan 88-16-02. ``tests/test_amauta_mcp_stdio.py`` and
``tests/test_amauta_mcp_pg_down.py`` both polled the server with
``select.select([proc.stdout], [], [], timeout)``. On Windows ``select`` accepts
**sockets only**: given a pipe it raises ``OSError``, the caller's ``except
(ValueError, OSError): break`` swallowed it, the read returned ``None`` and the
test called ``pytest.skip("No ... response within timeout")``. Eight tests
reported a skip on the Windows cell for a reason that had nothing to do with the
server.

A reader thread plus a queue is portable: ``readline()`` blocks in the thread,
the test waits on the queue with a deadline, and nothing in the path is
socket-only. The thread is a daemon and holds no lock the test needs, so a
hanging child cannot wedge the suite.

Example:
    >>> proc = subprocess.Popen(cmd, stdin=PIPE, stdout=PIPE)        # doctest: +SKIP
    >>> send_jsonrpc(proc, "initialize", {}, 1)                      # doctest: +SKIP
    >>> read_jsonrpc(proc, 1, timeout=5.0)                           # doctest: +SKIP
    {'jsonrpc': '2.0', 'id': 1, 'result': {...}}
"""
import json
import queue
import threading
import time

_QUEUE_ATTR = "_gsd_jsonrpc_queue"
_THREAD_ATTR = "_gsd_jsonrpc_thread"


def _pump(stream, q):
    """Read whole lines off ``stream`` into ``q`` until EOF.

    Args:
        stream: the child's binary stdout.
        q: the queue the reader drains.

    Returns:
        None. ``None`` is pushed onto the queue when the stream ends, so a
        waiter can tell "nothing yet" from "nothing ever".
    """
    try:
        for line in iter(stream.readline, b""):
            q.put(line)
    except (ValueError, OSError):
        pass
    finally:
        q.put(None)


def attach_reader(proc):
    """Start (once) the background reader for ``proc`` and return its queue.

    Args:
        proc: a ``subprocess.Popen`` whose ``stdout`` is a binary pipe.

    Returns:
        queue.Queue: the queue carrying one ``bytes`` line per message, and a
        single ``None`` at end of stream.
    """
    q = getattr(proc, _QUEUE_ATTR, None)
    if q is None:
        q = queue.Queue()
        thread = threading.Thread(target=_pump, args=(proc.stdout, q), daemon=True)
        setattr(proc, _QUEUE_ATTR, q)
        setattr(proc, _THREAD_ATTR, thread)
        thread.start()
    return q


def send_jsonrpc(proc, method, params, request_id):
    """Write one JSON-RPC 2.0 request line to ``proc.stdin``.

    Args:
        proc: the server subprocess.
        method: the JSON-RPC method name.
        params: the params object.
        request_id: the request id to correlate the response with.

    Returns:
        None. A ``BrokenPipeError`` is swallowed: a dead server is diagnosed by
        the caller's read timeout, which has the stderr tail to show.
    """
    msg = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    ) + "\n"
    try:
        proc.stdin.write(msg.encode("utf-8"))
        proc.stdin.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass


def read_jsonrpc(proc, request_id, timeout=5.0):
    """Wait for the JSON-RPC response whose ``id`` is ``request_id``.

    Notification lines (no ``id``, or ``id`` ``None``) and responses to other
    requests are discarded, exactly as the ``select``-based reader did.

    Args:
        proc: the server subprocess.
        request_id: the id to wait for.
        timeout: seconds to wait in total.

    Returns:
        dict | None: the parsed response, or None on timeout or end of stream.
    """
    q = attach_reader(proc)
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            line = q.get(timeout=min(remaining, 0.2))
        except queue.Empty:
            continue
        if line is None:
            return None  # end of stream
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if msg.get("id") == request_id:
            return msg


def stderr_tail(proc, limit=4000):
    """Best-effort tail of the child's stderr, for a failure message.

    The child's stderr is a pipe nobody drains; reading it after the process has
    been terminated is safe and is the only diagnostic a reader of a red CI log
    has.

    Args:
        proc: the server subprocess.
        limit: how many trailing characters to return.

    Returns:
        str: the tail, or a short note when nothing could be read.
    """
    if proc is None or proc.stderr is None:
        return "(no stderr captured)"
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        data = proc.stderr.read() or b""
    except Exception:
        return "(stderr unreadable)"
    return data.decode("utf-8", errors="replace")[-limit:]
