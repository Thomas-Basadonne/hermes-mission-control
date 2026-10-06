"""Offline regressions for the single snapshot owner (F8–F10)."""
from __future__ import annotations

import json
import multiprocessing
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
import local_telemetry_server as telemetry
import nous_portal_usage as nous
import provider_usage_snapshot as snapshots


def good(provider="nous", value=37, observed=None, source="portal-account"):
    return {"provider": provider, "available": True, "source": source,
            "updatedAt": (observed or datetime.now(timezone.utc)).isoformat(),
            "windows": [{"id": "primary", "label": "Quota", "usedPercent": value}],
            "balances": [], "metrics": []}


def process_writer(path, entered, release, now, crash=False):
    from provider_usage_collector import collect_selected_usage

    def remote():
        entered.set()
        if not release.wait(8):
            raise RuntimeError("test release missing")
        if crash:
            os._exit(17)
        return good(observed=now)

    with patch.object(nous, "fetch_nous_portal_usage", side_effect=remote):
        snapshots.refresh_provider_usage_snapshot(Path(path), ("nous",), lambda due: collect_selected_usage(due, []), now=now)


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mc-orchestration-")
        self.path = Path(self.temporary.name) / "usage.json"
        self.addCleanup(self.temporary.cleanup)

    def test_successful_discovery_clears_root_failure_without_bypassing_provider_cooldown(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        snapshots.record_provider_usage_refresh_failure(self.path, (), "CodexBar provider catalog is unavailable.", now=now, discovery=True)
        snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: [good(observed=now)], now=now)
        self.assertIn("error", snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now))
        calls = []
        snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: calls.append(due), now=now,
                                                  clear_discovery_failure=True)
        self.assertEqual(calls, [])
        snapshot = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now)
        self.assertNotIn("error", snapshot)
        self.assertEqual(snapshot["providers"][0]["windows"][0]["usedPercent"], 37)
        self.assertEqual(snapshot["providers"][0]["lastAttemptAt"], now.isoformat())

    def test_catalog_thread_constructor_failure_releases_latch(self):
        telemetry.reset_provider_usage_catalog_cache()
        with (patch.object(telemetry, "_PROVIDER_USAGE_CATALOG_REFRESH_RUNNING", False),
              patch.object(telemetry.threading, "Thread", side_effect=RuntimeError("synthetic"))):
            try:
                started = telemetry._schedule_provider_usage_catalog_refresh()
            except RuntimeError:
                started = "exception"
            self.assertFalse(telemetry._PROVIDER_USAGE_CATALOG_REFRESH_RUNNING)
            self.assertFalse(started)
        telemetry.reset_provider_usage_catalog_cache()

    def test_standalone_writer_failure_returns_safe_status_and_memory_diagnostic(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("write_failure_updater", ROOT / "scripts/update-provider-usage.py")
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        with (patch.object(updater, "provider_usage_snapshot_path", return_value=self.path),
              patch.object(updater, "stored_usage_providers", return_value=("deepseek",)),
              patch.object(updater, "selected_usage_providers", return_value=("deepseek",)),
              patch.object(updater, "discover_codexbar_catalog", return_value=[{"provider": "deepseek", "source": "codexbar", "enabled": True}]),
              patch.object(snapshots, "_write_snapshot", side_effect=PermissionError("private path")),
              patch.object(updater, "collect_selected_usage", side_effect=AssertionError("cannot collect before attempt"))):
            try:
                result = updater.main()
            except OSError:
                result = "exception"
            self.assertEqual(result, 1, "CLI must return a safe failure instead of a private traceback")
            snapshot = snapshots.read_provider_usage_snapshot(self.path, ("deepseek",))
            self.assertEqual(snapshot["error"], "Provider usage snapshot could not be written.")
            self.assertFalse(self.path.exists())

    def test_common_pool_bounds_native_and_cli_siblings_and_isolates_failure(self):
        from provider_usage_collector import collect_selected_usage
        release, five_entered = threading.Event(), threading.Event()
        lock = threading.Lock()
        active = [0]
        maximum = [0]
        results, errors = [], []
        providers = ("nous", *tuple(f"provider-{index}" for index in range(8)))

        def remote(provider="nous", catalog_ids=None):
            with lock:
                active[0] += 1
                maximum[0] = max(maximum[0], active[0])
                if active[0] == 5:
                    five_entered.set()
            if not release.wait(5):
                raise RuntimeError("test release missing")
            with lock:
                active[0] -= 1
            if provider == "provider-1":
                raise RuntimeError("private exception not allowed in output")
            return good(provider)

        def collect():
            try:
                results.extend(collect_selected_usage(providers, []))
            except BaseException as exc:
                errors.append(exc)

        with (patch.object(nous, "fetch_nous_portal_usage", side_effect=remote),
              patch("provider_usage_collector.collect_codexbar_provider", side_effect=remote)):
            worker = threading.Thread(target=collect)
            worker.start()
            try:
                self.assertTrue(five_entered.wait(3))
                self.assertEqual(maximum[0], 5)
            finally:
                release.set()
                worker.join(3)
        self.assertEqual(errors, [])
        self.assertEqual([entry["provider"] for entry in results], list(providers))
        self.assertEqual(sum(bool(entry["available"]) for entry in results), len(providers) - 1)
        self.assertLessEqual(maximum[0], 5)
        self.assertNotIn("private exception", json.dumps(results))

    def test_writer_oserror_is_observable_without_sticky_latch_or_unhandled_thread(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        errors = []
        for startup in (False, True):
            with self.subTest(startup=startup):
                self.path.unlink(missing_ok=True)
                with (patch.object(snapshots, "_now", return_value=now),
                      patch.object(snapshots, "_write_snapshot", side_effect=PermissionError("private path")),
                      patch.object(threading, "excepthook", side_effect=errors.append),
                      patch.object(threading.Thread, "start", side_effect=RuntimeError("synthetic")) if startup else patch.object(nous, "_read_nous_state", side_effect=AssertionError("must not read auth"))):
                    try:
                        thread = snapshots.request_background_provider_usage_refresh(self.path, ("nous",), lambda due: self.fail("writer failed before collector"))
                        if thread:
                            thread.join(3)
                    except OSError:
                        errors.append("scheduling exception")
                    self.assertEqual(errors, [], "writer failure must not escape request/worker")
                    self.assertFalse(snapshots._REFRESH_ACTIVE)
                    snapshot = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now)
                    self.assertEqual(snapshot.get("error"), "Provider usage snapshot could not be written.")
                    entry = snapshot["providers"][0]
                    self.assertEqual(entry["refreshState"], "failed")
                    self.assertEqual(entry["nextRetryAt"], (now + timedelta(seconds=60)).isoformat())
                    self.assertIsNone(snapshots.request_background_provider_usage_refresh(self.path, ("nous",), lambda due: self.fail("retry before cooldown")))
                    self.assertFalse(self.path.exists(), "must not claim disk persistence")
                with patch.object(snapshots, "_now", return_value=now + timedelta(seconds=61)):
                    thread = snapshots.request_background_provider_usage_refresh(self.path, ("nous",), lambda due: [good(observed=now + timedelta(seconds=61))])
                    self.assertIsNotNone(thread)
                    thread.join(3)
                    self.assertNotIn("error", snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now + timedelta(seconds=61)))

    def test_cross_process_lock_includes_native_nous_and_releases_after_crash(self):
        from provider_usage_collector import collect_selected_usage
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        context = multiprocessing.get_context("spawn")
        for crash in (False, True):
            with self.subTest(crash=crash):
                self.path.unlink(missing_ok=True)
                entered, release = context.Event(), context.Event()
                process = context.Process(target=process_writer, args=(str(self.path), entered, release, now, crash))
                process.start()
                try:
                    self.assertTrue(entered.wait(5), "child native collector did not enter")
                    self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(self.path.with_name("usage.json.lock").stat().st_mode & 0o777, 0o600)
                    pending = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now)["providers"][0]
                    self.assertEqual(pending["refreshState"], "running")
                    before = self.path.read_bytes()
                    with patch.object(nous, "fetch_nous_portal_usage", side_effect=AssertionError("duplicate native fetch")) as duplicate:
                        self.assertFalse(snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: collect_selected_usage(due, []), blocking=False, now=now + timedelta(seconds=151)))
                        self.assertFalse(snapshots.record_provider_usage_refresh_failure(self.path, ("nous",), "Provider refresh failed.", now=now + timedelta(seconds=151)))
                    duplicate.assert_not_called()
                    self.assertEqual(self.path.read_bytes(), before)
                finally:
                    release.set()
                    process.join(5)
                    if process.is_alive():
                        process.terminate()
                        process.join(3)
                self.assertEqual(process.exitcode, 17 if crash else 0)
                if crash:
                    with patch.object(nous, "fetch_nous_portal_usage", return_value=good(value=42, observed=now + timedelta(seconds=151))) as recovered:
                        self.assertTrue(snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: collect_selected_usage(due, []), now=now + timedelta(seconds=151)))
                    recovered.assert_called_once()
                else:
                    with patch.object(nous, "fetch_nous_portal_usage", side_effect=AssertionError("cooldown bypass")) as duplicate:
                        self.assertFalse(snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: collect_selected_usage(due, []), now=now + timedelta(seconds=30)))
                    duplicate.assert_not_called()
                entry = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now + timedelta(seconds=151))["providers"][0]
                self.assertEqual(entry["windows"][0]["usedPercent"], 42 if crash else 37)
                self.assertEqual(entry["updatedAt"], (now + timedelta(seconds=151)).isoformat() if crash else now.isoformat())

    def test_missing_nous_collects_during_catalog_outage_and_failure_retries_once_per_interval(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        self.path.write_text(json.dumps({"providers": [good("deepseek", observed=now - timedelta(seconds=600), source="api")]}))
        from provider_usage_contract import unavailable_provider
        clock = [now]
        with (patch.object(telemetry, "provider_usage_catalog_snapshot", return_value={"available": False, "providers": []}),
              patch.object(telemetry, "stored_usage_providers", return_value=("deepseek", "nous")),
              patch.object(telemetry, "provider_usage_snapshot_path", return_value=self.path),
              patch.object(snapshots, "_now", side_effect=lambda value=None: value or clock[0]),
              patch.object(nous, "fetch_nous_portal_usage", return_value=unavailable_provider("nous", "portal-account", "Provider refresh failed.")) as remote,
              patch.object(telemetry.subprocess, "run", side_effect=AssertionError("catalog outage cannot invoke CLI"))):
            telemetry.collect_provider_usage()
            writer = next((t for t in threading.enumerate() if t.name == "mc-provider-usage-refresh"), None)
            if writer:
                writer.join(3)
            for _ in range(3):
                snapshot = telemetry.collect_provider_usage()
            self.assertEqual(remote.call_count, 1)
            self.assertEqual([item["provider"] for item in snapshot["providers"]], ["deepseek", "nous"])
            self.assertEqual(snapshot["providers"][0]["windows"][0]["usedPercent"], 37)
            self.assertEqual(snapshot["providers"][1]["refreshState"], "failed")
            clock[0] = now + timedelta(seconds=61)
            telemetry.collect_provider_usage()
            writer = next((t for t in threading.enumerate() if t.name == "mc-provider-usage-refresh"), None)
            if writer:
                writer.join(3)
            self.assertEqual(remote.call_count, 2)

    def test_selection_change_during_collection_cannot_republish_removed_provider(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        selection = ["nous", "deepseek"]
        entered, release = threading.Event(), threading.Event()
        failures = []

        def collect(due):
            entered.set()
            release.wait(5)
            return [good(provider, observed=now) for provider in due]

        def refresh():
            try:
                snapshots.refresh_provider_usage_snapshot(self.path, tuple(selection), collect, now=now, selection=lambda: tuple(selection))
            except BaseException as exc:
                failures.append(exc)
                entered.set()

        worker = threading.Thread(target=refresh)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            self.assertEqual(failures, [], "writer must resolve current selection at publication")
            selection[:] = ["deepseek"]
        finally:
            release.set()
            worker.join(3)
        self.assertEqual([entry["provider"] for entry in json.loads(self.path.read_text())["providers"]], ["deepseek"])

    def test_standalone_catalog_outage_does_not_block_selected_native_nous(self):
        import importlib.util
        from provider_usage_catalog import ProviderCatalogError
        spec = importlib.util.spec_from_file_location("native_outage_updater", ROOT / "scripts/update-provider-usage.py")
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        with (patch.object(updater, "provider_usage_snapshot_path", return_value=self.path),
              patch.object(updater, "stored_usage_providers", return_value=("deepseek", "nous")),
              patch.object(updater, "discover_codexbar_catalog", side_effect=ProviderCatalogError("synthetic")),
              patch.object(updater, "collect_selected_usage", return_value=[good()]) as collect):
            self.assertEqual(updater.main(), 1)
        collect.assert_called_once_with(("nous",), [])
        snapshot = snapshots.read_provider_usage_snapshot(self.path, ("deepseek", "nous"))
        self.assertTrue(snapshot["providers"][1]["available"])
        self.assertEqual(snapshot["error"], "CodexBar provider catalog is unavailable.")
        clock = datetime.now(timezone.utc) + timedelta(seconds=61)
        snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: [good(observed=clock)], now=clock)
        self.assertEqual(snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=clock)["error"], snapshot["error"], "native refresh erased catalog failure")

    def test_discovery_failure_without_ids_is_visible_as_root_error(self):
        import importlib.util
        from provider_usage_catalog import ProviderCatalogError
        spec = importlib.util.spec_from_file_location("root_failure_updater", ROOT / "scripts/update-provider-usage.py")
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        with (patch.object(updater, "provider_usage_snapshot_path", return_value=self.path),
              patch.object(updater, "stored_usage_providers", return_value=()),
              patch.object(updater, "discover_codexbar_catalog", side_effect=ProviderCatalogError("synthetic"))):
            self.assertEqual(updater.main(), 1)
        snapshot = snapshots.read_provider_usage_snapshot(self.path, ())
        self.assertEqual(snapshot.get("error"), "CodexBar provider catalog is unavailable.")
        self.assertEqual(snapshot["providers"], [])
        self.assertTrue(snapshot["nextRetryAt"])

    def test_standalone_discovery_failure_persists_attempt_and_does_not_rediscover_during_backoff(self):
        import importlib.util
        from provider_usage_catalog import ProviderCatalogError
        spec = importlib.util.spec_from_file_location("orchestration_updater", ROOT / "scripts/update-provider-usage.py")
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        self.path.write_text(json.dumps({"providers": [good("deepseek", observed=now - timedelta(seconds=600), source="api")]}))
        with (patch.object(updater, "provider_usage_snapshot_path", return_value=self.path),
              patch.object(updater, "stored_usage_providers", return_value=("deepseek",), create=True),
              patch.object(updater, "discover_codexbar_catalog", side_effect=ProviderCatalogError("private details")) as discovery,
              patch.object(snapshots, "_now", return_value=now)):
            self.assertEqual(updater.main(), 1)
            entry = json.loads(self.path.read_text())["providers"][0]
            self.assertEqual(entry.get("lastAttemptAt"), now.isoformat(), "discovery failure was ignored")
            self.assertEqual(entry["refreshState"], "failed")
            self.assertEqual(entry["windows"][0]["usedPercent"], 37)
            self.assertEqual(entry["nextRetryAt"], (now + timedelta(seconds=60)).isoformat())
            self.assertNotIn("private details", self.path.read_text())
            self.assertEqual(updater.main(), 1)
            self.assertEqual(discovery.call_count, 1)

    def test_thread_creation_failure_releases_latch_and_persists_backoff(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        for seam in ("start", "constructor"):
            with self.subTest(seam=seam):
                self.path.unlink(missing_ok=True)
                self.path.write_text(json.dumps({"providers": [good(observed=now - timedelta(seconds=600))]}))
                snapshots._REFRESH_ACTIVE = False
                target = patch.object(snapshots.threading.Thread, "start", side_effect=RuntimeError("synthetic")) if seam == "start" else patch.object(snapshots.threading, "Thread", side_effect=RuntimeError("synthetic"))
                with patch.object(snapshots, "_now", return_value=now), target:
                    try:
                        thread = snapshots.request_background_provider_usage_refresh(self.path, ("nous",), lambda due: self.fail("must not collect"))
                    except RuntimeError:
                        thread = "exception"
                self.assertFalse(snapshots._REFRESH_ACTIVE, "thread failure left sticky latch")
                self.assertIsNone(thread)
                entry = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now)["providers"][0]
                self.assertEqual(entry["refreshState"], "failed")
                self.assertEqual(entry["updatedAt"], (now - timedelta(seconds=600)).isoformat())
                self.assertEqual(entry["nextRetryAt"], (now + timedelta(seconds=60)).isoformat())
                self.assertEqual(snapshots.providers_due_for_refresh({"providers": [entry]}, ("nous",), now=now + timedelta(seconds=30)), ())
                with patch.object(snapshots, "_now", return_value=now + timedelta(seconds=61)):
                    thread = snapshots.request_background_provider_usage_refresh(self.path, ("nous",), lambda due: [good(value=42, observed=now + timedelta(seconds=61))])
                    self.assertIsNotNone(thread)
                    thread.join(3)
                self.assertFalse(snapshots._REFRESH_ACTIVE)

    def test_running_attempt_has_finite_deadline_then_crashed_writer_can_recover(self):
        now = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        entered, release = threading.Event(), threading.Event()
        failures = []

        def collector(due):
            entered.set()
            release.wait(5)
            return [good(observed=now)]

        def refresh():
            try:
                snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), collector, now=now)
            except BaseException as exc:
                failures.append(exc)

        worker = threading.Thread(target=refresh)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            entry = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now)["providers"][0]
            self.assertEqual(entry.get("refreshState"), "running", "attempt must be visible before collection")
            self.assertNotIn("error", entry, "running missing data is not a failed attempt")
            self.assertEqual(entry["refreshStartedAt"], now.isoformat())
            self.assertEqual(entry["refreshDeadlineAt"], (now + timedelta(seconds=90)).isoformat())
            self.assertEqual(snapshots.providers_due_for_refresh({"providers": [entry]}, ("nous",), now=now + timedelta(seconds=61)), ())
            expired = snapshots.read_provider_usage_snapshot(self.path, ("nous",), now=now + timedelta(seconds=91))
            self.assertEqual(expired["providers"][0]["refreshState"], "failed")
            self.assertFalse(snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: self.fail("lock bypassed"), blocking=False, now=now + timedelta(seconds=151)))
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(failures, [])
        # A dead owner leaves running on disk; expired leases must be retryable.
        cached = json.loads(self.path.read_text())
        cached["providers"][0].update(refreshState="running", refreshStartedAt=now.isoformat(),
                                      refreshDeadlineAt=(now + timedelta(seconds=90)).isoformat())
        self.path.write_text(json.dumps(cached))
        called = []
        self.assertTrue(snapshots.refresh_provider_usage_snapshot(self.path, ("nous",), lambda due: called.append(due) or [good(value=42, observed=now + timedelta(seconds=151))], now=now + timedelta(seconds=151)))
        self.assertEqual(called, [("nous",)])

    def test_get_returns_before_blocked_native_fetch_and_never_spawns_updater(self):
        entered, release, returned = threading.Event(), threading.Event(), threading.Event()
        requests = []
        errors = []

        def remote():
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test release missing")
            return good()

        def get():
            try:
                requests.append(telemetry.collect_provider_usage())
            except BaseException as exc:
                errors.append(exc)
            finally:
                returned.set()

        with (patch.object(telemetry, "provider_usage_catalog_snapshot", return_value={
                  "available": True, "providers": [{"provider": "nous", "source": "mission-control", "enabled": True}]}),
              patch.object(telemetry, "selected_usage_providers", return_value=("nous",)),
              patch.object(telemetry, "provider_usage_snapshot_path", return_value=self.path),
              patch.object(telemetry, "collect_nous_portal_usage", side_effect=remote, create=True),
              patch.object(nous, "fetch_nous_portal_usage", side_effect=remote) as fetch,
              patch.object(telemetry.subprocess, "run", side_effect=AssertionError("GET must not spawn"))):
            request = threading.Thread(target=get)
            request.start()
            try:
                self.assertTrue(entered.wait(3), "mock native fetch did not enter")
                self.assertTrue(returned.wait(2), "GET waited for native remote fetch")
                self.assertEqual(errors, [])
                telemetry.collect_provider_usage()
                self.assertEqual(fetch.call_count, 1)
            finally:
                release.set()
                request.join(3)
                with snapshots._REFRESH_GUARD:
                    pass
            # Wait on the actual writer finishing, without a timing assumption.
            thread = next((t for t in threading.enumerate() if t.name == "mc-provider-usage-refresh"), None)
            if thread:
                thread.join(3)
        self.assertTrue(self.path.exists())
        self.assertEqual(json.loads(self.path.read_text())["providers"][0]["windows"][0]["usedPercent"], 37)


if __name__ == "__main__":
    unittest.main()
