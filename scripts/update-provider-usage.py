#!/usr/bin/env python3
"""Refresh the provider usage cache using the MC provider contract."""

from __future__ import annotations

import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SERVER_DIR = SCRIPT_DIR.parent / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from hermes_paths import hermes_cache_dir  # noqa: E402
from provider_usage_config import visible_usage_providers  # noqa: E402
from provider_usage_collector import collect_codexbar_usage  # noqa: E402
from provider_usage_snapshot import refresh_provider_usage_snapshot  # noqa: E402


def main() -> int:
    output_dir = Path(os.environ.get("MISSION_CONTROL_CACHE_DIR", "")).expanduser() if os.environ.get("MISSION_CONTROL_CACHE_DIR") else hermes_cache_dir()
    output = output_dir / "mission-control-provider-usage.json"
    refresh_provider_usage_snapshot(output, visible_usage_providers(), collect_codexbar_usage)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
