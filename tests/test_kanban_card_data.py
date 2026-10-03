"""Card lifecycle serialization uses in-memory data only: no core hooks or live DB."""
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import kanban_bridge as bridge


class KanbanCardDataTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE tasks(id TEXT, status TEXT);
            CREATE TABLE task_comments(task_id TEXT);
            CREATE TABLE task_links(parent_id TEXT, child_id TEXT);
            CREATE TABLE task_runs(id INTEGER PRIMARY KEY, task_id TEXT, profile TEXT,
                status TEXT, outcome TEXT, summary TEXT, error TEXT, started_at INTEGER,
                ended_at INTEGER, last_heartbeat_at INTEGER);
            CREATE TABLE task_events(id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT,
                payload TEXT, created_at INTEGER);
        """)
        self.task = SimpleNamespace(id="t_card", title="Card", status="running", priority=110,
            created_at=100, started_at=200, completed_at=None, current_run_id=2,
            last_heartbeat_at=310, block_kind=None, last_failure_error=None, result=None)
        self.kb_patch = patch.object(bridge, "_kb", return_value=SimpleNamespace())
        self.kb_patch.start()
        self.addCleanup(self.kb_patch.stop)
        self.addCleanup(self.conn.close)

    def run_row(self, run_id, *, task_id="t_card", started=300, ended=None,
                status="running", outcome=None, summary=None, error=None, heartbeat=310):
        self.conn.execute("INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?,?,?)",
            (run_id, task_id, "worker", status, outcome, summary, error, started, ended, heartbeat))

    def event(self, kind, payload):
        self.conn.execute("INSERT INTO task_events(task_id,kind,payload,created_at) VALUES(?,?,?,?)",
            (self.task.id, kind, json.dumps(payload), 400))

    def test_running_uses_current_attempt_not_first_task_start(self):
        self.run_row(1, started=200, ended=250, summary="Old attempt")
        self.run_row(2, started=300)
        data = bridge._task_dict(self.task, self.conn)
        self.assertEqual(data.get("current_run", {}).get("started_at"), 300)
        self.assertEqual(data["current_run"]["last_heartbeat_at"], 310)
        self.assertEqual(data["priority"], 110)
        self.assertIsNone(data.get("latest_summary"), "do not leak an older attempt's summary")
        self.assertIsNone(bridge._latest_summary(self.conn, self.task.id))

    def test_current_run_rejects_other_task_and_ended_attempt(self):
        for task_id, ended in [("t_other", None), ("t_card", 350)]:
            with self.subTest(task_id=task_id, ended=ended):
                self.conn.execute("DELETE FROM task_runs")
                self.run_row(2, task_id=task_id, ended=ended)
                data = bridge._task_dict(self.task, self.conn)
                self.assertIsNone(data.get("current_run"))

    def test_block_reason_prefers_latest_transition_over_old_failure(self):
        self.task.status = "blocked"
        self.task.block_kind = "needs_input"
        self.task.last_failure_error = "Old failure"
        self.event("blocked", {"reason": "Old block"})
        self.event("comment_added", {"body": "Not a reason"})
        self.event("blocked", {"reason": "Need credentials"})
        data = bridge._task_dict(self.task, self.conn)
        self.assertEqual(data.get("block_reason"), "Need credentials")
        self.assertEqual(data.get("block_kind"), "needs_input")

    def test_block_reason_falls_back_to_terminal_run_then_failure(self):
        self.task.status = "blocked"
        self.task.last_failure_error = "Fallback error"
        self.run_row(2, ended=320, status="blocked", outcome="blocked", summary="Worker blocked")
        self.assertEqual(bridge._task_dict(self.task, self.conn).get("block_reason"), "Worker blocked")
        self.conn.execute("DELETE FROM task_runs")
        self.assertEqual(bridge._task_dict(self.task, self.conn).get("block_reason"), "Fallback error")

    def test_scheduled_exposes_reason_without_inventing_a_due_time(self):
        self.task.status = "scheduled"
        self.event("scheduled", {"reason": "Wait for maintenance window"})
        self.assertEqual(bridge._task_dict(self.task, self.conn).get("schedule_reason"), "Wait for maintenance window")

    def test_preview_is_bounded_and_detail_summary_is_not_truncated(self):
        summary = "Review evidence " * 100
        self.task.status = "review"
        self.run_row(2, ended=350, status="review", outcome="review", summary=summary)
        self.task.result = "Result " * 100
        data = bridge._task_dict(self.task, self.conn)
        self.assertEqual(data.get("latest_summary"), summary[:200])
        self.assertEqual(data.get("result_preview"), self.task.result[:200])
        self.assertEqual(bridge._latest_summary(self.conn, self.task.id), summary)

    def test_detail_retains_full_handoff_summary(self):
        summary = "Full handoff evidence " * 100
        self.run_row(2, ended=350, status="review", summary=summary)
        core = SimpleNamespace(get_task=lambda conn, task_id: self.task, list_comments=lambda conn, task_id: [])
        with patch.object(bridge, "_kb", return_value=core), patch.object(bridge, "_conn", return_value=self.conn):
            self.assertEqual(bridge.get_task_detail(self.task.id)["latest_summary"], summary)

    def test_corrupt_event_payload_does_not_break_card(self):
        self.task.status = "blocked"
        self.task.last_failure_error = "Fallback"
        self.conn.execute("INSERT INTO task_events(task_id,kind,payload) VALUES(?,?,?)", (self.task.id, "blocked", "{"))
        self.assertEqual(bridge._task_dict(self.task, self.conn).get("block_reason"), "Fallback")


if __name__ == "__main__":
    unittest.main()
