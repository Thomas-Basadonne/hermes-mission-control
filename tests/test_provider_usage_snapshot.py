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
    def test_collection_timestamps_are_evaluated_at_completion_not_start(self):
        from unittest.mock import patch
        started = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        completed = started + timedelta(seconds=6)
        observed = started + timedelta(seconds=4)
        fresh = {"provider": "codex", "available": True, "source": "oauth",
                 "updatedAt": observed.isoformat(), "warnings": ["unknown_currency"],
                 "windows": [{"id": "primary", "label": "Session", "usedPercent": 64}],
                 "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            clock = [started]
            def collect(due):
                clock[0] = completed
                return [fresh]
            with patch("provider_usage_snapshot._now", side_effect=lambda value=None: value or clock[0]):
                self.assertTrue(refresh_provider_usage_snapshot(path, ("codex",), collect))
            persisted = json.loads(path.read_text())
            entry = persisted["providers"][0]
            self.assertFalse(entry["stale"], "collection duration is not clock skew")
            self.assertEqual(entry["warnings"], ["unknown_currency"])
            self.assertEqual(entry["updatedAt"], observed.isoformat())
            self.assertEqual(entry["lastAttemptAt"], started.isoformat())
            self.assertEqual(entry["nextRetryAt"], (started + timedelta(seconds=60)).isoformat())
            self.assertEqual(entry["freshUntil"], (observed + timedelta(seconds=300)).isoformat())
            self.assertEqual(persisted["updatedAt"], completed.isoformat())
            later = read_provider_usage_snapshot(path, ("codex",), now=completed + timedelta(seconds=10))
            self.assertFalse(later["providers"][0]["stale"])

    def test_successful_refresh_replaces_cached_false_clock_skew(self):
        from unittest.mock import patch
        started = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        completed = started + timedelta(seconds=6)
        old = {"provider": "nous", "available": True, "source": "portal-account",
               "updatedAt": (started - timedelta(seconds=60)).isoformat(),
               "lastAttemptAt": (started - timedelta(seconds=61)).isoformat(),
               "stale": True, "warnings": ["clock_skew"], "freshUntil": None,
               "windows": [], "balances": [{"id": "subscription", "label": "Remaining", "value": 2}], "metrics": []}
        fresh = {"provider": "nous", "available": True, "source": "portal-account",
                 "updatedAt": (started + timedelta(milliseconds=500)).isoformat(),
                 "windows": [], "balances": [{"id": "subscription", "label": "Remaining", "value": 3}], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            path.write_text(json.dumps({"schemaVersion": 2, "providers": [old]}))
            clock = [started]
            def collect(due):
                clock[0] = completed
                return [fresh]
            with patch("provider_usage_snapshot._now", side_effect=lambda value=None: value or clock[0]):
                self.assertTrue(refresh_provider_usage_snapshot(path, ("nous",), collect))
            entry = read_provider_usage_snapshot(path, ("nous",), now=completed)["providers"][0]
            self.assertFalse(entry["stale"])
            self.assertNotIn("clock_skew", entry.get("warnings", []))
            self.assertEqual(entry["balances"][0]["value"], 3)
            self.assertEqual(entry["lastAttemptAt"], started.isoformat())

    def test_collector_timestamp_after_completion_is_still_clock_skew(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        fresh = {"provider": "codex", "available": True, "source": "oauth",
                 "updatedAt": (now + timedelta(seconds=30)).isoformat(),
                 "windows": [{"id": "primary", "label": "Session", "usedPercent": 64}],
                 "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            self.assertTrue(refresh_provider_usage_snapshot(path, ("codex",), lambda due: [fresh], now=now))
            entry = read_provider_usage_snapshot(path, ("codex",), now=now)["providers"][0]
            self.assertTrue(entry["stale"])
            self.assertIn("clock_skew", entry["warnings"])
            self.assertIsNone(entry["freshUntil"])

    def test_retry_metadata_cannot_bypass_source_minimum_interval(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        for source, interval in (("api", 60), ("oauth+web", 300)):
            entry = {"provider": "deepseek", "available": True, "source": source,
                     "lastAttemptAt": now.isoformat(), "updatedAt": now.isoformat(),
                     "nextRetryAt": (now - timedelta(seconds=1)).isoformat()}
            self.assertEqual(providers_due_for_refresh({"providers": [entry]}, ("deepseek",), now=now), ())
            self.assertEqual(providers_due_for_refresh({"providers": [entry]}, ("deepseek",), now=now + timedelta(seconds=interval)), ("deepseek",))

    def test_reader_does_not_restat_a_snapshot_replaced_after_open(self):
        from unittest.mock import patch
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        entry = {"provider": "deepseek", "available": True, "source": "api", "updatedAt": now.isoformat(),
                 "windows": [{"id": "primary", "label": "Quota", "usedPercent": 37}], "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            path.write_text(json.dumps({"providers": [entry]}))
            with patch.object(Path, "stat", side_effect=FileNotFoundError("snapshot replaced after open")):
                try:
                    result = read_provider_usage_snapshot(path, ("deepseek",), now=now)
                except OSError:
                    result = None
            self.assertIsNotNone(result, "reader discarded an already-open atomic snapshot")
            self.assertEqual(result["providers"][0]["windows"][0]["usedPercent"], 37)

    def test_unknown_snapshot_schema_is_not_interpreted_or_rewritten_by_reader(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        entry = {"provider": "deepseek", "available": True, "source": "api", "updatedAt": now.isoformat(),
                 "windows": [{"id": "primary", "label": "Quota", "usedPercent": 37}], "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            for version in (1, 2):
                path.write_text(json.dumps({"schemaVersion": version, "providers": [entry]}))
                before = path.read_bytes()
                self.assertTrue(read_provider_usage_snapshot(path, ("deepseek",), now=now)["providers"][0]["available"])
                self.assertEqual(path.read_bytes(), before)
            path.write_text(json.dumps({"schemaVersion": 3, "providers": [entry]}))
            before = path.read_bytes()
            result = read_provider_usage_snapshot(path, ("deepseek",), now=now)
            self.assertFalse(result["providers"][0]["available"], "future schema is not the current wire contract")
            self.assertIn("unsupported_schema", result["warnings"])
            self.assertEqual(path.read_bytes(), before)

    def test_successful_cli_source_overrides_initial_ollama_web_hint(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        entry = {"provider": "ollama", "available": True, "source": "cli", "updatedAt": now.isoformat(),
                 "windows": [{"id": "primary", "label": "Quota", "usedPercent": 37}], "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            refresh_provider_usage_snapshot(path, ("ollama",), lambda due: [entry], now=now)
            result = read_provider_usage_snapshot(path, ("ollama",), now=now)["providers"][0]
            self.assertEqual(result["staleAfterSeconds"], 300, "source policy must override the pre-success provider hint")
            self.assertEqual(result["nextRetryAt"], (now + timedelta(seconds=60)).isoformat())

    def test_writer_reconstructs_collector_output_before_private_atomic_publication(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        raw = {"provider": "deepseek", "available": True, "source": "api", "updatedAt": now.isoformat(),
               "windows": [{"id": "primary", "label": "Quota", "usedPercent": 37}], "balances": [], "metrics": [],
               "rawAccount": {"secret": "never-store-private-payload"}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            refresh_provider_usage_snapshot(path, ("deepseek",), lambda due: [raw], now=now)
            self.assertNotIn("never-store-private-payload", path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["providers"][0]["windows"][0]["usedPercent"], 37)

    def test_expired_read_view_respects_retry_and_corrupt_lease_cannot_block_forever(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        entry = {"provider": "deepseek", "available": False, "source": "api", "updatedAt": None,
                 "lastAttemptAt": now.isoformat(), "refreshState": "running", "refreshStartedAt": now.isoformat(),
                 "refreshDeadlineAt": (now + timedelta(seconds=90)).isoformat(),
                 "windows": [], "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            path.write_text(json.dumps({"updatedAt": now.isoformat(), "providers": [entry]}))
            expired = read_provider_usage_snapshot(path, ("deepseek",), now=now + timedelta(seconds=91))
            self.assertEqual(providers_due_for_refresh(expired, ("deepseek",), now=now + timedelta(seconds=91)), (), "read view bypassed lease retry anchor")
            self.assertEqual(providers_due_for_refresh(expired, ("deepseek",), now=now + timedelta(seconds=151)), ("deepseek",))
            entry["refreshDeadlineAt"] = "2099-01-01T00:00:00Z"
            path.write_text(json.dumps({"updatedAt": now.isoformat(), "providers": [entry]}))
            invalid = read_provider_usage_snapshot(path, ("deepseek",), now=now)
            retry = datetime.fromisoformat(invalid["providers"][0]["nextRetryAt"])
            self.assertLessEqual(retry, now + timedelta(seconds=60), "invalid lease gave an unbounded retry")
            self.assertEqual(providers_due_for_refresh({"providers": [entry]}, ("deepseek",), now=now + timedelta(seconds=61)), ("deepseek",))

    def test_valid_no_data_after_success_preserves_last_good_without_failure(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        from provider_usage_contract import normalize_codexbar_entry
        good = {"provider": "deepseek", "available": True, "source": "api", "updatedAt": (now - timedelta(seconds=600)).isoformat(),
                "windows": [{"id": "primary", "label": "Quota", "usedPercent": 37}], "balances": [], "metrics": []}
        empty = normalize_codexbar_entry("deepseek", [{"provider": "deepseek", "source": "api", "usage": {}}])
        empty["dataState"] = "no_data"
        empty["available"] = False
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            path.write_text(json.dumps({"providers": [good]}))
            refresh_provider_usage_snapshot(path, ("deepseek",), lambda due: [empty], now=now)
            entry = json.loads(path.read_text())["providers"][0]
            self.assertNotIn("error", entry, "valid empty data must not masquerade as a failed request")
            self.assertEqual(entry["dataState"], "ready")
            self.assertEqual(entry["windows"][0]["usedPercent"], 37)
            self.assertEqual(entry["updatedAt"], good["updatedAt"])
            self.assertIn("no_data", entry["warnings"])
            self.assertNotEqual(entry["refreshState"], "failed")
            path.unlink()
            refresh_provider_usage_snapshot(path, ("deepseek",), lambda due: [empty], now=now)
            entry = json.loads(path.read_text())["providers"][0]
            self.assertEqual(entry["dataState"], "no_data")
            self.assertFalse(entry["available"])
            self.assertNotIn("error", entry)

    def test_actual_successful_web_source_drives_freshness_and_attempt_policy(self):
        now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
        fresh = {"provider": "deepseek", "available": True, "source": "oauth+web",
                 "updatedAt": now.isoformat(), "windows": [{"id": "primary", "label": "Quota", "usedPercent": 37}],
                 "balances": [], "metrics": []}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "usage.json"
            self.assertTrue(refresh_provider_usage_snapshot(path, ("deepseek",), lambda due: [fresh], now=now))
            snapshot = read_provider_usage_snapshot(path, ("deepseek",), now=now + timedelta(seconds=301))
            entry = snapshot["providers"][0]
            self.assertFalse(entry["stale"], "successful web data must not use API expiry")
            self.assertEqual(entry["staleAfterSeconds"], 900)
            self.assertEqual(entry["freshUntil"], (now + timedelta(seconds=900)).isoformat())
            self.assertEqual(entry["nextRetryAt"], (now + timedelta(seconds=300)).isoformat())
            self.assertEqual(entry["dataState"], "ready")
            self.assertEqual(entry["refreshState"], "idle")
            self.assertEqual(snapshot["schemaVersion"], 2)
            self.assertEqual(providers_due_for_refresh(snapshot, ("deepseek",), now=now + timedelta(seconds=61)), ())

    def test_future_last_attempt_has_finite_prudent_cooldown(self) -> None:
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

        self.assertEqual(providers_due_for_refresh(snapshot, ("ollama",), now=now), ())
        self.assertEqual(providers_due_for_refresh(snapshot, ("ollama",), now=now + timedelta(seconds=331)), ("ollama",))
        for value in ("2099-01-01T00:00:00Z", "invalid"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as temporary:
                snapshot["updatedAt"] = now.isoformat()
                snapshot["providers"][0]["lastAttemptAt"] = value
                path = Path(temporary) / "usage.json"
                path.write_text(json.dumps(snapshot))
                entry = read_provider_usage_snapshot(path, ("ollama",), now=now)["providers"][0]
                self.assertEqual(entry["nextRetryAt"], (now + timedelta(seconds=300)).isoformat())
                self.assertIn("clock_skew", entry["warnings"])
                self.assertEqual(providers_due_for_refresh(snapshot, ("ollama",), now=now), ())
                self.assertEqual(providers_due_for_refresh(snapshot, ("ollama",), now=now + timedelta(seconds=301)), ("ollama",))

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
