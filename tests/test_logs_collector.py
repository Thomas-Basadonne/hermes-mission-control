"""MC-FIX-6: logs are tailed with bounded memory and bounded query parameters."""
import http.client
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import tracemalloc
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
SPEC = importlib.util.spec_from_file_location("mission_control_local_telemetry_server_logs", MODULE_PATH)
server_mod = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server_mod)


class _LogsFixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="mc-logs-")
        self.logs = Path(self._tmp.name)
        self._patch = mock.patch.object(server_mod, "hermes_logs_dir", return_value=self.logs)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _file(self, name: str, data: bytes) -> Path:
        path = self.logs / name
        path.write_bytes(data)
        return path

    def _entries(self, payload, name):
        return next(f for f in payload["files"] if f["name"] == name)["entries"]


class CollectLogsTests(_LogsFixture):
    def test_tail_is_exact_with_absolute_line_numbers_and_levels(self):
        lines = [f"line {i}" for i in range(1, 11)]
        lines[8] = "WARNING: disk"
        lines[9] = "Traceback: boom"
        self._file("agent.log", ("\n".join(lines) + "\n").encode())
        entries = self._entries(server_mod._collect_logs(max_files=10, max_lines=3), "agent.log")
        self.assertEqual(
            entries,
            [
                {"lineNumber": 8, "level": "info", "text": "line 8"},
                {"lineNumber": 9, "level": "warn", "text": "WARNING: disk"},
                {"lineNumber": 10, "level": "error", "text": "Traceback: boom"},
            ],
        )

    def test_empty_file_and_missing_trailing_newline(self):
        self._file("empty.log", b"")
        self._file("agent.log", b"a\nb\nc")
        payload = server_mod._collect_logs(max_files=10, max_lines=2)
        self.assertEqual(self._entries(payload, "empty.log"), [])
        self.assertEqual(
            [(e["lineNumber"], e["text"]) for e in self._entries(payload, "agent.log")],
            [(2, "b"), (3, "c")],
        )

    def test_invalid_utf8_is_replaced_not_fatal(self):
        self._file("agent.log", b"ok\n\xff\xfe broken\n")
        entries = self._entries(server_mod._collect_logs(max_files=10, max_lines=10), "agent.log")
        self.assertEqual(entries[1]["lineNumber"], 2)
        self.assertIn("\ufffd", entries[1]["text"])

    def test_memory_stays_bounded_for_a_large_log(self):
        line = b"x" * 199 + b"\n"
        self._file("agent.log", line * 100_000)  # ~20 MB
        tracemalloc.start()
        try:
            payload = server_mod._collect_logs(max_files=1, max_lines=50)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        entries = self._entries(payload, "agent.log")
        self.assertEqual(len(entries), 50)
        self.assertEqual(entries[-1]["lineNumber"], 100_000)
        self.assertLess(peak, 4 * 1024 * 1024, f"peak {peak} bytes")


class LogsEndpointParameterTests(_LogsFixture):
    def setUp(self):
        super().setUp()
        self._env = {k: os.environ.get(k) for k in ("MISSION_CONTROL_TOKEN", "API_SERVER_KEY")}
        os.environ["MISSION_CONTROL_TOKEN"] = "logs-secret"
        os.environ.pop("API_SERVER_KEY", None)
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.server = server_mod.ThreadingHTTPServer(("127.0.0.1", self.port), server_mod.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.05)
        self._file("agent.log", b"".join(f"l{i}\n".encode() for i in range(1, 6)))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        super().tearDown()

    def _get(self, query: str):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", f"/api/local/logs?{query}", headers={"Authorization": "Bearer logs-secret"})
            response = conn.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()

    def test_zero_and_negative_max_lines_return_one_line_not_the_whole_file(self):
        for value in ("0", "-1"):
            with self.subTest(maxLines=value):
                status, payload = self._get(f"maxLines={value}")
                self.assertEqual(status, 200)
                self.assertEqual([e["text"] for e in self._entries(payload, "agent.log")], ["l5"])

    def test_non_numeric_falls_back_to_defaults(self):
        with mock.patch.object(server_mod, "_collect_logs", return_value={"files": []}) as collect:
            self._get("maxLines=abc&maxFiles=xyz")
        collect.assert_called_once_with(max_files=10, max_lines=160)

    def test_oversized_parameters_are_capped(self):
        with mock.patch.object(server_mod, "_collect_logs", return_value={"files": []}) as collect:
            self._get("maxLines=99999999&maxFiles=99999")
        collect.assert_called_once_with(max_files=server_mod._LOGS_MAX_FILES, max_lines=server_mod._LOGS_MAX_LINES)

    def test_non_positive_max_files_is_raised_to_one(self):
        with mock.patch.object(server_mod, "_collect_logs", return_value={"files": []}) as collect:
            self._get("maxFiles=-3&maxLines=160")
        collect.assert_called_once_with(max_files=1, max_lines=160)


if __name__ == "__main__":
    unittest.main()
