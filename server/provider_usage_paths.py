"""Canonical cache paths for provider usage snapshots."""

from __future__ import annotations

import os
from pathlib import Path

from hermes_paths import hermes_cache_dir

_PROVIDER_USAGE_SNAPSHOT = "mission-control-provider-usage.json"


def provider_usage_snapshot_path() -> Path:
    """Resolve the shared reader/writer path, including the optional override."""
    override = os.environ.get("MISSION_CONTROL_CACHE_DIR", "").strip()
    cache_dir = Path(override).expanduser() if override else hermes_cache_dir()
    return cache_dir / _PROVIDER_USAGE_SNAPSHOT
