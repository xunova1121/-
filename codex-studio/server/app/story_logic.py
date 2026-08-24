from __future__ import annotations

import json
import sqlite3
from typing import Any


ACTION_PHASES = ("anticipation", "start", "middle", "impact", "follow_through", "end", "settle")
ACTION_PHASE_ORDER = {name: index for index, name in enumerate(ACTION_PHASES)}
OPPOSITE_MOMENTUM = {("left", "right"), ("right", "left"), ("up", "down"), ("down", "up"), ("forward", "back"), ("back", "forward")}


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
    previous_action_id = ""
    previous_phase = "static"
    previous_momentum = ""
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

        action_id = str(continuity.get("action_id") or "").strip()
        phase = str(continuity.get("action_phase") or "static").strip().lower()
        momentum = str(continuity.get("momentum") or "").strip().lower()
        if phase not in {*ACTION_PHASES, "static"}:
            conflicts.append({"type": "action_phase", "path": "continuity.action_phase", "expected": "/".join(ACTION_PHASES), "actual": phase, "message": f"未知动作相位 {phase}"})
            phase = "static"
        if relation == "continuous":
            if not action_id and previous_action_id:
                action_id = previous_action_id
                continuity["action_id"] = action_id
            if action_id and previous_action_id and action_id != previous_action_id:
                conflicts.append({"type": "action_chain", "path": "continuity.action_id", "expected": previous_action_id, "actual": action_id,
                                  "message": "标记为 continuous 的相邻镜头必须属于同一个动作链"})
            if phase != "static" and previous_phase != "static":
                current_index = ACTION_PHASE_ORDER[phase]
                previous_index = ACTION_PHASE_ORDER[previous_phase]
                if current_index < previous_index:
                    conflicts.append({"type": "action_phase", "path": "continuity.action_phase", "expected": f">={previous_phase}", "actual": phase,
                                      "message": f"连续动作相位从 {previous_phase} 倒退到 {phase}"})
                elif current_index - previous_index > 2:
                    conflicts.append({"type": "action_phase_gap", "path": "continuity.action_phase", "expected": ACTION_PHASES[min(previous_index + 1, len(ACTION_PHASES) - 1)], "actual": phase,
                                      "message": f"连续动作从 {previous_phase} 跳到 {phase}，跨度过大，必须补过渡镜头或中间相位"})
            if previous_momentum and momentum and (previous_momentum, momentum) in OPPOSITE_MOMENTUM:
                conflicts.append({"type": "momentum", "path": "continuity.momentum", "expected": previous_momentum, "actual": momentum,
                                  "message": f"连续动作动量从 {previous_momentum} 突然反向为 {momentum}"})
        continuity["state_before"] = merged_before
        continuity["state_after"] = merged_after
        continuity["state_schema_version"] = "1.0"
        shot["continuity"] = continuity
        projected.append({"shot_number": shot.get("number"), "before": merged_before, "after": merged_after, "conflicts": conflicts})
        for conflict in conflicts:
            findings.append({"shot_number": shot.get("number"), "severity": "blocking", "type": "story_state", **conflict})
        previous_after, previous_scene = merged_after, scene_index
        previous_action_id, previous_phase, previous_momentum = action_id, phase, momentum
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
