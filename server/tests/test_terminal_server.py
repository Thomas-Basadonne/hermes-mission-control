import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_server


class TerminalServerTicketTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            "MISSION_CONTROL_TOKEN": os.environ.get("MISSION_CONTROL_TOKEN"),
            "API_SERVER_KEY": os.environ.get("API_SERVER_KEY"),
        }
        os.environ["MISSION_CONTROL_TOKEN"] = "terminal-test-token"
        os.environ.pop("API_SERVER_KEY", None)
        with terminal_server._ticket_lock:
            terminal_server._tickets.clear()

    def tearDown(self):
        with terminal_server._ticket_lock:
            terminal_server._tickets.clear()
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_issue_requires_configured_token(self):
        self.assertIsNone(terminal_server.issue_ticket("wrong"))
        self.assertIsNotNone(terminal_server.issue_ticket("terminal-test-token"))

    def test_ticket_is_single_use(self):
        ticket = terminal_server.issue_ticket("terminal-test-token")
        self.assertTrue(ticket)
        self.assertTrue(terminal_server._consume_ticket(ticket))
        self.assertFalse(terminal_server._consume_ticket(ticket))

    def test_api_server_key_is_auth_fallback(self):
        os.environ.pop("MISSION_CONTROL_TOKEN", None)
        os.environ["API_SERVER_KEY"] = "api-key"
        self.assertIsNotNone(terminal_server.issue_ticket("api-key"))


    def test_expired_ticket_is_rejected(self):
        ticket = terminal_server.issue_ticket("terminal-test-token")
        self.assertTrue(ticket)
        with terminal_server._ticket_lock:
            terminal_server._tickets[ticket] = time.monotonic() - 1
        self.assertFalse(terminal_server._consume_ticket(ticket))


class _FakeRequest:
    def __init__(self, path: str):
        self.path = path
        self.headers = {}


class _FakeWebSocket:
    def __init__(self, path: str):
        self.request = _FakeRequest(path)
        self.closed = None

    async def close(self, code: int, reason: str = "") -> None:
        self.closed = (code, reason)


class TerminalServerReadOnlyTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            key: os.environ.get(key)
            for key in ("MISSION_CONTROL_TOKEN", "API_SERVER_KEY", "MISSION_CONTROL_READ_ONLY")
        }
        os.environ["MISSION_CONTROL_TOKEN"] = "terminal-test-token"
        os.environ.pop("API_SERVER_KEY", None)
        os.environ.pop("MISSION_CONTROL_READ_ONLY", None)
        with terminal_server._ticket_lock:
            terminal_server._tickets.clear()

    def tearDown(self):
        with terminal_server._ticket_lock:
            terminal_server._tickets.clear()
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_already_issued_ticket_cannot_spawn_a_shell_in_read_only_mode(self):
        import asyncio
        import pty
        from unittest import mock

        ticket = terminal_server.issue_ticket("terminal-test-token")
        os.environ["MISSION_CONTROL_READ_ONLY"] = "1"
        ws = _FakeWebSocket(f"/terminal?ticket={ticket}")
        with mock.patch.object(pty, "fork") as fork:
            asyncio.run(terminal_server._handle(ws))
        fork.assert_not_called()
        self.assertEqual(ws.closed[0], 4403)
        self.assertIn("read-only", ws.closed[1])

    def test_valid_ticket_reaches_pty_spawn_when_writable(self):
        import asyncio
        import pty
        from unittest import mock

        ticket = terminal_server.issue_ticket("terminal-test-token")
        ws = _FakeWebSocket(f"/terminal?ticket={ticket}")
        with mock.patch.object(pty, "fork", side_effect=RuntimeError("fork reached")) as fork:
            with self.assertRaisesRegex(RuntimeError, "fork reached"):
                asyncio.run(terminal_server._handle(ws))
        fork.assert_called_once()
        self.assertIsNone(ws.closed)


if __name__ == "__main__":
    unittest.main()
