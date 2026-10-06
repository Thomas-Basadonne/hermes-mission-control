"""Atomic, freshness-aware snapshots shared by the updater and telemetry API."""

from __future__ import annotations

import fcntl
import json
import math
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
_WRITE_FAILURES: dict[Path, tuple[datetime, tuple[str, ...]]] = {}


def _remember_write_failure(path: Path, providers: tuple[str, ...]) -> None:
    with _REFRESH_GUARD:
        _WRITE_FAILURES[path.resolve()] = (_now(), providers)


def _source_for(provider: str, entry: dict[str, Any] | None = None) -> str:
    source = (entry or {}).get("source", "")
    if isinstance(source, str) and "web" in source.lower().replace("+", "-").split("-"):
        return "codexbar_web"
    # Before a successful result only, preserve the collector's Ollama hint.
    if provider == "ollama" and (source == "" or (source == "cli" and not (entry or {}).get("available"))):
        return "codexbar_web"
    return "codexbar_api"


def _retry_at(provider: str, entry: dict[str, Any], now: datetime, snapshot: dict[str, Any] | None = None) -> datetime | None:
    interval = SOURCE_LIMITS[_source_for(provider, entry)]["min_interval_seconds"]
    raw = entry.get("lastAttemptAt") or entry.get("updatedAt")
    attempted = _parse_timestamp(raw)
    explicit = _parse_timestamp(entry.get("nextRetryAt"))
    if explicit and explicit <= now + timedelta(seconds=1800 + interval):
        minimum = attempted + timedelta(seconds=interval) if attempted and attempted <= now + timedelta(seconds=interval) else None
        return max(explicit, minimum) if minimum else explicit
    if attempted and attempted <= now + timedelta(seconds=interval):
        return attempted + timedelta(seconds=interval)
    if raw is None:
        return None
    # Never trust a broken/far-future clock indefinitely. Use a fixed observation
    # anchor, not the time of each GET (which would continually extend cooldown).
    context = snapshot or {}
    anchor = next((stamp for key in ("updatedAt", "_clockAnchorAt")
                   if (stamp := _parse_timestamp(context.get(key))) and stamp <= now), None)
    if anchor is None:
        anchor = _parse_timestamp(entry.get("updatedAt"))
    if anchor is None or anchor > now:
        anchor = now
    return anchor + timedelta(seconds=interval)


def _metadata(provider: str, entry: dict[str, Any], now: datetime, snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    result = dict(entry)
    policy = SOURCE_LIMITS[_source_for(provider, entry)]
    updated = _parse_timestamp(entry.get("updatedAt"))
    attempted = _parse_timestamp(entry.get("lastAttemptAt") or entry.get("updatedAt"))
    result["dataState"] = "ready" if entry.get("available") else entry.get("dataState", "error")
    result["staleAfterSeconds"] = policy["stale_after_seconds"]
    result["freshUntil"] = (updated + timedelta(seconds=policy["stale_after_seconds"])).isoformat() if updated and updated <= now else None
    retry = _retry_at(provider, entry, now, snapshot)
    result["nextRetryAt"] = retry.isoformat() if retry else None
    raw_attempt = entry.get("lastAttemptAt") or entry.get("updatedAt")
    if raw_attempt and (attempted is None or attempted > now) or (updated and updated > now):
        result["warnings"] = list(dict.fromkeys([*result.get("warnings", []), "clock_skew"]))
    if result.get("refreshState") not in ("running", "failed"):
        result["refreshState"] = "cooldown" if retry and now < retry else "idle"
    result.setdefault("refreshStartedAt", None)
    result.setdefault("refreshDeadlineAt", None)
    if result.get("refreshState") == "running":
        started = _parse_timestamp(entry.get("refreshStartedAt"))
        deadline = _parse_timestamp(entry.get("refreshDeadlineAt"))
        if not (started and started <= now and deadline and now < deadline <= started + timedelta(seconds=1800)):
            result["refreshState"] = "failed"
            result["error"] = "Provider refresh deadline expired."
            result["stale"] = bool(entry.get("available"))
            valid_deadline = started and started <= now and deadline and started < deadline <= started + timedelta(seconds=1800)
            if valid_deadline:
                result["nextRetryAt"] = (deadline + timedelta(seconds=policy["min_interval_seconds"])).isoformat()
    result["stale"] = _is_stale(provider, result, now)
    return result


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
    max_age = SOURCE_LIMITS[_source_for(provider, entry)]["stale_after_seconds"]
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
        if entry.get("refreshState") == "running":
            started = _parse_timestamp(entry.get("refreshStartedAt"))
            deadline = _parse_timestamp(entry.get("refreshDeadlineAt"))
            if started and deadline and started <= current < deadline <= started + timedelta(seconds=1800):
                continue
            if started and started <= current and deadline and started < deadline <= started + timedelta(seconds=1800) and current < deadline + timedelta(seconds=SOURCE_LIMITS[_source_for(provider, entry)]["min_interval_seconds"]):
                continue
        retry = _retry_at(provider, entry, current, snapshot)
        if retry is None or current >= retry:
            due.append(provider)
    return tuple(due)


def _read_snapshot(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as stream:
            payload = json.load(stream)
            modified = os.fstat(stream.fileno()).st_mtime
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"providers": []}
    if not isinstance(payload, dict) or not isinstance(payload.get("providers"), list):
        return {"providers": []}
    if payload.get("schemaVersion", 1) not in (1, 2) or isinstance(payload.get("schemaVersion"), bool):
        return {"providers": [], "error": "Unsupported provider usage snapshot schema.", "warnings": ["unsupported_schema"]}
    normalized = []
    for raw in payload["providers"]:
        entry = normalize_cached_entry(raw)
        if entry is None:
            continue
        if entry["provider"] == "ollama" and not raw.get("source"):
            entry["source"] = "web"
        # Scheduling belongs to the writer, including while migrating v1 caches.
        if raw.get("refreshState") in ("idle", "running", "cooldown", "failed"):
            entry["refreshState"] = raw["refreshState"]
        for key in ("refreshStartedAt", "refreshDeadlineAt", "nextRetryAt"):
            timestamp = _parse_timestamp(raw.get(key))
            if timestamp:
                entry[key] = timestamp.isoformat()
        if raw.get("lastAttemptAt") and _parse_timestamp(raw["lastAttemptAt"]) is None:
            entry["lastAttemptAt"] = "invalid"
        normalized.append(entry)
    return {**payload, "providers": normalized,
            "_clockAnchorAt": datetime.fromtimestamp(modified, timezone.utc).isoformat()}


def read_provider_usage_snapshot(
    path: Path, providers: tuple[str, ...], *, now: datetime | None = None
) -> dict[str, Any]:
    """Return an immediate UI snapshot, filling missing entries with pending states."""
    current = _now(now)
    cached = _read_snapshot(path)
    with _REFRESH_GUARD:
        write_failure = _WRITE_FAILURES.get(path.resolve())
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
        if write_failure and provider in write_failure[1]:
            entry = _merge_attempt(entry, unavailable_provider(provider, "cli", "Provider usage snapshot could not be written."),
                                   provider, write_failure[0].isoformat())
        visible.append(_metadata(provider, entry, current, cached))
    result = {
        "schemaVersion": 2,
        "success": any(entry.get("available") for entry in visible),
        "available": True,
        "updatedAt": current.isoformat(),
        "providers": visible,
    }
    if cached.get("error") == "CodexBar provider catalog is unavailable.":
        result["error"] = cached["error"]
        result["warnings"] = ["catalog_unavailable"]
        for key in ("lastAttemptAt", "nextRetryAt"):
            value = _parse_timestamp(cached.get(key))
            result[key] = value.isoformat() if value else None
    if cached.get("error") == "Unsupported provider usage snapshot schema.":
        result["error"] = cached["error"]
        result["warnings"] = ["unsupported_schema"]
    if write_failure:
        result["error"] = "Provider usage snapshot could not be written."
        result["warnings"] = ["snapshot_write_failed"]
    return result


def _write_snapshot(path: Path, providers: tuple[str, ...], entries: dict[str, dict[str, Any]], now: datetime, *, orchestration: dict[str, Any] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = [entries[provider] for provider in providers if provider in entries]
    payload = {
        "schemaVersion": 2,
        "success": any(entry.get("available") for entry in ordered),
        "available": True,
        "updatedAt": now.isoformat(),
        "providers": ordered,
    }
    if orchestration:
        payload.update(orchestration)
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        with _REFRESH_GUARD:
            _WRITE_FAILURES.pop(path.resolve(), None)
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
    *,
    evaluated_at: datetime | None = None,
) -> dict[str, Any]:
    no_data = bool(fresh and fresh.get("dataState") == "no_data" and not fresh.get("error"))
    if no_data:
        result = dict(previous if previous and previous.get("available") else fresh)
        result["stale"] = bool(result.get("available"))
        result["dataState"] = "ready" if result.get("available") else "no_data"
        result["warnings"] = list(dict.fromkeys([*result.get("warnings", []), "no_data"]))
        result.pop("error", None)
    elif fresh and fresh.get("available"):
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
    result.pop("nextRetryAt", None)
    result["refreshState"] = "idle" if no_data or (fresh and fresh.get("available")) else "failed"
    return _metadata(provider, result, evaluated_at if evaluated_at is not None else _parse_timestamp(attempted_at))


def _catalog_failure(snapshot: dict[str, Any]) -> dict[str, Any] | None:
    if snapshot.get("error") != "CodexBar provider catalog is unavailable.":
        return None
    result = {"error": snapshot["error"]}
    for key in ("lastAttemptAt", "nextRetryAt"):
        value = _parse_timestamp(snapshot.get(key))
        if value:
            result[key] = value.isoformat()
    return result


def refresh_provider_usage_snapshot(
    path: Path,
    providers: tuple[str, ...],
    collector: Callable[[tuple[str, ...]], list[dict[str, Any]]],
    *,
    blocking: bool = True,
    now: datetime | None = None,
    selection: Callable[[], tuple[str, ...]] | None = None,
    clear_discovery_failure: bool = False,
) -> bool:
    """Refresh due providers under a cross-process lock and retain last-good data."""
    with _snapshot_lock(path, blocking=blocking) as locked:
        if not locked:
            return False
        current = _now(now)
        if selection:
            providers = tuple(p for p in providers if p in selection())
        attempted_at = current.isoformat()
        snapshot = _read_snapshot(path)
        orchestration = None if clear_discovery_failure else _catalog_failure(snapshot)
        previous = {
            entry["provider"]: entry
            for entry in snapshot["providers"]
            if isinstance(entry.get("provider"), str)
        }
        due = providers_due_for_refresh(snapshot, providers, now=current)
        if not due:
            if clear_discovery_failure and _catalog_failure(snapshot):
                visible = selection() if selection else tuple(previous)
                _write_snapshot(path, visible, previous, current)
            return False

        entries = {provider: dict(entry) for provider, entry in previous.items()}
        deadline = (current + timedelta(seconds=min(1800, math.ceil(len(due) / 5) * 30 + 60))).isoformat()
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
            pending.update(refreshState="running", refreshStartedAt=attempted_at, refreshDeadlineAt=deadline)
            if previous_entry is None:
                pending.pop("error", None)
        _write_snapshot(path, tuple(entries), entries, current, orchestration=orchestration)

        try:
            fresh_entries = collector(due)
        except Exception:
            fresh_entries = [unavailable_provider(provider, "cli", "Provider refresh failed.") for provider in due]
        fresh = {
            entry["provider"]: entry for raw in fresh_entries
            if (entry := normalize_cached_entry(raw)) is not None and entry["provider"] in due
        }
        # Collector observations can legitimately be newer than the attempt start.
        # Evaluate freshness at completion while keeping cooldown anchored to start.
        completed_at = _now(now)
        for provider in due:
            entries[provider] = _merge_attempt(entries.get(provider), fresh.get(provider), provider, attempted_at,
                                               evaluated_at=completed_at)
        visible = selection() if selection else tuple(entries)
        entries = {provider: entries[provider] for provider in visible if provider in entries}
        _write_snapshot(path, tuple(entries), entries, completed_at, orchestration=orchestration)
        return True


def provider_usage_discovery_is_due(path: Path, *, now: datetime | None = None) -> bool:
    snapshot = _read_snapshot(path)
    retry = _parse_timestamp(snapshot.get("nextRetryAt"))
    return retry is None or _now(now) >= retry


def record_provider_usage_refresh_failure(
    path: Path, providers: tuple[str, ...], error: str, *, now: datetime | None = None, discovery: bool = False,
) -> bool:
    """Persist a safe scheduling failure without overwriting an active owner."""
    try:
        with _snapshot_lock(path, blocking=False) as locked:
            if not locked:
                return False
            current = _now(now)
            snapshot = _read_snapshot(path)
            previous = {entry["provider"]: entry for entry in snapshot["providers"]}
            due = providers_due_for_refresh(snapshot, providers, now=current)
            if not due and not discovery:
                return False
            entries = dict(previous)
            for provider in due:
                entries[provider] = _merge_attempt(previous.get(provider), unavailable_provider(provider, "cli", error),
                                                    provider, current.isoformat())
            orchestration = {"error": error, "lastAttemptAt": current.isoformat(),
                             "nextRetryAt": (current + timedelta(seconds=60)).isoformat()} if discovery else _catalog_failure(snapshot)
            _write_snapshot(path, tuple(entries), entries, current, orchestration=orchestration)
            return True
    except OSError:
        _remember_write_failure(path, providers)
        return False


def request_background_provider_usage_refresh(
    path: Path,
    providers: tuple[str, ...],
    collector: Callable[[tuple[str, ...]], list[dict[str, Any]]],
    *, selection: Callable[[], tuple[str, ...]] | None = None, clear_discovery_failure: bool = False,
) -> threading.Thread | None:
    """Start at most one daemon refresh; API callers never wait for collection."""
    global _REFRESH_ACTIVE
    if not providers_due_for_refresh(read_provider_usage_snapshot(path, providers), providers):
        return None
    with _REFRESH_GUARD:
        if _REFRESH_ACTIVE:
            return None
        _REFRESH_ACTIVE = True

    def refresh() -> None:
        global _REFRESH_ACTIVE
        try:
            refresh_provider_usage_snapshot(path, providers, collector, blocking=False, selection=selection,
                                            clear_discovery_failure=clear_discovery_failure)
        except OSError:
            _remember_write_failure(path, providers)
        finally:
            with _REFRESH_GUARD:
                _REFRESH_ACTIVE = False

    try:
        thread = threading.Thread(target=refresh, name="mc-provider-usage-refresh", daemon=True)
        thread.start()
    except RuntimeError:
        with _REFRESH_GUARD:
            _REFRESH_ACTIVE = False
        try:
            record_provider_usage_refresh_failure(path, providers, "Provider refresh could not start.")
        except OSError:
            _remember_write_failure(path, providers)
        return None
    return thread
