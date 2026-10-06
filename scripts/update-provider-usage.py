#!/usr/bin/env python3
"""CLI entry point for the same snapshot writer used by the telemetry API."""
from __future__ import annotations

import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from provider_usage_catalog import ProviderCatalogError, discover_codexbar_catalog
from provider_usage_collector import collect_selected_usage
from provider_usage_config import selected_usage_providers, stored_usage_providers
from provider_usage_paths import provider_usage_snapshot_path
from provider_usage_snapshot import (provider_usage_discovery_is_due,
                                     record_provider_usage_refresh_failure,
                                     refresh_provider_usage_snapshot)


def _update_usage(output: Path) -> int:
    if not provider_usage_discovery_is_due(output):
        return 1
    try:
        catalog = discover_codexbar_catalog()
    except ProviderCatalogError:
        stored = stored_usage_providers()
        native = tuple(provider for provider in stored if provider == "nous")
        refresh_provider_usage_snapshot(output, native, lambda due: collect_selected_usage(due, []),
                                        blocking=False, selection=stored_usage_providers)
        record_provider_usage_refresh_failure(output, tuple(provider for provider in stored if provider != "nous"),
                                              "CodexBar provider catalog is unavailable.", discovery=True)
        return 1
    catalog = [*catalog, {"provider": "nous", "source": "mission-control", "enabled": True}]
    selected = selected_usage_providers(catalog)
    refresh_provider_usage_snapshot(output, selected, lambda due: collect_selected_usage(due, catalog),
                                    selection=lambda: selected_usage_providers(catalog), clear_discovery_failure=True)
    return 0


def main() -> int:
    output = provider_usage_snapshot_path()
    try:
        return _update_usage(output)
    except OSError:
        record_provider_usage_refresh_failure(output, stored_usage_providers(),
                                              "Provider usage snapshot could not be written.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
