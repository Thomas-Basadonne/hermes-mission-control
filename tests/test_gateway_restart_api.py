import json
import os
import socket
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import importlib.util

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_gateway_restart_server", MODULE_PATH)
assert SPEC and SPEC.loader
local_telemetry_server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local_telemetry_server)

TOKEN = "gateway-restart-test-token"
ENDPOINT = "/api/local/gateway/restart"


class GatewayRestartApiTests(unittest.TestCase):
    def setUp(self):
        self._env_backup = {
            "MISSION_CONTROL_TOKEN": os.environ.get("MISSION_CONTROL_TOKEN"),
            "MISSION_CONTROL_READ_ONLY": os.environ.get("MISSION_CONTROL_READ_ONLY"),
        }
        os.environ["MISSION_CONTROL_TOKEN"] = TOKEN
        os.environ.pop("MISSION_CONTROL_READ_ONLY", None)

        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]

        self.server = local_telemetry_server.ThreadingHTTPServer(
            ("127.0.0.1", self.port), local_telemetry_server.Handler
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def request(self, token=TOKEN):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{ENDPOINT}", data=b"{}", method="POST"
        )
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")
        request.add_header("Content-Type", "application/json")
        return urllib.request.urlopen(request, timeout=5)

    def test_restart_requires_authentication_and_does_not_spawn(self):
        with patch.object(local_telemetry_server.subprocess, "Popen") as popen:
            for token in (None, "invalid-token"):
                with self.subTest(token=token):
                    with self.assertRaises(urllib.error.HTTPError) as context:
                        self.request(token=token)
                    self.assertEqual(context.exception.code, 401)

        popen.assert_not_called()

    def test_read_only_mode_rejects_restart_and_does_not_spawn(self):
        os.environ["MISSION_CONTROL_READ_ONLY"] = "1"

        with patch.object(local_telemetry_server.subprocess, "Popen") as popen:
            with self.assertRaises(urllib.error.HTTPError) as context:
                self.request()
            payload = json.loads(context.exception.read())

        self.assertEqual(context.exception.code, 403)
        self.assertEqual(payload["error"], "read_only_mode")
        popen.assert_not_called()

    def test_authorized_restart_invokes_command_and_returns_accepted(self):
        with patch.object(local_telemetry_server.subprocess, "Popen") as popen:
            with self.request() as response:
                payload = json.loads(response.read())
                self.assertEqual(response.status, 202)

        self.assertEqual(payload, {"success": True, "detail": "Gateway restart initiated."})
        popen.assert_called_once_with(
            ["hermes", "gateway", "restart"],
            stdout=local_telemetry_server.subprocess.DEVNULL,
            stderr=local_telemetry_server.subprocess.DEVNULL,
            start_new_session=True,
        )

    def test_restart_spawn_failure_returns_server_error(self):
        with patch.object(local_telemetry_server.subprocess, "Popen", side_effect=FileNotFoundError):
            with self.assertRaises(urllib.error.HTTPError) as context:
                self.request()
            payload = json.loads(context.exception.read())

        self.assertEqual(context.exception.code, 500)
        self.assertEqual(payload["success"], False)
        self.assertTrue(payload["manual"])
        self.assertIn("not found", payload["detail"])


if __name__ == "__main__":
    unittest.main()
