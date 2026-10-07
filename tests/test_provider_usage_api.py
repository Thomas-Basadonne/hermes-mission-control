"""HTTP contract tests for dynamic provider catalog discovery."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
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

    def _get(self, *, token: bool = True, force_refresh: bool = False):
        headers = {}
        if token:
            headers["Authorization"] = "Bearer synthetic-provider-test-token"
        query = "?refresh=1" if force_refresh else ""
        request = urllib.request.Request(
            f"{self.base_url}/api/local/provider-usage/catalog{query}",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def _get_usage(self, *, token: bool = True):
        headers = {}
        if token:
            headers["Authorization"] = "Bearer synthetic-provider-test-token"
        request = urllib.request.Request(
            f"{self.base_url}/api/local/provider-usage",
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

    def _wait_for_catalog(self, timeout: float = 2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, payload = self._get()
            if not payload.get("refreshing"):
                return status, payload
            time.sleep(0.01)
        self.fail("provider catalog discovery did not settle")

    def test_usage_get_does_not_wait_for_catalog_discovery(self) -> None:
        discovery_started = threading.Event()
        release_discovery = threading.Event()
        request_finished = threading.Event()
        result = []

        def slow_discovery():
            discovery_started.set()
            release_discovery.wait(timeout=2)
            return []

        def request_usage():
            try:
                result.append(self._get_usage())
            finally:
                request_finished.set()

        with (
            patch.object(telemetry, "discover_codexbar_catalog", side_effect=slow_discovery),
            patch.object(telemetry, "stored_usage_providers", return_value=()),
            patch.object(telemetry, "request_background_provider_usage_refresh", return_value=None),
        ):
            request = threading.Thread(target=request_usage)
            request.start()
            try:
                self.assertTrue(discovery_started.wait(timeout=1))
                self.assertTrue(request_finished.wait(timeout=0.25), "usage GET waited for CodexBar catalog discovery")
                self.assertEqual(result[0][0], 200)
            finally:
                release_discovery.set()
                request.join(timeout=2)
                deadline = time.monotonic() + 1
                while telemetry._PROVIDER_USAGE_CATALOG_REFRESH_RUNNING and time.monotonic() < deadline:
                    time.sleep(0.01)

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
            status, payload = self._wait_for_catalog()

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
            status, payload = self._wait_for_catalog()

        self.assertEqual(status, 200)
        self.assertFalse(payload["available"])
        self.assertEqual(payload["error"], "CodexBar provider catalog is unavailable.")
        self.assertEqual([item["provider"] for item in payload["providers"]], ["nous"])

    def test_catalog_decode_failure_surfaces_error_and_obeys_retry_backoff(self) -> None:
        invalid_output = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")
        with (
            patch("provider_usage_catalog.shutil.which", return_value="/test/codexbar"),
            patch("provider_usage_catalog.subprocess.run", side_effect=invalid_output) as run,
        ):
            status, payload = self._get()
            if payload.get("refreshing"):
                status, payload = self._wait_for_catalog()
            self.assertEqual(status, 200)
            self.assertFalse(payload["available"])
            self.assertEqual(payload["error"], "CodexBar provider catalog is unavailable.")

            self._get()

        run.assert_called_once()

    def test_catalog_retry_query_bypasses_failure_backoff(self) -> None:
        from provider_usage_catalog import ProviderCatalogError

        with patch.object(
            telemetry,
            "discover_codexbar_catalog",
            side_effect=ProviderCatalogError("CodexBar provider catalog is unavailable."),
        ):
            self._wait_for_catalog()

        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[{
            "provider": "deepseek",
            "displayName": "DeepSeek",
            "enabled": True,
            "defaultEnabled": False,
            "source": "codexbar",
        }]):
            status, payload = self._get(force_refresh=True)
            if payload.get("refreshing"):
                status, payload = self._wait_for_catalog()

        self.assertEqual(status, 200)
        self.assertTrue(payload["available"])
        self.assertIn("deepseek", {item["provider"] for item in payload["providers"]})

    def test_failed_forced_refresh_keeps_cached_catalog_and_surfaces_error(self) -> None:
        from provider_usage_catalog import ProviderCatalogError

        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[{
            "provider": "deepseek",
            "displayName": "DeepSeek",
            "enabled": True,
            "defaultEnabled": False,
            "source": "codexbar",
        }]):
            self._wait_for_catalog()

        with patch.object(
            telemetry,
            "discover_codexbar_catalog",
            side_effect=ProviderCatalogError("CodexBar provider catalog is unavailable."),
        ):
            status, payload = self._get(force_refresh=True)
            if payload.get("refreshing"):
                status, payload = self._wait_for_catalog()

        self.assertEqual(status, 200)
        self.assertTrue(payload["available"])
        self.assertFalse(payload["stale"])
        self.assertEqual(payload["error"], "CodexBar provider catalog is unavailable.")
        self.assertIn("deepseek", {item["provider"] for item in payload["providers"]})

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
            _, catalog = self._wait_for_catalog()
            status, payload = self._put({"selectedProviders": ["deepseek", "deepseek", "nous"], "expectedRevision": catalog["selectionRevision"]})

        self.assertEqual(status, 200)
        self.assertEqual(payload["selectedProviders"], ["deepseek", "nous"])
        persisted = json.loads((Path(self._tmp.name) / "mission-control-usage.json").read_text())
        self.assertEqual(persisted["selectedProviders"], ["deepseek", "nous"])

    def test_selection_route_rejects_unknown_ids_and_requires_auth(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[]):
            _, catalog = self._wait_for_catalog()
            unauth_status, _ = self._put({"selectedProviders": []}, token=False)
            invalid_status, payload = self._put({"selectedProviders": ["not-in-catalog"], "expectedRevision": catalog["selectionRevision"]})

        self.assertEqual(unauth_status, 401)
        self.assertEqual(invalid_status, 400)
        self.assertEqual(payload["error"], "bad_request")

    def test_selection_route_rejects_non_object_json_without_server_error(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[]):
            status, payload = self._put([{}])

        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "bad_request")

    def test_late_put_cannot_overwrite_a_newer_save_after_reconciliation(self) -> None:
        catalog = [{"provider": "deepseek", "displayName": "DeepSeek", "enabled": True,
                    "defaultEnabled": False, "source": "codexbar"}]
        from provider_usage_config import save_selected_usage_providers

        save_selected_usage_providers(["nous"], {"nous", "deepseek"})
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=catalog):
            _, initial = self._wait_for_catalog()
            self.assertIn("selectionRevision", initial, "catalog must expose a write-fencing revision")
            revision = initial["selectionRevision"]
            original_save = telemetry.save_selected_usage_provider_snapshot
            entered = threading.Event()
            release = threading.Event()
            late_result = []

            def delayed_save(selected, catalog_ids, expected_revision):
                if selected == ["deepseek"]:
                    entered.set()
                    if not release.wait(timeout=2):
                        raise AssertionError("late PUT was not released")
                return original_save(selected, catalog_ids, expected_revision)

            with patch.object(telemetry, "save_selected_usage_provider_snapshot", side_effect=delayed_save):
                late = threading.Thread(target=lambda: late_result.append(self._put({
                    "selectedProviders": ["deepseek"], "expectedRevision": revision,
                })))
                late.start()
                try:
                    self.assertTrue(entered.wait(timeout=1))
                    _, reconciled = self._get()
                    self.assertEqual(reconciled["selectedProviders"], ["nous"])
                    self.assertEqual(reconciled["selectionRevision"], revision)
                    status, saved = self._put({"selectedProviders": [], "expectedRevision": revision})
                    self.assertEqual(status, 200)
                    self.assertNotEqual(saved["selectionRevision"], revision)
                finally:
                    release.set()
                    late.join(timeout=3)
                self.assertFalse(late.is_alive())

            self.assertEqual(late_result[0][0], 409, "old PUT must lose its compare-and-swap after C commits")
            self.assertEqual(late_result[0][1]["error"], "selection_conflict")
            _, canonical = self._get()
            self.assertEqual(canonical["selectedProviders"], [])
            self.assertEqual(canonical["selectionRevision"], saved["selectionRevision"])
            persisted = json.loads((Path(self._tmp.name) / "mission-control-usage.json").read_text())
            self.assertEqual(persisted["selectedProviders"], [])

    def test_selection_route_rejects_missing_invalid_and_stale_revisions_without_writing(self) -> None:
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[]):
            _, initial = self._wait_for_catalog()
            revision = initial["selectionRevision"]
            for body in [
                {"selectedProviders": []},
                {"selectedProviders": [], "expectedRevision": None},
                {"selectedProviders": [], "expectedRevision": "invalid"},
            ]:
                self.assertEqual(self._put(body)[0], 400)
            self.assertEqual(self._get()[1]["selectionRevision"], revision)
            self.assertFalse((Path(self._tmp.name) / "mission-control-usage.json").exists())
            status, first = self._put({"selectedProviders": [], "expectedRevision": revision})
            self.assertEqual(status, 200)
            status, restored = self._put({"selectedProviders": ["nous"], "expectedRevision": first["selectionRevision"]})
            self.assertEqual(status, 200)
            self.assertEqual(restored["selectedProviders"], initial["selectedProviders"])
            self.assertNotEqual(restored["selectionRevision"], revision, "ABA must not revive old PUTs")
            path = Path(self._tmp.name) / "mission-control-usage.json"
            before = path.read_bytes()
            self.assertEqual(self._put({"selectedProviders": [], "expectedRevision": revision})[0], 409)
            self.assertEqual(path.read_bytes(), before, "conflicting PUT must not touch persisted preferences")

    def test_versioned_selection_remains_read_only_and_preserves_display_rules(self) -> None:
        path = Path(self._tmp.name) / "mission-control-usage.json"
        display = {"nous": {"hidden": {"metrics": ["detail:api.requests"]}}}
        path.write_text(json.dumps({"providers": display}), encoding="utf-8")
        with patch.object(telemetry, "discover_codexbar_catalog", return_value=[]):
            _, catalog = self._wait_for_catalog()
            body = {"selectedProviders": [], "expectedRevision": catalog["selectionRevision"]}
            before = path.read_bytes()
            os.environ["MISSION_CONTROL_READ_ONLY"] = "1"
            self.assertEqual(self._put(body)[0], 403)
            self.assertEqual(path.read_bytes(), before)
            os.environ.pop("MISSION_CONTROL_READ_ONLY")
            self.assertEqual(self._put(body)[0], 200)
            self.assertEqual(json.loads(path.read_text())["providers"], display)

if __name__ == "__main__":
    unittest.main()
