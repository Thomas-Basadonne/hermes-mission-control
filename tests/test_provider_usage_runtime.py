"""Regression tests for provider usage payloads exposed to the UI."""

from __future__ import annotations

import os
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import local_telemetry_server as telemetry


class ProviderUsageRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="mc-provider-runtime-")
        self._home = Path(self._tmp.name) / "hermes"
        self._home.mkdir()
        self._old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self._home)

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._old_home
        self._tmp.cleanup()

    def test_codexbar_missing_still_returns_empty_contract_arrays(self) -> None:
        with (
            patch.object(telemetry, "provider_usage_catalog_snapshot", create=True, return_value={
                "available": True,
                "providers": [{"provider": "codex", "source": "codexbar"}],
            }),
            patch.object(telemetry, "selected_usage_providers", create=True, return_value=("codex",)),
            patch.object(telemetry, "_schedule_provider_usage_refresh", create=True) as schedule,
            patch("provider_usage_paths.hermes_cache_dir", return_value=self._home / "cache"),
            patch.object(telemetry.subprocess, "run", side_effect=FileNotFoundError("codexbar")),
        ):
            snapshot = telemetry.collect_provider_usage()

        schedule.assert_called_once_with()
        self.assertEqual(len(snapshot["providers"]), 1)
        provider = snapshot["providers"][0]
        self.assertFalse(provider["available"])
        self.assertEqual(provider["provider"], "codex")
        self.assertEqual(provider["windows"], [])
        self.assertEqual(provider["balances"], [])
        self.assertEqual(provider["metrics"], [])

    def test_cache_miss_collects_dynamic_selection_and_native_nous_separately(self) -> None:
        catalog = [
            {"provider": "deepseek", "displayName": "DeepSeek", "enabled": True, "source": "codexbar"},
            {"provider": "nous", "displayName": "Nous Portal", "enabled": True, "source": "mission-control"},
        ]
        deepseek = {
            "provider": "deepseek", "available": True, "windows": [], "balances": [], "metrics": [],
        }
        nous = {
            "provider": "nous", "available": True, "windows": [], "balances": [], "metrics": [],
        }
        with (
            patch.object(telemetry, "provider_usage_catalog_snapshot", create=True, return_value={"available": True, "providers": catalog}),
            patch.object(telemetry, "selected_usage_providers", create=True, return_value=("deepseek", "nous")),
            patch.object(telemetry, "collect_codexbar_usage", create=True, return_value=[deepseek]) as collect,
            patch.object(telemetry, "_schedule_provider_usage_refresh", create=True) as schedule,
            patch.object(telemetry, "collect_nous_portal_usage", return_value=nous),
            patch("provider_usage_paths.hermes_cache_dir", return_value=self._home / "cache"),
            patch.object(telemetry.subprocess, "run", side_effect=FileNotFoundError("test guard")),
        ):
            snapshot = telemetry.collect_provider_usage()

        collect.assert_not_called()
        schedule.assert_called_once_with()
        self.assertEqual([item["provider"] for item in snapshot["providers"]], ["deepseek", "nous"])
        self.assertFalse(snapshot["providers"][0]["available"])

    def test_fresh_cache_serves_only_selected_dynamic_providers(self) -> None:
        cache_dir = self._home / "cache"
        cache_dir.mkdir()
        cached_provider = {
            "provider": "deepseek", "available": True, "source": "oauth",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "lastAttemptAt": datetime.now(timezone.utc).isoformat(),
            "windows": [{"id": "primary", "label": "Session", "usedPercent": 32}],
            "balances": [], "metrics": [],
        }
        (cache_dir / "mission-control-provider-usage.json").write_text(
            json.dumps({
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "providers": [cached_provider, {**cached_provider, "provider": "codex"}],
            }),
            encoding="utf-8",
        )
        catalog = [
            {"provider": "deepseek", "source": "codexbar"},
            {"provider": "codex", "source": "codexbar"},
        ]
        with (
            patch.object(telemetry, "provider_usage_catalog_snapshot", create=True, return_value={"available": True, "providers": catalog}),
            patch.object(telemetry, "selected_usage_providers", create=True, return_value=("deepseek",)),
            patch.object(telemetry, "_schedule_provider_usage_refresh", create=True) as schedule,
            patch("provider_usage_paths.hermes_cache_dir", return_value=cache_dir),
            patch.object(telemetry.subprocess, "run", side_effect=FileNotFoundError("test guard")),
        ):
            snapshot = telemetry.collect_provider_usage()

        schedule.assert_not_called()
        self.assertEqual([item["provider"] for item in snapshot["providers"]], ["deepseek"])
        self.assertEqual(snapshot["providers"][0]["windows"][0]["usedPercent"], 32)

    def test_cache_directory_override_is_shared_by_api_reader(self) -> None:
        override_cache = Path(self._tmp.name) / "override-cache"
        override_cache.mkdir()
        provider = {
            "provider": "deepseek", "available": True, "source": "oauth",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "windows": [{"id": "primary", "label": "Session", "usedPercent": 32}],
            "balances": [], "metrics": [],
        }
        (override_cache / "mission-control-provider-usage.json").write_text(
            json.dumps({"updatedAt": provider["updatedAt"], "providers": [provider]}), encoding="utf-8"
        )
        catalog = [{"provider": "deepseek", "source": "codexbar"}]
        with (
            patch.dict(os.environ, {"MISSION_CONTROL_CACHE_DIR": str(override_cache)}),
            patch.object(telemetry, "provider_usage_catalog_snapshot", return_value={"available": True, "providers": catalog}),
            patch.object(telemetry, "selected_usage_providers", return_value=("deepseek",)),
            patch.object(telemetry, "_schedule_provider_usage_refresh") as schedule,
            patch("provider_usage_paths.hermes_cache_dir", return_value=self._home / "different-cache"),
            patch.object(telemetry.subprocess, "run", side_effect=AssertionError("GET must not run CodexBar")),
        ):
            snapshot = telemetry.collect_provider_usage()

        schedule.assert_not_called()
        self.assertTrue(snapshot["providers"][0]["available"])
        self.assertEqual(snapshot["providers"][0]["windows"][0]["usedPercent"], 32)

    def test_stale_provider_retries_independently_of_fresh_global_timestamp(self) -> None:
        cache_dir = self._home / "cache"
        cache_dir.mkdir()
        provider_updated = datetime.now(timezone.utc) - timedelta(seconds=600)
        last_attempt = datetime.now(timezone.utc) - timedelta(seconds=120)
        provider = {
            "provider": "deepseek", "available": True, "source": "oauth",
            "updatedAt": provider_updated.isoformat(),
            "lastAttemptAt": last_attempt.isoformat(),
            "windows": [{"id": "primary", "label": "Session", "usedPercent": 32}],
            "balances": [], "metrics": [],
        }
        (cache_dir / "mission-control-provider-usage.json").write_text(
            json.dumps({"updatedAt": datetime.now(timezone.utc).isoformat(), "providers": [provider]}),
            encoding="utf-8",
        )
        with (
            patch.object(telemetry, "provider_usage_catalog_snapshot", return_value={
                "available": True, "providers": [{"provider": "deepseek", "source": "codexbar"}],
            }),
            patch.object(telemetry, "selected_usage_providers", return_value=("deepseek",)),
            patch.object(telemetry, "_schedule_provider_usage_refresh") as schedule,
            patch("provider_usage_paths.hermes_cache_dir", return_value=cache_dir),
            patch.object(telemetry.subprocess, "run", side_effect=AssertionError("GET must not run CodexBar")),
        ):
            snapshot = telemetry.collect_provider_usage()

        schedule.assert_called_once_with()
        self.assertTrue(snapshot["providers"][0]["stale"])


if __name__ == "__main__":
    unittest.main()
