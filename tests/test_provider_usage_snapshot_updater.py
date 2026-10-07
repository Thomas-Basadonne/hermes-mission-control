"""The dynamic updater must write through the LKG snapshot manager."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import ANY, patch

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))
spec = importlib.util.spec_from_file_location("update_provider_usage", ROOT / "scripts" / "update-provider-usage.py")
assert spec and spec.loader
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class SnapshotUpdaterTests(unittest.TestCase):
    def test_main_uses_snapshot_manager_for_selected_codexbar_providers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "mission-control-provider-usage.json"
            catalog = [{"provider": "deepseek", "source": "codexbar"}, {"provider": "nous", "source": "mission-control"}]
            with (
                patch.object(updater, "provider_usage_snapshot_path", return_value=cache_path),
                patch.object(updater, "discover_codexbar_catalog", return_value=catalog),
                patch.object(updater, "selected_usage_providers", return_value=("deepseek", "nous")),
                patch.object(updater, "refresh_provider_usage_snapshot", return_value=True) as refresh,
            ):
                self.assertEqual(updater.main(), 0)
            refresh.assert_called_once_with(cache_path, ("deepseek", "nous"), ANY, selection=ANY, clear_discovery_failure=True)


if __name__ == "__main__":
    unittest.main()
