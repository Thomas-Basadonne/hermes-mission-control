"""Local visibility and presentation configuration for provider usage."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from hermes_paths import get_hermes_home, hermes_root

BUILTIN_USAGE_PROVIDERS = ("codex", "ollama", "openrouter", "nous")
_USAGE_CONFIG_FILENAME = "mission-control-usage.json"
_USAGE_CONFIG_LOCK = threading.Lock()
_PROVIDER_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_LEGACY_DEFAULT_PROVIDERS = ("codex", "ollama", "openrouter", "nous")


def visible_usage_providers() -> tuple[str, ...]:
    """Return the locally configured provider allowlist in stable order.

    ``MISSION_CONTROL_USAGE_PROVIDERS`` is intentionally local configuration,
    loaded by the telemetry launcher from the external environment file.
    An unset or blank value keeps every built-in provider visible.
    """
    raw = os.environ.get("MISSION_CONTROL_USAGE_PROVIDERS", "").strip()
    if not raw:
        return BUILTIN_USAGE_PROVIDERS

    configured = {item.strip().lower() for item in raw.split(",") if item.strip()}
    return tuple(provider for provider in BUILTIN_USAGE_PROVIDERS if provider in configured)


def is_usage_provider_visible(provider: str) -> bool:
    return provider.strip().lower() in visible_usage_providers()


def _provider_ceiling() -> set[str] | None:
    raw = os.environ.get("MISSION_CONTROL_USAGE_PROVIDERS", "").strip()
    if not raw:
        return None
    return {item.strip().lower() for item in raw.split(",") if _PROVIDER_ID.fullmatch(item.strip().lower())}


def usage_provider_selectable(provider: str, *, enabled: bool, source: str) -> bool:
    """Whether MC may collect this provider under CodexBar and admin policy."""
    ceiling = _provider_ceiling()
    return (source == "mission-control" or enabled) and (ceiling is None or provider in ceiling)


def stored_usage_providers(*, config: dict[str, Any] | None = None) -> tuple[str, ...]:
    """Return saved IDs without catalog validation, for last-known-good display."""
    config = _load_config() if config is None else config
    saved = config.get("selectedProviders")
    configured = (
        [provider for provider in saved if isinstance(provider, str) and _PROVIDER_ID.fullmatch(provider)]
        if isinstance(saved, list)
        else list(_LEGACY_DEFAULT_PROVIDERS)
    )
    ceiling = _provider_ceiling()
    if ceiling is not None:
        configured = [provider for provider in configured if provider in ceiling]
    return tuple(dict.fromkeys(configured))


def selected_usage_providers(catalog: list[dict[str, Any]], *, config: dict[str, Any] | None = None) -> tuple[str, ...]:
    """Resolve persisted MC selection against the current catalog and ceiling."""
    available: list[str] = []
    collectable: set[str] = set()
    for item in catalog:
        if not isinstance(item, dict):
            continue
        provider = item.get("provider")
        if not isinstance(provider, str) or not _PROVIDER_ID.fullmatch(provider) or provider in available:
            continue
        available.append(provider)
        if item.get("enabled") is True:
            collectable.add(provider)
        elif item.get("source") == "mission-control":
            collectable.add(provider)

    configured = set(stored_usage_providers(config=config)) & collectable

    ceiling = _provider_ceiling()
    if ceiling is not None:
        configured &= ceiling
    return tuple(provider for provider in available if provider in configured)


def save_selected_usage_providers(selected: Any, catalog_ids: set[str]) -> list[str]:
    """Preserve the existing internal/CLI interface; HTTP writes must use CAS."""
    return _save_selected_usage_providers(selected, catalog_ids)["selectedProviders"]


class ProviderUsageSelectionConflict(ValueError):
    """The selection changed after the caller read its revision."""


def _selection_revision(config: dict[str, Any]) -> str:
    # Include the IDs to detect manual edits, and a nonce to prevent ABA/replay.
    state = [config.get("selectedProviders", list(_LEGACY_DEFAULT_PROVIDERS)), config.get("selectionRevision")]
    return hashlib.sha256(json.dumps(state, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def selected_usage_provider_snapshot(catalog: list[dict[str, Any]]) -> dict[str, Any]:
    """Read canonical IDs and their write-fencing revision from the same state."""
    with _USAGE_CONFIG_LOCK:
        config = _load_config()
        return {"selectedProviders": list(selected_usage_providers(catalog, config=config)),
                "selectionRevision": _selection_revision(config)}


def save_selected_usage_provider_snapshot(selected: Any, catalog_ids: set[str], expected_revision: str) -> dict[str, Any]:
    return _save_selected_usage_providers(selected, catalog_ids, expected_revision)


def _save_selected_usage_providers(selected: Any, catalog_ids: set[str], expected_revision: str | None = None) -> dict[str, Any]:
    """Atomically persist validated MC selections, preserving display rules."""
    if not isinstance(selected, list) or len(selected) > 256:
        raise ValueError("selectedProviders must be a list of at most 256 IDs.")

    valid_ids = {
        provider for provider in catalog_ids
        if isinstance(provider, str) and _PROVIDER_ID.fullmatch(provider)
    }
    normalized: list[str] = []
    for provider in selected:
        if not isinstance(provider, str) or not _PROVIDER_ID.fullmatch(provider):
            raise ValueError("selectedProviders contains an invalid provider ID.")
        if provider not in valid_ids:
            raise ValueError("selectedProviders contains an unknown provider ID.")
        if provider not in normalized:
            normalized.append(provider)

    ceiling = _provider_ceiling()
    if ceiling is not None and not set(normalized).issubset(ceiling):
        raise ValueError("selectedProviders exceeds the Mission Control provider allowlist.")

    with _USAGE_CONFIG_LOCK:
        config = _load_config()
        if expected_revision is not None and expected_revision != _selection_revision(config):
            raise ProviderUsageSelectionConflict("Provider selection changed since last read.")
        config["selectedProviders"] = normalized
        config["selectionRevision"] = uuid.uuid4().hex
        path = _config_paths()[0]
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(config, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except BaseException:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return {"selectedProviders": normalized, "selectionRevision": _selection_revision(config)}


def _config_paths() -> list[Path]:
    override = os.environ.get("MISSION_CONTROL_USAGE_CONFIG_FILE", "").strip()
    if override:
        return [Path(override).expanduser()]

    paths = [
        get_hermes_home() / _USAGE_CONFIG_FILENAME,
        hermes_root() / _USAGE_CONFIG_FILENAME,
    ]
    unique: list[Path] = []
    for path in paths:
        resolved = path.resolve(strict=False)
        if resolved not in unique:
            unique.append(resolved)
    return unique


def _load_config() -> dict[str, Any]:
    for path in _config_paths():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def _configured_ids(section: Any, key: str) -> set[str]:
    if not isinstance(section, dict):
        return set()
    values = section.get(key)
    if not isinstance(values, list):
        return set()
    return {value.strip() for value in values if isinstance(value, str) and value.strip()}


def apply_provider_display_config(entry: dict[str, Any]) -> dict[str, Any]:
    """Apply local hidden/featured rules without changing provider semantics."""
    provider = entry.get("provider")
    if not isinstance(provider, str):
        return dict(entry)

    providers = _load_config().get("providers")
    provider_config = providers.get(provider) if isinstance(providers, dict) else None
    if not isinstance(provider_config, dict):
        return dict(entry)

    hidden = provider_config.get("hidden")
    featured = provider_config.get("featured")
    result = dict(entry)
    for collection_name in ("windows", "balances", "metrics"):
        items = entry.get(collection_name)
        if not isinstance(items, list):
            continue
        hidden_ids = _configured_ids(hidden, collection_name)
        featured_ids = _configured_ids(featured, collection_name)
        normalized: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            if isinstance(item_id, str) and item_id in hidden_ids:
                continue
            clone = dict(item)
            clone.pop("featured", None)
            if isinstance(item_id, str) and item_id in featured_ids:
                clone["featured"] = True
            normalized.append(clone)
        result[collection_name] = normalized
    return result
