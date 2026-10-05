"""Regression tests for profile-aware Hermes paths in telemetry."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

fake_psutil = types.SimpleNamespace(
    cpu_percent=lambda interval=None: 7.5,
    virtual_memory=lambda: types.SimpleNamespace(percent=42.0, used=8 * 1024**3, available=8 * 1024**3, total=16 * 1024**3),
    disk_usage=lambda path: types.SimpleNamespace(percent=55.0, free=100 * 1024**3, total=200 * 1024**3),
    Process=lambda: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=256 * 1024**2)),
)
sys.modules.setdefault("psutil", fake_psutil)

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_telemetry_paths", MODULE_PATH)
local_telemetry_server = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(local_telemetry_server)


class TelemetryPathResolutionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="mc-telemetry-paths-"))
        self._home_backup = os.environ.get("HOME")
        self._hermes_home_backup = os.environ.get("HERMES_HOME")
        self._vault_backup = os.environ.get("MISSION_CONTROL_VAULT_PATH")
        self._usage_providers_backup = os.environ.get("MISSION_CONTROL_USAGE_PROVIDERS")
        os.environ["HOME"] = str(self._tmp / "home")
        os.environ["HERMES_HOME"] = str(self._tmp / "hermes")
        os.environ.pop("MISSION_CONTROL_VAULT_PATH", None)
        self._hermes_home = Path(os.environ["HERMES_HOME"])

    def tearDown(self):
        if self._home_backup is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._home_backup
        if self._hermes_home_backup is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._hermes_home_backup
        if self._vault_backup is None:
            os.environ.pop("MISSION_CONTROL_VAULT_PATH", None)
        else:
            os.environ["MISSION_CONTROL_VAULT_PATH"] = self._vault_backup
        if self._usage_providers_backup is None:
            os.environ.pop("MISSION_CONTROL_USAGE_PROVIDERS", None)
        else:
            os.environ["MISSION_CONTROL_USAGE_PROVIDERS"] = self._usage_providers_backup
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_provider_usage_reads_profile_aware_cache(self):
        cache = self._hermes_home / "cache" / "mission-control-provider-usage.json"
        cache.parent.mkdir(parents=True)
        payload = {"success": True, "available": True, "providers": [{"provider": "codex"}]}
        cache.write_text(json.dumps(payload), encoding="utf-8")

        with patch.object(
            local_telemetry_server,
            "collect_nous_portal_usage",
            return_value={
                "provider": "nous",
                "available": False,
                "source": "portal-account",
                "windows": [],
                "balances": [],
                "metrics": [],
            },
        ), patch.object(
            local_telemetry_server,
            "provider_usage_catalog_snapshot",
            return_value={"available": False, "providers": [{"provider": "nous", "source": "mission-control", "enabled": True}]},
        ):
            result = local_telemetry_server.collect_provider_usage()

        self.assertEqual(result["schemaVersion"], 1)
        self.assertTrue(result["available"])
        self.assertEqual(result["providers"][0]["provider"], "codex")
        self.assertEqual(result["providers"][0]["windows"], [])
        self.assertEqual(result["providers"][-1]["provider"], "nous")

    def test_local_allowlist_filters_hidden_provider_from_cache_and_fetches(self):
        cache = self._hermes_home / "cache" / "mission-control-provider-usage.json"
        cache.parent.mkdir(parents=True)
        cache.write_text(
            json.dumps({
                "success": True,
                "available": True,
                "providers": [
                    {"provider": "codex", "available": True, "windows": [], "balances": [], "metrics": []},
                    {"provider": "openrouter", "available": True, "windows": [], "balances": [], "metrics": []},
                ],
            }),
            encoding="utf-8",
        )
        os.environ["MISSION_CONTROL_USAGE_PROVIDERS"] = "codex,nous"
        nous = {"provider": "nous", "available": True, "windows": [], "balances": [], "metrics": []}

        with patch.object(local_telemetry_server, "collect_nous_portal_usage", return_value=nous), \
             patch.object(local_telemetry_server, "provider_usage_catalog_snapshot", return_value={
                 "available": False,
                 "providers": [{"provider": "nous", "source": "mission-control", "enabled": True}],
             }), \
             patch.object(local_telemetry_server.subprocess, "run") as run:
            result = local_telemetry_server.collect_provider_usage()

        self.assertEqual([item["provider"] for item in result["providers"]], ["codex", "nous"])
        self.assertFalse(any(call.args[0][1] == "usage" for call in run.call_args_list))

    def test_local_display_rules_filter_codex_balance_and_feature_reset_metric(self):
        config = self._hermes_home / "mission-control-usage.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(
            json.dumps({
                "providers": {
                    "codex": {
                        "hidden": {"balances": ["credits_remaining"]},
                        "featured": {"metrics": ["reset_credits_available"]},
                    }
                }
            }),
            encoding="utf-8",
        )
        cache = self._hermes_home / "cache" / "mission-control-provider-usage.json"
        cache.parent.mkdir(parents=True)
        cache.write_text(
            json.dumps({
                "schemaVersion": 1,
                "available": True,
                "providers": [{
                    "provider": "codex",
                    "available": True,
                    "windows": [],
                    "balances": [{"id": "credits_remaining", "value": 0, "unit": "credits"}],
                    "metrics": [{"id": "reset_credits_available", "value": 1, "unit": "count"}],
                }],
            }),
            encoding="utf-8",
        )
        os.environ["MISSION_CONTROL_USAGE_PROVIDERS"] = "codex"

        result = local_telemetry_server.collect_provider_usage()
        provider = result["providers"][0]

        self.assertEqual(provider["balances"], [])
        self.assertEqual(provider["metrics"][0]["id"], "reset_credits_available")
        self.assertTrue(provider["metrics"][0]["featured"])

    def test_runtime_home_follows_central_resolver(self):
        self.assertEqual(local_telemetry_server._get_hermes_home(), self._hermes_home)
        self.assertEqual(
            local_telemetry_server._client_diagnostics_log(),
            self._hermes_home / "logs" / "mission-control-client.log",
        )


class GatewayStatusCompatibilityTests(unittest.TestCase):
    def setUp(self):
        import shutil

        self._tmp = Path(tempfile.mkdtemp(prefix="mc-gateway-status-"))
        self._hermes_home = self._tmp / "hermes"
        self._hermes_home.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)
        patcher = patch.object(local_telemetry_server, "_get_hermes_home", return_value=self._hermes_home)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _status(self, *, live: bool = True, start_time: int | None = 200):
        with patch.object(local_telemetry_server, "psutil", types.SimpleNamespace(pid_exists=lambda pid: live and pid == 4321)), \
             patch.object(local_telemetry_server, "_gateway_process_start_time", return_value=start_time), \
             patch.object(local_telemetry_server, "_candidates_enabled", return_value=False):
            return local_telemetry_server._collect_status_payload_uncached()

    def test_matching_runtime_fingerprint_is_live(self):
        state = {"pid": 4321, "kind": "hermes-gateway", "start_time": 200, "gateway_state": "running"}
        (self._hermes_home / "gateway_state.json").write_text(json.dumps(state), encoding="utf-8")
        result = self._status()
        self.assertTrue(result["gateway_running"])
        self.assertEqual(result["gateway_pid"], 4321)

    def test_dead_pid_does_not_report_running_or_platforms(self):
        state = {"pid": 4321, "kind": "hermes-gateway", "start_time": 200,
                 "gateway_state": "running", "platforms": {"discord": {"status": "connected"}}}
        (self._hermes_home / "gateway_state.json").write_text(json.dumps(state), encoding="utf-8")
        result = self._status(live=False)
        self.assertFalse(result["gateway_running"])
        self.assertIsNone(result["gateway_pid"])
        self.assertEqual(result["gateway_state"], "stopped")
        self.assertEqual(result["gateway_platforms"], {})

    def test_legacy_numeric_and_json_pid_files_remain_supported(self):
        for raw in ("4321", json.dumps({"pid": 4321}), json.dumps({"pid": 4321, "start_time": 200})):
            with self.subTest(raw=raw):
                (self._hermes_home / "gateway.pid").write_text(raw, encoding="utf-8")
                self.assertTrue(self._status()["gateway_running"])

    def test_reused_legacy_json_pid_is_rejected(self):
        (self._hermes_home / "gateway.pid").write_text(json.dumps({"pid": 4321, "start_time": 100}), encoding="utf-8")
        self.assertFalse(self._status()["gateway_running"])

    def test_missing_fingerprint_observation_preserves_legacy_liveness(self):
        state = {"pid": 4321, "kind": "hermes-gateway", "start_time": 200}
        (self._hermes_home / "gateway_state.json").write_text(json.dumps(state), encoding="utf-8")
        self.assertTrue(self._status(start_time=None)["gateway_running"])

    def test_canonical_status_wins_over_legacy_status(self):
        canonical = {"pid": 4321, "kind": "hermes-gateway", "gateway_state": "running"}
        (self._hermes_home / "gateway_state.json").write_text(json.dumps(canonical), encoding="utf-8")
        (self._hermes_home / "runtime_status.json").write_text(json.dumps({"gateway_state": "stopped"}), encoding="utf-8")
        self.assertEqual(local_telemetry_server._read_runtime_status(), canonical)

    def test_missing_malformed_or_non_dict_canonical_status_uses_legacy(self):
        legacy = {"pid": 4321, "gateway_state": "running"}
        (self._hermes_home / "runtime_status.json").write_text(json.dumps(legacy), encoding="utf-8")
        self.assertEqual(local_telemetry_server._read_runtime_status(), legacy)
        for raw in ("{broken", "[]", "null"):
            with self.subTest(raw=raw):
                (self._hermes_home / "gateway_state.json").write_text(raw, encoding="utf-8")
                self.assertEqual(local_telemetry_server._read_runtime_status(), legacy)
                self.assertTrue(self._status()["gateway_running"])

    def test_invalid_pid_values_are_ignored(self):
        for pid in (None, "bad", 0, -1, [], {}):
            with self.subTest(pid=pid):
                (self._hermes_home / "gateway.pid").write_text(json.dumps({"pid": pid}), encoding="utf-8")
                self.assertFalse(self._status()["gateway_running"])

    def test_unreadable_legacy_pid_file_does_not_break_canonical_status(self):
        (self._hermes_home / "gateway_state.json").write_text(json.dumps({"pid": 4321, "start_time": 200}), encoding="utf-8")
        (self._hermes_home / "gateway.pid").write_bytes(b"\xff")
        self.assertTrue(self._status()["gateway_running"])

    def test_linux_start_time_reads_field_22_with_spaced_comm(self):
        stat = "4321 (hermes (gateway worker)) " + " ".join(["S"] + ["0"] * 18 + ["98765"] + ["0"] * 4)
        with patch.object(Path, "read_text", return_value=stat):
            self.assertEqual(local_telemetry_server._gateway_process_start_time(4321), 98765)

    def test_non_proc_start_time_uses_centiseconds_and_handles_unavailable_process(self):
        process = types.SimpleNamespace(create_time=lambda: 1234.567)
        fake = types.SimpleNamespace(Process=lambda pid: process)
        with patch.object(Path, "read_text", side_effect=FileNotFoundError), \
             patch.object(local_telemetry_server, "psutil", fake):
            self.assertEqual(local_telemetry_server._gateway_process_start_time(4321), int(round(1234.567 * 100)))
        with patch.object(Path, "read_text", side_effect=FileNotFoundError), \
             patch.object(local_telemetry_server, "psutil", types.SimpleNamespace(Process=lambda pid: None)):
            self.assertIsNone(local_telemetry_server._gateway_process_start_time(4321))

    def test_reused_runtime_pid_is_rejected_even_with_legacy_pid_fallback(self):
        state = {"pid": 4321, "kind": "hermes-gateway", "start_time": 100,
                 "gateway_state": "running", "platforms": {"discord": {"status": "connected"}}}
        (self._hermes_home / "gateway_state.json").write_text(json.dumps(state), encoding="utf-8")
        (self._hermes_home / "gateway.pid").write_text("4321", encoding="utf-8")
        with patch.object(local_telemetry_server, "psutil", types.SimpleNamespace(pid_exists=lambda pid: pid == 4321)), \
             patch.object(local_telemetry_server, "_gateway_process_start_time", return_value=200, create=True), \
             patch.object(local_telemetry_server, "_candidates_enabled", return_value=False):
            result = local_telemetry_server._collect_status_payload_uncached()
        self.assertFalse(result["gateway_running"])
        self.assertIsNone(result["gateway_pid"])
        self.assertEqual(result["gateway_state"], "stopped")
        self.assertEqual(result["gateway_platforms"], {})

    def test_status_recognizes_live_gateway_state_without_legacy_pid_file(self):
        state = {
            "pid": 4321,
            "kind": "hermes-gateway",
            "gateway_state": "running",
            "platforms": {"discord": {"status": "connected"}},
            "exit_reason": None,
            "updated_at": "2026-10-01T15:58:44+00:00",
        }
        self._hermes_home.mkdir(parents=True, exist_ok=True)
        (self._hermes_home / "gateway_state.json").write_text(json.dumps(state), encoding="utf-8")

        with patch.object(local_telemetry_server, "psutil", types.SimpleNamespace(pid_exists=lambda pid: pid == 4321)), \
             patch.object(local_telemetry_server, "_candidates_enabled", return_value=False):
            result = local_telemetry_server._collect_status_payload_uncached()

        self.assertTrue(result["gateway_running"])
        self.assertEqual(result["gateway_pid"], 4321)
        self.assertEqual(result["gateway_state"], "running")
        self.assertEqual(result["gateway_platforms"], state["platforms"])
        self.assertEqual(result["gateway_updated_at"], state["updated_at"])


if __name__ == "__main__":
    unittest.main()
