"""MC-FIX-5: Sessions endpoints answer a loader timeout with JSON, not a dropped socket."""
import http.client
import importlib.util
import json
import os
import socket
import sys
import threading
import time
import types
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

fake_psutil = types.SimpleNamespace(
    cpu_percent=lambda interval=None: 7.5,
    virtual_memory=lambda: types.SimpleNamespace(percent=42.0, used=8 * 1024**3, available=8 * 1024**3, total=16 * 1024**3),
    disk_usage=lambda path: types.SimpleNamespace(percent=55.0, free=100 * 1024**3, total=200 * 1024**3),
    Process=lambda: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=256 * 1024**2)),
)
sys.modules.setdefault("psutil", fake_psutil)

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_local_telemetry_server_sessions", MODULE_PATH)
server_mod = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server_mod)

ENDPOINTS = ("/api/local/mission-control/sessions", "/api/local/sessions")


class SessionsTimeoutTests(unittest.TestCase):
    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("MISSION_CONTROL_TOKEN", "API_SERVER_KEY")}
        os.environ["MISSION_CONTROL_TOKEN"] = "sessions-secret"
        os.environ.pop("API_SERVER_KEY", None)
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.server = server_mod.ThreadingHTTPServer(("127.0.0.1", self.port), server_mod.Handler)
        self.server.handle_error = lambda request, client_address: None  # keep expected tracebacks quiet
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.05)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _get(self, path: str, token: str | None = "sessions-secret"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            conn.request("GET", path, headers=headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()

    def test_loader_timeout_maps_to_503_sessions_unavailable(self):
        loader = mock.Mock(side_effect=TimeoutError("/private/path/state.db pool busy"))
        with mock.patch.object(server_mod, "load_agents_sessions_snapshot", loader):
            for path in ENDPOINTS:
                with self.subTest(path=path):
                    status, payload = self._get(path)
                    self.assertEqual(status, 503)
                    self.assertEqual(payload["error"], "sessions_unavailable")
                    self.assertNotIn("/private/path", json.dumps(payload))

    def test_success_payload_and_query_parameters_are_unchanged(self):
        loader = mock.Mock(return_value={"items": [], "stats": {"totalSessions": 0}})
        with mock.patch.object(server_mod, "load_agents_sessions_snapshot", loader):
            status, payload = self._get("/api/local/mission-control/sessions?limit=25&offset=50&session_id=s1&profile=p&q=abc")
        self.assertEqual((status, payload), (200, {"items": [], "stats": {"totalSessions": 0}}))
        kwargs = loader.call_args.kwargs
        self.assertEqual((kwargs["limit"], kwargs["offset"], kwargs["session_id"], kwargs["profile"]), (25, 50, "s1", "p"))

    def test_other_loader_errors_are_not_reported_as_unavailable(self):
        loader = mock.Mock(side_effect=RuntimeError("boom"))
        with mock.patch.object(server_mod, "load_agents_sessions_snapshot", loader):
            for path in ENDPOINTS:
                with self.subTest(path=path):
                    try:
                        status, payload = self._get(path)
                    except (http.client.RemoteDisconnected, ConnectionError):
                        continue
                    self.assertNotEqual(payload.get("error"), "sessions_unavailable")

    def test_auth_is_still_checked_before_the_loader(self):
        loader = mock.Mock(side_effect=TimeoutError())
        with mock.patch.object(server_mod, "load_agents_sessions_snapshot", loader):
            for path in ENDPOINTS:
                with self.subTest(path=path):
                    status, _ = self._get(path, token=None)
                    self.assertEqual(status, 401)
        loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
