"""MC-FIX-3: the recursive skill viewer never reads files outside the skill root."""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

fake_psutil = types.SimpleNamespace(
    cpu_percent=lambda interval=None: 7.5,
    virtual_memory=lambda: types.SimpleNamespace(percent=42.0, used=8 * 1024**3, available=8 * 1024**3, total=16 * 1024**3),
    disk_usage=lambda path: types.SimpleNamespace(percent=55.0, free=100 * 1024**3, total=200 * 1024**3),
    Process=lambda: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=256 * 1024**2)),
)
sys.modules.setdefault("psutil", fake_psutil)

MODULE_PATH = Path(__file__).resolve().parents[1] / "server" / "local_telemetry_server.py"
SPEC = importlib.util.spec_from_file_location("mission_control_local_telemetry_server_skills", MODULE_PATH)
server_mod = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server_mod)

SKILL_MD = "---\nname: {name}\ndescription: synthetic\n---\n# {name}\n"


class SkillFilesBoundaryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="mc-skill-boundary-")
        self.root = Path(self._tmp.name).resolve()
        self.skills = self.root / "skills"
        self.skills.mkdir()
        self.outside = self.root / "outside"
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("SYNTHETIC-OUTSIDE-CONTENT", encoding="utf-8")
        self._patch = mock.patch.object(server_mod, "hermes_skills_dir", return_value=self.skills)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _make_skill(self, parent: Path, name: str) -> Path:
        skill = parent / name
        (skill / "references").mkdir(parents=True)
        (skill / "SKILL.md").write_text(SKILL_MD.format(name=name), encoding="utf-8")
        (skill / "references" / "notes.md").write_text("nested notes", encoding="utf-8")
        return skill

    def _names(self, payload):
        return [item["name"] for item in payload["files"]]

    def test_external_symlink_is_not_read(self):
        skill = self._make_skill(self.skills, "demo")
        os.symlink(self.outside / "secret.txt", skill / "leak.txt")
        payload = server_mod._collect_skill_files_recursive("demo")
        self.assertNotIn("leak.txt", self._names(payload))
        self.assertNotIn("SYNTHETIC-OUTSIDE-CONTENT", "".join(item["content"] for item in payload["files"]))

    def test_ordinary_nested_and_internal_link_files_are_kept_in_order(self):
        skill = self._make_skill(self.skills, "demo")
        os.symlink(skill / "references" / "notes.md", skill / "alias.md")
        payload = server_mod._collect_skill_files_recursive("demo")
        self.assertEqual(self._names(payload), ["SKILL.md", "alias.md", "references/notes.md"])
        alias = next(item for item in payload["files"] if item["name"] == "alias.md")
        self.assertEqual(alias["content"], "nested notes")

    def test_skills_root_that_is_itself_a_symlink_still_works(self):
        checkout = self.root / "checkout-skills"
        checkout.mkdir()
        self._make_skill(checkout, "linked")
        linked_root = self.root / "linked-skills"
        os.symlink(checkout, linked_root)
        with mock.patch.object(server_mod, "hermes_skills_dir", return_value=linked_root):
            payload = server_mod._collect_skill_files_recursive("linked")
        self.assertEqual(self._names(payload), ["SKILL.md", "references/notes.md"])

    def test_broken_link_and_loop_do_not_fail_the_listing(self):
        skill = self._make_skill(self.skills, "demo")
        os.symlink(self.root / "missing.txt", skill / "broken.txt")
        os.symlink(skill / "loop-b", skill / "loop-a")
        os.symlink(skill / "loop-a", skill / "loop-b")
        payload = server_mod._collect_skill_files_recursive("demo")
        self.assertEqual(self._names(payload), ["SKILL.md", "references/notes.md"])

    def test_size_comes_from_the_authorised_target(self):
        skill = self._make_skill(self.skills, "demo")
        os.symlink(self.outside / "secret.txt", skill / "leak.txt")
        payload = server_mod._collect_skill_files_recursive("demo")
        for item in payload["files"]:
            self.assertNotEqual(item["size"], len("SYNTHETIC-OUTSIDE-CONTENT"))


if __name__ == "__main__":
    unittest.main()
