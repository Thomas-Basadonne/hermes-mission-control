"""Tests for Hermes-owned Nous session refresh and CodexBar normalization."""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

nous_portal_usage = importlib.import_module("nous_portal_usage")
from provider_usage_contract import normalize_cached_entry, normalize_codexbar_entry


class NousPortalUsageTests(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="mc-nous-usage-"))
        self._home_backup = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self._tmp / "hermes")
        (self._tmp / "hermes").mkdir()

    def tearDown(self):
        if self._home_backup is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._home_backup
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_normalizes_codexbar_windows_and_provider_metrics(self):
        result = normalize_codexbar_entry(
            "codex",
            [{
                "provider": "codex",
                "source": "oauth",
                "usage": {
                    "primary": {"usedPercent": 12, "resetsAt": "2026-09-01T00:00:00Z", "windowMinutes": 300},
                    "secondary": {"usedPercent": 20, "windowMinutes": 10080},
                    "codexResetCredits": {"availableCount": 2},
                },
                "credits": {"remaining": 4},
            }],
        )

        self.assertEqual([window["id"] for window in result["windows"]], ["primary", "secondary"])
        self.assertEqual(result["windows"][0]["usedPercent"], 12)
        self.assertEqual(result["balances"][0]["value"], 4)
        self.assertEqual(result["metrics"][0]["value"], 2)

    def test_normalizes_codexbar_nous_snapshot_without_losing_detail_rows(self):
        fixture_path = Path(__file__).parent / "fixtures" / "codexbar-nous-usage.json"
        payload = json.loads(fixture_path.read_text(encoding="utf-8"))

        result = normalize_codexbar_entry("nous", payload)

        self.assertTrue(result["available"])
        self.assertEqual(result["source"], "api")
        self.assertEqual(result["plan"], "Ultra")
        self.assertEqual(result["renewsAt"], "2026-10-12T04:29:00Z")
        self.assertEqual(result["windows"], [{
            "id": "subscription",
            "label": "Subscription",
            "usedPercent": 75,
            "resetsAt": "2026-10-12T04:29:00Z",
            "remaining": 55.0,
            "total": 220.0,
            "unit": "USD",
        }])
        self.assertEqual(result["metrics"], [])
        self.assertEqual(
            [(balance["id"], balance["value"]) for balance in result["balances"]],
            [
                ("subscription_remaining", 55.0),
                ("rollover_credits", 4.0),
                ("topup_remaining", 19.25),
                ("total_spendable", 74.25),
            ],
        )
        self.assertEqual(result["windows"][0]["remaining"], 55.0)
        self.assertEqual(result["windows"][0]["total"], 220.0)
        self.assertEqual(result["windows"][0]["unit"], "USD")

    def test_nous_detail_rows_are_allowlisted_and_value_checked(self):
        fixture_path = Path(__file__).parent / "fixtures" / "codexbar-nous-usage.json"
        payload = json.loads(fixture_path.read_text(encoding="utf-8"))
        payload[0]["pace"] = {"token": "[REDACTED]"}
        payload[0]["usage"]["details"][0]["rows"].extend([
            {"label": "Account email", "value": "owner@example.test"},
            {"label": "Session token", "value": "Bearer [REDACTED]"},
            {"label": "Top-up credits", "value": "Bearer [REDACTED]"},
            {"label": "Top-up credits", "value": "$" + "9" * 70},
            {"label": "Oversized " + "x" * 64, "value": "$5.00"},
        ])

        result = normalize_codexbar_entry("nous", payload)

        self.assertEqual(
            [balance["id"] for balance in result["balances"]],
            ["subscription_remaining", "rollover_credits", "topup_remaining", "total_spendable"],
        )
        serialized = json.dumps(result)
        self.assertNotIn("owner@example.test", serialized)
        self.assertNotIn("[REDACTED]", serialized)

        payload[0]["usage"]["identity"]["loginMethod"] = "owner@example.test"
        self.assertNotIn("plan", normalize_codexbar_entry("nous", payload))

    def test_cached_contract_drops_unknown_fields_and_unapproved_metrics(self):
        result = normalize_cached_entry({
            "provider": "nous",
            "available": True,
            "source": "api",
            "windows": [],
            "balances": [],
            "metrics": [{
                "id": "session_token",
                "label": "Session token",
                "value": "Bearer [REDACTED]",
            }],
            "plan": "owner@example.test",
            "pace": {"token": "[REDACTED]"},
            "unexpected": "[REDACTED]",
        })

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["metrics"], [])
        self.assertNotIn("pace", result)
        self.assertNotIn("plan", result)
        self.assertNotIn("unexpected", result)


    def test_codexbar_preflight_refreshes_only_an_expiring_hermes_token(self):
        auth_path = self._tmp / "hermes" / "auth.json"
        auth_path.write_text(
            json.dumps({
                "providers": {
                    "nous": {
                        "access_token": "expired-access",
                        "expires_at": "2000-01-01T00:00:00Z",
                    }
                }
            }),
            encoding="utf-8",
        )
        fake_cli = self._tmp / "fake-hermes-cli"
        fake_cli.write_text("#!/bin/sh\n", encoding="utf-8")
        refresh = getattr(nous_portal_usage, "refresh_nous_session_if_expiring", None)
        self.assertTrue(callable(refresh), "CodexBar collector needs Hermes-owned refresh preflight")

        with patch.object(nous_portal_usage, "_hermes_cli_path", return_value=str(fake_cli)), \
             patch.object(
                 nous_portal_usage.subprocess,
                 "run",
                 return_value=subprocess.CompletedProcess([str(fake_cli), "portal", "info"], 0, "", ""),
             ) as run:
            refresh()

        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][1:], ["portal", "info"])

    def test_valid_hermes_token_does_not_invoke_refresh(self):
        auth_path = self._tmp / "hermes" / "auth.json"
        auth_path.write_text(
            json.dumps({"providers": {"nous": {"expires_at": "2099-01-01T00:00:00Z"}}}),
            encoding="utf-8",
        )
        refresh = nous_portal_usage.refresh_nous_session_if_expiring

        with patch.object(nous_portal_usage, "_hermes_cli_path") as cli_path, \
             patch.object(nous_portal_usage.subprocess, "run") as run:
            self.assertFalse(refresh())

        cli_path.assert_not_called()
        run.assert_not_called()

if __name__ == "__main__":
    unittest.main()
