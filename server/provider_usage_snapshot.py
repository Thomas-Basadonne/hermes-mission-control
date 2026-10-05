"""Atomic, freshness-aware snapshots shared by the updater and telemetry API."""

from __future__ import annotations

import fcntl
import json
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from provider_usage_contract import normalize_cached_entry, unavailable_provider

SOURCE_LIMITS = {
    "codexbar_api": {"min_interval_seconds": 60, "stale_after_seconds": 300},
    "codexbar_web": {"min_interval_seconds": 300, "stale_after_seconds": 900},
}

_REFRESH_GUARD = threading.Lock()
_REFRESH_ACTIVE = False


def _source_for(provider: str) -> str:
    return "codexbar_web" if provider == "ollama" else "codexbar_api"


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _now(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    return current.astimezone(timezone.utc) if current.tzinfo else current.replace(tzinfo=timezone.utc)


def _is_stale(provider: str, entry: dict[str, Any], now: datetime) -> bool:
    if not entry.get("available"):
        return bool(entry.get("stale", False))
    updated_at = _parse_timestamp(entry.get("updatedAt"))
    if updated_at is None or updated_at > now:
        return True
    max_age = SOURCE_LIMITS[_source_for(provider)]["stale_after_seconds"]
    return bool(entry.get("stale", False)) or now - updated_at > timedelta(seconds=max_age)


def provider_usage_entry_is_stale(
    provider: str, entry: dict[str, Any], *, now: datetime | None = None
) -> bool:
    """Evaluate freshness from this provider's last successful update."""
    return _is_stale(provider, entry, _now(now))


def providers_due_for_refresh(
    snapshot: dict[str, Any], providers: tuple[str, ...], *, now: datetime | None = None
) -> tuple[str, ...]:
    """Apply per-source minimum intervals using persisted attempt timestamps."""
    current = _now(now)
    entries = {
        entry["provider"]: entry
        for entry in snapshot.get("providers", [])
        if isinstance(entry, dict) and isinstance(entry.get("provider"), str)
    }
    due: list[str] = []
    for provider in providers:
        entry = entries.get(provider)
        if entry is None:
            due.append(provider)
            continue
        last_attempt = _parse_timestamp(entry.get("lastAttemptAt") or entry.get("updatedAt"))
        if last_attempt is None:
            due.append(provider)
            continue
        interval = SOURCE_LIMITS[_source_for(provider)]["min_interval_seconds"]
        elapsed = (current - last_attempt).total_seconds()
        if elapsed < 0 or elapsed >= interval:
            due.append(provider)
    return tuple(due)


def _read_snapshot(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"providers": []}
    if not isinstance(payload, dict) or not isinstance(payload.get("providers"), list):
        return {"providers": []}
    normalized = [
        entry
        for raw in payload["providers"]
        if (entry := normalize_cached_entry(raw)) is not None
    ]
    return {**payload, "providers": normalized}


def read_provider_usage_snapshot(
    path: Path, providers: tuple[str, ...], *, now: datetime | None = None
) -> dict[str, Any]:
    """Return an immediate UI snapshot, filling missing entries with pending states."""
    current = _now(now)
    cached = _read_snapshot(path)
    entries = {
        entry["provider"]: entry
        for entry in cached["providers"]
        if isinstance(entry.get("provider"), str)
    }
    visible: list[dict[str, Any]] = []
    for provider in providers:
        entry = entries.get(provider)
        if entry is None:
            entry = unavailable_provider(provider, "cli", "Provider usage refresh pending.")
            entry["updatedAt"] = None
            entry["lastAttemptAt"] = None
            entry["stale"] = False
        else:
            entry = dict(entry)
            entry["stale"] = _is_stale(provider, entry, current)
        visible.append(entry)
    return {
        "schemaVersion": 1,
        "success": any(entry.get("available") for entry in visible),
        "available": True,
        "updatedAt": current.isoformat(),
        "providers": visible,
    }


def _write_snapshot(path: Path, providers: tuple[str, ...], entries: dict[str, dict[str, Any]], now: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = [entries[provider] for provider in providers if provider in entries]
    payload = {
        "schemaVersion": 1,
        "success": any(entry.get("available") for entry in ordered),
        "available": True,
        "updatedAt": now.isoformat(),
        "providers": ordered,
    }
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


@contextmanager
def _snapshot_lock(path: Path, *, blocking: bool) -> Iterator[bool]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(descriptor, 0o600)
    locked = False
    try:
        try:
            operation = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
            fcntl.flock(descriptor, operation)
            locked = True
        except BlockingIOError:
            pass
        yield locked
    finally:
        if locked:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _merge_attempt(
    previous: dict[str, Any] | None,
    fresh: dict[str, Any] | None,
    provider: str,
    attempted_at: str,
) -> dict[str, Any]:
    if fresh and fresh.get("available"):
        result = dict(fresh)
        result["updatedAt"] = result.get("updatedAt") or attempted_at
        result["available"] = True
        result["stale"] = False
        result.pop("error", None)
    elif previous and previous.get("available"):
        result = dict(previous)
        result["stale"] = True
        result["error"] = (fresh or {}).get("error") or "Provider refresh failed."
    else:
        result = dict(fresh or unavailable_provider(provider, "cli", "Provider refresh failed."))
        result["available"] = False
        result["stale"] = False
        result["updatedAt"] = None
    result["lastAttemptAt"] = attempted_at
    return result


def refresh_provider_usage_snapshot(
    path: Path,
    providers: tuple[str, ...],
    collector: Callable[[tuple[str, ...]], list[dict[str, Any]]],
    *,
    blocking: bool = True,
    now: datetime | None = None,
) -> bool:
    """Refresh due providers under a cross-process lock and retain last-good data."""
    with _snapshot_lock(path, blocking=blocking) as locked:
        if not locked:
            return False
        current = _now(now)
        attempted_at = current.isoformat()
        snapshot = _read_snapshot(path)
        previous = {
            entry["provider"]: entry
            for entry in snapshot["providers"]
            if isinstance(entry.get("provider"), str)
        }
        due = providers_due_for_refresh(snapshot, providers, now=current)
        if not due:
            return False

        entries = {provider: dict(entry) for provider, entry in previous.items() if provider in providers}
        for provider in due:
            previous_entry = entries.get(provider)
            if previous_entry is None:
                pending = unavailable_provider(provider, "cli", "Provider usage refresh pending.")
                pending["updatedAt"] = None
                pending["lastAttemptAt"] = attempted_at
                entries[provider] = pending
            else:
                pending = dict(previous_entry)
                pending["lastAttemptAt"] = attempted_at
                entries[provider] = pending
        _write_snapshot(path, providers, entries, current)

        try:
            fresh_entries = collector(due)
        except Exception:
            fresh_entries = [unavailable_provider(provider, "cli", "Provider refresh failed.") for provider in due]
        fresh = {
            entry["provider"]: entry
            for entry in fresh_entries
            if isinstance(entry, dict) and isinstance(entry.get("provider"), str)
        }
        for provider in due:
            entries[provider] = _merge_attempt(entries.get(provider), fresh.get(provider), provider, attempted_at)
        _write_snapshot(path, providers, entries, _now())
        return True


def request_background_provider_usage_refresh(
    path: Path,
    providers: tuple[str, ...],
    collector: Callable[[tuple[str, ...]], list[dict[str, Any]]],
) -> threading.Thread | None:
    """Start at most one daemon refresh; API callers never wait for collection."""
    global _REFRESH_ACTIVE
    if not providers_due_for_refresh(_read_snapshot(path), providers):
        return None
    with _REFRESH_GUARD:
        if _REFRESH_ACTIVE:
            return None
        _REFRESH_ACTIVE = True

    def refresh() -> None:
        global _REFRESH_ACTIVE
        try:
            refresh_provider_usage_snapshot(path, providers, collector, blocking=False)
        finally:
            with _REFRESH_GUARD:
                _REFRESH_ACTIVE = False

    thread = threading.Thread(target=refresh, name="mc-provider-usage-refresh", daemon=True)
    thread.start()
    return thread
