"""Real HTTP/WebSocket contract tests for the no-agent MC checker."""
from __future__ import annotations

import importlib.util
from http import HTTPStatus
import json
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlparse

from websockets.sync.server import serve

ROOT = Path(__file__).resolve().parents[1]


class MCHealthTests(unittest.TestCase):
    url: str

    @classmethod
    def setUpClass(cls):
        cls.fault = None

        def http_response(connection, status, body, content_type='application/json'):
            response = connection.respond(status, body)
            del response.headers['Content-Type']
            response.headers['Content-Type'] = content_type
            return response

        def route(connection, request):
            parsed = urlparse(request.path)
            path = parsed.path
            if path == '/api/ws':
                if parse_qs(parsed.query).get('token') != ['fixture-ws-secret']:
                    return http_response(connection, HTTPStatus.UNAUTHORIZED, '{}')
                return None
            if path.startswith('/api/') and request.headers.get('Authorization') != 'Bearer fixture-secret':
                return http_response(connection, HTTPStatus.UNAUTHORIZED, '{"error":"unauthorized"}')
            if cls.fault == path:
                return http_response(connection, HTTPStatus.OK, '<html>SPA fallback</html>', 'text/html')
            if path == '/':
                return http_response(connection, HTTPStatus.OK, '<html><div id="root"></div><script type="module" src="/src/main.tsx"></script></html>', 'text/html')
            if path == '/src/main.tsx':
                return http_response(connection, HTTPStatus.OK, 'import React from "/deps/react.js"; createRoot(document.getElementById("root"));', 'text/javascript')
            if path == '/api/gateway-root':
                return http_response(connection, HTTPStatus.OK, 'window.__HERMES_SESSION_TOKEN__="fixture-ws-secret"', 'text/html')
            payloads = {
                '/api/status': {'gateway_running': True, 'gateway_state': 'running', 'overall': 'ok', 'install_id': 'fixture-host'},
                '/health': {'ok': True, 'service': 'mission-control-local-telemetry', 'source': 'local-psutil'},
                '/api/local/health': {'ok': True, 'service': 'mission-control-local-telemetry', 'source': 'local-psutil'},
                '/api/local/system': {'source': 'local-psutil', 'cpuCores': 8, 'ramUsage': {'totalGb': 16}, 'diskUsage': {'totalGb': 100}},
                '/api/local/cron/jobs': {'jobs': [{'id': 'fixture-job'}], 'count': 1},
                '/api/local/sessions': {'success': True, 'available': True, 'items': [], 'schemaVersion': 1},
                '/api/local/provider-usage': {'success': True, 'available': True, 'providers': {}, 'updatedAt': '2026-01-01T00:00:00Z'},
            }
            return http_response(connection, HTTPStatus.OK if path in payloads else HTTPStatus.NOT_FOUND, json.dumps(payloads.get(path, {'error': 'missing'})))

        def websocket(connection):
            connection.send(json.dumps({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'gateway.ready'}}))
            for _ in connection:
                pass

        cls.server = serve(websocket, '127.0.0.1', 0, process_request=route)
        cls.url = 'http://127.0.0.1:' + str(cls.server.socket.getsockname()[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(5)

    def load_checker(self):
        path = ROOT / 'scripts/mc_health_watchdog.py'
        self.assertTrue(path.exists(), 'MC health checker not implemented yet')
        spec = importlib.util.spec_from_file_location('mc_health_watchdog', path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_real_payloads_and_chat_transport_cannot_be_replaced_by_spa_html(self):
        checker = self.load_checker()
        targets = {name: self.url for name in ['frontend', 'backend', 'telemetry']}
        services = lambda label: {'running': True, 'pid': 123}
        healthy = checker.check_health(targets, 'fixture-secret', service_probe=services)
        self.assertEqual(healthy['status'], 'ok', healthy)
        self.assertTrue(all(c['status'] == 'ok' for c in healthy['checks'].values()))
        self.assertEqual(healthy['checks']['chat_websocket']['detail'], 'authenticated WebSocket + gateway.ready')
        for path in ['/api/status', '/api/local/cron/jobs', '/api/local/sessions']:
            with self.subTest(path=path):
                self.__class__.fault = path
                try:
                    degraded = checker.check_health(targets, 'fixture-secret', service_probe=services)
                    self.assertEqual(degraded['status'], 'failed')
                    self.assertTrue(degraded['failed_checks'])
                    self.assertNotIn('fixture-secret', checker.render_report(degraded))
                    self.assertNotIn('fixture-ws-secret', checker.render_report(degraded))
                finally:
                    self.__class__.fault = None
        denied = checker.check_health(targets, 'wrong-secret', service_probe=services)
        self.assertEqual(denied['status'], 'failed')
        self.assertNotIn('wrong-secret', checker.render_report(denied))

    def test_delivery_transitions_preserve_failures_without_spamming_successes(self):
        import tempfile
        import json
        import stat

        checker = self.load_checker()
        self.assertTrue(hasattr(checker, 'run_watchdog'), 'Delivery transition/state handling missing')
        targets = {name: self.url for name in ['frontend', 'backend', 'telemetry']}
        services = lambda label: {'running': True, 'pid': 123}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            def run():
                return checker.run_watchdog(home, targets, 'fixture-secret', service_probe=services)
            report, output = run()
            self.assertEqual(report['status'], 'ok')
            self.assertIn('monitor attivato', output)
            report, output = run()
            self.assertEqual(output, '')
            self.__class__.fault = '/api/status'
            try:
                failed, first_error = run()
                repeated, second_error = run()
                self.assertEqual(failed['status'], 'failed')
                self.assertEqual(repeated['status'], 'failed')
                self.assertEqual(first_error, second_error)
            finally:
                self.__class__.fault = None
            recovered, output = run()
            self.assertEqual(recovered['status'], 'ok')
            self.assertIn('ripristinato dopo un errore', output)
            self.assertEqual(run()[1], '')
            saved = home / 'run/mc-health-watchdog.json'
            self.assertEqual(json.loads(saved.read_text())['status'], 'ok')
            self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
            self.assertTrue((home / 'run/mc-health-watchdog.md').exists())
            self.assertNotIn('fixture-secret', saved.read_text())


if __name__ == '__main__':
    unittest.main()
