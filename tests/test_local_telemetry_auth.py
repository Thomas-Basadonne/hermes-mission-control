import json
import os
import socket
import threading
import time
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from pathlib import Path
import importlib.util
import tempfile
from typing import Optional
from unittest import mock
import sys


fake_psutil = types.SimpleNamespace(
    cpu_percent=lambda interval=None: 7.5,
    virtual_memory=lambda: types.SimpleNamespace(percent=42.0, used=8 * 1024**3, available=8 * 1024**3, total=16 * 1024**3),
    disk_usage=lambda path: types.SimpleNamespace(percent=55.0, free=100 * 1024**3, total=200 * 1024**3),
    Process=lambda: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=256 * 1024**2)),
)
sys.modules.setdefault("psutil", fake_psutil)

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_local_telemetry_server", MODULE_PATH)
local_telemetry_server = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(local_telemetry_server)


class LocalTelemetryAuthTests(unittest.TestCase):
    def setUp(self):
        self._env_backup = {
            "MISSION_CONTROL_TOKEN": os.environ.get("MISSION_CONTROL_TOKEN"),
            "API_SERVER_KEY": os.environ.get("API_SERVER_KEY"),
            "MISSION_CONTROL_READ_ONLY": os.environ.get("MISSION_CONTROL_READ_ONLY"),
            "MISSION_CONTROL_VAULT_PATH": os.environ.get("MISSION_CONTROL_VAULT_PATH"),
            "HERMES_OBSIDIAN_VAULT": os.environ.get("HERMES_OBSIDIAN_VAULT"),
            "HERMES_HOME": os.environ.get("HERMES_HOME"),
        }
        os.environ["MISSION_CONTROL_TOKEN"] = "phase1-secret"
        os.environ.pop("API_SERVER_KEY", None)
        os.environ.pop("MISSION_CONTROL_READ_ONLY", None)
        # Isolate vault-backed tests from any vault override on the host.
        os.environ.pop("MISSION_CONTROL_VAULT_PATH", None)
        os.environ.pop("HERMES_OBSIDIAN_VAULT", None)
        # The profile-aware core scan (hermes_paths) reads HERMES_HOME before
        # falling back to Path.home; tests that patch Path.home (e.g. the
        # "no fabricated macOS path" check) need it unset so the patched home
        # actually takes effect.
        os.environ.pop("HERMES_HOME", None)

        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]

        self.server = local_telemetry_server.ThreadingHTTPServer(("127.0.0.1", self.port), local_telemetry_server.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.05)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _request(self, path: str, token: Optional[str] = None, method: str = "GET", payload: Optional[dict] = None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, method=method)
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        if body is not None:
            request.add_header("Content-Type", "application/json")
        return urllib.request.urlopen(request, timeout=5)

    def test_health_endpoint_stays_open_without_auth(self):
        with self._request("/health") as response:
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read().decode("utf-8"))
        self.assertTrue(payload["ok"])

    def test_system_endpoint_rejects_missing_token(self):
        with self.assertRaises(urllib.error.HTTPError) as exc:
            self._request("/api/local/system")
        self.assertEqual(exc.exception.code, 401)
        self.assertEqual(exc.exception.headers.get("WWW-Authenticate"), 'Bearer realm="Mission Control"')
        payload = json.loads(exc.exception.read().decode("utf-8"))
        self.assertEqual(payload["error"], "invalid_api_key")

    def test_system_endpoint_accepts_mission_control_token(self):
        with self._request("/api/local/system", token="phase1-secret") as response:
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["source"], "local-psutil")
        self.assertIn("cpuUsagePercent", payload)

    def test_api_server_key_is_used_as_fallback_token(self):
        os.environ.pop("MISSION_CONTROL_TOKEN", None)
        os.environ["API_SERVER_KEY"] = "api-key-secret"

        with self._request("/api/local/system", token="api-key-secret") as response:
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read().decode("utf-8"))
        self.assertEqual(payload["source"], "local-psutil")

    def test_query_access_token_is_rejected_for_non_stream_endpoints(self):
        encoded = urllib.parse.quote("phase1-secret", safe="")
        with self.assertRaises(urllib.error.HTTPError) as exc:
            self._request(f"/api/local/system?access_token={encoded}")
        self.assertEqual(exc.exception.code, 401)

    def test_read_only_mode_rejects_all_mutating_methods(self):
        os.environ["MISSION_CONTROL_READ_ONLY"] = "1"
        for method, path in (
            ("PUT", "/api/local/config"),
            ("POST", "/api/local/gateway/restart"),
            ("POST", "/api/local/memory/honcho/local-identity"),
            ("DELETE", "/api/local/push/subscriptions"),
        ):
            with self.subTest(method=method), self.assertRaises(urllib.error.HTTPError) as exc:
                self._request(path, token="phase1-secret", method=method)
            self.assertEqual(exc.exception.code, 403)
            payload = json.loads(exc.exception.read().decode("utf-8"))
            self.assertEqual(payload["error"], "read_only_mode")

    def test_read_only_mode_rejects_terminal_ticket_without_issuing_one(self):
        os.environ["MISSION_CONTROL_READ_ONLY"] = "1"
        with mock.patch.object(local_telemetry_server, "issue_ticket", return_value="synthetic-ticket") as issue:
            with self.assertRaises(urllib.error.HTTPError) as exc:
                self._request("/api/local/terminal/ticket", token="phase1-secret", method="POST", payload={})
        self.assertEqual(exc.exception.code, 403)
        self.assertEqual(json.loads(exc.exception.read().decode("utf-8"))["error"], "read_only_mode")
        issue.assert_not_called()

    def test_read_only_mode_rejects_client_diagnostics_without_writing(self):
        os.environ["MISSION_CONTROL_READ_ONLY"] = "1"
        with mock.patch.object(local_telemetry_server, "_append_client_diagnostic") as append:
            with self.assertRaises(urllib.error.HTTPError) as exc:
                self._request(
                    "/api/local/client-diagnostics",
                    token="phase1-secret",
                    method="POST",
                    payload={"event": "synthetic"},
                )
        self.assertEqual(exc.exception.code, 403)
        self.assertEqual(json.loads(exc.exception.read().decode("utf-8"))["error"], "read_only_mode")
        append.assert_not_called()

    def test_read_only_mode_keeps_health_and_protected_reads_available(self):
        os.environ["MISSION_CONTROL_READ_ONLY"] = "1"
        with self._request("/health") as response:
            self.assertEqual(response.status, 200)
        with self._request("/api/local/system", token="phase1-secret") as response:
            self.assertEqual(response.status, 200)
        with self.assertRaises(urllib.error.HTTPError) as exc:
            self._request("/api/local/system")
        self.assertEqual(exc.exception.code, 401)

    def test_terminal_ticket_and_diagnostics_work_when_not_read_only(self):
        with mock.patch.object(local_telemetry_server, "issue_ticket", return_value="synthetic-ticket") as issue:
            with self._request("/api/local/terminal/ticket", token="phase1-secret", method="POST", payload={}) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read().decode("utf-8"))["ticket"], "synthetic-ticket")
        issue.assert_called_once_with("phase1-secret")
        with mock.patch.object(local_telemetry_server, "_append_client_diagnostic") as append:
            with self._request(
                "/api/local/client-diagnostics",
                token="phase1-secret",
                method="POST",
                payload={"event": "synthetic"},
            ) as response:
                self.assertEqual(response.status, 200)
        append.assert_called_once_with({"event": "synthetic"})

    def test_honcho_status_requires_auth_and_never_exposes_api_key(self):
        with tempfile.TemporaryDirectory(prefix="mc-honcho-api-") as temp_home:
            root = Path(temp_home) / ".hermes"
            root.mkdir()
            (root / "honcho.json").write_text(json.dumps({
                "baseUrl": "http://127.0.0.1:8000",
                "apiKey": "do-not-leak",
                "enabled": True,
            }), encoding="utf-8")
            os.environ["HERMES_HOME"] = str(root)

            with self.assertRaises(urllib.error.HTTPError) as exc:
                self._request("/api/local/memory/honcho")
            self.assertEqual(exc.exception.code, 401)

            with self._request("/api/local/memory/honcho", token="phase1-secret") as response:
                self.assertEqual(response.status, 200)
                payload = json.loads(response.read().decode("utf-8"))

        self.assertTrue(payload["configured"])
        self.assertEqual(payload["identityMode"], "unresolved")
        self.assertNotIn("apiKey", json.dumps(payload))
        self.assertNotIn("do-not-leak", json.dumps(payload))

    def test_honcho_local_identity_endpoint_configures_all_profiles(self):
        with tempfile.TemporaryDirectory(prefix="mc-honcho-api-") as temp_home:
            root = Path(temp_home) / ".hermes"
            root.mkdir()
            profile = root / "profiles" / "researcher"
            profile.mkdir(parents=True)
            (profile / "profile.yaml").write_text("name: researcher\n", encoding="utf-8")
            (root / "honcho.json").write_text(json.dumps({
                "baseUrl": "http://127.0.0.1:8000",
                "enabled": True,
                "workspace": "shared",
            }), encoding="utf-8")
            os.environ["HERMES_HOME"] = str(root)

            with self._request(
                "/api/local/memory/honcho/local-identity",
                token="phase1-secret",
                method="POST",
                payload={"peerName": "local-owner"},
            ) as response:
                self.assertEqual(response.status, 200)
                payload = json.loads(response.read().decode("utf-8"))

            written = json.loads((root / "honcho.json").read_text(encoding="utf-8"))

        self.assertTrue(payload["success"])
        self.assertEqual(payload["identityMode"], "local-single-user")
        self.assertEqual(payload["peerName"], "local-owner")
        self.assertEqual(written["hosts"]["hermes"]["aiPeer"], "hermes")
        self.assertEqual(written["hosts"]["hermes_researcher"]["aiPeer"], "hermes_researcher")
        self.assertTrue(written["hosts"]["hermes_researcher"]["sessionAiPeerPrefix"])

    def test_mission_control_agent_endpoints_are_served_from_db_and_gateway(self):
        """Verify MC discovers sessions from gateway index + SessionDB, not sidecar files."""
        sessions_dir = Path.home() / ".hermes" / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        session_id = "mc-db-test-session"
        index_path = sessions_dir / "sessions.json"
        original_index = index_path.read_text(encoding="utf-8", errors="replace") if index_path.exists() else None

        # Write gateway index entry
        index_payload = {
            "discord-home": {
                "session_id": session_id,
                "platform": "discord",
                "display_name": "Mission Control DB test",
                "chat_type": "channel",
                "created_at": "2026-04-24T12:00:00+00:00",
                "updated_at": "2999-04-24T12:00:05+00:00",
            }
        }

        # Write a JSONL transcript for trace
        jsonl_path = sessions_dir / f"{session_id}.jsonl"
        original_jsonl = jsonl_path.read_text(encoding="utf-8", errors="replace") if jsonl_path.exists() else None
        jsonl_messages = [
            {"role": "user", "content": "Ship the trace feed.", "timestamp": "2026-04-24T12:00:00+00:00"},
            {
                "role": "assistant",
                "timestamp": "2026-04-24T12:00:01+00:00",
                "tool_calls": [
                    {
                        "id": "call_db_trace",
                        "function": {
                            "name": "search_files",
                            "arguments": '{"pattern":"mission-control"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_db_trace",
                "tool_name": "search_files",
                "content": '{"success": true, "total_count": 1}',
                "timestamp": "2026-04-24T12:00:02+00:00",
            },
            {"role": "assistant", "content": "Done.", "timestamp": "2026-04-24T12:00:03+00:00"},
        ]

        try:
            index_path.write_text(json.dumps(index_payload), encoding="utf-8")
            jsonl_path.write_text(
                "\n".join(json.dumps(m) for m in jsonl_messages),
                encoding="utf-8",
            )

            with self._request("/api/local/mission-control/agents", token="phase1-secret") as response:
                self.assertEqual(response.status, 200)
                agents_payload = json.loads(response.read().decode("utf-8"))

            self.assertTrue(agents_payload["available"])
            self.assertTrue(agents_payload["capabilities"]["trace"]["stream"])

            with self._request("/api/local/mission-control/sessions?limit=10", token="phase1-secret") as response:
                self.assertEqual(response.status, 200)
                sessions_payload = json.loads(response.read().decode("utf-8"))

            matching = [i for i in sessions_payload["items"] if i["sessionId"] == session_id]
            self.assertTrue(len(matching) == 1, f"Session {session_id} not found in MC sessions list")
            self.assertEqual(matching[0]["traceMode"], "transcript")

            with self._request(
                f"/api/local/mission-control/agents/trace?session_id={session_id}&compact=1&limit=20",
                token="phase1-secret",
            ) as response:
                self.assertEqual(response.status, 200)
                trace_payload = json.loads(response.read().decode("utf-8"))

            self.assertTrue(trace_payload["available"])
            self.assertEqual(trace_payload["traceMode"], "transcript")
            self.assertTrue(any(event["type"] == "tool_call_started" for event in trace_payload["events"]))
            self.assertTrue(any(event["type"] == "tool_call_completed" for event in trace_payload["events"]))
        finally:
            if original_index is None:
                try:
                    index_path.unlink()
                except FileNotFoundError:
                    pass
            else:
                index_path.write_text(original_index, encoding="utf-8")

            if original_jsonl is None:
                try:
                    jsonl_path.unlink()
                except FileNotFoundError:
                    pass
            else:
                jsonl_path.write_text(original_jsonl, encoding="utf-8")

if __name__ == "__main__":
    unittest.main()
