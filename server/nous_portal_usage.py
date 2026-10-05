"""Hermes-owned Nous auth preflight; usage data itself is collected by CodexBar."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from hermes_paths import get_hermes_home, hermes_root


def _auth_paths() -> list[Path]:
    """Return profile-local auth first, then the shared root auth store."""
    paths = [get_hermes_home() / "auth.json", hermes_root() / "auth.json"]
    unique: list[Path] = []
    for path in paths:
        resolved = path.resolve(strict=False)
        if resolved not in unique:
            unique.append(resolved)
    return unique


def _read_nous_state() -> Optional[dict[str, Any]]:
    """Read only the Nous provider state from the active/shared auth stores."""
    for path in _auth_paths():
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(document, dict):
            continue
        providers = document.get("providers")
        state = providers.get("nous") if isinstance(providers, dict) else None
        if isinstance(state, dict):
            return state
    return None


def _token_is_expiring(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        expires_at = datetime.fromisoformat(text)
    except ValueError:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc)


def _hermes_cli_path() -> Optional[str]:
    candidates = [
        shutil.which("hermes"),
        str(get_hermes_home() / "hermes-agent" / "venv" / "bin" / "hermes"),
        str(hermes_root() / "hermes-agent" / "venv" / "bin" / "hermes"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def _refresh_via_hermes_cli() -> bool:
    """Ask Hermes to refresh its own OAuth state without touching refresh tokens."""
    executable = _hermes_cli_path()
    if not executable:
        return False
    try:
        completed = subprocess.run(
            [executable, "portal", "info"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        return completed.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def refresh_nous_session_if_expiring() -> bool:
    """Delegate refresh of an expiring Nous access token to Hermes, if needed."""
    state = _read_nous_state()
    if not state or not _token_is_expiring(state.get("expires_at")):
        return False
    return _refresh_via_hermes_cli()
