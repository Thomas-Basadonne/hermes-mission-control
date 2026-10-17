"""Hot-path cost guards for the telemetry sidecar.

``/api/local/status`` and ``/api/local/system`` are polled by every open
Mission Control tab. They must not re-read every legacy session file or
fork a thermal sampler per request: under a few tabs that saturates the
sidecar and every other route (sessions, chat transcript) times out behind it.
"""

from __future__ import annotations

import builtins
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

fake_psutil = types.SimpleNamespace(
    cpu_percent=lambda interval=None: 7.5,
    virtual_memory=lambda: types.SimpleNamespace(percent=42.0, used=8 * 1024**3, available=8 * 1024**3, total=16 * 1024**3),
    disk_usage=lambda path: types.SimpleNamespace(percent=55.0, free=100 * 1024**3, total=200 * 1024**3),
    Process=lambda *args: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=256 * 1024**2)),
    pid_exists=lambda pid: False,
)
sys.modules.setdefault("psutil", fake_psutil)

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_hot_paths_server", MODULE_PATH)
server = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server)


class StatusSessionScanTests(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="mc-status-scan-"))
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)
        self._home = self._tmp / "hermes"
        self._sessions = self._home / "sessions"
        self._sessions.mkdir(parents=True)
        for patcher in (
            patch.object(server, "_get_hermes_home", return_value=self._home),
            patch.object(server, "_candidates_enabled", return_value=False),
            patch.object(server, "psutil", types.SimpleNamespace(pid_exists=lambda pid: False)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _write(self, name: str, payload: dict, *, age_seconds: float) -> Path:
        path = self._sessions / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_recently_written_session_is_counted(self):
        self._write("session_live.json", {"last_active": time.time(), "ended_at": None}, age_seconds=1)
        self.assertEqual(server._collect_status_payload_uncached()["active_sessions"], 1)

    def test_files_untouched_for_the_live_window_are_never_opened(self):
        live = self._write("session_live.json", {"last_active": time.time(), "ended_at": None}, age_seconds=1)
        stale = self._write("request_dump_old.json", {"last_active": time.time(), "ended_at": None}, age_seconds=3600)
        opened: list[str] = []
        real_open = builtins.open

        def tracking_open(file, *args, **kwargs):
            opened.append(str(file))
            return real_open(file, *args, **kwargs)

        with patch.object(builtins, "open", tracking_open):
            result = server._collect_status_payload_uncached()

        self.assertEqual(result["active_sessions"], 1)
        self.assertIn(str(live), opened)
        self.assertNotIn(str(stale), opened)


class SystemThermalCacheTests(unittest.TestCase):
    def setUp(self):
        server._THERMAL_CACHE = None
        self.addCleanup(setattr, server, "_THERMAL_CACHE", None)

    def test_system_snapshot_reuses_thermal_reading_within_ttl(self):
        calls = []

        def fake_thermal():
            calls.append(1)
            return {"fanRpm": None, "fanCount": None, "thermalPressure": 0.0, "thermalLevel": "nominal",
                    "levelSource": "powermetrics", "source": "powermetrics", "error": None}

        with patch.object(server, "collect_thermal_snapshot", fake_thermal):
            first = server.collect_system_snapshot()
            second = server.collect_system_snapshot()

        self.assertEqual(len(calls), 1)
        self.assertEqual(first["thermal"]["thermalLevel"], "nominal")
        self.assertEqual(second["thermal"]["thermalLevel"], "nominal")

    def test_thermal_reading_refreshes_after_ttl(self):
        calls = []

        def fake_thermal():
            calls.append(1)
            return {"thermalLevel": f"level-{len(calls)}", "error": None}

        with patch.object(server, "collect_thermal_snapshot", fake_thermal):
            server._cached_thermal_snapshot()
            server._THERMAL_CACHE = (time.monotonic() - server._THERMAL_CACHE_TTL_SECONDS - 1, server._THERMAL_CACHE[1])
            refreshed = server._cached_thermal_snapshot()

        self.assertEqual(len(calls), 2)
        self.assertEqual(refreshed["thermalLevel"], "level-2")


if __name__ == "__main__":
    unittest.main()
