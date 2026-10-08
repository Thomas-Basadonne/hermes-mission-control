"""Exercise the real listener created by main(), not an attribute-only contract."""
import concurrent.futures
from contextlib import ExitStack
import http.client
import importlib.util
from pathlib import Path
import socket
import threading
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_telemetry_backlog", MODULE_PATH)
telemetry = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(telemetry)


class TelemetryBacklogTests(unittest.TestCase):
    def _startup_listener(self):
        listeners = []
        # Keep the production bind/listen and server selection, but don't start
        # gateway/terminal services or accept until the whole burst is queued.
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(telemetry, "_resolve_telemetry_bind", return_value=("127.0.0.1", 0)))
            stack.enter_context(mock.patch.object(telemetry, "_cpu_sampler"))
            stack.enter_context(mock.patch.object(telemetry, "start_gateway_watcher"))
            stack.enter_context(mock.patch.object(telemetry, "start_terminal_server"))
            stack.enter_context(mock.patch.object(telemetry, "shutdown_terminal_sessions"))
            stack.enter_context(mock.patch.object(telemetry.signal, "signal"))
            stack.enter_context(mock.patch("builtins.print"))
            stack.enter_context(mock.patch.object(
                telemetry.ThreadingHTTPServer, "serve_forever", autospec=True,
                side_effect=lambda server: listeners.append(server),
            ))
            telemetry.main()
        self.assertEqual(len(listeners), 1)
        server = listeners[0]
        self.addCleanup(server.server_close)
        return server

    def test_startup_listener_queues_and_serves_entire_dashboard_burst(self):
        server = self._startup_listener()
        count = 40  # Headroom above the dashboard's ~30-request first load.
        barrier = threading.Barrier(count)

        def connect(_):
            barrier.wait(timeout=5)
            sock = None
            try:
                sock = socket.create_connection(server.server_address, timeout=1)
                sock.sendall(b"GET /api/local/health HTTP/1.0\r\nHost: localhost\r\n\r\n")
                sock.settimeout(5)
                return sock
            except OSError as exc:
                if sock is not None:
                    sock.close()
                return type(exc).__name__

        with mock.patch.object(telemetry.Handler, "log_message"):
            with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
                pending = list(pool.map(connect, range(count)))
            # No accept ran during connect: success cannot depend on CI scheduling
            # fortuitously spreading the burst across the old five-entry queue.
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            statuses = []
            try:
                for item in pending:
                    if not isinstance(item, socket.socket):
                        statuses.append(item)
                        continue
                    try:
                        response = http.client.HTTPResponse(item)
                        response.begin()
                        statuses.append(response.status)
                        response.read()
                        response.close()
                    except (OSError, http.client.HTTPException) as exc:
                        statuses.append(type(exc).__name__)
            finally:
                for item in pending:
                    if isinstance(item, socket.socket):
                        item.close()
                server.shutdown()
                thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(statuses, [200] * count)

    def test_startup_retains_nonblocking_handler_shutdown(self):
        server = self._startup_listener()
        self.assertTrue(server.daemon_threads)
        self.assertFalse(server.block_on_close)


if __name__ == "__main__":
    unittest.main()
