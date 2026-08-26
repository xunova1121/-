from __future__ import annotations

import json
import sqlite3
from typing import Any

from .previz import stage_fingerprint


def _json(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def _constraint(layout: dict[str, Any]) -> str:
    camera = layout.get("camera") or {}
    position = camera.get("position") or {}
    target = camera.get("target") or {}
    subjects = layout.get("subjects") or []
    subject_text = "；".join(
        f"{item.get('entity_key', '人物')}位于({item.get('position', {}).get('x', 0)},{item.get('position', {}).get('y', 0)})，"
        f"朝向{item.get('facing_deg', 0)}°，姿态{item.get('pose', 'standing')}"
        for item in subjects
    ) or "无人物走位"
    sunlight = "未指定" if layout.get("sun_bearing_deg") is None else f"{layout['sun_bearing_deg']}°/{layout.get('sun_elevation', 'mid')}"
    return (
        f"场景 {layout.get('scene_key', '')}；机位({position.get('x', 0)},{position.get('y', 0)})，"
        f"拍摄目标({target.get('x', 0)},{target.get('y', 0)})，焦段{camera.get('lens_mm', 35)}mm，"
        f"机高{camera.get('height_m', 1.6)}m，运镜{camera.get('movement', 'fixed')}；"
        f"人物走位：{subject_text}；光向：{sunlight}。"
    )


def _binding_row(db: sqlite3.Connection, project_id: str, shot_id: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT b.*,s.number AS shot_number,l.scene_key,l.version AS layout_version,l.layout_json,l.fingerprint AS current_fingerprint "
        "FROM shot_previz_bindings b JOIN shots s ON s.id=b.shot_id JOIN scene_layouts l ON l.id=b.layout_id "
        "WHERE b.project_id=? AND b.shot_id=?",
        (project_id, shot_id),
    ).fetchone()


def serialize_binding(row: sqlite3.Row) -> dict[str, Any]:
    layout = _json(row["layout_json"], {})
    stored = str(row["current_fingerprint"] or "")
    current = stage_fingerprint(layout)
    saved = str(row["layout_fingerprint"] or "")
    return {
        "project_id": row["project_id"], "shot_id": int(row["shot_id"]), "shot_number": row["shot_number"],
        "layout_id": int(row["layout_id"]), "scene_key": row["scene_key"], "layout_version": int(row["layout_version"]),
        "fingerprint": saved, "status": "bound" if current == saved == stored else "stale",
        "prompt_constraint": _constraint(layout), "layout": layout, "updated_at": row["updated_at"],
    }


def bind_shot(db: sqlite3.Connection, project_id: str, shot_id: int, layout_id: int) -> dict[str, Any]:
    shot = db.execute("SELECT id FROM shots WHERE id=? AND project_id=?", (shot_id, project_id)).fetchone()
    if not shot:
        raise LookupError("镜头不存在或不属于当前项目")
    layout = db.execute("SELECT id,fingerprint FROM scene_layouts WHERE id=? AND project_id=?", (layout_id, project_id)).fetchone()
    if not layout:
        raise LookupError("预演版本不存在或不属于当前项目")
    db.execute(
        "INSERT INTO shot_previz_bindings(project_id,shot_id,layout_id,layout_fingerprint,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) "
        "ON CONFLICT(shot_id) DO UPDATE SET project_id=excluded.project_id,layout_id=excluded.layout_id,layout_fingerprint=excluded.layout_fingerprint,updated_at=CURRENT_TIMESTAMP",
        (project_id, shot_id, layout_id, layout["fingerprint"]),
    )
    row = _binding_row(db, project_id, shot_id)
    assert row is not None
    return serialize_binding(row)


def get_binding(db: sqlite3.Connection, project_id: str, shot_id: int) -> dict[str, Any] | None:
    row = _binding_row(db, project_id, shot_id)
    return serialize_binding(row) if row else None


def production_payload(db: sqlite3.Connection, project_id: str, shot_id: int, prompt: str) -> dict[str, Any]:
    shot = db.execute("SELECT * FROM shots WHERE id=? AND project_id=?", (shot_id, project_id)).fetchone()
    if not shot:
        raise LookupError("镜头不存在或不属于当前项目")
    binding = get_binding(db, project_id, shot_id)
    if not binding:
        raise ValueError("该镜头尚未绑定空间预演版本，禁止进入图片/视频生产")
    if binding["status"] != "bound":
        raise ValueError("该镜头绑定的空间预演版本已失效，请重新绑定")
    base = (prompt or shot["prompt"] or shot["description"] or shot["title"]).strip()
    combined = f"{base}\n\n【空间预演强制约束】{binding['prompt_constraint']}不得改变机位、焦段、人物站位、朝向和光向。"
    return {
        "shot_id": shot_id, "shot_number": shot["number"], "episode": int(shot["episode"]),
        "base_prompt": base, "prompt": combined,
        "previz": {
            "layout_id": binding["layout_id"], "scene_key": binding["scene_key"],
            "version": binding["layout_version"], "fingerprint": binding["fingerprint"],
            "constraint": binding["prompt_constraint"], "layout": binding["layout"],
        },
    }
