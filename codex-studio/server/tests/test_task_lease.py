import sqlite3
from datetime import datetime
from pathlib import Path

from app import database
from app.config import settings
from app.task_runner import TaskRunner


def test_long_task_lease_renews_and_observes_cancel(tmp_path: Path):
    original = settings.database_path
    object.__setattr__(settings, "database_path", tmp_path / "lease.db")
    database.initialize_database(settings.database_path)
    try:
        with sqlite3.connect(settings.database_path) as db:
            db.execute("INSERT INTO projects(id,name) VALUES('p','项目')")
            db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json) VALUES('p','video','mock','{}')")
        runner = TaskRunner(lease_seconds=30)
        task = runner.claim_next()
        assert task is not None and task["status"] == "queued"
        with sqlite3.connect(settings.database_path) as db:
            before = db.execute("SELECT lease_until,progress FROM tasks WHERE id=?", (task["id"],)).fetchone()
        assert runner._renew_lease(task["id"]) is False
        with sqlite3.connect(settings.database_path) as db:
            after = db.execute("SELECT lease_until,progress FROM tasks WHERE id=?", (task["id"],)).fetchone()
            db.execute("UPDATE tasks SET cancel_requested=1 WHERE id=?", (task["id"],))
        assert datetime.fromisoformat(after[0]) >= datetime.fromisoformat(before[0])
        assert after[1] > before[1]
        assert runner._renew_lease(task["id"]) is True
        runner._mark_canceled(task["id"])
        with sqlite3.connect(settings.database_path) as db:
            status = db.execute("SELECT status,lease_until FROM tasks WHERE id=?", (task["id"],)).fetchone()
        assert status == ("canceled", None)
    finally:
        object.__setattr__(settings, "database_path", original)
