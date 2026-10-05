"""HTTP contract tests for dynamic provider catalog discovery."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

fake_psutil = types.SimpleNamespace(
    cpu_percent=lambda interval=None: 0,
    virtual_memory=lambda: types.SimpleNamespace(percent=0, used=0, available=1, total=1),
    disk_usage=lambda path: types.SimpleNamespace(percent=0, free=1, total=1),
    Process=lambda: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=0)),
)
sys.modules.setdefault("psutil", fake_psutil)

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("provider_usage_api_telemetry", MODULE_PATH)
telemetry = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(telemetry)


class ProviderUsageApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_values = {
            key: os.environ.get(key)
            for key in ("MISSION_CONTROL_TOKEN", "MISSION_CONTROL_READ_ONLY", "HERMES_HOME")
        }
        os.environ["MISSION_CONTROL_TOKEN"] = "synthetic-provider-test-token"
        os.environ.pop("MISSION_CONTROL_READ_ONLY", None)
        self._tmp = tempfile.TemporaryDirectory(prefix="mc-provider-api-")
        os.environ["HERMES_HOME"] = self._tmp.name
        telemetry.reset_provider_usage_catalog_cache()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), telemetry.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self._tmp.cleanup()
        for key, value in self._old_values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        reset = getattr(telemetry, "reset_provider_usage_catalog_cache", None)
        if reset is not None:
            reset()

    def _get(self, *, token: bool = True):
        headers = {}
        if token:
            headers["Authorization"] = "Bearer synthetic-provider-test-token"
        request = urllib.request.Request(
            f"{self.base_url}/api/local/provider-usage/catalog",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def _put(self, payload: object, *, token: bool = True):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer synthetic-provider-test-token"
        request = urllib.request.Request(
            f"{self.base_url}/api/local/provider-usage/selection",
            data=json.dumps(payload).encode(),
            headers=headers,
            method="PUT",
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_catalog_route_returns_only_sanitized_catalog_and_native_nous(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", create=True, return_value=[
            {
                "provider": "deepseek",
                "displayName": "DeepSeek",
                "enabled": True,
                "defaultEnabled": False,
                "source": "codexbar",
                "secret": "must-not-leak",
            },
        ]):
            status, payload = self._get()

        self.assertEqual(status, 200)
        self.assertTrue(payload["available"])
        providers = payload["providers"]
        self.assertEqual({item["provider"] for item in providers}, {"deepseek", "nous"})
        self.assertEqual(sum(item["provider"] == "nous" for item in providers), 1)
        self.assertNotIn("secret", repr(payload))
        self.assertNotIn("must-not-leak", repr(payload))

    def test_catalog_route_requires_bearer_auth(self) -> None:
        status, payload = self._get(token=False)

        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "invalid_api_key")

    def test_catalog_failure_returns_safe_unavailable_response(self) -> None:
        from provider_usage_catalog import ProviderCatalogError

        with patch.object(
            telemetry,
            "discover_codexbar_catalog",
            create=True,
            side_effect=ProviderCatalogError("CodexBar provider catalog is unavailable."),
        ):
            status, payload = self._get()

        self.assertEqual(status, 200)
        self.assertFalse(payload["available"])
        self.assertEqual(payload["error"], "CodexBar provider catalog is unavailable.")
        self.assertEqual([item["provider"] for item in payload["providers"]], ["nous"])

    def test_selection_route_validates_and_persists_only_catalog_ids(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[
            {
                "provider": "deepseek",
                "displayName": "DeepSeek",
                "enabled": True,
                "defaultEnabled": False,
                "source": "codexbar",
            },
        ]):
            status, payload = self._put({"selectedProviders": ["deepseek", "deepseek", "nous"]})

        self.assertEqual(status, 200)
        self.assertEqual(payload["selectedProviders"], ["deepseek", "nous"])
        persisted = json.loads((Path(self._tmp.name) / "mission-control-usage.json").read_text())
        self.assertEqual(persisted["selectedProviders"], ["deepseek", "nous"])

    def test_selection_route_rejects_unknown_ids_and_requires_auth(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[]):
            unauth_status, _ = self._put({"selectedProviders": []}, token=False)
            invalid_status, payload = self._put({"selectedProviders": ["not-in-catalog"]})

        self.assertEqual(unauth_status, 401)
        self.assertEqual(invalid_status, 400)
        self.assertEqual(payload["error"], "bad_request")

    def test_selection_route_rejects_non_object_json_without_server_error(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[]):
            status, payload = self._put([{}])

        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_request")

if __name__ == "__main__":
    unittest.main()
