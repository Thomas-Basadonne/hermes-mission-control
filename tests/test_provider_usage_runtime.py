"""Regression tests for provider usage payloads exposed to the UI."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
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
            patch.object(telemetry, "visible_usage_providers", return_value=("codex",)),
            patch.object(telemetry, "hermes_cache_dir", return_value=self._home / "cache"),
            patch.object(telemetry.shutil, "which", return_value="/missing/codexbar"),
            patch.object(telemetry.subprocess, "run", side_effect=FileNotFoundError("codexbar")),
        ):
            snapshot = telemetry.collect_provider_usage()

        self.assertEqual(len(snapshot["providers"]), 1)
        provider = snapshot["providers"][0]
        self.assertFalse(provider["available"])
        self.assertEqual(provider["provider"], "codex")
        self.assertEqual(provider["windows"], [])
        self.assertEqual(provider["balances"], [])
        self.assertEqual(provider["metrics"], [])


if __name__ == "__main__":
    unittest.main()
