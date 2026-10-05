"""Tests for the cache writer's selected-provider integration."""

from __future__ import annotations

import importlib.util
import sys
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
            patch.object(updater, "discover_codexbar_catalog", create=True, return_value=catalog),
            patch.object(updater, "selected_usage_providers", create=True, return_value=("deepseek", "nous")),
            patch.object(updater, "collect_dynamic_codexbar_usage", create=True, return_value=[deepseek]) as collect,
        ):
            results = updater.collect_codexbar_usage()

        collect.assert_called_once_with(("deepseek",), catalog)
        self.assertEqual(results, [deepseek])


if __name__ == "__main__":
    unittest.main()
