"""Tests for safe discovery of CodexBar provider metadata."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from provider_usage_catalog import ProviderCatalogError, discover_codexbar_catalog, parse_provider_catalog


class ProviderUsageCatalogTests(unittest.TestCase):
    def test_parse_sanitizes_deduplicates_sorts_and_reserves_native_nous(self) -> None:
        payload = [
            {
                "provider": "deepseek",
                "displayName": "DeepSeek",
                "enabled": False,
                "defaultEnabled": False,
                "apiKey": "must-not-leak",
            },
            {
                "provider": "codex",
                "displayName": "Codex",
                "enabled": True,
                "defaultEnabled": True,
            },
            {
                "provider": "deepseek",
                "displayName": "Duplicate must be ignored",
                "enabled": True,
                "defaultEnabled": True,
            },
            {
                "provider": "nous",
                "displayName": "Nous from CodexBar",
                "enabled": True,
                "defaultEnabled": True,
            },
            {
                "provider": "bad/provider",
                "displayName": "Invalid ID",
                "enabled": True,
                "defaultEnabled": True,
            },
            {
                "provider": "oversized",
                "displayName": "x" * 81,
                "enabled": True,
                "defaultEnabled": True,
            },
        ]

        result = parse_provider_catalog(json.dumps(payload))

        self.assertEqual([item["provider"] for item in result], ["codex", "deepseek"])
        self.assertEqual(result[1]["displayName"], "DeepSeek")
        self.assertFalse(result[1]["enabled"])
        self.assertEqual(result[0]["source"], "codexbar")
        self.assertNotIn("apiKey", repr(result))
        self.assertNotIn("must-not-leak", repr(result))

    def test_invalid_json_raises_safe_catalog_error(self) -> None:
        with self.assertRaises(ProviderCatalogError) as raised:
            parse_provider_catalog("not json")

        self.assertEqual(str(raised.exception), "CodexBar provider catalog is invalid.")

    def test_discovery_invokes_only_read_only_catalog_command(self) -> None:
        completed = type("Completed", (), {
            "returncode": 0,
            "stdout": json.dumps([{
                "provider": "deepseek",
                "displayName": "DeepSeek",
                "enabled": True,
                "defaultEnabled": False,
            }]),
        })()
        with patch("provider_usage_catalog.shutil.which", return_value="/test/codexbar"), \
             patch("provider_usage_catalog.subprocess.run", return_value=completed) as run:
            result = discover_codexbar_catalog()

        run.assert_called_once()
        self.assertEqual(
            run.call_args.args[0],
            ["/test/codexbar", "config", "providers", "--json"],
        )
        self.assertEqual([item["provider"] for item in result], ["deepseek"])

    def test_discovery_does_not_return_raw_process_errors(self) -> None:
        with patch("provider_usage_catalog.shutil.which", return_value="/test/codexbar"), \
             patch("provider_usage_catalog.subprocess.run", side_effect=OSError("secret path")):
            with self.assertRaises(ProviderCatalogError) as raised:
                discover_codexbar_catalog()

        self.assertEqual(str(raised.exception), "CodexBar provider catalog is unavailable.")
        self.assertNotIn("secret path", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
