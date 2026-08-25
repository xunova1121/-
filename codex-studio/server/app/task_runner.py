import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from .adapters import registry
from .config import settings
from .media import render_transition
from .task_outputs import ingest_task_output


class TaskRunner:
    """Durable single-worker dispatcher with leases and crash recovery."""

    def __init__(self, poll_interval: float = 0.25, lease_seconds: int = 120) -> None:
        self.poll_interval = poll_interval
        self.lease_seconds = lease_seconds
        self._stop = asyncio.Event()

    async def run(self) -> None:
        await asyncio.to_thread(self.recover_expired)
        while not self._stop.is_set():
            task = await asyncio.to_thread(self.claim_next)
            if task:
                await self.execute(task)
                continue
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.poll_interval)
            except TimeoutError:
                pass

    def stop(self) -> None:
        self._stop.set()

    def recover_expired(self) -> None:
        with sqlite3.connect(settings.database_path) as db:
            db.execute(
                "UPDATE tasks SET status='queued', lease_until=NULL, error_message='服务重启后自动恢复', "
                "updated_at=CURRENT_TIMESTAMP WHERE status='running' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))"
            )

    def claim_next(self) -> dict[str, Any] | None:
        lease = (datetime.now(UTC) + timedelta(seconds=self.lease_seconds)).strftime("%Y-%m-%d %H:%M:%S")
        with sqlite3.connect(settings.database_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM tasks WHERE status IN ('queued','retry_wait') AND cancel_requested=0 "
                "AND datetime(available_at)<=datetime('now') ORDER BY priority DESC,id LIMIT 1"
            ).fetchone()
            if not row:
                return None
            updated = db.execute(
                "UPDATE tasks SET status='running',progress=5,attempts=attempts+1,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),"
                "lease_until=?,error_message='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','retry_wait')",
                (lease, row["id"]),
            )
            if updated.rowcount != 1:
                return None
            return {**dict(row), "attempts": row["attempts"] + 1}

    async def execute(self, task: dict[str, Any]) -> None:
        try:
            payload = json.loads(task["payload_json"])
            if task["task_type"] == "transition_render":
                result = await asyncio.to_thread(render_transition, payload)
            else:
                adapter = registry.resolve(task["provider"])
                prompt = str(payload.get("prompt") or f"执行 {task['task_type']} 任务")
                result = await adapter.invoke(prompt, {**payload, "task_id": task["id"], "task_type": task["task_type"]})
            await asyncio.to_thread(self._complete, task, result)
        except Exception as exc:
            await asyncio.to_thread(self._fail_or_retry, task, str(exc))

    def _complete(self, task: dict[str, Any], result: dict[str, Any]) -> None:
        task_id = int(task["id"])
        with sqlite3.connect(settings.database_path) as db:
            db.row_factory = sqlite3.Row
            canceled = db.execute("SELECT cancel_requested FROM tasks WHERE id=?", (task_id,)).fetchone()
            status = "canceled" if canceled and canceled[0] else "completed"
            progress = 0 if status == "canceled" else 100
            if status == "completed":
                result = ingest_task_output(db, task, result)
            db.execute(
                "UPDATE tasks SET status=?,progress=?,result_json=?,lease_until=NULL,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (status, progress, json.dumps(result, ensure_ascii=False), task_id),
            )

    def _fail_or_retry(self, task: dict[str, Any], message: str) -> None:
        attempts = int(task["attempts"])
        max_attempts = int(task["max_attempts"])
        terminal = attempts >= max_attempts
        delay = min(60, 2 ** attempts)
        available = (datetime.now(UTC) + timedelta(seconds=delay)).strftime("%Y-%m-%d %H:%M:%S")
        with sqlite3.connect(settings.database_path) as db:
            db.execute(
                "UPDATE tasks SET status=?,progress=0,error_message=?,available_at=?,lease_until=NULL,"
                "completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                ("failed" if terminal else "retry_wait", message[:1000], available, terminal, task["id"]),
            )


def serialize_task(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["payload"] = json.loads(result.pop("payload_json"))
    result["result"] = json.loads(result.pop("result_json"))
    result["cancel_requested"] = bool(result["cancel_requested"])
    return result
