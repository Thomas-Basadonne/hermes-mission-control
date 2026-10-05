#!/usr/bin/env python3
"""Refresh the provider usage cache using the MC provider contract."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
SERVER_DIR = SCRIPT_DIR.parent / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from hermes_paths import hermes_cache_dir  # noqa: E402
from provider_usage_catalog import discover_codexbar_catalog  # noqa: E402
from provider_usage_collector import collect_codexbar_usage as collect_dynamic_codexbar_usage  # noqa: E402
from provider_usage_config import selected_usage_providers  # noqa: E402


def collect_codexbar_usage() -> list[dict[str, Any]]:
    catalog = discover_codexbar_catalog()
    selected = selected_usage_providers(catalog)
    codexbar_selection = tuple(provider for provider in selected if provider != "nous")
    return collect_dynamic_codexbar_usage(codexbar_selection, catalog)


def main() -> int:
    output_dir = Path(os.environ.get("MISSION_CONTROL_CACHE_DIR", "")).expanduser() if os.environ.get("MISSION_CONTROL_CACHE_DIR") else hermes_cache_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "mission-control-provider-usage.json"
    temporary = output.with_name(f"{output.name}.tmp.{os.getpid()}")
    providers = collect_codexbar_usage()
    payload = {
        "schemaVersion": 1,
        "success": any(provider.get("available") for provider in providers),
        "available": True,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "providers": providers,
    }
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
