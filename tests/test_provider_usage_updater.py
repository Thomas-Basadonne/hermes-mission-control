"""Tests for the cache writer's selected-provider integration."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "update-provider-usage.py"
sys.path.insert(0, str(ROOT / "server"))
spec = importlib.util.spec_from_file_location("update_provider_usage", SCRIPT)
assert spec and spec.loader
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class ProviderUsageUpdaterTests(unittest.TestCase):
    def test_cache_writer_collects_only_persisted_dynamic_selection(self) -> None:
        catalog = [
            {"provider": "deepseek", "enabled": True, "source": "codexbar"},
            {"provider": "nous", "enabled": True, "source": "mission-control"},
        ]
        deepseek = {"provider": "deepseek", "available": True, "windows": [], "balances": [], "metrics": []}
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(updater, "provider_usage_snapshot_path", return_value=Path(temporary) / "usage.json"),
            patch.object(updater, "discover_codexbar_catalog", create=True, return_value=catalog),
            patch.object(updater, "selected_usage_providers", create=True, return_value=("deepseek", "nous")),
            patch.object(updater, "collect_selected_usage", return_value=[deepseek]) as collect,
        ):
            self.assertEqual(updater.main(), 0)

        self.assertEqual(collect.call_args.args[0], ("deepseek", "nous"))
        self.assertEqual({item["provider"] for item in collect.call_args.args[1]}, {"deepseek", "nous"})


if __name__ == "__main__":
    unittest.main()
