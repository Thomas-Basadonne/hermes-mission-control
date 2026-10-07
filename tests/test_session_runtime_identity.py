"""Read-only SQLite integration of the sidecar's multi-profile aggregation."""
import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
mc = importlib.import_module('mission_control_agents')
paths = importlib.import_module('hermes_paths')


class ReadOnlySessionStore:
    """SQLite test adapter exposing only telemetry's session-reader interface."""
    def __init__(self, path):
        self.connection = sqlite3.connect('file:{}?mode=ro'.format(path), uri=True)
        self.connection.row_factory = sqlite3.Row

    def list_sessions_rich(self, **kwargs):
        return [dict(row) for row in self.connection.execute('SELECT * FROM sessions ORDER BY last_active DESC')]

    def _get_session_rich_row(self, session_id, **kwargs):
        row = self.connection.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
        return dict(row) if row else None

    def close(self):
        self.connection.close()


class SessionRuntimeIdentityIntegrationTests(unittest.TestCase):
    def test_legacy_presence_is_one_conversation_before_filters_counts_and_pagination(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            root = Path(directory)
            bot_home = root / 'profiles' / 'other-bot'
            bot_home.mkdir(parents=True)
            stores = {}
            for profile, home, session_id in [('default', root, 'stored-1'), ('other-bot', bot_home, 'bot-stored-1')]:
                db_path = home / 'state.db'
                with sqlite3.connect(db_path) as db:
                    db.execute('CREATE TABLE sessions (id TEXT, session_key TEXT, source TEXT, title TEXT, started_at REAL, last_active REAL, ended_at REAL, end_reason TEXT, message_count INTEGER, model TEXT)')
                    db.execute('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', (session_id, session_id, 'mission-control', 'Same title', 80, 90, 99, 'completed', 2, 'test-model'))
                    db.execute('CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT)')
                    db.executemany('INSERT INTO messages VALUES (?, ?, ?)', [(session_id, 'user', 'Original user row'), (session_id, 'assistant', 'Original reply')])
                    stores[profile] = (db_path, list(db.execute('SELECT * FROM messages')))
            lease = {'runtimeSessionId':'runtime-1', 'resumedFrom':'stored-1', 'sessionKey':'stored-1', 'source':'mission-control', 'title':'Same title', 'updatedAt':100.0}
            def open_store(profile=None):
                return ReadOnlySessionStore(mc._profile_home(profile or 'default') / 'state.db')
            with patch.object(paths, 'hermes_root', return_value=root), patch.object(paths, 'hermes_sessions_dir', return_value=root / 'sessions'), patch.object(mc, '_try_get_session_db', side_effect=open_store), patch.object(mc, 'active_runtime_presences', return_value=[lease]):
                for profile in ['default', 'other-bot', 'default']:
                    scoped = mc._collect_snapshot_sessions(profile=profile, include_recent_messages=False)
                    self.assertEqual(len(scoped), 1)
                    self.assertEqual(scoped[0]['profile'], profile)
                    self.assertEqual(scoped[0]['status'], 'live' if profile == 'default' else 'ended')
                snapshot = mc._load_agents_sessions_snapshot_uncached(limit=1, filters={'status':'live'}, include_recent_messages=False)
                self.assertEqual([item['sessionId'] for item in snapshot['items']], ['stored-1'])
                self.assertEqual(snapshot['stats']['liveSessions'], 1)
                self.assertEqual(snapshot['stats']['totalSessions'], len(stores))
                self.assertEqual(snapshot['pagination']['total'], 1)
                self.assertFalse(snapshot['pagination']['hasMore'])
                complete = mc._collect_snapshot_sessions(include_recent_messages=False)
                self.assertEqual({(item['profile'] or 'default', item['sessionId']) for item in complete}, {('default', 'stored-1'), ('other-bot', 'bot-stored-1')}, 'Same titles do not justify collapsing distinct conversations')
            for db_path, before in stores.values():
                with sqlite3.connect(db_path) as db:
                    self.assertEqual(list(db.execute('SELECT * FROM messages')), before)
                    self.assertEqual(db.execute('SELECT end_reason FROM sessions').fetchone()[0], 'completed')


if __name__ == '__main__':
    unittest.main()
