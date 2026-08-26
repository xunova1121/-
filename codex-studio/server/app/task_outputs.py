from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path
from typing import Any

from .config import app_data_dir


def managed_output_root() -> Path:
    return app_data_dir() / "projects"


def _safe_name(value: str) -> str:
    cleaned = "".join(char for char in value if char.isalnum() or char in "-_.")
    return cleaned[:120] or "output.bin"


def ingest_task_output(db: sqlite3.Connection, task: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    raw_path = str(result.get("output_path") or "").strip()
    if not raw_path:
        return result
    source = Path(raw_path).expanduser().resolve()
    if not source.is_file() or source.stat().st_size <= 0:
        raise RuntimeError("任务声称已完成，但输出文件不存在或为空")

    payload = json.loads(task.get("payload_json") or "{}")
    shot_id = payload.get("shot_id")
    if shot_id is not None:
        shot = db.execute("SELECT id FROM shots WHERE id=? AND project_id=?", (shot_id, task["project_id"])).fetchone()
        if not shot:
            raise RuntimeError("任务输出引用的镜头不存在，拒绝登记孤儿资产")

    target_dir = managed_output_root() / str(task["project_id"]) / str(task["task_type"])
    target_dir.mkdir(parents=True, exist_ok=True)
    target = (target_dir / f"task-{task['id']}-{_safe_name(source.name)}").resolve()
    if source != target:
        shutil.copy2(source, target)
    hasher = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    size = target.stat().st_size
    metadata = {key: value for key, value in result.items() if key != "output_path"}
    asset = {
        "source_task_id": int(task["id"]), "shot_id": shot_id, "path": str(target),
        "file_name": target.name, "size_bytes": size, "sha256": digest,
    }
    cursor = db.execute(
        "INSERT INTO assets(project_id,asset_type,name,memory_json) VALUES(?,?,?,?)",
        (task["project_id"], task["task_type"], target.name, json.dumps(asset, ensure_ascii=False)),
    )
    db.execute(
        "INSERT INTO task_outputs(task_id,project_id,shot_id,output_type,path,file_name,size_bytes,sha256,metadata_json) "
        "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET path=excluded.path,file_name=excluded.file_name,"
        "size_bytes=excluded.size_bytes,sha256=excluded.sha256,metadata_json=excluded.metadata_json",
        (task["id"], task["project_id"], shot_id, task["task_type"], str(target), target.name, size, digest, json.dumps(metadata, ensure_ascii=False)),
    )
    if shot_id is not None:
        db.execute("UPDATE shots SET status='已生成' WHERE id=? AND project_id=?", (shot_id, task["project_id"]))
    return {**result, "output_path": str(target), "asset_id": cursor.lastrowid, "output": asset}


def serialize_output(row: sqlite3.Row) -> dict[str, Any]:
    value = dict(row)
    value["metadata"] = json.loads(value.pop("metadata_json") or "{}")
    return value
