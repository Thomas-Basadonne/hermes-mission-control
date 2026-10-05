"""Snapshot freshness and last-known-good behavior."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from provider_usage_contract import unavailable_provider
from provider_usage_snapshot import (
    providers_due_for_refresh,
    read_provider_usage_snapshot,
    refresh_provider_usage_snapshot,
)


class ProviderUsageSnapshotTests(unittest.TestCase):
    def test_future_last_attempt_is_due_immediately(self) -> None:
        now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
        snapshot = {"providers": [{
            "provider": "ollama",
            "available": True,
            "updatedAt": (now - timedelta(seconds=60)).isoformat(),
            "lastAttemptAt": (now + timedelta(seconds=30)).isoformat(),
            "windows": [],
            "balances": [],
            "metrics": [],
        }]}

        self.assertEqual(providers_due_for_refresh(snapshot, ("ollama",), now=now), ("ollama",))

    def test_future_updated_timestamp_is_stale(self) -> None:
        now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            path.write_text(json.dumps({"providers": [{
                "provider": "deepseek",
                "available": True,
                "updatedAt": "2099-01-01T00:00:00+00:00",
                "windows": [],
                "balances": [],
                "metrics": [],
            }]}), encoding="utf-8")

            snapshot = read_provider_usage_snapshot(path, ("deepseek",), now=now)

        self.assertTrue(snapshot["providers"][0]["stale"])

    def test_failed_refresh_retains_last_good_data_and_provider_retry_time(self) -> None:
        now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
        last_good = now - timedelta(seconds=600)
        last_attempt = now - timedelta(seconds=120)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            cached = {
                "provider": "deepseek",
                "available": True,
                "source": "oauth",
                "updatedAt": last_good.isoformat(),
                "lastAttemptAt": last_attempt.isoformat(),
                "windows": [{"id": "primary", "label": "Session", "usedPercent": 37}],
                "balances": [],
                "metrics": [],
            }
            path.write_text(json.dumps({"updatedAt": last_attempt.isoformat(), "providers": [cached]}), encoding="utf-8")

            refreshed = refresh_provider_usage_snapshot(
                path,
                ("deepseek",),
                lambda due: [unavailable_provider(due[0], "cli", "synthetic failure")],
                now=now,
            )

            self.assertTrue(refreshed)
            snapshot = json.loads(path.read_text(encoding="utf-8"))
            provider = snapshot["providers"][0]
            self.assertEqual(provider["windows"][0]["usedPercent"], 37)
            self.assertEqual(provider["updatedAt"], last_good.isoformat())
            self.assertEqual(provider["lastAttemptAt"], now.isoformat())
            self.assertTrue(provider["stale"])
            self.assertNotEqual(snapshot["updatedAt"], last_good.isoformat())
            self.assertTrue(read_provider_usage_snapshot(path, ("deepseek",), now=now + timedelta(seconds=1))["providers"][0]["stale"])
            self.assertEqual(providers_due_for_refresh(snapshot, ("deepseek",), now=now + timedelta(seconds=30)), ())
            self.assertEqual(providers_due_for_refresh(snapshot, ("deepseek",), now=now + timedelta(seconds=61)), ("deepseek",))


if __name__ == "__main__":
    unittest.main()
