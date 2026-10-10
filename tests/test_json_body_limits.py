"""MC-FIX-2: the shared JSON body helper validates Content-Length and bounds reads."""
import http.client
import importlib.util
import io
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
SPEC = importlib.util.spec_from_file_location("mission_control_local_telemetry_server_body", MODULE_PATH)
server_mod = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server_mod)


class _RecordingReader(io.BytesIO):
    def __init__(self, data: bytes):
        super().__init__(data)
        self.read_sizes: list[int] = []

    def read(self, size=-1):  # noqa: D401 - BytesIO signature
        self.read_sizes.append(size)
        return super().read(size)


def _helper(content_length, body: bytes = b"", **kwargs):
    handler = server_mod.Handler.__new__(server_mod.Handler)
    handler.headers = {} if content_length is None else {"Content-Length": content_length}
    handler.rfile = _RecordingReader(body)
    responses: list[tuple[int, dict]] = []
    handler._json = lambda status, payload, extra_headers=None: responses.append((status, payload))
    result = handler._read_json_body(**kwargs)
    return result, responses, handler.rfile.read_sizes


class ReadJsonBodyHelperTests(unittest.TestCase):
    def test_non_numeric_content_length_is_a_400_not_an_exception(self):
        result, responses, reads = _helper("abc", b"{}")
        self.assertIsNone(result)
        self.assertEqual(responses[0][0], 400)
        self.assertEqual(responses[0][1]["error"], "bad_request")
        self.assertEqual(reads, [])

    def test_negative_content_length_is_rejected_without_reading(self):
        result, responses, reads = _helper("-1", b'{"a": 1}')
        self.assertIsNone(result)
        self.assertEqual(responses[0][0], 400)
        self.assertEqual(reads, [])

    def test_payload_over_the_general_limit_is_413_without_reading(self):
        too_big = server_mod._MAX_JSON_BODY_BYTES + 1
        result, responses, reads = _helper(str(too_big), b"{}")
        self.assertIsNone(result)
        self.assertEqual(responses[0][0], 413)
        self.assertEqual(responses[0][1]["error"], "payload_too_large")
        self.assertEqual(reads, [])

    def test_caller_can_tighten_the_limit(self):
        result, responses, _ = _helper("33", b"{" + b" " * 31 + b"}", max_bytes=32)
        self.assertIsNone(result)
        self.assertEqual(responses[0][0], 413)

    def test_payload_exactly_at_the_limit_is_accepted(self):
        body = b'{"k": "' + b"x" * 20 + b'"}'
        result, responses, reads = _helper(str(len(body)), body, max_bytes=len(body))
        self.assertEqual(result, {"k": "x" * 20})
        self.assertEqual(responses, [])
        self.assertEqual(reads, [len(body)])

    def test_missing_or_zero_content_length_is_an_empty_object(self):
        for header in (None, "0", ""):
            with self.subTest(header=header):
                result, responses, reads = _helper(header)
                self.assertEqual(result, {})
                self.assertEqual(responses, [])
                self.assertEqual(reads, [])

    def test_invalid_json_and_non_object_json_stay_400(self):
        for body in (b"not json", b"[1, 2]"):
            with self.subTest(body=body):
                result, responses, _ = _helper(str(len(body)), body)
                self.assertIsNone(result)
                self.assertEqual(responses[0][0], 400)


class JsonBodyRouteTests(unittest.TestCase):
    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("MISSION_CONTROL_TOKEN", "API_SERVER_KEY", "MISSION_CONTROL_READ_ONLY")}
        os.environ["MISSION_CONTROL_TOKEN"] = "body-secret"
        os.environ.pop("API_SERVER_KEY", None)
        os.environ.pop("MISSION_CONTROL_READ_ONLY", None)
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.server = server_mod.ThreadingHTTPServer(("127.0.0.1", self.port), server_mod.Handler)
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

    def _raw_post(self, path: str, content_length: str, body: bytes = b"", method: str = "POST"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path)
            conn.putheader("Authorization", "Bearer body-secret")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", content_length)
            conn.endheaders()
            if body:
                conn.send(body)
            response = conn.getresponse()
            return response.status, json.loads(response.read().decode("utf-8") or "null")
        finally:
            conn.close()

    def test_cron_create_rejects_bad_length_without_mutating(self):
        with mock.patch.object(server_mod.cron_bridge_mod, "create_job") as create_job:
            for header, expected in (("abc", 400), ("-5", 400), (str(server_mod._MAX_JSON_BODY_BYTES + 1), 413)):
                with self.subTest(header=header):
                    status, payload = self._raw_post("/api/local/cron/jobs", header)
                    self.assertEqual(status, expected)
                    self.assertIn("error", payload)
        create_job.assert_not_called()

    def test_cron_create_accepts_a_valid_body(self):
        body = json.dumps({"prompt": "synthetic", "schedule": "every 1h"}).encode()
        with mock.patch.object(server_mod.cron_bridge_mod, "create_job", return_value={"ok": True}) as create_job:
            status, payload = self._raw_post("/api/local/cron/jobs", str(len(body)), body)
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})
        create_job.assert_called_once()

    def test_plugin_fallback_does_not_dispatch_after_a_rejected_body(self):
        with mock.patch.object(server_mod, "dispatch_plugin_request", return_value=(True, {"ok": True}, 200)) as dispatch:
            status, payload = self._raw_post("/api/local/some-plugin/action", "abc")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_request")
        dispatch.assert_not_called()

    def test_rejected_body_produces_exactly_one_http_response(self):
        for path in (
            "/api/local/room/vault",
            "/api/local/chat/title",
            "/api/local/chat/handoffs/claim",
            "/api/local/chat/handoffs",
        ):
            with self.subTest(path=path), closing(socket.create_connection(("127.0.0.1", self.port), timeout=5)) as sock:
                sock.sendall(
                    f"POST {path} HTTP/1.0\r\nAuthorization: Bearer body-secret\r\n"
                    "Content-Type: application/json\r\nContent-Length: 8\r\n\r\nnot json".encode()
                )
                raw = b""
                while chunk := sock.recv(65536):
                    raw += chunk
                self.assertEqual(raw.count(b"HTTP/1.0 "), 1, raw.decode("utf-8", "replace"))
                self.assertTrue(raw.startswith(b"HTTP/1.0 400"))

    def test_selection_keeps_its_stricter_limit(self):
        status, payload = self._raw_post("/api/local/provider-usage/selection", "32769", method="PUT")
        self.assertEqual(status, 413)


if __name__ == "__main__":
    unittest.main()
