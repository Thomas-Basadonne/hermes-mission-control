from pathlib import Path
import unittest


HERMES_API_PATH = Path(__file__).resolve().parents[1] / "src" / "lib" / "hermes-api.ts"


class HermesApiRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = HERMES_API_PATH.read_text(encoding="utf-8")

    def test_local_fetches_use_configurable_local_api_url_helper(self):
        self.assertIn("fetch(localApiUrl('/system')", self.source)
        self.assertNotIn("fetch('/api/local/system'", self.source)

    def test_removed_knowledge_api_is_not_called(self):
        self.assertNotIn("'/knowledge", self.source)
        self.assertNotIn("`/knowledge", self.source)


if __name__ == "__main__":
    unittest.main()
