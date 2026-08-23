import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .adapters import registry
from .config import settings
from .media import render_timeline, render_transition
from .production import advance_automation


class TaskRunner:
    """Durable single-worker dispatcher with leases and crash recovery."""

    def __init__(self, poll_interval: float = 0.25, lease_seconds: int = 120) -> None:
        self.poll_interval = poll_interval
        self.lease_seconds = lease_seconds
        self._stop = asyncio.Event()

    async def run(self) -> None:
        await asyncio.to_thread(self.recover_expired)
        await asyncio.to_thread(self.recover_automation_runs)
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

    @staticmethod
    def recover_automation_runs() -> None:
        """Advance runs left between a completed stage and the next queue after a crash."""
        with sqlite3.connect(settings.database_path) as db:
            run_ids = [row[0] for row in db.execute("SELECT id FROM automation_runs WHERE status IN ('queued','running') AND cancel_requested=0").fetchall()]
        for run_id in run_ids:
            advance_automation(int(run_id))

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
            elif task["task_type"] == "timeline_export":
                clips = await asyncio.to_thread(self._timeline_clips, task["project_id"], int(payload.get("episode", 1)))
                result = await asyncio.to_thread(render_timeline, {**payload, "project_id": task["project_id"]}, clips)
            else:
                adapter = registry.resolve(task["provider"])
                prompt = str(payload.get("prompt") or f"执行 {task['task_type']} 任务")
                result = await adapter.invoke(prompt, {**payload, "project_id": task["project_id"], "task_id": task["id"], "task_type": task["task_type"]})
            await asyncio.to_thread(self._complete, task, result)
            if task.get("automation_run_id"):
                await asyncio.to_thread(advance_automation, int(task["automation_run_id"]))
        except Exception as exc:
            terminal = await asyncio.to_thread(self._fail_or_retry, task, str(exc))
            if terminal and task.get("automation_run_id"):
                await asyncio.to_thread(advance_automation, int(task["automation_run_id"]))

    @staticmethod
    def _timeline_clips(project_id: str, episode: int) -> list[dict[str, Any]]:
        with sqlite3.connect(settings.database_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("SELECT * FROM timeline_clips WHERE project_id=? AND episode=? ORDER BY track,position,id", (project_id, episode)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.get("metadata_json") or "{}")
            result.append(item)
        return result

    def _complete(self, task: dict[str, Any], result: dict[str, Any]) -> None:
        task_id = int(task["id"])
        with sqlite3.connect(settings.database_path) as db:
            db.row_factory = sqlite3.Row
            canceled = db.execute("SELECT cancel_requested FROM tasks WHERE id=?", (task_id,)).fetchone()
            status = "canceled" if canceled and canceled[0] else "completed"
            progress = 0 if status == "canceled" else 100
            db.execute(
                "UPDATE tasks SET status=?,progress=?,result_json=?,lease_until=NULL,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (status, progress, json.dumps(result, ensure_ascii=False), task_id),
            )
            if status == "completed" and task["task_type"] == "vision_review":
                payload = json.loads(task["payload_json"])
                score = max(0, min(100, int(result.get("score", 0))))
                findings = list(result.get("findings") or [])
                db.execute(
                    "INSERT INTO quality_reviews(project_id,episode,shot_number,score,status,dimensions_json,findings_json,repair_plan_json) VALUES(?,?,?,?,?,?,?,?)",
                    (task["project_id"], int(payload.get("episode", 1)), str(payload.get("shot_number") or payload.get("shot_id") or ""), score,
                     "passed" if score >= int((payload.get("options") or {}).get("threshold", 80)) else "repair_required",
                     json.dumps(result.get("dimensions") or {}, ensure_ascii=False), json.dumps(findings, ensure_ascii=False),
                     json.dumps({"action": "regenerate_keyframe", "findings": findings}, ensure_ascii=False)),
                )
            output_path = str(result.get("output_path") or "")
            asset_type = str(result.get("asset_type") or ("video" if task["task_type"] == "timeline_export" else ""))
            if status == "completed" and output_path and asset_type:
                payload = json.loads(task["payload_json"])
                cursor = db.execute(
                    "INSERT INTO assets(project_id,asset_type,name,episode,shot_id,local_path,mime_type,source_kind,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (task["project_id"], asset_type, str(result.get("output_name") or Path(output_path).name), int(payload.get("episode", 1)), result.get("shot_id") or payload.get("shot_id"), output_path,
                     {"image": "image/png", "video": "video/mp4", "voice": "audio/mpeg"}.get(asset_type, "application/octet-stream"), "generated", "ready", json.dumps({"provider": result.get("provider"), "model": result.get("model"), "task_id": task_id}, ensure_ascii=False)),
                )
                result["asset_id"] = cursor.lastrowid
                db.execute("UPDATE tasks SET result_json=? WHERE id=?", (json.dumps(result, ensure_ascii=False), task_id))
                shot_id = result.get("shot_id") or payload.get("shot_id")
                if shot_id:
                    db.execute("INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES(?,?,?)", (shot_id, cursor.lastrowid, asset_type))

    def _fail_or_retry(self, task: dict[str, Any], message: str) -> bool:
        attempts = int(task["attempts"])
        max_attempts = int(task["max_attempts"])
        non_retryable = any(marker in message for marker in ("HTTP 400", "HTTP 401", "HTTP 403", "HTTP 404", "尚未配置", "不支持", "缺少", "不存在"))
        terminal = non_retryable or attempts >= max_attempts
        delay = min(60, 2 ** attempts)
        available = (datetime.now(UTC) + timedelta(seconds=delay)).strftime("%Y-%m-%d %H:%M:%S")
        with sqlite3.connect(settings.database_path) as db:
            db.execute(
                "UPDATE tasks SET status=?,progress=0,error_message=?,available_at=?,lease_until=NULL,"
                "completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                ("failed" if terminal else "retry_wait", message[:1000], available, terminal, task["id"]),
            )
        return terminal


def serialize_task(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["payload"] = json.loads(result.pop("payload_json"))
    result["result"] = json.loads(result.pop("result_json"))
    result["cancel_requested"] = bool(result["cancel_requested"])
    return result
