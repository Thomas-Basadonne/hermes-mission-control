"""Canonical provider-usage cache path resolution."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from provider_usage_paths import provider_usage_snapshot_path


class ProviderUsagePathsTests(unittest.TestCase):
    def test_cache_directory_override_is_used(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, patch.dict(
            os.environ, {"MISSION_CONTROL_CACHE_DIR": temporary}
        ):
            self.assertEqual(
                provider_usage_snapshot_path(),
                Path(temporary) / "mission-control-provider-usage.json",
            )

    def test_default_uses_hermes_cache_directory(self) -> None:
        expected_cache = Path("/synthetic/hermes/cache")
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("provider_usage_paths.hermes_cache_dir", return_value=expected_cache),
        ):
            self.assertEqual(
                provider_usage_snapshot_path(),
                expected_cache / "mission-control-provider-usage.json",
            )


if __name__ == "__main__":
    unittest.main()
