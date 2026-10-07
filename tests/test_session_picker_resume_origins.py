import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from mission_control_agents import _classify_session_origin


class SessionPickerResumeOriginsTests(unittest.TestCase):
    def test_interactive_origins_can_resume_without_reclassifying_system_history(self):
        for origin, category in [('cli', 'system'), ('bot_room', 'unknown'), ('acp', 'unknown'), ('api_server', 'unknown')]:
            with self.subTest(origin=origin):
                item = _classify_session_origin(origin, origin)
                self.assertTrue(item['isResumable'], 'interactive histories must be resumable from the all-origin picker')
                self.assertEqual(item['category'], category)
                self.assertFalse(_classify_session_origin(origin, origin, {'is_resumable': False})['isResumable'])
        for origin in ['cron', 'kanban', 'test', 'smoke']:
            self.assertFalse(_classify_session_origin(origin, origin)['isResumable'])


if __name__ == '__main__':
    unittest.main()
