"""Regression tests for provider usage payloads exposed to the UI."""

from __future__ import annotations

import os
import sys
import subprocess
import tempfile
import unittest
import importlib.util
import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import local_telemetry_server as telemetry
import provider_usage_collector as collector
import nous_portal_usage
import provider_usage_snapshot as snapshots


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
            patch.object(collector.shutil, "which", return_value="/missing/codexbar"),
            patch.object(collector.subprocess, "run", side_effect=FileNotFoundError("codexbar")),
        ):
            provider = collector.collect_codexbar_provider("codex")

        self.assertFalse(provider["available"])
        self.assertEqual(provider["provider"], "codex")
        self.assertEqual(provider["windows"], [])
        self.assertEqual(provider["balances"], [])
        self.assertEqual(provider["metrics"], [])

    def test_nous_usage_comes_from_codexbar_instead_of_the_portal_adapter(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "codexbar-nous-usage.json"
        codexbar_output = fixture_path.read_text(encoding="utf-8")
        completed = subprocess.CompletedProcess(
            args=["/fake/codexbar", "usage", "--provider", "nous"],
            returncode=0,
            stdout=codexbar_output,
            stderr="",
        )

        with (
            patch.object(collector.shutil, "which", return_value="/fake/codexbar"),
            patch.object(collector, "refresh_nous_session_if_expiring", return_value=False),
            patch.object(collector.subprocess, "run", return_value=completed) as run,
        ):
            provider = collector.collect_codexbar_provider("nous")

        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/fake/codexbar", "usage", "--provider", "nous"])
        self.assertEqual(provider["provider"], "nous")
        self.assertTrue(provider["available"])
        self.assertEqual(provider["balances"][-1]["id"], "total_spendable")
        self.assertEqual(provider["balances"][-1]["value"], 74.25)
        self.assertEqual(provider["metrics"], [])

    def test_shared_collector_keeps_going_after_a_provider_failure(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "codexbar-nous-usage.json"
        nous_output = fixture_path.read_text(encoding="utf-8")
        codexbar_calls = [
            subprocess.TimeoutExpired(cmd="codexbar usage --provider codex", timeout=30),
            subprocess.CompletedProcess(["codexbar", "usage", "--provider", "ollama"], 0, "[]", ""),
            subprocess.CompletedProcess(["codexbar", "usage", "--provider", "nous"], 0, nous_output, ""),
        ]

        with (
            patch.object(collector, "visible_usage_providers", return_value=("codex", "ollama", "nous")),
            patch.object(collector.shutil, "which", return_value="/fake/codexbar"),
            patch.object(collector, "refresh_nous_session_if_expiring", return_value=False),
            patch.object(collector.subprocess, "run", side_effect=codexbar_calls) as run,
        ):
            providers = collector.collect_codexbar_usage()

        self.assertEqual([provider["provider"] for provider in providers], ["codex", "ollama", "nous"])
        self.assertFalse(providers[0]["available"])
        self.assertTrue(providers[0]["error"].endswith("timed out."))
        self.assertFalse(providers[1]["available"])
        self.assertTrue(providers[2]["available"])
        self.assertIn("--source", run.call_args_list[1].args[0])
        self.assertIn("web", run.call_args_list[1].args[0])

    def test_nous_refresh_runs_through_hermes_before_codexbar(self) -> None:
        auth_path = self._home / "auth.json"
        auth_path.write_text(
            json.dumps({"providers": {"nous": {"expires_at": "2000-01-01T00:00:00Z"}}}),
            encoding="utf-8",
        )
        fixture_path = Path(__file__).parent / "fixtures" / "codexbar-nous-usage.json"
        nous_output = fixture_path.read_text(encoding="utf-8")
        commands: list[list[str]] = []

        def run_command(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[1:] == ["portal", "info"]:
                auth_path.write_text(
                    json.dumps({"providers": {"nous": {"expires_at": "2099-01-01T00:00:00Z"}}}),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, nous_output, "")

        with (
            patch.object(collector.shutil, "which", return_value="/fake/codexbar"),
            patch.object(nous_portal_usage, "_hermes_cli_path", return_value="/fake/hermes"),
            patch.object(collector.subprocess, "run", side_effect=run_command),
        ):
            providers = collector.collect_codexbar_usage(("nous",))

        self.assertEqual([command[1:] for command in commands], [
            ["portal", "info"],
            ["usage", "--provider", "nous", "--json", "--no-color"],
        ])
        self.assertTrue(providers[0]["available"])

    def test_cache_updater_uses_the_shared_collector(self) -> None:
        provider_snapshot = {
            "provider": "nous",
            "available": False,
            "source": "cli",
            "windows": [],
            "balances": [],
            "metrics": [],
        }
        script_path = Path(__file__).resolve().parents[1] / "scripts" / "update-provider-usage.py"
        spec = importlib.util.spec_from_file_location("update_provider_usage_test", script_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        updater = importlib.util.module_from_spec(spec)
        cache_dir = self._home / "cache-output"

        with (
            patch.object(collector, "collect_codexbar_usage", return_value=[provider_snapshot]) as collect,
            patch.dict(os.environ, {
                "MISSION_CONTROL_CACHE_DIR": str(cache_dir),
                "MISSION_CONTROL_USAGE_PROVIDERS": "nous",
            }),
        ):
            spec.loader.exec_module(updater)
            self.assertEqual(updater.main(), 0)

        collect.assert_called_once_with(("nous",))
        cached = json.loads((cache_dir / "mission-control-provider-usage.json").read_text(encoding="utf-8"))
        self.assertEqual(cached["providers"][0]["provider"], "nous")
        self.assertFalse(cached["providers"][0]["available"])
        self.assertIsNotNone(cached["providers"][0]["lastAttemptAt"])

    def test_cache_updater_preserves_last_good_provider_data_on_failure(self) -> None:
        script_path = Path(__file__).resolve().parents[1] / "scripts" / "update-provider-usage.py"
        spec = importlib.util.spec_from_file_location("update_provider_usage_lkg_test", script_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        updater = importlib.util.module_from_spec(spec)
        cache_dir = self._home / "cache-lkg"
        cache_dir.mkdir()
        cache_path = cache_dir / "mission-control-provider-usage.json"
        updated_at = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        previous = {
            "provider": "codex",
            "available": True,
            "source": "oauth",
            "updatedAt": updated_at,
            "stale": False,
            "windows": [{"id": "primary", "label": "Session", "usedPercent": 23}],
            "balances": [],
            "metrics": [],
        }
        cache_path.write_text(json.dumps({"schemaVersion": 1, "providers": [previous]}), encoding="utf-8")
        failed = {
            "provider": "codex",
            "available": False,
            "source": "cli",
            "error": "CodexBar timed out.",
            "windows": [],
            "balances": [],
            "metrics": [],
        }

        with (
            patch.object(collector, "collect_codexbar_usage", return_value=[failed]) as collect,
            patch.dict(os.environ, {
                "MISSION_CONTROL_CACHE_DIR": str(cache_dir),
                "MISSION_CONTROL_USAGE_PROVIDERS": "codex",
            }),
        ):
            spec.loader.exec_module(updater)
            self.assertEqual(updater.main(), 0)

        collect.assert_called_once_with(("codex",))
        cached = json.loads(cache_path.read_text(encoding="utf-8"))["providers"][0]
        self.assertTrue(cached["available"])
        self.assertTrue(cached["stale"])
        self.assertEqual(cached["windows"], previous["windows"])
        self.assertEqual(cached["updatedAt"], updated_at)
        self.assertEqual(cached["error"], "CodexBar timed out.")
        self.assertIsNotNone(cached.get("lastAttemptAt"))

    def test_provider_usage_get_does_not_wait_for_a_slow_collector(self) -> None:
        started = threading.Event()
        release = threading.Event()
        returned = threading.Event()
        result: list[dict[str, object]] = []
        background_threads: list[threading.Thread] = []

        def slow_collector(providers: tuple[str, ...]) -> list[dict[str, object]]:
            started.set()
            release.wait(timeout=2)
            return []

        def request_snapshot() -> None:
            result.append(telemetry.collect_provider_usage())
            returned.set()

        def schedule_refresh(path, providers, collect):
            thread = snapshots.request_background_provider_usage_refresh(path, providers, collect)
            if thread is not None:
                background_threads.append(thread)
            return thread

        with (
            patch.object(telemetry, "visible_usage_providers", return_value=("codex",)),
            patch.object(telemetry, "hermes_cache_dir", return_value=self._home / "cache-nonblocking"),
            patch.object(telemetry, "collect_codexbar_usage", side_effect=slow_collector),
            patch.object(telemetry, "request_background_provider_usage_refresh", side_effect=schedule_refresh),
        ):
            request = threading.Thread(target=request_snapshot, daemon=True)
            request.start()
            try:
                self.assertTrue(started.wait(timeout=1), "refresh worker never started")
                returned_while_refresh_blocked = returned.wait(timeout=0.1)
                self.assertEqual(result[0]["providers"][0]["error"], "Provider usage refresh pending.")
            finally:
                release.set()
                request.join(timeout=2)
                if background_threads:
                    background_threads[0].join(timeout=2)

        self.assertTrue(returned_while_refresh_blocked, "provider usage request waited for CodexBar")
        self.assertEqual(len(result), 1)

    def test_provider_snapshots_use_source_specific_freshness_and_refresh_limits(self) -> None:
        now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
        cache_path = self._home / "provider-source-limits.json"
        providers = [
            {
                "provider": "codex",
                "available": True,
                "source": "oauth",
                "updatedAt": (now - timedelta(seconds=301)).isoformat(),
                "lastAttemptAt": (now - timedelta(seconds=61)).isoformat(),
                "windows": [], "balances": [], "metrics": [],
            },
            {
                "provider": "ollama",
                "available": True,
                "source": "web",
                "updatedAt": (now - timedelta(seconds=901)).isoformat(),
                "lastAttemptAt": (now - timedelta(seconds=61)).isoformat(),
                "windows": [], "balances": [], "metrics": [],
            },
        ]
        cache_path.write_text(json.dumps({"schemaVersion": 1, "providers": providers}), encoding="utf-8")

        snapshot = snapshots.read_provider_usage_snapshot(cache_path, ("codex", "ollama"), now=now)
        due = snapshots.providers_due_for_refresh(snapshot, ("codex", "ollama"), now=now)

        self.assertEqual([entry["stale"] for entry in snapshot["providers"]], [True, True])
        self.assertEqual(due, ("codex",))

    def test_successful_refresh_records_data_and_attempt_timestamps_per_provider(self) -> None:
        now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
        cache_path = self._home / "provider-success.json"
        data_at = (now - timedelta(seconds=10)).isoformat()
        fresh = {
            "provider": "codex",
            "available": True,
            "source": "oauth",
            "updatedAt": data_at,
            "windows": [], "balances": [], "metrics": [],
        }

        refreshed = snapshots.refresh_provider_usage_snapshot(
            cache_path,
            ("codex",),
            lambda providers: [fresh],
            now=now,
        )
        cached = json.loads(cache_path.read_text(encoding="utf-8"))["providers"][0]

        self.assertTrue(refreshed)
        self.assertEqual(cached["updatedAt"], data_at)
        self.assertEqual(cached["lastAttemptAt"], now.isoformat())
        self.assertFalse(cached["stale"])

    def test_refreshing_keeps_last_good_state_until_collection_finishes(self) -> None:
        now = datetime.now(timezone.utc)
        cache_path = self._home / "provider-refreshing.json"
        previous = {
            "provider": "codex",
            "available": True,
            "source": "oauth",
            "updatedAt": (now - timedelta(seconds=61)).isoformat(),
            "lastAttemptAt": (now - timedelta(seconds=61)).isoformat(),
            "stale": False,
            "windows": [{"id": "primary", "label": "Session", "usedPercent": 23}],
            "balances": [],
            "metrics": [],
        }
        cache_path.write_text(json.dumps({"schemaVersion": 1, "providers": [previous]}), encoding="utf-8")
        started, release = threading.Event(), threading.Event()

        def slow_collector(_providers):
            started.set()
            release.wait(timeout=2)
            return []

        worker = threading.Thread(
            target=snapshots.refresh_provider_usage_snapshot,
            args=(cache_path, ("codex",), slow_collector),
            kwargs={"blocking": False},
        )
        worker.start()
        try:
            self.assertTrue(started.wait(timeout=1), "collector did not start")
            staged = json.loads(cache_path.read_text(encoding="utf-8"))["providers"][0]
            self.assertFalse(staged["stale"])
            self.assertNotIn("error", staged)
            self.assertEqual(staged["windows"], previous["windows"])
            self.assertNotEqual(staged["lastAttemptAt"], previous["lastAttemptAt"])
        finally:
            release.set()
            worker.join(timeout=2)

        self.assertFalse(worker.is_alive(), "refresh worker did not finish")

    def test_background_refresh_does_not_spawn_inside_source_cooldown(self) -> None:
        now = datetime.now(timezone.utc)
        cache_path = self._home / "provider-cooldown.json"
        entry = {
            "provider": "codex",
            "available": True,
            "source": "oauth",
            "updatedAt": now.isoformat(),
            "lastAttemptAt": now.isoformat(),
            "windows": [], "balances": [], "metrics": [],
        }
        cache_path.write_text(json.dumps({"schemaVersion": 1, "providers": [entry]}), encoding="utf-8")
        calls: list[tuple[str, ...]] = []

        thread = snapshots.request_background_provider_usage_refresh(
            cache_path,
            ("codex",),
            lambda providers: calls.append(providers) or [],
        )
        if thread is not None:
            thread.join(timeout=2)

        self.assertIsNone(thread)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
