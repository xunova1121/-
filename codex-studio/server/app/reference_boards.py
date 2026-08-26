from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

from .story_bible import fingerprint as bible_fingerprint


REQUIRED_VIEWS: dict[str, tuple[str, ...]] = {
    "character": ("front", "profile", "full_body"),
    "location": ("wide", "reverse"),
    "prop": ("front", "detail"),
}

VIEW_LABELS = {
    "front": "正面", "profile": "侧面", "full_body": "全身", "back": "背面",
    "wide": "全景", "reverse": "反向", "detail": "细节", "top": "俯视",
}


def _json(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def _latest_entity(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM bible_entities WHERE project_id=? AND entity_type=? AND entity_key=? ORDER BY version DESC,id DESC LIMIT 1",
        (project_id, entity_type, entity_key),
    ).fetchone()


def _assets(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str) -> list[sqlite3.Row]:
    return db.execute(
        "SELECT * FROM assets WHERE project_id=? AND entity_type=? AND entity_key=? AND local_path<>'' ORDER BY id DESC",
        (project_id, entity_type, entity_key),
    ).fetchall()


def _asset_dict(row: sqlite3.Row, approved_ids: set[int]) -> dict[str, Any]:
    return {
        "id": int(row["id"]), "project_id": row["project_id"], "asset_type": row["asset_type"],
        "name": row["name"], "episode": int(row["episode"]), "shot_id": row["shot_id"],
        "local_path": row["local_path"], "mime_type": row["mime_type"], "source_kind": row["source_kind"],
        "status": row["status"], "entity_type": row["entity_type"], "entity_key": row["entity_key"],
        "view_role": row["view_role"], "view_label": VIEW_LABELS.get(row["view_role"], row["view_role"]),
        "approved": int(row["id"]) in approved_ids, "created_at": row["created_at"],
        "memory": _json(row["memory_json"], {}), "metadata": _json(row["metadata_json"], {}),
    }


def _select_assets(rows: list[sqlite3.Row], requested_ids: list[int] | None) -> list[sqlite3.Row]:
    allowed = set(requested_ids or [])
    source = [row for row in rows if not allowed or int(row["id"]) in allowed]
    selected: dict[str, sqlite3.Row] = {}
    for row in source:  # rows are newest first; one approved candidate per view role
        role = str(row["view_role"] or "")
        if role and role not in selected:
            selected[role] = row
    return list(selected.values())


def _snapshot(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str, asset_ids: list[int]) -> tuple[dict[str, Any], list[str]]:
    entity = _latest_entity(db, project_id, entity_type, entity_key)
    rows = _assets(db, project_id, entity_type, entity_key)
    selected = _select_assets(rows, asset_ids)
    issues: list[str] = []
    if entity is None:
        issues.append("对应的 Story Bible 设定不存在")
    roles = {str(row["view_role"] or "") for row in selected}
    required = REQUIRED_VIEWS.get(entity_type, ())
    missing = [VIEW_LABELS.get(role, role) for role in required if role not in roles]
    if missing:
        issues.append("缺少必需视图：" + "、".join(missing))
    files: list[dict[str, Any]] = []
    for row in sorted(selected, key=lambda item: (str(item["view_role"]), int(item["id"]))):
        path = Path(str(row["local_path"] or ""))
        if not path.is_file():
            issues.append(f"参考文件不存在：{row['name']}")
            size, modified = -1, -1
        else:
            stat = path.stat()
            size, modified = stat.st_size, stat.st_mtime_ns
        if not str(row["mime_type"] or "").startswith("image/"):
            issues.append(f"参考视图不是图片：{row['name']}")
        files.append({
            "id": int(row["id"]), "role": row["view_role"], "path": str(path),
            "size": size, "modified_ns": modified,
        })
    core = {
        "schema_version": "1.0", "project_id": project_id, "entity_type": entity_type, "entity_key": entity_key,
        "bible_version": int(entity["version"]) if entity else 0,
        "bible_fingerprint": entity["fingerprint"] if entity else "", "assets": files,
    }
    canonical = json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    core["fingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return core, list(dict.fromkeys(issues))


def board_status(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str) -> dict[str, Any]:
    entity = _latest_entity(db, project_id, entity_type, entity_key)
    approval = db.execute(
        "SELECT * FROM reference_asset_approvals WHERE project_id=? AND entity_type=? AND entity_key=?",
        (project_id, entity_type, entity_key),
    ).fetchone()
    approved_ids = [int(value) for value in _json(approval["asset_ids_json"], [])] if approval else []
    current, issues = _snapshot(db, project_id, entity_type, entity_key, approved_ids)
    rows = _assets(db, project_id, entity_type, entity_key)
    candidate_snapshot, candidate_issues = _snapshot(db, project_id, entity_type, entity_key, [])
    state = "draft"
    if approval and approval["status"] == "approved":
        saved = _json(approval["snapshot_json"], {})
        state = "approved" if saved.get("fingerprint") == current["fingerprint"] and not issues else "stale"
    return {
        "project_id": project_id, "entity_type": entity_type, "entity_key": entity_key,
        "name": entity["name"] if entity else entity_key, "bible_version": int(entity["version"]) if entity else 0,
        "status": state, "revision": int(approval["revision"]) if approval else 0,
        "approved_at": approval["approved_at"] if approval else None,
        "required_views": list(REQUIRED_VIEWS.get(entity_type, ())), "required_view_labels": [VIEW_LABELS.get(v, v) for v in REQUIRED_VIEWS.get(entity_type, ())],
        "ready_to_approve": not candidate_issues, "issues": issues if state in {"approved", "stale"} else candidate_issues,
        "fingerprint": current["fingerprint"], "candidate_fingerprint": candidate_snapshot["fingerprint"],
        "approved_asset_ids": approved_ids, "assets": [_asset_dict(row, set(approved_ids)) for row in rows],
    }


def list_boards(db: sqlite3.Connection, project_id: str, entity_type: str | None = None) -> list[dict[str, Any]]:
    args: list[Any] = [project_id]
    where = "b.project_id=? AND b.entity_type IN ('character','location','prop')"
    if entity_type:
        where += " AND b.entity_type=?"
        args.append(entity_type)
    rows = db.execute(
        f"SELECT entity_type,entity_key FROM bible_entities b WHERE {where} AND version=(SELECT MAX(version) FROM bible_entities x WHERE x.project_id=b.project_id AND x.entity_type=b.entity_type AND x.entity_key=b.entity_key) ORDER BY entity_type,name",
        args,
    ).fetchall()
    return [board_status(db, project_id, row["entity_type"], row["entity_key"]) for row in rows]


def approve_board(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str, asset_ids: list[int]) -> dict[str, Any]:
    rows = _assets(db, project_id, entity_type, entity_key)
    selected = _select_assets(rows, asset_ids)
    selected_ids = [int(row["id"]) for row in selected]
    _, issues = _snapshot(db, project_id, entity_type, entity_key, selected_ids)
    if issues:
        raise ValueError("；".join(issues))
    entity = _latest_entity(db, project_id, entity_type, entity_key)
    assert entity is not None
    references = [str(row["local_path"]) for row in sorted(selected, key=lambda item: str(item["view_role"]))]
    data = _json(entity["data_json"], {})
    mark = bible_fingerprint(data, references)
    db.execute(
        "UPDATE bible_entities SET state='frozen',reference_assets_json=?,fingerprint=? WHERE id=?",
        (json.dumps(references, ensure_ascii=False), mark, int(entity["id"])),
    )
    snapshot, issues = _snapshot(db, project_id, entity_type, entity_key, selected_ids)
    if issues:
        raise ValueError("；".join(issues))
    previous = db.execute(
        "SELECT revision FROM reference_asset_approvals WHERE project_id=? AND entity_type=? AND entity_key=?",
        (project_id, entity_type, entity_key),
    ).fetchone()
    revision = int(previous["revision"]) + 1 if previous else 1
    db.execute(
        "INSERT INTO reference_asset_approvals(project_id,entity_type,entity_key,revision,status,asset_ids_json,snapshot_json,approved_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP) "
        "ON CONFLICT(project_id,entity_type,entity_key) DO UPDATE SET revision=excluded.revision,status='approved',asset_ids_json=excluded.asset_ids_json,snapshot_json=excluded.snapshot_json,approved_at=CURRENT_TIMESTAMP",
        (project_id, entity_type, entity_key, revision, "approved", json.dumps(selected_ids), json.dumps(snapshot, ensure_ascii=False)),
    )
    return board_status(db, project_id, entity_type, entity_key)


def revoke_board(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str) -> None:
    db.execute(
        "UPDATE reference_asset_approvals SET status='draft',approved_at=NULL WHERE project_id=? AND entity_type=? AND entity_key=?",
        (project_id, entity_type, entity_key),
    )


def approved_reference_paths(db: sqlite3.Connection, project_id: str, entity_type: str, entity_key: str) -> list[str]:
    board = board_status(db, project_id, entity_type, entity_key)
    if board["status"] != "approved":
        return []
    approved = set(board["approved_asset_ids"])
    return [item["local_path"] for item in board["assets"] if item["id"] in approved]


def episode_reference_gate(db: sqlite3.Connection, project_id: str, episode: int) -> dict[str, Any]:
    shots = db.execute(
        "SELECT characters_json,description,action,dialogue,prompt,scene_id FROM shots WHERE project_id=? AND episode=?",
        (project_id, episode),
    ).fetchall()
    character_names: set[str] = set()
    location_names: set[str] = set()
    text = ""
    for shot in shots:
        character_names.update(str(value) for value in _json(shot["characters_json"], []))
        text += " " + " ".join(str(shot[key] or "") for key in ("description", "action", "dialogue", "prompt"))
        if shot["scene_id"]:
            scene = db.execute("SELECT location FROM scenes WHERE id=?", (shot["scene_id"],)).fetchone()
            if scene and scene["location"]:
                location_names.add(str(scene["location"]))
    all_boards = list_boards(db, project_id)
    required = [
        board for board in all_boards
        if (board["entity_type"] == "character" and board["name"] in character_names)
        or (board["entity_type"] == "location" and board["name"] in location_names)
        or (board["entity_type"] == "prop" and board["name"] and board["name"] in text)
    ]
    issues = [f"{board['name']}：{('、'.join(board['issues'][:2]) or '尚未批准')}" for board in required if board["status"] != "approved"]
    return {
        "status": "approved" if not issues else "blocked", "required_count": len(required),
        "approved_count": sum(1 for board in required if board["status"] == "approved"),
        "issues": issues, "boards": [{key: board[key] for key in ("entity_type", "entity_key", "name", "status", "revision", "fingerprint")} for board in required],
    }
