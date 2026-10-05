"""Shared CodexBar collection path for the updater and telemetry sidecar."""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

from nous_portal_usage import refresh_nous_session_if_expiring
from provider_usage_config import BUILTIN_USAGE_PROVIDERS, visible_usage_providers
from provider_usage_contract import normalize_codexbar_entry, unavailable_provider

_DEFAULT_CODEXBAR = "/opt/homebrew/bin/codexbar"


def _decode_payload(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        raw = stdout.strip()
        try:
            decoded = json.loads(raw)
            return json.loads(decoded) if isinstance(decoded, str) else decoded
        except (json.JSONDecodeError, TypeError):
            start, end = raw.find("["), raw.rfind("]")
            if start >= 0 and end > start:
                try:
                    return json.loads(raw[start : end + 1])
                except json.JSONDecodeError:
                    pass
    return None


def collect_codexbar_provider(provider: str) -> dict[str, Any]:
    """Collect and normalize one allowlisted provider without leaking CLI output."""
    if provider not in BUILTIN_USAGE_PROVIDERS:
        return unavailable_provider(provider, "cli", "Unknown provider.")

    executable = shutil.which("codexbar") or _DEFAULT_CODEXBAR
    if provider == "nous":
        # Hermes alone owns OAuth refresh-token rotation. CodexBar then reads the
        # refreshed access token from the same active Hermes home.
        refresh_nous_session_if_expiring()

    source_args = ["--source", "web"] if provider == "ollama" else []
    try:
        completed = subprocess.run(
            [executable, "usage", "--provider", provider, *source_args, "--json", "--no-color"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return unavailable_provider(provider, "cli", "CodexBar timed out.")
    except OSError:
        return unavailable_provider(provider, "cli", "CodexBar unavailable.")

    if not completed.stdout.strip():
        result = unavailable_provider(provider, "cli", "CodexBar returned no data.")
    else:
        result = normalize_codexbar_entry(provider, _decode_payload(completed.stdout))
    if completed.returncode != 0 and result.get("available"):
        result["available"] = False
        result["error"] = "CodexBar returned a provider error."
    return result


def collect_codexbar_usage(providers: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
    """Collect each enabled provider independently; one failure never aborts the batch."""
    selected = visible_usage_providers() if providers is None else providers
    return [collect_codexbar_provider(provider) for provider in selected]
