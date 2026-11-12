"""Plan 88-18 task 02: the daemon binds without a reverse-DNS lookup.

Root cause of the seven ``fixture daemon did not become ready`` errors on the macOS pytest cell
(measured, faulthandler traceback from the stuck daemon on run 43143465623):

    socket.py getfqdn  <-  http/server.py server_bind  <-  socketserver.py __init__
        <-  services/amauta-daemon.py start_server

``http.server.HTTPServer.server_bind`` calls ``socket.getfqdn(host)`` to fill ``server_name``.
On a runner whose resolver answers slowly that blocks for tens of seconds, so the daemon never
announced its port inside the 20 s readiness budget. ``ThreadedHTTPServer`` now binds through
``socketserver.TCPServer.server_bind`` directly.

The test binds one ephemeral loopback port and never connects anywhere; ``getfqdn`` is replaced
by a recorder, so it does not matter how the host's resolver behaves.
"""
import importlib.util
import socket
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DAEMON = REPO / "services" / "amauta-daemon.py"


def _load_daemon(monkeypatch, tmp_path):
    """Import a fresh copy of the daemon module with auto-start off and a temp data dir."""
    for key in ("GSD_RLM_PORT", "GSD_TEST_MODE", "GSD_RLM_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("AMAUTA_LOG_FILE", "off")
    monkeypatch.setenv("GSD_AMAUTA_NO_AUTO_START", "1")
    monkeypatch.setenv("GSD_AMAUTA_PORT", "0")
    monkeypatch.setenv("GSD_FORCE_SQLITE", "1")
    (tmp_path / "data").mkdir(exist_ok=True)
    spec = importlib.util.spec_from_file_location("amauta_daemon_88_18_bind", str(DAEMON))
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(REPO / "services"))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(str(REPO / "services"))
    return mod


def test_threaded_server_binds_without_a_reverse_dns_lookup(monkeypatch, tmp_path):
    mod = _load_daemon(monkeypatch, tmp_path)
    lookups = []

    def recording_getfqdn(*args, **kwargs):
        lookups.append(args)
        return "slow-resolver.invalid"

    monkeypatch.setattr(socket, "getfqdn", recording_getfqdn)
    server = mod.ThreadedHTTPServer(("127.0.0.1", 0), mod.AmautaHandler)
    try:
        assert lookups == [], "the daemon asked the resolver for a name while binding: %r" % (lookups,)
        port = server.server_address[1]
        assert port > 0
        assert server.server_port == port
        assert server.server_name == "127.0.0.1"
    finally:
        server.server_close()


def test_threaded_server_keeps_its_class_attributes(monkeypatch, tmp_path):
    mod = _load_daemon(monkeypatch, tmp_path)
    assert mod.ThreadedHTTPServer.daemon_threads is True
    assert mod.ThreadedHTTPServer.allow_reuse_address is True
