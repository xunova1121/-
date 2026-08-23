from __future__ import annotations

import json
import sqlite3
from typing import Any


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _flatten(value: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, item in value.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(item, dict):
            result.update(_flatten(item, path))
        else:
            result[path] = item
    return result


def _persistent_state(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if key not in {"environment", "camera", "lighting"}}


def validate_and_project(shots: list[dict[str, Any]], initial_state: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Project deterministic story state and report unexplained discontinuities.

    The model may propose state, but the engine owns inheritance. Missing before-state is
    filled from the previous shot. A conflicting explicit before-state becomes a blocking
    finding unless the shot's visible action explains the change.
    """
    projected: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    previous_after: dict[str, Any] = dict(initial_state or {})
    previous_scene: int | None = None
    for shot in shots:
        continuity = _mapping(shot.get("continuity"))
        before = _mapping(continuity.get("state_before"))
        after = _mapping(continuity.get("state_after"))
        scene_index = int(shot.get("scene_index") or 1)
        relation = str(continuity.get("link") or "cut")
        inherited = previous_after if previous_after and relation != "new-scene" and scene_index == previous_scene else _persistent_state(previous_after)
        explicit = _flatten(before)
        inherited_flat = _flatten(inherited)
        conflicts = []
        change_reason = str(continuity.get("state_change_reason") or "").strip()
        for path, expected in inherited_flat.items():
            actual = explicit.get(path, expected)
            if actual != expected and not change_reason:
                conflicts.append({"path": path, "expected": expected, "actual": actual})
        merged_before = json.loads(json.dumps(inherited, ensure_ascii=False)) if inherited else {}
        for group, values in before.items():
            if isinstance(values, dict) and isinstance(merged_before.get(group), dict):
                merged_before[group].update(values)
            else:
                merged_before[group] = values
        merged_after = json.loads(json.dumps(merged_before, ensure_ascii=False))
        for group, values in after.items():
            if isinstance(values, dict) and isinstance(merged_after.get(group), dict):
                merged_after[group].update(values)
            else:
                merged_after[group] = values
        if previous_after and not change_reason:
            for path, actual in _flatten(merged_after).items():
                expected = _flatten(merged_before).get(path)
                if expected is not None and actual != expected and not any(item["path"] == path for item in conflicts):
                    conflicts.append({"path": path, "expected": expected, "actual": actual})
        continuity["state_before"] = merged_before
        continuity["state_after"] = merged_after
        continuity["state_schema_version"] = "1.0"
        shot["continuity"] = continuity
        projected.append({"shot_number": shot.get("number"), "before": merged_before, "after": merged_after, "conflicts": conflicts})
        for conflict in conflicts:
            findings.append({"shot_number": shot.get("number"), "severity": "blocking", "type": "story_state", **conflict})
        previous_after, previous_scene = merged_after, scene_index
    return projected, findings


def persist_snapshots(db: sqlite3.Connection, project_id: str, episode: int, shots: list[dict[str, Any]], shot_ids: list[int]) -> list[dict[str, Any]]:
    previous = db.execute(
        "SELECT ss.state_after_json FROM shot_state_snapshots ss JOIN shots s ON s.id=ss.shot_id WHERE ss.project_id=? AND ss.episode<? ORDER BY ss.episode DESC,s.sequence DESC,s.id DESC LIMIT 1",
        (project_id, episode),
    ).fetchone()
    initial = json.loads(previous["state_after_json"] or "{}") if previous else {}
    projected, findings = validate_and_project(shots, initial)
    db.execute("DELETE FROM shot_state_snapshots WHERE project_id=? AND episode=?", (project_id, episode))
    by_number: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        by_number.setdefault(str(finding["shot_number"]), []).append(finding)
    for shot, snapshot, shot_id in zip(shots, projected, shot_ids):
        number = str(shot.get("number") or "")
        db.execute(
            "INSERT INTO shot_state_snapshots(project_id,episode,shot_id,schema_version,state_before_json,state_after_json,conflicts_json) VALUES(?,?,?,?,?,?,?)",
            (project_id, episode, shot_id, "1.0", json.dumps(snapshot["before"], ensure_ascii=False), json.dumps(snapshot["after"], ensure_ascii=False), json.dumps(by_number.get(number, []), ensure_ascii=False)),
        )
        db.execute("UPDATE shots SET continuity_json=? WHERE id=?", (json.dumps(shot["continuity"], ensure_ascii=False), shot_id))
    return findings


def recompute_episode(db: sqlite3.Connection, project_id: str, episode: int) -> list[dict[str, Any]]:
    rows = db.execute(
        "SELECT s.id,s.number,s.action,s.continuity_json,COALESCE(sc.sequence,1) AS scene_index FROM shots s LEFT JOIN scenes sc ON sc.id=s.scene_id WHERE s.project_id=? AND s.episode=? ORDER BY s.sequence,s.id",
        (project_id, episode),
    ).fetchall()
    shots = [{"number": row["number"], "action": row["action"], "scene_index": row["scene_index"], "continuity": json.loads(row["continuity_json"] or "{}") } for row in rows]
    return persist_snapshots(db, project_id, episode, shots, [int(row["id"]) for row in rows])
