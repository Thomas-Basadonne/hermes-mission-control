#!/usr/bin/env python3
"""Refresh the provider usage cache using the MC provider contract."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
SERVER_DIR = SCRIPT_DIR.parent / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from provider_usage_catalog import ProviderCatalogError, discover_codexbar_catalog  # noqa: E402
from provider_usage_collector import collect_codexbar_usage as collect_dynamic_codexbar_usage  # noqa: E402
from provider_usage_config import selected_usage_providers  # noqa: E402
from provider_usage_paths import provider_usage_snapshot_path  # noqa: E402
from provider_usage_snapshot import refresh_provider_usage_snapshot  # noqa: E402


def collect_codexbar_usage() -> list[dict[str, Any]]:
    """Collect the persisted provider selection without querying Nous."""
    catalog = discover_codexbar_catalog()
    selected = selected_usage_providers(catalog)
    codexbar_selection = tuple(provider for provider in selected if provider != "nous")
    return collect_dynamic_codexbar_usage(codexbar_selection, catalog)


def main() -> int:
    output = provider_usage_snapshot_path()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        catalog = discover_codexbar_catalog()
    except ProviderCatalogError:
        # Discovery failure must not replace the last-known-good snapshot.
        return 1
    selected = selected_usage_providers(catalog)
    codexbar_selection = tuple(provider for provider in selected if provider != "nous")
    refresh_provider_usage_snapshot(
        output,
        codexbar_selection,
        lambda due: collect_dynamic_codexbar_usage(due, catalog),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
