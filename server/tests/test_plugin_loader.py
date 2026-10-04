"""PluginLoader registration rules for backend and UI-only plugins."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plugins.loader import PluginLoader  # noqa: E402


class PluginLoaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.internal = root / "internal"
        self.external = root / "external"
        self.internal.mkdir()
        self.external.mkdir()
        self.loader = PluginLoader(internal_dir=self.internal, external_dir=self.external)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _plugin(self, plugin_id: str, manifest: dict, endpoints_py: str | None = None) -> None:
        plugin_dir = self.external / plugin_id
        plugin_dir.mkdir()
        (plugin_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        if endpoints_py is not None:
            (plugin_dir / "endpoints.py").write_text(endpoints_py, encoding="utf-8")

    def test_ui_only_plugin_without_endpoints_is_registered(self) -> None:
        self._plugin("ui-only", {"id": "ui-only", "name": "UI only", "routePath": "/ui-only"})

        self.assertTrue(self.loader.load_plugin("ui-only"))
        manifest = self.loader.get_manifest("ui-only")
        assert manifest is not None
        self.assertEqual(manifest["routePath"], "/ui-only")
        self.assertEqual(self.loader.handler_count, 0)
        self.assertIsNone(self.loader.get_module("ui-only"))

    def test_backend_plugin_registers_declared_handlers(self) -> None:
        self._plugin(
            "backend",
            {"id": "backend", "endpoints": [{"method": "GET", "path": "/backend/items", "handler": "list_items"}]},
            "def list_items(*args, **kwargs):\n    return {'items': []}\n",
        )

        self.assertTrue(self.loader.load_plugin("backend"))
        self.assertIsNotNone(self.loader.resolve("GET", "/backend/items"))

    def test_plugin_with_declared_but_missing_handlers_is_rejected(self) -> None:
        self._plugin(
            "broken",
            {"id": "broken", "endpoints": [{"method": "GET", "path": "/broken", "handler": "missing"}]},
            "def other():\n    return None\n",
        )

        self.assertFalse(self.loader.load_plugin("broken"))
        self.assertIsNone(self.loader.get_manifest("broken"))


if __name__ == "__main__":
    unittest.main()
