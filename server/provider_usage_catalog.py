"""Discover CodexBar provider metadata without fetching provider usage."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from typing import Any


class ProviderCatalogError(RuntimeError):
    """Safe, user-facing catalog discovery failure."""


_PROVIDER_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MAX_CATALOG_BYTES = 512 * 1024
_MAX_PROVIDERS = 256
_MAX_DISPLAY_NAME = 80
_CODEXBAR_FALLBACK = "/opt/homebrew/bin/codexbar"


def parse_provider_catalog(stdout: str) -> list[dict[str, Any]]:
    """Return bounded, sanitized descriptors from ``config providers --json``."""
    if not isinstance(stdout, str) or len(stdout.encode("utf-8")) > _MAX_CATALOG_BYTES:
        raise ProviderCatalogError("CodexBar provider catalog is invalid.")
    try:
        payload = json.loads(stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ProviderCatalogError("CodexBar provider catalog is invalid.") from exc
    if not isinstance(payload, list) or len(payload) > _MAX_PROVIDERS:
        raise ProviderCatalogError("CodexBar provider catalog is invalid.")

    providers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        provider = item.get("provider")
        display_name = item.get("displayName")
        enabled = item.get("enabled")
        default_enabled = item.get("defaultEnabled")
        if (
            not isinstance(provider, str)
            or not _PROVIDER_ID.fullmatch(provider)
            or provider == "nous"
            or provider in seen
            or not isinstance(display_name, str)
            or not display_name.strip()
            or len(display_name) > _MAX_DISPLAY_NAME
            or not isinstance(enabled, bool)
            or not isinstance(default_enabled, bool)
        ):
            continue
        seen.add(provider)
        providers.append({
            "provider": provider,
            "displayName": display_name.strip(),
            "enabled": enabled,
            "defaultEnabled": default_enabled,
            "source": "codexbar",
        })

    providers.sort(key=lambda item: (item["displayName"].casefold(), item["provider"]))
    return providers


def discover_codexbar_catalog(executable: str | None = None) -> list[dict[str, Any]]:
    """Run CodexBar's local metadata command; never invoke authenticated usage."""
    command = executable or shutil.which("codexbar") or _CODEXBAR_FALLBACK
    try:
        completed = subprocess.run(
            [command, "config", "providers", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProviderCatalogError("CodexBar provider catalog is unavailable.") from exc
    if completed.returncode != 0:
        raise ProviderCatalogError("CodexBar provider catalog is unavailable.")
    return parse_provider_catalog(completed.stdout)
