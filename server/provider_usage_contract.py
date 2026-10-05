"""Provider-agnostic usage contract shared by Mission Control adapters.

Every provider entry uses the same small vocabulary:
- ``windows`` for quota or period usage;
- ``balances`` for money/credit balances;
- ``metrics`` for provider counters.

Provider-specific payloads are normalized at the telemetry boundary. The UI does
not need to know whether a value came from CodexBar or another adapter.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional


_SAFE_SOURCES = {"api", "oauth", "web", "cli"}
_SAFE_PLANS = {"Free", "Trial", "Plus", "Pro", "Ultra", "Team", "Enterprise"}
_SAFE_ERRORS = {
    "Unknown provider.", "Invalid CodexBar response.", "Provider not returned by CodexBar.",
    "Provider unavailable.", "CodexBar timed out.", "CodexBar unavailable.",
    "CodexBar returned no data.", "CodexBar returned a provider error.",
    "Provider refresh failed.", "Provider usage refresh pending.",
}
_WINDOW_LABELS = {
    "primary": "Session", "secondary": "Weekly", "tertiary": "Tertiary",
    "subscription": "Subscription",
}
_BALANCE_FIELDS = {
    "balance": ("Balance", "USD", None),
    "credits_remaining": ("Credits remaining", None, "credits"),
    "subscription_remaining": ("Subscription remaining", "USD", None),
    "rollover_credits": ("Rollover credits", "USD", None),
    "topup_remaining": ("Top-up remaining", "USD", None),
    "total_spendable": ("Total usable", "USD", None),
}
_METRIC_FIELDS = {
    "reset_credits_available": ("Reset credits available", "count"),
    "totalCredits": ("Total credits", "USD"),
    "totalUsage": ("Total usage", "USD"),
    "keyUsageDaily": ("Daily usage", "USD"),
    "keyUsageWeekly": ("Weekly usage", "USD"),
    "keyUsageMonthly": ("Monthly usage", "USD"),
}
_MONEY = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?"


def _finite_number(value: Any) -> Optional[float | int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else None
    return None


def _timestamp(value: Any) -> Optional[str]:
    if not isinstance(value, str) or len(value) > 64:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError:
        return None
    return text


def _safe_error(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if text in _SAFE_ERRORS else "Provider unavailable."


def _safe_plan(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    plan = value.strip()
    return plan if plan in _SAFE_PLANS else None


def _usd_amount(value: str) -> Optional[float]:
    if not re.fullmatch(_MONEY, value):
        return None
    amount = _finite_number(float(value.replace(",", "")))
    return float(amount) if amount is not None else None


def _add_balance(result: Dict[str, Any], field_id: str, value: float) -> None:
    if any(balance["id"] == field_id for balance in result["balances"]):
        return
    label, currency, unit = _BALANCE_FIELDS[field_id]
    balance: Dict[str, Any] = {"id": field_id, "label": label, "value": value}
    if currency:
        balance["currency"] = currency
    if unit:
        balance["unit"] = unit
    result["balances"].append(balance)


def _window(value: Any, window_id: str, label: str) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    result: Dict[str, Any] = {"id": window_id, "label": label}
    for key in ("usedPercent", "resetsAt", "windowMinutes", "remaining", "total", "unit"):
        if key not in value or value[key] is None:
            continue
        if key in ("usedPercent", "windowMinutes", "remaining", "total"):
            number = _finite_number(value[key])
            if number is not None:
                result[key] = number
        elif key == "resetsAt":
            timestamp = _timestamp(value[key])
            if timestamp is not None:
                result[key] = timestamp
        elif (
            key == "unit"
            and isinstance(value[key], str)
            and value[key] in {"%", "USD", "credits", "tokens", "requests", "messages", "count", "days", "hours"}
        ):
            result[key] = value[key]
    return result if len(result) > 2 else None


def _base_entry(provider: str, *, available: bool, source: str, error: Optional[str] = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "provider": provider,
        "available": available,
        "source": source if isinstance(source, str) and source in _SAFE_SOURCES else "cli",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "stale": False,
        "windows": [],
        "balances": [],
        "metrics": [],
    }
    safe_error = _safe_error(error)
    if safe_error:
        result["error"] = safe_error
    return result


def unavailable_provider(provider: str, source: str, error: str) -> Dict[str, Any]:
    return _base_entry(provider, available=False, source=source, error=error)


def normalize_codexbar_entry(provider: str, payload: Any) -> Dict[str, Any]:
    """Normalize one CodexBar provider response to the MC contract."""
    if not isinstance(payload, list):
        return unavailable_provider(provider, "cli", "Invalid CodexBar response.")

    item = next((entry for entry in payload if isinstance(entry, dict) and entry.get("provider") == provider), None)
    if not isinstance(item, dict):
        return unavailable_provider(provider, "cli", "Provider not returned by CodexBar.")

    source = item.get("source") if isinstance(item.get("source"), str) else "cli"
    error = item.get("error")
    if isinstance(error, dict):
        return unavailable_provider(provider, source, str(error.get("message") or "Provider unavailable."))

    raw_usage = item.get("usage")
    usage: Dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
    result = _base_entry(provider, available=True, source=source)
    result["updatedAt"] = _timestamp(usage.get("updatedAt")) or result["updatedAt"]

    for window_id, label in _WINDOW_LABELS.items():
        if window_id == "subscription":
            continue
        window = _window(usage.get(window_id), window_id, label)
        if window is not None:
            if provider == "nous" and window_id == "primary":
                window["id"] = "subscription"
                window["label"] = "Subscription"
            result["windows"].append(window)

    if provider == "nous":
        identity = usage.get("identity")
        plan = _safe_plan(identity.get("loginMethod")) if isinstance(identity, dict) else None
        if plan is not None:
            result["plan"] = plan
        renews_at = _timestamp(usage.get("subscriptionRenewsAt"))
        if renews_at is not None:
            result["renewsAt"] = renews_at

        details = usage.get("details")
        if isinstance(details, list):
            for section in details[:8]:
                if not isinstance(section, dict) or not isinstance(section.get("rows"), list):
                    continue
                for row in section["rows"][:32]:
                    if not isinstance(row, dict):
                        continue
                    label, value = row.get("label"), row.get("value")
                    if (
                        not isinstance(label, str)
                        or not isinstance(value, str)
                        or len(label) > 64
                        or len(value) > 64
                    ):
                        continue
                    label, value = label.strip().casefold(), value.strip()
                    if label == "subscription credits":
                        match = re.fullmatch(rf"\$\s*({_MONEY})\s+of\s+\$\s*({_MONEY})\s+left", value, re.IGNORECASE)
                        if not match:
                            continue
                        remaining, total = (_usd_amount(part) for part in match.groups())
                        if remaining is None or total is None:
                            continue
                        _add_balance(result, "subscription_remaining", remaining)
                        window = next((item for item in result["windows"] if item["id"] == "subscription"), None)
                        if window is None:
                            window = {"id": "subscription", "label": "Subscription"}
                            result["windows"].append(window)
                        window.update({"remaining": remaining, "total": total, "unit": "USD"})
                        if total > 0 and "usedPercent" not in window:
                            window["usedPercent"] = (total - remaining) * 100 / total
                        continue

                    field_id = {
                        "rollover credits": "rollover_credits",
                        "top-up credits": "topup_remaining",
                        "total usable": "total_spendable",
                    }.get(label)
                    amount_match = re.fullmatch(rf"\$\s*({_MONEY})", value) if field_id else None
                    amount = _usd_amount(amount_match.group(1)) if amount_match else None
                    if field_id and amount is not None:
                        _add_balance(result, field_id, amount)

    if provider == "openrouter":
        openrouter = usage.get("openRouterUsage")
        if isinstance(openrouter, dict):
            balance = _finite_number(openrouter.get("balance"))
            if balance is not None:
                result["balances"].append({
                    "id": "balance",
                    "label": "Balance",
                    "value": balance,
                    "currency": "USD",
                })
            for key, label in (
                ("totalCredits", "Total credits"),
                ("totalUsage", "Total usage"),
                ("keyUsageDaily", "Daily usage"),
                ("keyUsageWeekly", "Weekly usage"),
                ("keyUsageMonthly", "Monthly usage"),
            ):
                value = _finite_number(openrouter.get(key))
                if value is not None:
                    result["metrics"].append({"id": key, "label": label, "value": value, "unit": "USD"})

    if provider == "codex":
        credits = item.get("credits")
        remaining = _finite_number(credits.get("remaining")) if isinstance(credits, dict) else None
        if remaining is not None:
            result["balances"].append({
                "id": "credits_remaining",
                "label": "Credits remaining",
                "value": remaining,
                "unit": "credits",
            })
        codex_credits = usage.get("codexResetCredits")
        if isinstance(codex_credits, dict):
            count = _finite_number(codex_credits.get("availableCount"))
            if count is None and isinstance(codex_credits.get("credits"), list):
                count = sum(1 for entry in codex_credits["credits"] if isinstance(entry, dict) and entry.get("status") == "available")
            if count is not None:
                result["metrics"].append({
                    "id": "reset_credits_available",
                    "label": "Reset credits available",
                    "value": count,
                    "unit": "count",
                })

    return result


def normalize_cached_entry(entry: Any) -> Optional[Dict[str, Any]]:
    """Accept both the pre-contract cache and the current contract."""
    if not isinstance(entry, dict) or not isinstance(entry.get("provider"), str):
        return None
    if all(isinstance(entry.get(key), list) for key in ("windows", "balances", "metrics")):
        provider = entry["provider"]
        result = _base_entry(
            provider,
            available=entry.get("available") is True,
            source=entry.get("source") if isinstance(entry.get("source"), str) else "cli",
            error=entry.get("error"),
        )
        for key in ("updatedAt", "lastAttemptAt", "renewsAt"):
            timestamp = _timestamp(entry.get(key))
            if timestamp is not None:
                result[key] = timestamp
        result["stale"] = entry.get("stale") is True
        plan = _safe_plan(entry.get("plan"))
        if plan is not None:
            result["plan"] = plan

        for item in entry["windows"][:8]:
            if not isinstance(item, dict):
                continue
            window_id = item.get("id")
            label = _WINDOW_LABELS.get(window_id) if isinstance(window_id, str) else None
            window = _window(item, window_id, label) if label else None
            if window is not None:
                result["windows"].append(window)

        for item in entry["balances"][:16]:
            if not isinstance(item, dict):
                continue
            field_id, value = item.get("id"), _finite_number(item.get("value"))
            if isinstance(field_id, str) and field_id in _BALANCE_FIELDS and value is not None:
                _add_balance(result, field_id, float(value))

        for item in entry["metrics"][:16]:
            if not isinstance(item, dict):
                continue
            field_id, value = item.get("id"), _finite_number(item.get("value"))
            if isinstance(field_id, str) and field_id in _METRIC_FIELDS and value is not None:
                label, unit = _METRIC_FIELDS[field_id]
                result["metrics"].append({"id": field_id, "label": label, "value": value, "unit": unit})
        return result

    provider = entry["provider"]
    result = _base_entry(
        provider,
        available=bool(entry.get("available")),
        source=entry.get("source") if isinstance(entry.get("source"), str) else "cli",
        error=entry.get("error"),
    )
    for key in ("updatedAt", "lastAttemptAt", "renewsAt"):
        timestamp = _timestamp(entry.get(key))
        if timestamp is not None:
            result[key] = timestamp
    result["stale"] = entry.get("stale") is True
    plan = _safe_plan(entry.get("plan"))
    if plan is not None:
        result["plan"] = plan

    for window_id, label in _WINDOW_LABELS.items():
        if window_id == "subscription":
            continue
        window = _window(entry.get(window_id), window_id, label)
        if window is not None:
            result["windows"].append(window)

    openrouter = entry.get("openRouter")
    if isinstance(openrouter, dict):
        balance = _finite_number(openrouter.get("balance"))
        if balance is not None:
            result["balances"].append({"id": "balance", "label": "Balance", "value": balance, "currency": "USD"})

    credits = _finite_number(entry.get("creditsRemaining"))
    if credits is not None:
        result["balances"].append({"id": "credits_remaining", "label": "Credits remaining", "value": credits, "unit": "credits"})

    reset_count = _finite_number(entry.get("resetCreditsAvailable"))
    if reset_count is not None:
        result["metrics"].append({"id": "reset_credits_available", "label": "Reset credits available", "value": reset_count, "unit": "count"})
    return result
