"""Tests for selected-provider CodexBar invocation and normalization."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from provider_usage_collector import collect_codexbar_usage
from provider_usage_contract import normalize_codexbar_entry


class ProviderUsageCollectorTests(unittest.TestCase):
    def test_selected_dynamic_ids_are_invoked_individually_and_normalized(self) -> None:
        payload = json.dumps([
            {
                "provider": "deepseek",
                "source": "oauth",
                "usage": {
                    "primary": {"usedPercent": 12, "windowMinutes": 300},
                    "privateField": "must-not-leak",
                },
            },
            {
                "provider": "ollama",
                "source": "web",
                "usage": {"primary": {"usedPercent": 25}},
            },
        ])
        completed = type("Completed", (), {"returncode": 0, "stdout": payload})()
        catalog = [
            {"provider": "deepseek", "source": "codexbar"},
            {"provider": "ollama", "source": "codexbar"},
            {"provider": "nous", "source": "mission-control"},
        ]

        with patch("provider_usage_collector.shutil.which", return_value="/test/codexbar"), \
             patch("provider_usage_collector.subprocess.run", return_value=completed) as run:
            results = collect_codexbar_usage(("deepseek", "ollama"), catalog)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["provider"], "deepseek")
        self.assertEqual(results[0]["windows"][0]["usedPercent"], 12)
        self.assertEqual(results[1]["provider"], "ollama")
        self.assertEqual(run.call_count, 2)
        calls = [call.args[0] for call in run.call_args_list]
        self.assertEqual(calls[0], ["/test/codexbar", "usage", "--provider", "deepseek", "--json", "--no-color"])
        self.assertEqual(calls[1], ["/test/codexbar", "usage", "--provider", "ollama", "--source", "web", "--json", "--no-color"])
        self.assertNotIn("must-not-leak", repr(results))

    def test_unlisted_and_native_ids_never_reach_codexbar_argv(self) -> None:
        catalog = [{"provider": "deepseek", "source": "codexbar"}, {"provider": "nous", "source": "mission-control"}]
        with patch("provider_usage_collector.shutil.which", return_value="/test/codexbar"), \
             patch("provider_usage_collector.subprocess.run") as run:
            results = collect_codexbar_usage(("not-in-catalog", "nous"), catalog)

        run.assert_not_called()
        self.assertEqual([item["provider"] for item in results], ["not-in-catalog"])
        self.assertFalse(results[0]["available"])

    def test_one_provider_failure_does_not_abort_selected_batch(self) -> None:
        successful = type("Completed", (), {
            "returncode": 0,
            "stdout": json.dumps([{"provider": "deepseek", "usage": {"primary": {"usedPercent": 10}}}]),
        })()
        catalog = [
            {"provider": "deepseek", "source": "codexbar"},
            {"provider": "claude", "source": "codexbar"},
        ]
        with patch("provider_usage_collector.shutil.which", return_value="/test/codexbar"), \
             patch("provider_usage_collector.subprocess.run", side_effect=[successful, OSError("private path")]):
            results = collect_codexbar_usage(("deepseek", "claude"), catalog)

        self.assertTrue(results[0]["available"])
        self.assertFalse(results[1]["available"])
        self.assertNotIn("private path", repr(results))

    def test_raw_error_source_timestamp_unit_and_pace_are_not_echoed(self) -> None:
        payload = [{
            "provider": "deepseek",
            "source": "private-source-marker",
            "error": {"message": "private-error-marker"},
            "usage": {
                "updatedAt": "not-a-timestamp",
                "primary": {"usedPercent": 10, "unit": "private-unit-marker"},
                "pace": {"secret": "private-pace-marker"},
            },
        }]

        result = normalize_codexbar_entry("deepseek", payload)

        self.assertFalse(result["available"])
        self.assertEqual(result["source"], "cli")
        self.assertEqual(result["error"], "CodexBar returned a provider error.")
        self.assertNotIn("private-", repr(result))

    def test_generic_details_map_numeric_rows_without_exposing_identity_or_raw_fields(self) -> None:
        payload = [{
            "provider": "deepseek",
            "source": "openai-web",
            "usage": {
                "primary": {"usedPercent": 41},
                "rateWindowLabels": {"primary": "Five-hour quota"},
                "identity": {"accountEmail": "fixture@example.invalid"},
                "details": [{
                    "title": "Account details",
                    "rows": [
                        {"label": "Fast requests", "value": 12},
                        {"label": "Account email", "value": "fixture@example.invalid"},
                        {"label": "Authorization: Bearer private-token-marker", "value": 2},
                        {"label": "Premium active", "value": True},
                    ],
                    "bars": [{"secret": "private-chart-marker"}],
                }],
            },
        }]

        result = normalize_codexbar_entry("deepseek", payload)

        self.assertEqual(result["source"], "openai-web")
        self.assertEqual(result["windows"][0]["label"], "Five-hour quota")
        self.assertEqual([metric["value"] for metric in result["metrics"]], [12, True])
        self.assertNotIn("fixture@example.invalid", repr(result))
        self.assertNotIn("private-token-marker", repr(result))
        self.assertNotIn("private-chart-marker", repr(result))


if __name__ == "__main__":
    unittest.main()
